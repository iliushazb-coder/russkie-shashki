// STAGE 5 / REMATCH: the negotiation of a rematch between the two players of a FINISHED Italian online game.
//
// A rematch is a NEW room (never a reset of the finished one). The finished room, the Worker and the Russian mode are untouched.
// The negotiation lives in its own small node  roomsItalianRematch/<old room code>  (STAGING Rules, tools/build-staging-rules.js):
//    {by, at}            proposal of the player of colour `by` (server time)
//    + accepted | declined   answer of the OTHER player, strictly before at + 10 s (B2R21); or `cancelled` = the proposer withdrew it (same window)
//    + room              24-hex code (NO time window: the 10 s limit the ANSWER, not the technical creation of the room) of the new room, reserved ONCE by the former DARK player (he creates the room and therefore
//                        plays light and moves first: the colours swap by themselves)
// This module is the state machine and the sequencing only. Everything that touches the screen, the access preflight, the room
// creation and the join is injected through `hooks`, so the existing guarded code paths (preflight, one SDK write, read-only
// confirmation) are reused unchanged and this file can be tested without a browser.
//
// Safety properties (all of them are also enforced by the Rules; the client never relies on itself):
//  * the code of the new room is chosen and written to the node BEFORE the room exists. Every later attempt uses the SAME code, and the
//    Rules allow a room to be created only once at a code, so a failing write can never produce more than ONE new room;
//  * at most MAX_CREATE_ATTEMPTS creation writes per negotiation, and a second one only after a read proved the room is absent;
//    an unknown outcome (lost ACK) is never repeated blindly;
//  * B2R21: the node is NEVER deleted or overwritten by a client (Rules). It is the only protection against a repeated invitation: after a
//    refusal, a cancel or an expiry (nobody answered within 10 s) the same finished game can never be offered again;
//  * a proposal / answer / reservation is written once; double clicks and reloads cannot repeat it (the node is the single source of truth);
//  * if the Rules for the node are not published, the first read is refused and the feature stays hidden (fail closed).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ItalianOnlineRematch = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const WINDOW_MS = 10000;           // owner decision 12.11.2026 (B2R21): the answer window is exactly 10 s from the SERVER time of the proposal (same as the Rules)
  const MAX_CREATE_ATTEMPTS = 2, MAX_RESERVE_ATTEMPTS = 2;
  const JOIN_POLL_MS = 2000, JOIN_POLL_MAX = 15;   // the light player waits at most ~30 s for the new room to appear
  const CODE = /^[A-F0-9]{24}$/, UID = /^tg_[0-9]+$/;
  const TERMINAL = ["declined_by_other", "declined_by_me", "cancelled_by_me", "cancelled_by_other", "expired_by_other", "expired_by_me"];
  const KEYS = ["by", "at", "accepted", "declined", "cancelled", "room"];
  const NODE = "roomsItalianRematch/";

  const denied = e => !!e && (e.code === "PERMISSION_DENIED" || /PERMISSION_DENIED/i.test(String(e.message || e)));
  const isTime = n => typeof n === "number" && Number.isFinite(n) && n > 0;
  const other = c => c === "light" ? "dark" : "light";

  // Pure: the state of the negotiation seen by the player of colour `myColor`.
  // phase: idle | invalid | waiting_answer | incoming | accepted | reserved
  //   terminal (only «Закрыть», never a new offer for this game):
  //        declined_by_other (the proposer sees it) | declined_by_me | cancelled_by_me (proposer) | cancelled_by_other (the other player)
  //        | expired_by_other (the proposer: nobody answered in time) | expired_by_me (the other player: I did not answer in time)
  function derive(node, myColor, serverNow) {
    if (node === null || node === undefined) return { phase: "idle" };
    if (typeof node !== "object" || Array.isArray(node)) return { phase: "invalid" };
    for (const k of Object.keys(node)) if (KEYS.indexOf(k) === -1) return { phase: "invalid" };
    if ((node.by !== "light" && node.by !== "dark") || !isTime(node.at)) return { phase: "invalid" };
    if ((node.accepted !== undefined && !isTime(node.accepted)) || (node.declined !== undefined && !isTime(node.declined)) ||
        (node.cancelled !== undefined && !isTime(node.cancelled))) return { phase: "invalid" };
    if (node.room !== undefined && (typeof node.room !== "string" || !CODE.test(node.room))) return { phase: "invalid" };
    if ([node.accepted, node.declined, node.cancelled].filter(x => x !== undefined).length > 1) return { phase: "invalid" };
    if (node.room !== undefined && node.accepted === undefined) return { phase: "invalid" };
    const mine = node.by === myColor;
    const base = { by: node.by, mine };
    if (node.room !== undefined) return Object.assign(base, { phase: "reserved", room: node.room });
    if (node.accepted !== undefined) return Object.assign(base, { phase: "accepted" });
    if (node.declined !== undefined) return Object.assign(base, { phase: mine ? "declined_by_other" : "declined_by_me" });
    if (node.cancelled !== undefined) return Object.assign(base, { phase: mine ? "cancelled_by_me" : "cancelled_by_other" });
    const left = WINDOW_MS - (serverNow - node.at);   // live only while now < at + 10 s (the Rules: now < at + 10000)
    if (left > 0) return Object.assign(base, { phase: mine ? "waiting_answer" : "incoming", remainingMs: Math.min(left, WINDOW_MS) });
    return Object.assign(base, { phase: mine ? "expired_by_other" : "expired_by_me", remainingMs: 0 });
  }

  // deps: { database, TIMESTAMP, oldCode, myColor, myUid, oldDarkId, oldLightId, setInterval, clearInterval, setTimeout, clearTimeout, now, hooks }
  // hooks: { onView(view), gate() -> Promise<boolean>, newCode() -> string, roomState(code) -> 'absent'|'present'|'unknown',
  //          createRoom(code) -> 'created'|'uncertain'|'failed'|'busy', enterExisting(code) -> boolean,
  //          tryJoin(code, creatorUid) -> 'joined'|'not_ready'|'uncertain'|'failed'|'busy' }
  function create(deps) {
    const d = deps, h = deps.hooks;
    if (!d || !d.database || !h || typeof h.onView !== "function") throw new Error("italian_rematch_invalid_dependencies");
    if (!CODE.test(d.oldCode) || (d.myColor !== "light" && d.myColor !== "dark") || !UID.test(d.myUid) ||
        !UID.test(d.oldDarkId) || !UID.test(d.oldLightId)) throw new Error("italian_rematch_invalid_identity");
    const iAmDark = d.myColor === "dark";
    const st = {
      stopped: false, started: false, node: null, nodeKnown: false, unavailable: false, offset: 0, offsetKnown: false,
      ref: null, listener: null, offRef: null, offListener: null, tick: null, joinTimer: null, retryTimer: null,
      forceExpired: false,
      busy: false,            // one user-initiated write at a time (double click, race with the answer)
      reserving: false, reservedCode: null, reserveAttempts: 0, createAttempts: 0, creating: false, createUncertain: false,
      joinPolls: 0, joinTimer: null, joining: false, joinDone: false, error: null, entered: false
    };
    const serverNow = () => d.now() + (st.offsetKnown ? st.offset : 0);
    const nodeRef = () => d.database.ref(NODE + d.oldCode);
    // The server clock the client knows may be a little off. If the Rules REFUSED an answer to a node that still has no answer, the window is over
    // (the Rules deny nothing else for a legitimate player): from then on the offer is shown as expired, never as a generic failure.
    const nodeNow = () => {
      const t = serverNow();
      return (st.forceExpired && st.node && isTime(st.node.at)) ? Math.max(t, st.node.at + WINDOW_MS) : t;
    };

    function view() {
      if (st.unavailable) return { phase: "unavailable" };
      if (!st.nodeKnown) return { phase: "loading" };
      const v = derive(st.node, d.myColor, nodeNow());
      v.busy = st.busy || st.reserving || st.creating || st.joining;
      v.error = st.error;
      v.createUncertain = st.createUncertain;
      v.amFormerDark = iAmDark;
      return v;
    }
    function emit() { if (!st.stopped) { try { h.onView(view()); } catch (_) { /* a failing screen must not stop the negotiation */ } } }
    function fail(code) { st.error = code; emit(); }

    function onNode(snap) {
      if (st.stopped) return;
      let val = null;
      try { val = snap.val(); } catch (_) { val = null; }
      st.node = val === undefined ? null : val; st.nodeKnown = true; st.unavailable = false;
      emit(); drive();
    }
    function onNodeError() {
      if (st.stopped) return;
      st.unavailable = true; emit();   // Rules not published / no access: the feature stays hidden
    }
    // Automatic steps that follow the node.
    function drive() {
      if (st.stopped || !st.nodeKnown) return;
      const v = derive(st.node, d.myColor, nodeNow());
      if (v.phase === "accepted" && iAmDark) reserve();
      else if (v.phase === "reserved" && iAmDark) ensureRoom(v.room);
      else if (v.phase === "reserved" && !iAmDark) pollJoin(v.room);
    }

    // ---- former DARK: reserve the code (once), then create the room at that very code ----
    async function reserve() {
      if (st.reserving || st.reservedCode || st.stopped) return;
      if (st.reserveAttempts >= MAX_RESERVE_ATTEMPTS) { fail("failed"); return; }   // bounded: a failing write never loops
      st.reserveAttempts++;
      st.reserving = true; st.error = null; emit();
      try {
        let ok = false;
        try { ok = (await h.gate()) === true; } catch (_) { ok = false; }
        if (st.stopped) return;
        if (!ok) { fail("unavailable"); return; }
        const code = h.newCode();
        if (!CODE.test(code)) { fail("failed"); return; }
        st.reservedCode = code;   // from now on THIS is the only code of this negotiation
        try { await nodeRef().child("room").set(code); }
        catch (_) {
          // The write may have reached the server or not: the node (read below) decides; never write a second code.
          try {
            const snap = await nodeRef().once("value");
            const n = snap.val();
            if (!n || n.room !== code) { st.reservedCode = null; if (!st.stopped) fail("failed"); return; }
          } catch (_2) { st.reservedCode = null; if (!st.stopped) fail("failed"); return; }
        }
        if (st.stopped) return;
        await ensureRoom(code, true);
      } finally { st.reserving = false; emit(); }
    }
    async function ensureRoom(code, gated) {
      if (st.creating || st.entered || st.stopped) return;
      if (st.reservedCode && st.reservedCode !== code) return;   // never a second code
      st.reservedCode = code;
      st.creating = true; st.error = null; emit();
      try {
        const state = await h.roomState(code);
        if (st.stopped) return;
        if (state === "present") {
          if (await h.enterExisting(code)) { st.entered = true; return; }
          fail("failed"); return;
        }
        if (state !== "absent") { st.createUncertain = true; fail("uncertain"); return; }
        if (st.createAttempts >= MAX_CREATE_ATTEMPTS) { fail("failed"); return; }
        st.createAttempts++;
        const out = await h.createRoom(code);
        if (st.stopped) return;
        if (out === "created") { st.entered = true; st.createUncertain = false; return; }
        if (out === "busy") { st.createAttempts--; scheduleRetry(code, 1000); return; }
        if (out === "uncertain") { st.createUncertain = true; fail("uncertain"); return; }
        fail("failed");
      } finally { st.creating = false; emit(); }
    }
    function scheduleRetry(code, ms) {
      if (st.retryTimer !== null || st.stopped) return;
      st.retryTimer = d.setTimeout(() => { st.retryTimer = null; ensureRoom(code); }, ms);
    }
    // Manual «check / try again» after an unknown or failed creation: ALWAYS reads first, then at most the remaining attempts.
    // B2R21 recovery (never by deleting the node): the SAME code again; or, if nothing was reserved yet, a fresh bounded reservation; the light
    // player simply listens for the new room again.
    function retry() {
      if (st.stopped || st.creating || st.reserving || st.joining) return false;
      const v = derive(st.node, d.myColor, nodeNow());
      if (iAmDark) {
        if (st.reservedCode) { st.createUncertain = false; st.error = null; ensureRoom(st.reservedCode); return true; }
        if (v.phase === "accepted") { st.reserveAttempts = 0; st.error = null; reserve(); return true; }
        if (v.phase === "reserved") { st.createUncertain = false; st.error = null; st.createAttempts = 0; ensureRoom(v.room); return true; }
        return false;
      }
      if (v.phase === "reserved") { st.joinDone = false; st.joinPolls = 0; st.error = null; pollJoin(v.room); return true; }
      return false;
    }

    // ---- former LIGHT: join the new room as soon as it appears (the existing guarded join path) ----
    async function pollJoin(code) {
      if (st.joining || st.joinDone || st.joinTimer || st.stopped) return;
      st.joining = true; st.error = null; emit();
      try {
        while (!st.stopped && !st.joinDone && st.joinPolls < JOIN_POLL_MAX) {
          st.joinPolls++;
          const out = await h.tryJoin(code, d.oldDarkId);
          if (st.stopped) return;
          if (out === "joined") { st.joinDone = true; st.entered = true; return; }
          if (out === "uncertain") { st.joinDone = true; fail("uncertain"); return; }   // never a second join write
          if (out === "failed") { st.joinDone = true; fail("failed"); return; }
          if (out === "busy") st.joinPolls--;
          await new Promise(res => { st.joinTimer = d.setTimeout(() => { st.joinTimer = null; res(); }, JOIN_POLL_MS); });
        }
        if (!st.stopped && !st.joinDone) { st.joinDone = true; fail("no_room"); }
      } finally { st.joining = false; emit(); }
    }

    // ---- user actions: one write each ----
    async function guarded(fn) {
      if (st.stopped || st.busy) return false;
      st.busy = true; st.error = null; emit();
      try { await fn(); return true; }
      catch (err) {
        // A refused write usually means the other player was faster: read the node and show what is really there.
        try {
          const snap = await nodeRef().once("value"); onNode(snap);
          // The other player (or the clock) was faster: the node now says what really happened -- show THAT, not a generic failure.
          let ph = derive(st.node, d.myColor, nodeNow()).phase;
          if ((ph === "waiting_answer" || ph === "incoming") && denied(err)) { st.forceExpired = true; ph = derive(st.node, d.myColor, nodeNow()).phase; emit(); }
          if (TERMINAL.indexOf(ph) !== -1 || ph === "accepted" || ph === "reserved") return false;
        } catch (_2) { /* the listener will correct the view */ }
        fail("failed"); return false;
      } finally { st.busy = false; emit(); }
    }
    // B2R21: ONE offer per finished game. propose() is possible only when the node does not exist at all; every terminal state
    // (declined / cancelled / expired / accepted / reserved) is a hard «no» that never reaches the server.
    function liveView() {
      if (!st.nodeKnown || st.unavailable) return null;
      return derive(st.node, d.myColor, nodeNow());
    }
    function propose() {
      const v = liveView();
      if (!v || v.phase !== "idle") return Promise.resolve(false);
      return guarded(async () => { await nodeRef().set({ by: d.myColor, at: d.TIMESTAMP }); });
    }
    // Cancel is a MARK on the node (the node stays, so the offer can never be restarted), allowed only to the proposer before any answer.
    function cancel() {
      const v = liveView();
      if (!v || v.phase !== "waiting_answer") return Promise.resolve(false);
      return guarded(async () => { await nodeRef().child("cancelled").set(d.TIMESTAMP); });
    }
    function accept() {
      const v = liveView();
      if (!v || v.phase !== "incoming") return Promise.resolve(false);
      return guarded(async () => { await nodeRef().child("accepted").set(d.TIMESTAMP); });
    }
    function decline() {
      const v = liveView();
      if (!v || v.phase !== "incoming") return Promise.resolve(false);
      return guarded(async () => { await nodeRef().child("declined").set(d.TIMESTAMP); });
    }

    function start() {
      if (st.started || st.stopped) return;
      st.started = true;
      st.ref = nodeRef(); st.listener = onNode;
      try { st.ref.on("value", st.listener, onNodeError); } catch (_) { onNodeError(); }
      try {
        st.offRef = d.database.ref(".info/serverTimeOffset");
        st.offListener = snap => { const o = snap && snap.val(); if (typeof o === "number" && Number.isFinite(o)) { st.offset = o; st.offsetKnown = true; } };
        st.offRef.on("value", st.offListener, () => {});
      } catch (_) { /* local clock: only the displayed countdown is affected, never a decision */ }
      st.tick = d.setInterval(() => { if (!st.stopped && st.nodeKnown) { emit(); } }, 1000);
    }
    function stop() {
      if (st.stopped) return;
      st.stopped = true;
      if (st.ref && st.listener) try { st.ref.off("value", st.listener); } catch (_) {}
      if (st.offRef && st.offListener) try { st.offRef.off("value", st.offListener); } catch (_) {}
      if (st.tick !== null) d.clearInterval(st.tick);
      if (st.joinTimer !== null) d.clearTimeout(st.joinTimer);
      if (st.retryTimer !== null) d.clearTimeout(st.retryTimer);
      st.tick = st.joinTimer = st.retryTimer = null;
    }
    return Object.freeze({ start, stop, propose, cancel, accept, decline, retry, view, oldCode: d.oldCode,
      get stopped() { return st.stopped; } });
  }

  return Object.freeze({ WINDOW_MS, TERMINAL, MAX_CREATE_ATTEMPTS, MAX_RESERVE_ATTEMPTS, JOIN_POLL_MS, JOIN_POLL_MAX, derive, create });
});

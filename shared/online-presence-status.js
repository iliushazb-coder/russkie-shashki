// F1 (all draughts variants): ONE honest classification of a SEAT for the game panel and the exit logic.
// Pure function, no DOM, no Firebase, no clocks of its own: the Russian screen (script.js) and the Italian screen
// (italian-online-two-player-ui.js) feed it the same facts and show the same words. Presentation only: it never writes and never decides a result.
//
// The old panels turned every "silent for more than a minute" seat into «Подтверждение…» even when NOTHING was being confirmed
// (the server never marked the player away, so no claim is allowed): the status then stayed forever. The states are now separated:
//   unknown        no clock / no link of my own / no record yet / data not fresh      -> «Подключение…» (neutral, never a countdown)
//   present        online and the heartbeat is fresh                                     -> «В игре»
//   countdown      marked away, or online but silent > STALE_MS, for less than a minute -> «Оффлайн NNс» (the minute left to come back)
//   confirming     the server MARKED the player away for >= 1 minute and the verdict of the server is awaited, at most CONFIRM_MAX_MS
//                  after the minute (a claim is possible / sent)                         -> «Подтверждение…»
//   away_unresolved the player is marked away >= 1 minute, but the server gave no verdict in CONFIRM_MAX_MS or REFUSED the claim
//   no_link        silent for >= 1 minute and NEVER marked away (the server cannot prove an exit)
//                  away_unresolved and no_link -> «Нет связи» + a clear way out (leave to the menu WITHOUT a result)
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.OnlinePresenceStatus = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const GRACE_MS = 60000, STALE_MS = 12000, CONFIRM_MAX_MS = 15000, SILENT_EXTRA_MS = 15000, LINK_SUSPECT_MS = 10000, LINK_RECOVER_HOLD_MS = 6000;   // SILENT_EXTRA_MS = PresenceEvidence.SILENT_EXTRA_MS (a test keeps them equal)
  const isNum = (v) => typeof v === "number" && isFinite(v);

  // in: { ready, connected, known, awayMs, silentMs, claim }
  //   ready      server clock known AND the room data is fresh after my last (re)connect (the caller decides, as before)
  //   connected  MY link to the database is up
  //   known      the seat has a record
  //   awayMs     age of the server mark "went away" (absentSince / off/<sid>), or null when the player is not marked away
  //   silentMs   age of the last heartbeat (server time), or null when unknown
  //   claim      what MY client knows about the technical-result request: "idle" | "sending" | "refused"
  function classifySeat(i) {
    i = i || {};
    if (!i.ready || !i.connected || !i.known) return { state: "unknown" };
    // OWN link under suspicion (see classifyOwnLink): what I hold about this seat is only what arrived BEFORE my link broke, so it says nothing
    // about the seat now. Optional input: absent / false = exactly the behaviour before this input existed (the Russian production panels never pass it).
    if (i.linkSuspect === true) return { state: "unknown", linkSuspect: true };
    const marked = isNum(i.awayMs);
    const silent = isNum(i.silentMs) ? Math.max(0, i.silentMs) : 0;
    // F1 (final rule): a seat leaves by a server MARK (>= 60 s) or by SILENCE (the server counts 60 s after a 15 s margin: PresenceEvidence).
    // The silent seat therefore goes through the same minute and the same «Подтверждение…» window, never straight to «Нет связи».
    // i.legacySilent === true: the Russian PRODUCTION client keeps the published (pre-final-rule) reading of silence (owner decision В1).
    const legacy = i.legacySilent === true;
    const elapsed = legacy ? (marked ? Math.max(0, i.awayMs) : silent) : Math.max(marked ? Math.max(0, i.awayMs) : 0, silent - SILENT_EXTRA_MS);
    if (elapsed > GRACE_MS && legacy) {
      if (!marked) return { state: "no_link", marked: false, silentMs: silent };
      if (i.claim === "refused" || elapsed - GRACE_MS > CONFIRM_MAX_MS) return { state: "away_unresolved", marked: true, awayMs: elapsed };
      return { state: "confirming", marked: true, awayMs: elapsed };
    }
    if (elapsed > GRACE_MS) {
      if (i.claim === "refused" || elapsed - GRACE_MS > CONFIRM_MAX_MS) return marked ? { state: "away_unresolved", marked: true, awayMs: elapsed } : { state: "no_link", marked: false, silentMs: silent };
      return { state: "confirming", marked: marked, awayMs: elapsed };
    }
    if (marked || silent > STALE_MS) return { state: "countdown", remainingMs: Math.max(0, GRACE_MS - elapsed), marked: marked };
    return { state: "present" };
  }
  // OWN link (presentation only; never writes, never decides a result, never reconnects anything).
  //   in: { connected: true|false|null, wasConnected, onLine: navigator.onLine|null, offlineForMs, ackAgeMs, visible }
  //   connected     the database client's own flag (.info/connected): it flips only after the transport timeout, ~30-45 s without internet
  //   wasConnected  the link has been up at least once in this screen (before that «Подключение…» is the normal start-up, not an outage)
  //   onLine        the browser's own signal (instant when the system reports it); offlineForMs = how long it has said "offline" (monotonic)
  //   ackAgeMs      how long the DATABASE has not confirmed a write of mine (the heartbeat is sent every 4 s); null = not measurable
  //   visible       false = hidden page: no heartbeat is sent, so silence proves nothing
  // -> "ok" | "suspect" (the link is probably dead, the client does not know yet) | "lost" (the client knows) | "na" (not up yet / nothing to judge)
  function classifyOwnLink(i) {
    i = i || {};
    if (i.connected === false) return { state: i.wasConnected ? "lost" : "na" };
    if (i.connected !== true) return { state: "na" };
    // The browser says "offline" - believed only while NO write was confirmed since it said so (a false "offline" with a working link is healed by the first ack).
    if (i.onLine === false && (!isNum(i.ackAgeMs) || !isNum(i.offlineForMs) || i.ackAgeMs >= i.offlineForMs)) return { state: "suspect", reason: "offline" };
    if (i.visible !== false && isNum(i.ackAgeMs) && i.ackAgeMs > LINK_SUSPECT_MS) return { state: "suspect", reason: "no_ack" };
    return { state: "ok" };
  }
  // Own seat: never a countdown or a verdict about MYSELF (a server mark on my own record right after a short network break is not "I left").
  function classifyOwnSeat(i) {
    i = i || {};
    if (!i.ready || !i.connected || !i.known) return { state: "unknown" };
    return isNum(i.awayMs) ? { state: "unknown", reviving: true } : { state: "present" };
  }
  // F1: a TECHNICAL end of a game (the opponent never came back, or a side ran out of time on the move) has NO rematch: the finish window has ONE button
  // «Закрыть» -> menu. Ordinary results (a win by the rules, a resignation, a draw) keep the rematch. Presentation only: the server result is not touched.
  const TECHNICAL_END_REASONS = Object.freeze(["disconnect", "timeout"]);
  const isTechnicalEnd = (winReason) => TECHNICAL_END_REASONS.indexOf(winReason) !== -1;
  // The panel shows a way out for these (the Italian/Russian screen calls it once per episode).
  const needsExit = (s) => !!s && (s.state === "no_link" || s.state === "away_unresolved");
  // Honest panel key per state (the caller maps keys to its own i18n table).
  const keyFor = (s, spectator) => !s ? "connecting" : s.state === "present" ? "in_game" : s.state === "countdown" ? "offline"
    : s.state === "confirming" ? (spectator ? "interrupted" : "confirming") : (s.state === "no_link" || s.state === "away_unresolved") ? (spectator ? "interrupted" : "no_link") : "connecting";

  // ---- the way out (shared by the Russian and the Italian screen; same look as the other modals, no HTML edits) ----
  // «Нет связи» must never leave a player without an exit. One prompt per episode: [wait] closes it, [leave] goes to the menu WITHOUT any result
  // (the caller marks the player away exactly as when the app is minimised; nothing is resigned, nothing is claimed).
  const PROMPT_ID = "link-lost-modal";
  function closeLinkLost(doc) {
    try { const old = doc && doc.getElementById && doc.getElementById(PROMPT_ID); if (old && old.parentNode) old.parentNode.removeChild(old); } catch (_) {}
  }
  function promptLinkLost(o) {
    const doc = o && o.doc;
    if (!doc || typeof doc.createElement !== "function" || !doc.body) return false;
    closeLinkLost(doc);
    const mk = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const ov = mk("div", "modal-overlay"); ov.id = PROMPT_ID; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
    const box = mk("div", "modal-box"), msg = mk("p", "end-game-text", o.text), row = mk("div", "modal-buttons");
    const wait = mk("button", "menu-button", o.waitLabel), leave = mk("button", "menu-button", o.leaveLabel);
    wait.type = "button"; leave.type = "button";
    wait.addEventListener("click", () => closeLinkLost(doc));
    leave.addEventListener("click", () => { closeLinkLost(doc); try { if (typeof o.onLeave === "function") o.onLeave(); } catch (_) {} });
    row.appendChild(wait); row.appendChild(leave); box.appendChild(msg); box.appendChild(row); ov.appendChild(box); doc.body.appendChild(ov);
    return true;
  }
  return Object.freeze({ GRACE_MS, STALE_MS, CONFIRM_MAX_MS, LINK_SUSPECT_MS, LINK_RECOVER_HOLD_MS, classifySeat, classifyOwnSeat, classifyOwnLink, needsExit, keyFor, isTechnicalEnd, TECHNICAL_END_REASONS, promptLinkLost, closeLinkLost });
});

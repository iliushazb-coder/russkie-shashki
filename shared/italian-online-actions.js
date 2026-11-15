// Stage F-A: Italian Online player ACTIONS beside the move: draw offer (offer / accept / decline / cancel) and reactions.
// The Russian game keeps both in its room (rooms/<code>/drawProposal, rooms/<code>/reaction) and any client may write them.
// Here they live in two SEPARATE nodes, so a write never changes the revision / ETag of the room (the Worker commits every move
// with an ETag compare-and-set; a write inside the room would turn the next move into italian_stale_revision):
//     roomsItalianDraw/<code>      = { by, at, rev, accepted? }   offer of the colour `by`, made at room revision `rev`
//     roomsItalianReaction/<code>  = { emoji, from, ts }           the last reaction (an emoji burst on both screens, like the Russian one)
// Semantics (copied from the Russian script.js, see tools/build-staging-rules.js for the Rules):
//   * the offering player sees «Ждём ответа…» + «Отменить предложение»; the other sees «<имя> предлагает ничью» + «Принять» / «Отклонить»;
//   * cancel and decline both just remove the offer; ANY move cancels it: an offer is valid only while rev === room.revision;
//   * the agreement is only RECORDED here (`accepted`); the result «draw» is written by the Worker alone (POST /italian/end kind=draw),
//     which re-reads the offer, so a client never assigns a result. Both clients ask the Worker (idempotent), the second answer is «already».
// Nothing here runs on import. A missing database / Rules (denied write) = the action simply does nothing visible (fail closed).
(function (global) {
  "use strict";
  const CODE = /^[A-F0-9]{24}$/;
  const EMOJI = ["\u{1F602}", "\u{1F525}", "\u{1F631}", "\u{1F621}"];   // 😂 🔥 😱 😡 (the four Russian reactions)
  const BURST_MAX_AGE_MS = 10000, REACTION_GAP_MS = 1000, FINISH_RETRY_MS = 3000, PROPOSER_FINISH_DELAY_MS = 2000;
  const num = v => typeof v === "number" && isFinite(v);
  const colorOk = c => c === "light" || c === "dark";

  // Pure: what the offer node means for THIS player right now.
  //   none      no live offer (no node, malformed, made at another revision = a move was made, game not active)
  //   waiting   I offered, no answer yet
  //   incoming  the opponent offered
  //   agreed    the other player accepted (the Worker has to record the result)
  function drawView(node, room, myColor) {
    if (!node || typeof node !== "object" || Array.isArray(node) || !colorOk(node.by) || !num(node.rev) || !num(node.at)) return { phase: "none" };
    if (!room || room.status !== "active") return { phase: "none" };
    if (node.rev !== (num(room.revision) ? room.revision : 0)) return { phase: "none" };
    const mine = node.by === myColor;
    if (num(node.accepted)) return { phase: "agreed", by: node.by, mine, at: node.at };
    return { phase: mine ? "waiting" : "incoming", by: node.by, mine, at: node.at };
  }
  // Pure: should this reaction snapshot trigger a burst? (fresh, not seen before, well formed)
  function burstFor(node, lastTs, serverNow) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;
    if (EMOJI.indexOf(node.emoji) === -1 || !colorOk(node.from) || !num(node.ts)) return null;
    if (node.ts <= lastTs) return null;
    if (!num(serverNow) || Math.abs(serverNow - node.ts) > BURST_MAX_AGE_MS) return null;
    return { emoji: node.emoji, from: node.from, ts: node.ts };
  }

  // env: { database, TIMESTAMP, code, myColor (null for a spectator), getRoom() -> {status, revision}, finishDraw() -> Promise,
  //        onDraw(view), onBurst({emoji, from, ts}), now() (wall clock), setTimeout, clearTimeout }
  function create(env) {
    const db = env.database, TS = env.TIMESTAMP, code = env.code, me = env.myColor;
    if (!CODE.test(code)) throw Error("actions_bad_code");
    const wall = env.now || (() => Date.now());
    const setT = env.setTimeout || (f => setTimeout(f)), clearT = env.clearTimeout || (t => clearTimeout(t));
    const spectator = !colorOk(me);
    let node = null, view = { phase: "none" }, lastTs = 0, offset = 0, offsetReady = false, started = false, dead = false;
    let drawRef = null, rxRef = null, offRef = null, drawL = null, rxL = null, offL = null;
    let finishTimer = null, finishing = false, lastFinish = -Infinity, lastReact = -Infinity, firstRx = true;
    const serverNow = () => wall() + offset;
    const safe = f => { try { return f(); } catch (_) { return undefined; } };

    function recompute() {
      if (dead) return;
      const next = spectator ? { phase: "none" } : drawView(node, safe(() => env.getRoom()), me);
      // `at` too: an offer that was withdrawn and made again by the same player between two events must still repaint the dialog
      const changed = next.phase !== view.phase || next.by !== view.by || next.at !== view.at;
      view = next;
      if (changed) safe(() => env.onDraw(view));
      if (view.phase === "agreed") scheduleFinish();
      else if (finishTimer !== null) { clearT(finishTimer); finishTimer = null; }
    }
    // Recording the agreed draw: the accepting client asks the Worker at once, the offering client after a short delay (the first
    // one normally wins; both calls are idempotent). Retries are spaced; it ends as soon as the room is no longer active.
    function scheduleFinish() {
      if (finishTimer !== null || finishing) return;
      const delay = view.mine ? PROPOSER_FINISH_DELAY_MS : 0;
      finishTimer = setT(() => { finishTimer = null; runFinish(); }, delay);
    }
    function runFinish() {
      if (dead || view.phase !== "agreed" || finishing) return;
      const t = wall();
      if (t - lastFinish < FINISH_RETRY_MS) { finishTimer = setT(() => { finishTimer = null; runFinish(); }, FINISH_RETRY_MS - (t - lastFinish)); return; }
      lastFinish = t; finishing = true;
      let p; try { p = Promise.resolve(env.finishDraw()); } catch (e) { p = Promise.reject(e); }
      p.then(() => {}, () => {}).then(() => { finishing = false; if (!dead && view.phase === "agreed") scheduleFinish(); });
    }
    function start() {
      if (started) return;
      started = true;
      offRef = db.ref(".info/serverTimeOffset");
      offL = snap => { const v = snap && snap.val ? snap.val() : null; if (num(v)) { offset = v; offsetReady = true; } };
      safe(() => offRef.on("value", offL));
      rxRef = db.ref("roomsItalianReaction/" + code);
      rxL = snap => {
        const v = snap && snap.val ? snap.val() : null;
        // The first value is the STATE of the node (an old reaction must not burst when a screen opens): it only moves the watermark
        // unless it is fresh by the server clock.
        const b = burstFor(v, lastTs, serverNow());
        if (v && num(v.ts) && v.ts > lastTs) lastTs = v.ts;
        const first = firstRx; firstRx = false;
        if (b && !(first && !offsetReady)) safe(() => env.onBurst(b));
      };
      safe(() => rxRef.on("value", rxL, () => {}));
      if (!spectator) {
        drawRef = db.ref("roomsItalianDraw/" + code);
        drawL = snap => { node = snap && snap.val ? snap.val() : null; recompute(); };
        safe(() => drawRef.on("value", drawL, () => {}));
      }
    }
    function stop() {
      dead = true;
      if (finishTimer !== null) { clearT(finishTimer); finishTimer = null; }
      if (drawRef && drawL) safe(() => drawRef.off("value", drawL));
      if (rxRef && rxL) safe(() => rxRef.off("value", rxL));
      if (offRef && offL) safe(() => offRef.off("value", offL));
      drawRef = rxRef = offRef = null; node = null; view = { phase: "none" };
    }
    const write = f => { try { const p = f(); return Promise.resolve(p).then(() => true, () => false); } catch (_) { return Promise.resolve(false); } };
    function room() { return safe(() => env.getRoom()) || null; }
    return {
      start, stop, refresh: recompute, view: () => view,
      // «🤝 Ничья»
      offerDraw() {
        const r = room();
        if (dead || spectator || !drawRef || !r || r.status !== "active") return Promise.resolve(false);
        if (view.phase !== "none") return Promise.resolve(false);
        return write(() => drawRef.set({ by: me, at: TS, rev: num(r.revision) ? r.revision : 0 }));
      },
      // «✅ Принять»: the answer is recorded, then the Worker records the result (re-reading the offer itself)
      acceptDraw() {
        if (dead || spectator || !drawRef || view.phase !== "incoming") return Promise.resolve(false);
        return write(() => drawRef.child("accepted").set(TS)).then(ok => { if (ok) { lastFinish = -Infinity; recompute(); } return ok; });
      },
      // «❌ Отклонить» (incoming) and «Отменить предложение» (waiting) are the same Russian action: the offer node is removed
      declineDraw() {
        if (dead || spectator || !drawRef || (view.phase !== "incoming" && view.phase !== "waiting")) return Promise.resolve(false);
        return write(() => drawRef.remove());
      },
      cancelDraw() { return this.declineDraw(); },
      // reactions
      react(emoji) {
        const r = room();
        if (dead || spectator || !rxRef || EMOJI.indexOf(emoji) === -1 || !r || r.status !== "active") return Promise.resolve(false);
        const t = wall();
        if (t - lastReact < REACTION_GAP_MS) return Promise.resolve(false);
        lastReact = t;
        return write(() => rxRef.set({ emoji, from: me, ts: TS }));
      }
    };
  }

  const api = Object.freeze({ EMOJI, BURST_MAX_AGE_MS, REACTION_GAP_MS, drawView, burstFor, create });
  global.ItalianOnlineActions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

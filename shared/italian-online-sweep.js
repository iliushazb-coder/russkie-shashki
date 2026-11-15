// Stage F-A: lazy "dead game" cleanup for Italian Online - the equivalent of the Russian lobby sweep (script.js: a client that has the
// «Кто играет?» list open removes rooms that nobody plays any more), but WITHOUT any client deleting or writing a result:
// a client only ASKS the Worker (POST /italian/end, kind "void") and the Worker + the Rules decide on the database clock.
//
// A game is dead when BOTH players have been away for >= 60 s counted from the SECOND departure (ItalianOnlinePresence.isAbandoned,
// the Russian isRoomAbandonedNow). The game then becomes «Партия не состоялась» (status "void"): no winner, no loss, no draw, no rating,
// it leaves the list at once and can never be resumed.
//
// Guarantees and their limit (the same honest limit as the Russian mechanism): this runs only while some allowed client has the list
// open (or a player returns / somebody opens that room). Without any client nothing runs. A dead game is hidden from the list in the
// meantime (script.js hides it at render) but physically stays `active` until the next such client. A server-side Cron would remove
// this dependency; it is NOT enabled (it needs a separate permission).
// Nothing runs on import; env supplies every effect (tests inject fakes).
(function (global) {
  "use strict";
  const MAX_PER_TICK = 3, MAX_ROOMS = 50, ASK_AGAIN_MS = 90000, PARALLEL_READS = 5;

  // env: { listActive() -> Promise<{code: room}>, readPresence(code) -> Promise<raw|null>, serverNow() -> ms, serverReady() -> bool,
  //        isAbandoned(room, presence, serverNow, ready) -> bool, requestVoid(code) -> Promise, now() (wall clock) }
  function create(env) {
    const asked = new Map();
    let running = false;
    function fresh() { const t = env.now(); for (const [k, at] of asked) if (t - at > ASK_AGAIN_MS) asked.delete(k); }
    async function tick() {
      if (running) return { skipped: true };
      running = true;
      const out = { checked: 0, asked: [] };
      try {
        fresh();
        const rooms = await env.listActive();
        const codes = Object.keys(rooms || {}).filter(c => !asked.has(c)).slice(0, MAX_ROOMS);
        const dead = [];
        for (let i = 0; i < codes.length && dead.length < MAX_PER_TICK; i += PARALLEL_READS) {
          const batch = codes.slice(i, i + PARALLEL_READS);
          const got = await Promise.all(batch.map(async c => {
            try { return [c, await env.readPresence(c)]; } catch (_) { return [c, undefined]; }   // a read problem is "unknown", never "dead"
          }));
          for (const [c, p] of got) {
            out.checked++;
            if (p === undefined || dead.length >= MAX_PER_TICK) continue;
            let gone = false;
            try { gone = env.isAbandoned(rooms[c], p, env.serverNow(), env.serverReady()) === true; } catch (_) { gone = false; }
            if (gone) dead.push(c);
          }
        }
        for (const c of dead) {
          asked.set(c, env.now());
          out.asked.push(c);
          try { await env.requestVoid(c); } catch (_) { /* the answer is not needed: the room leaves the list through its status */ }
        }
      } catch (_) { /* the list could not be read: nothing to do this time */ }
      finally { running = false; }
      return out;
    }
    return { tick, asked: () => Array.from(asked.keys()) };
  }

  const api = Object.freeze({ MAX_PER_TICK, ASK_AGAIN_MS, create });
  global.ItalianOnlineSweep = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

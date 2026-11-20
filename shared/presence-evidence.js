// F1 (all draughts variants): the ONE definition of "a seat has left the game" and of the verdicts built on it.
// Pure functions, no DOM, no Firebase, no clock of their own (the caller passes the DATABASE time `now`).
// Used by: the Worker (Russian claim-technical, Italian absence / end / void), the generated Rules constants
// (tools/build-staging-rules.js reads GRACE_MS / SILENT_MS / ALIVE_MS from here) and the clients (so the screen and the server never disagree).
//
// A seat is ABSENT when ONE of two independent proofs holds:
//   mark    the server marked the seat away (onDisconnect, or the client's own "hidden" write) at `absentSince`, and now - absentSince >= GRACE_MS (60 s);
//   silent  the seat was never marked, but its heartbeat (lastSeen = DATABASE time, written every 4 s) is older than SILENT_MS (75 s = 60 s + 15 s margin
//           for a single missed beat). This covers a phone that lost the whole network: onDisconnect then fires late or never.
// Unknown / partial data is NEVER absence.
//
// THE RULE (F1, final): every seat has its OWN 60 s to come back, counted from ITS OWN departure; the other seat leaving never restarts that clock.
// A seat whose time ran out is FORFEITED for good: it cannot come back (the Rules refuse its arrival), so a late return can neither win nor revive a dead game.
//   win   the loser is forfeited and the winner is ONLINE (unmarked) and ALIVE (heartbeat <= 30 s)                       -> technicalVerdict
//   void  BOTH seats are forfeited: the game did not take place (no winner, no Elo, no statistics)                      -> bothGoneVerdict
//   both back in time: the game simply goes on, nothing is decided.
// All nulls below mean PROVEN, anything else is a short reason; nothing here ever produces a result by itself (the Worker and the Rules do, on the database clock).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.PresenceEvidence = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const GRACE_MS = 60000, SILENT_EXTRA_MS = 15000, SILENT_MS = GRACE_MS + SILENT_EXTRA_MS, ALIVE_MS = 30000;
  const num = (v) => typeof v === "number" && isFinite(v);

  // seat = { online:boolean, absentSince?:number, onlineSince?:number, lastSeen?:number }  (Russian shape; Italian seatView/aggregate has the same keys)
  const isMarked = (s) => !!s && s.online === false && num(s.absentSince);
  // Effective age of the absence in ms (>= GRACE_MS means "proven absent"), or null when nothing is known.
  // The larger of the two proofs counts: a LATE mark (onDisconnect fired long after the cable was pulled) must not restart the clock.
  function absenceAge(s, now) {
    if (!s || typeof s !== "object" || !num(now)) return null;
    let best = null;
    if (isMarked(s)) best = now - s.absentSince;
    if (num(s.lastSeen)) {
      const silent = now - s.lastSeen - SILENT_EXTRA_MS;
      if (best === null || silent > best) best = silent;
    }
    return best;
  }
  const isAbsent = (s, now) => { const a = absenceAge(s, now); return a !== null && a >= GRACE_MS; };
  // The moment (database time) at which the seat counts as left: for a mark its absentSince, for silence lastSeen + 15 s.
  function absentAt(s, now) {
    const a = absenceAge(s, now);
    return a === null ? null : now - a;
  }

  // THE RULE (F1, final): every seat has its OWN 60 s to come back, counted from ITS OWN departure; the clock of one seat is never restarted
  // by the other seat leaving. A seat whose time ran out is FORFEITED for good (it cannot come back: the Rules refuse its arrival).
  //   win   the loser is forfeited and the winner is ONLINE (unmarked) and ALIVE (heartbeat <= 30 s). No "winner online for 60 s" delay.
  //   void  both seats are forfeited (see bothGoneVerdict): no winner, no Elo, no statistics.
  // opts.continuity === true (Russian, until its Rules refuse the arrival of a forfeited seat): the winner must also have been online >= 60 s
  // (a seat that has just come back after its own absence cannot win at once). Italian does not need it: its Rules refuse such an arrival.
  // opts.aliveForMark === false: skip the heartbeat check when the loser is proven by a MARK (the Russian claim keeps its older shape there).
  function technicalVerdict(loser, winner, now, opts) {
    if (!loser || !winner || !num(now)) return "presence_unknown";
    const a = absenceAge(loser, now);
    const proven = a !== null && a >= GRACE_MS;
    if (!isMarked(loser) && !proven) return "opponent_not_absent";
    if (winner.online !== true) return "caller_not_online";
    if (!proven) return "absence_too_short";
    if (opts && opts.continuity === true && (!num(winner.onlineSince) || now - winner.onlineSince < GRACE_MS)) return "caller_online_too_short";
    const markProven = isMarked(loser) && now - loser.absentSince >= GRACE_MS;
    const aliveNeeded = !markProven || !opts || opts.aliveForMark !== false;
    if (aliveNeeded && !(num(winner.lastSeen) && now - winner.lastSeen <= ALIVE_MS)) return "caller_not_alive";
    return null;
  }

  function bothGoneVerdict(a, b, now) {
    if (!a || !b || !num(now)) return "presence_unknown";
    const x = absenceAge(a, now), y = absenceAge(b, now);
    if (x === null || y === null) return "presence_unknown";
    if ((!isMarked(a) && x < GRACE_MS) || (!isMarked(b) && y < GRACE_MS)) return "someone_present";
    if (x < GRACE_MS || y < GRACE_MS) return "absence_too_short";   // the later departure counts: both must be >= 60 s
    return null;
  }

  // For a screen: what the opponent's seat looks like. awayMs = effective absence age (>= 0) or null; marked = a server mark exists.
  function seatFacts(s, now) {
    const a = absenceAge(s, now);
    return { awayMs: a === null ? null : Math.max(0, a), marked: isMarked(s) };
  }

  return Object.freeze({ GRACE_MS, SILENT_EXTRA_MS, SILENT_MS, ALIVE_MS, absenceAge, isAbsent, absentAt, technicalVerdict, bothGoneVerdict, seatFacts });
});

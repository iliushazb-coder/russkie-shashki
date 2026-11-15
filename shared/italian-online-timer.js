// STEP K3: the per-move timer of Italian Online, PURE helpers (no DOM, no network, no Firebase).
//
// The behaviour is the one of the Russian game (script.js: updateTimerDisplay / checkTimeout), nothing invented:
//   * the time limit per move is one of 0 (no limit), 30, 60, 120, 180, 300 seconds, chosen before the room is created;
//   * the clock of a move starts at room.turnStartedAt, a DATABASE time (the STAGING Rules only accept the server value), and is compared with the
//     server time of the phone (.info/serverTimeOffset), never with the bare phone clock;
//   * the line over the board: «⏱ Ход: Белые — осталось 0:45», in the last 10 seconds it blinks red;
//   * when the limit of the player on move has passed, either client asks the Worker (POST /italian/end kind "timeout"); the loss is
//     recorded only after the server (Rules + Worker) confirmed it.
// What differs from the Russian script is only the place where the loss is recorded (the Worker, STEP K2), not what the player sees.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ItalianOnlineTimer = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const VALUES = Object.freeze([0, 30, 60, 120, 180, 300]);
  const LOW_SECONDS = 10;          // the red blinking of the Russian #turn-timer.timer-low
  const CLAIM_GAP_MS = 2000;       // spacing between two "time is up" requests of one client

  const num = v => typeof v === "number" && Number.isFinite(v);

  // The limit of a room in seconds (0 when the room has none: an older room, or the creator chose "no limit").
  function limitOf(room) {
    return room && num(room.timeControlSeconds) && VALUES.indexOf(room.timeControlSeconds) > 0 ? room.timeControlSeconds : 0;
  }
  // Seconds left for the player on move by the server clock, or null when there is nothing to count (no limit, not active, no start time yet).
  // Never more than the limit (a start time slightly in the future of the estimated server time must not show "more than allowed").
  function remaining(room, serverNowMs) {
    const tc = limitOf(room);
    if (!tc || !room || room.status !== "active" || !num(room.turnStartedAt) || room.turnStartedAt <= 0 || !num(serverNowMs)) return null;
    const left = tc - (serverNowMs - room.turnStartedAt) / 1000;
    return left > tc ? tc : left;
  }
  // The same rule as the Russian checkTimeout: elapsed > limit. The decision is the server's; this only says when it is worth asking.
  function due(room, serverNowMs) {
    const left = remaining(room, serverNowMs);
    return left !== null && left < 0;
  }
  // Russian formatTime (shared/format-utils.js): m:ss, rounded up, never negative.
  function formatTime(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60), rem = s % 60;
    return m + ":" + (rem < 10 ? "0" : "") + rem;
  }
  function isLow(left) { return left !== null && left <= LOW_SECONDS; }
  // May this client ask for the timeout now? (pure: every input is a plain value)
  //   room: the server room (never the temporary picture of an own move), serverNow/ready/connected: the server clock,
  //   player: true for a player (a spectator never asks), idle: no own move / operation in flight, lastAt/at: wall times of the last / this request.
  function mayClaim(o) {
    if (!o || !o.player || !o.idle || !o.ready || !o.connected) return false;   // fail closed, like the Russian "!serverTimeOffsetReady" / "!isFirebaseConnected"
    if (!due(o.room, o.serverNow)) return false;
    return !(num(o.lastAt) && num(o.at) && o.at - o.lastAt < CLAIM_GAP_MS);
  }
  return Object.freeze({ VALUES, LOW_SECONDS, CLAIM_GAP_MS, limitOf, remaining, due, formatTime, isLow, mayClaim });
});

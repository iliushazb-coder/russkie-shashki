// Stage 3 / Step B: Italian Online PRESENCE -- the Russian presence semantics, in a SEPARATE node, per SESSION.
//
// Why a separate node: the Worker commits every Italian move as a whole-room PUT guarded by the room's
// ETag, so any descendant write inside roomsItalian/<code> (a heartbeat every 4 s!) would make the next
// move fail with italian_stale_revision. Presence therefore lives in
//     roomsItalianPresence/<code>/<color>/cur        = { sid, onlineSince, lastSeen }   the CURRENT session of that player
//     roomsItalianPresence/<code>/<color>/off/<sid>  = absentSince                      "session <sid> went away" (create-only)
// and THIS module never touches a roomsItalian/... path for writing (only reads the room for the
// abandoned/finished check).
//
// Why per session (auditor finding): the server executes onDisconnect AFTER the connection is gone, and we cannot
// rely on Rules re-checking "whose session is this" at that moment. The "went away" marker is therefore written into
// a cell keyed by THIS session's sid: a late onDisconnect / offline write of an old tab can only create
// off/<old sid> and has no way to switch off the new session (cur.sid is different). A player is present iff
// cur.sid has no off/<cur.sid>. Every NEW arrival (page start, reconnect, tab shown again, takeover) uses a NEW sid and
// a fresh server onlineSince, so an old onlineSince can never be carried over a gap in presence.
// Semantics mirror script.js (setupPresence / revivePresenceAfterReconnect / handleVisibilityChange / isRoomAbandonedNow):
//   * onDisconnect is armed FIRST (off/<new sid> = server time), only after its ACK the player is announced;
//   * heartbeat every 4 s writes {sid, lastSeen}, only while connected and visible;
//   * hidden tab == absence (off/<sid>), visible again == fresh arrival with a new sid;
//   * reconnect: fresh read -> abandoned check -> arm onDisconnect -> arrival with a new sid;
//   * nothing is written while there is no connection (the server-side onDisconnect owns "offline");
//   * leaving a room (stop, also when moving to another room) marks the session away unless the game is over;
//   * server time: .info/serverTimeOffset, FAIL CLOSED until the first offset arrived.
// The sid is a session LABEL, not a secret: it is readable by the opponent and spectators. A player's own crafted
// client could mark his own other session away; that only hurts himself and heals at the next arrival.
(function (global) {
  "use strict";
  const GRACE_MS = 60000, BEAT_MS = 4000, ALIVE_MS = 30000, REARM_MIN_MS = 3000, CODE = /^[A-F0-9]{24}$/;
  const num = v => typeof v === "number" && isFinite(v);

  // ---- pure helpers (shared semantics with the Russian predicates) ----
  // One colour's stored { cur, off } -> the Russian-shaped view { online, onlineSince, absentSince?, lastSeen, sid }.
  // Unknown / partial data -> null ("unknown", never "absent").
  function aggregateColor(c) {
    if (!c || typeof c !== "object") return null;
    const cur = c.cur;
    if (!cur || typeof cur !== "object" || typeof cur.sid !== "string" || !num(cur.onlineSince) || !num(cur.lastSeen)) return null;
    const off = c.off && typeof c.off === "object" ? c.off[cur.sid] : undefined;
    if (num(off)) return { online: false, absentSince: off, onlineSince: cur.onlineSince, lastSeen: cur.lastSeen, sid: cur.sid };
    return { online: true, onlineSince: cur.onlineSince, lastSeen: cur.lastSeen, sid: cur.sid };
  }
  function aggregate(p) { // raw roomsItalianPresence/<code> -> { light, dark } (each may be null)
    if (!p || typeof p !== "object") return null;
    return { light: aggregateColor(p.light), dark: aggregateColor(p.dark) };
  }
  // Russian isRoomAbandonedNow(room) with presence passed separately (it does not live in the room here).
  function isAbandoned(room, presence, serverNow, ready) {
    if (!room || !ready) return false;
    if (room.status !== "active") return false;
    if (room.winner || room.result) return false;
    const p = aggregate(presence);
    if (!p || !p.light || !p.dark) return false; // missing presence is NEVER "abandoned"
    if (p.light.online !== false || p.dark.online !== false) return false;
    return (serverNow - Math.max(p.light.absentSince, p.dark.absentSince)) >= GRACE_MS;
  }
  function absenceMs(p, serverNow) { // getAuthoritativeAbsenceMs, p = aggregated colour
    if (!p || p.online !== false || !num(p.absentSince)) return null;
    return serverNow - p.absentSince;
  }
  function onlineMs(p, serverNow) { // getOnlineSessionMs, p = aggregated colour
    if (!p || p.online !== true || !num(p.onlineSince)) return null;
    return serverNow - p.onlineSince;
  }
  // What the player sees / what the client may ask the Worker for. Never "expired" for unknown data.
  function opponentState(presenceRaw, myColor, serverNow, ready) {
    if (!ready) return { state: "unknown" };
    const presence = aggregate(presenceRaw);
    const opp = myColor === "light" ? "dark" : "light";
    const a = absenceMs(presence && presence[opp], serverNow);
    if (a === null) return { state: presence && presence[opp] && presence[opp].online === true ? "present" : "unknown" };
    if (a < GRACE_MS) return { state: "countdown", remainingMs: GRACE_MS - a };
    const me = presence && presence[myColor];
    const mine = onlineMs(me, serverNow);
    // the same three conditions the Worker and the Rules re-check: online for >= 60 s, and alive (recent heartbeat)
    return { state: "expired", canClaim: mine !== null && mine >= GRACE_MS && serverNow - me.lastSeen <= ALIVE_MS };
  }

  // Stage F-A: one SEAT as the Russian statusForColor shows it (a spectator sees both seats, a player sees the opponent).
  //   unknown   no clock / no record yet                        (neutral «Подключение…», never a countdown)
  //   present   online and its heartbeat is fresh               («В игре»)
  //   countdown marked away, or online but silent > 12 s        («Оффлайн 45с»: the minute left to come back; PRESENCE_STALE_WARNING_MS)
  //   expired   away / silent for more than the minute           (a player: «Подтверждение…», a spectator: «Игра прервана»)
  // Display only: nothing here decides a result (the Worker and the Rules do, on the database clock).
  const STALE_MS = 12000;
  function seatState(presenceRaw, color, serverNow, ready) {
    if (!ready || (color !== "light" && color !== "dark")) return { state: "unknown" };
    const p = aggregate(presenceRaw), c = p && p[color];
    if (!c) return { state: "unknown" };
    const age = num(c.lastSeen) ? Math.max(0, serverNow - c.lastSeen) : 0;
    const away = absenceMs(c, serverNow);
    const elapsed = away !== null ? away : age;
    if (elapsed > GRACE_MS) return { state: "expired", marked: away !== null };
    if (away !== null || age > STALE_MS) return { state: "countdown", remainingMs: Math.max(0, GRACE_MS - elapsed), marked: away !== null };
    return { state: "present" };
  }

  function randomSid(g) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
    let out = "", bytes = null;
    try { const c = g.crypto; if (c && c.getRandomValues) { bytes = new Uint8Array(24); c.getRandomValues(bytes); } } catch (_) { bytes = null; }
    if (!bytes) throw Error("no_secure_random");
    for (let i = 0; i < 24; i++) out += A[bytes[i] & 63];
    return out;
  }

  // env: { database, TIMESTAMP, doc, setInterval, clearInterval, makeSid, onEvent, now? }
  function create(env) {
    const db = env.database, TS = env.TIMESTAMP, doc = env.doc;
    const setI = env.setInterval, clearI = env.clearInterval;
    const wall = env.now || (() => Date.now());
    const emit = ev => { try { env.onEvent && env.onEvent(ev); } catch (_) {} };
    let offset = 0, offsetReady = false, connected = null, infoOff = [];
    let cur = null, gen = 0, beat = null, visHandler = null;

    const serverNow = () => wall() + offset;
    function attachInfo() {
      if (infoOff.length) return;
      const o = db.ref(".info/serverTimeOffset"), c = db.ref(".info/connected");
      const ol = s => { const v = s.val(); if (num(v)) { offset = v; offsetReady = true; } };
      const cl = s => { const was = connected; connected = s.val() === true; if (cur && connected && was !== true) bring(cur); };
      o.on("value", ol); c.on("value", cl);
      infoOff = [() => o.off("value", ol), () => c.off("value", cl)];
    }
    function detachInfo() { infoOff.forEach(f => { try { f(); } catch (_) {} }); infoOff = []; connected = null; }
    function stopBeat() { if (beat !== null) { clearI(beat); beat = null; } }
    function stopVis() { if (visHandler) { doc.removeEventListener("visibilitychange", visHandler); visHandler = null; } }
    const live = s => cur === s && !s.dead;
    const colorRef = s => db.ref("roomsItalianPresence/" + s.code + "/" + s.color);
    const curRef = s => colorRef(s).child("cur");
    const offRef = (s, sid) => colorRef(s).child("off").child(sid);
    const rd = r => (typeof r.get === "function" ? r.get() : r.once("value"));

    const isDenied = err => !!err && (err.code === "PERMISSION_DENIED" || /permission_denied/i.test(String(err.message || "")));
    const asSet = k => (k instanceof Set ? k : new Set(k ? [k] : []));
    // The sessions of THIS tab that the server may currently hold as `cur`: the last CONFIRMED one and every one whose
    // cur write was issued but has no verdict yet (it may still land, or be refused, or already have landed).
    const candidates = s => { const t = new Set(s.unsettled); if (s.confirmed) t.add(s.confirmed); return t; };

    // ---- away marking ------------------------------------------------------------------------------------------
    // A session is marked away by creating off/<sid>. Because a cur write that is still in flight can land LATER, the tab
    // marks EVERY session the server may hold as current (candidates), not only the newest one: if the newest arrival is
    // refused, the server still holds the older one and it must not stay "online". Writes on one connection are applied
    // in order, so an away marker can never overtake the arrival it belongs to; and because the cell is keyed by sid it
    // can never switch off a NEWER session whatever the order of the ACKs.
    // The server-side onDisconnect of a sid is withdrawn ONLY after the server confirmed off/<sid> (see stop): until then
    // it is the safety net that still turns an unconfirmed "away" into a marker when the connection ends.
    function awayOne(s, sid) {
      const e = s.awayMap.get(sid);
      if (e && e.ok !== false) return e.p; // already asked (in flight or confirmed); a FAILED attempt may be retried
      const attempt = () => { try { return Promise.resolve(offRef(s, sid).set(TS)); } catch (x) { return Promise.reject(x); } };
      const ent = { ok: null, p: null };
      // A denial is final (the room no longer takes presence writes). Anything else gets ONE more try; if that fails too,
      // the armed onDisconnect stays as the only safety net.
      ent.p = attempt().then(() => true, err => (isDenied(err) ? false : attempt().then(() => true, () => false)))
        .then(ok => { ent.ok = ok; return { sid, ok }; });
      s.awayMap.set(sid, ent);
      return ent.p;
    }
    // Returns a Promise<[{sid, ok}]> (ok = the SERVER confirmed off/<sid>) or null when there is nothing to write.
    function markAway(s) {
      const t = candidates(s);
      if (!t.size) return null;
      if (!connected) return null; // the server's onDisconnect already owns "offline"
      s.armed = false;
      return Promise.all(Array.from(t).map(sid => awayOne(s, sid)));
    }
    function cancelOd(s, sid) { try { const p = offRef(s, sid).onDisconnect().cancel(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    function cancelRegistrations(s, keep) {
      const k = asSet(keep);
      for (const sid of Array.from(s.registered)) {
        if (k.has(sid)) continue;
        s.registered.delete(sid);
        cancelOd(s, sid);
      }
    }
    // The server still holds the last CONFIRMED session and it is alive: continue with it (an arrival that was refused
    // or failed has changed nothing).
    function resumeConfirmed(s) {
      if (!live(s) || !s.confirmed || doc.hidden || !connected) return;
      s.sid = s.confirmed;
      if (s.armed) return;
      s.armed = true; startBeat(s);
    }

    // ---- per-attempt ordering (audit round 4) -----------------------------------------------------------------------
    // Every arrival that reaches the stage "cur write issued" gets a sequence number n (s.seqOf: sid -> n). Writes of one
    // connection are applied by the server in issue order, so the verdict of attempt n says something ONLY about attempts
    // with a number <= n:
    //   * ACK(n): the database accepted n (compare-and-set), so every attempt with a number < n is replaced -- their guards
    //     and "unsettled" entries go. Attempts with a number > n are untouched: they may be issued, applied, or even
    //     current already, and their guard must stay until THEIR verdict is known. A late ACK can therefore never withdraw
    //     the guard of a newer arrival, never overwrite `confirmed` with an older session (confirmedSeq only grows), and a
    //     late ACK arriving after a newer one changes nothing.
    //   * refusal of n: n never became current; only n's own guard and entry go.
    //   * no verdict for n: n stays a candidate with its guard (it may have landed).
    function confirmAttempt(s, sid, n) {
      for (const [x, xn] of Array.from(s.seqOf)) {
        if (xn >= n) continue;
        s.seqOf.delete(x); s.unsettled.delete(x);
        if (s.registered.delete(x)) cancelOd(s, x);
      }
      s.unsettled.delete(sid);
      if (n > s.confirmedSeq) { s.confirmedSeq = n; s.confirmed = sid; }
    }
    function refuseAttempt(s, sid) {
      s.unsettled.delete(sid); s.seqOf.delete(sid);
      if (s.registered.delete(sid)) cancelOd(s, sid);
      if (s.sid === sid) s.sid = s.confirmed || null; // only when the refused attempt is still the latest one
    }

    // fresh read -> finished/abandoned check -> arm onDisconnect(off/<new sid>) -> announce cur with the NEW sid and the
    // sid it REPLACES (`prev`, compare-and-set: see tools/build-staging-rules.js). The guard of every older session is
    // withdrawn only AFTER the new cur is CONFIRMED.
    function bring(s) {
      if (!live(s) || !connected) return;
      if (doc.hidden) return; // a hidden tab is absent: the visible handler brings it back
      const myGen = ++s.bringGen;
      const stale = () => !live(s) || myGen !== s.bringGen || !connected || doc.hidden;
      Promise.all([rd(db.ref("roomsItalian/" + s.code)), rd(db.ref("roomsItalianPresence/" + s.code))]).then(([rs, ps]) => {
        if (stale()) return;
        const room = rs && rs.val ? rs.val() : null, pres = ps && ps.val ? ps.val() : null;
        if (!room || room.status === "finished" || room.winner) { finishLocal(s, "finished"); return; }
        if (isAbandoned(room, pres, serverNow(), offsetReady)) { finishLocal(s, "abandoned"); return; }
        // The session this arrival REPLACES, exactly as the database showed it a moment ago. If another tab publishes in
        // between, the database refuses this arrival (it no longer matches) -- a stale arrival cannot displace it.
        const seat0 = (pres || {})[s.color] || {};
        const prev = seat0.cur && typeof seat0.cur.sid === "string" ? seat0.cur.sid : null;
        // Housekeeping: away markers of OUR OWN earlier sessions of this seat (written by markAway or by the server's
        // onDisconnect) are meaningless once a newer session of ours is announced; they are removed after that arrival
        // is confirmed, so an honest client never accumulates markers (the Rules only allow removing NON-current ones).
        const stale0 = seat0.off;
        const toClean = stale0 && typeof stale0 === "object" ? Object.keys(stale0).filter(k => s.mine.has(k)) : [];
        const sid = env.makeSid(), od = offRef(s, sid);
        s.registered.add(sid); s.mine.add(sid);
        return od.onDisconnect().set(TS).then(() => {
          // A delayed ACK may arrive after hide / stop / a newer arrival: then nothing is announced for this sid and
          // ITS registration is withdrawn (it could only ever create off/<this sid>, which is harmless anyway).
          if (stale()) { s.registered.delete(sid); cancelOd(s, sid); return; }
          // NO withdrawal of older guards here: until the new cur is confirmed the server may still hold the older session.
          const n = ++s.nIssued; s.seqOf.set(sid, n);
          s.sid = sid; s.issued = true; s.armed = false; stopBeat();
          s.unsettled.add(sid);
          const cell = { sid, onlineSince: TS, lastSeen: TS };
          if (prev) cell.prev = prev;
          return curRef(s).set(cell).then(() => {
            // CONFIRMED: the database accepted `sid`; attempts OLDER than this one are replaced. Newer attempts (issued
            // while this ACK was on its way) keep their state and their guard -- see confirmAttempt.
            confirmAttempt(s, sid, n);
            for (const k of toClean) {
              if (k === sid) continue;
              try { const p = offRef(s, k).remove(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
            }
            if (!live(s) || s.sid !== sid || myGen !== s.bringGen) return; // hide / stop / newer arrival owns the state now
            s.armed = true; startBeat(s); emit({ type: "online" });
          }, err => {
            if (isDenied(err)) {
              // Definitive: this sid never became current. Its own guard goes; every other session keeps ITS guard (the
              // older session the database may still hold, and any newer attempt).
              refuseAttempt(s, sid);
            } else if (live(s) && myGen === s.bringGen) {
              // No verdict: the write may have landed. BOTH guards stay armed and both sessions stay candidates for the
              // away marking. The tab goes on with the last confirmed session; if the unknown arrival did land, the next
              // heartbeat is refused and the usual re-arrival (with the right predecessor) follows.
              resumeConfirmed(s);
            }
            throw err;
          });
        });
      }).catch(err => { if (live(s) && myGen === s.bringGen) onWriteError(s, err); }); // a verdict of an OLDER arrival is no business of the current one
    }
    function startBeat(s) {
      stopBeat();
      beat = setI(() => {
        if (!live(s) || !connected || !s.armed) return;
        if (doc.hidden) return;
        const sid = s.sid;
        curRef(s).update({ sid, lastSeen: TS }).catch(err => { if (s.sid === sid) onWriteError(s, err); }); // a late error of an OLD sid says nothing
      }, BEAT_MS);
    }
    function onWriteError(s, err) {
      if (!live(s)) return;
      if (!isDenied(err) || s.checking) return;
      s.checking = true;
      const tok = s.bringGen; // anything started meanwhile (hide, a newer arrival, stop) owns the state: this check is then obsolete
      rd(colorRef(s)).then(snap => {
        s.checking = false;
        if (!live(s) || tok !== s.bringGen) return;
        const agg = aggregateColor(snap && snap.val ? snap.val() : null);
        if (agg && agg.sid !== s.sid && agg.online === true && !s.mine.has(agg.sid)) { // a live session of ANOTHER tab owns the seat (not one of ours)
          s.dead = true; stopBeat(); stopVis(); cancelRegistrations(s, null);
          emit({ type: "superseded" });
          return;
        }
        if (agg && agg.online === true && s.confirmed && agg.sid === s.confirmed) { resumeConfirmed(s); return; } // an arrival was refused; the seat is still ours and alive
        if (agg && agg.sid === s.sid && agg.online === true) return; // the error was about an older arrival; the seat is ours and alive
        // The seat is empty, belongs to an away session, or ours was marked away (e.g. by the server's onDisconnect):
        // arrive again with a NEW sid and a fresh onlineSince -- never reuse the old session. Throttled.
        const t = wall();
        if (s.issued && t - s.lastRearm >= REARM_MIN_MS) { s.lastRearm = t; s.armed = false; bring(s); }
      }).catch(() => { s.checking = false; });
    }
    function finishLocal(s, type) {
      if (!live(s)) return;
      stop({ explicit: false, game_over: true });
      emit({ type });
    }
    function onVisibility() {
      const s = cur; if (!live(s) || !connected) return;
      if (doc.hidden) {
        s.bringGen++;          // an arrival still in flight must not announce a hidden tab
        stopBeat();
        markAway(s);           // every session the server may hold for this tab, also one whose replacement is still in flight
      } else {
        bring(s); // same fresh path as a reconnect: never trusts a cache, always a new sid
      }
    }

    function start(code, color) {
      if (!CODE.test(code) || (color !== "light" && color !== "dark")) throw Error("presence_bad_args");
      if (cur && cur.code === code && cur.color === color && !cur.dead) return false;
      stop({ explicit: false }); // moving between rooms: the old room's session is marked away (no stale "online" left behind)
      const s = { code, color, sid: null, armed: false, dead: false, issued: false, bringGen: 0,
        confirmed: null, confirmedSeq: 0, nIssued: 0, seqOf: new Map(), unsettled: new Set(), awayMap: new Map(),
        registered: new Set(), mine: new Set(), checking: false, lastRearm: -Infinity };
      cur = s; gen++;
      attachInfo();
      visHandler = onVisibility; doc.addEventListener("visibilitychange", visHandler);
      if (connected) bring(s); // else: the .info/connected listener starts it
      return true;
    }
    // Leaving a room always marks every possibly-current session of this tab away (explicit or not) unless the game is
    // over / abandoned (then the room no longer accepts presence writes anyway).
    function stop(opts) {
      const s = cur; if (!s) return false;
      cur = null; stopBeat(); stopVis();
      s.dead = true; s.bringGen++;
      const over = !!(opts && opts.game_over);
      const away = over ? null : markAway(s);
      if (away) {
        // Withdraw every registration EXCEPT those of the sessions being marked, and each of those only after the server
        // confirmed its off/<sid>: cancelling first would leave a false "online" if the write never lands (denied / lost).
        cancelRegistrations(s, candidates(s));
        away.then(list => { for (const r of list) if (r.ok) { s.registered.delete(r.sid); cancelOd(s, r.sid); } });
      } else if (!over && candidates(s).size && !connected) {
        cancelRegistrations(s, candidates(s)); // offline: the dead connection's onDisconnect is the server's job; do not cancel it
      } else {
        cancelRegistrations(s, null);
      }
      detachInfo();
      return true;
    }
    return { start, stop, serverNow, serverReady: () => offsetReady, isConnected: () => connected === true,
      sid: () => (cur ? cur.sid : null), active: () => !!cur && !cur.dead, armed: () => !!cur && cur.armed, generation: () => gen };
  }

  const api = Object.freeze({ GRACE_MS, BEAT_MS, ALIVE_MS, STALE_MS, create, randomSid, aggregate, aggregateColor, isAbandoned, absenceMs, onlineMs, opponentState, seatState });
  global.ItalianOnlinePresence = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
    "use strict";

    // Stage 6B. Sounds of the Italian online screen.
    //
    // The sound implementation is NOT duplicated: this module only DECIDES which of the existing sounds of
    // shared/audio-effects.js (window.RussianCheckersAudioEffects, unchanged) belongs to a server-confirmed change of an
    // Italian room, and calls that module through its public API. It reads two already validated views
    // ({room, color, game, spectator}: the projection of the Italian UI) and never touches the network, Firebase,
    // the DOM, the game engine or any room data.
    //
    // WHEN a sound is allowed (everything else is silent):
    //   * both views are the SAME game (createdAt and both player ids equal), the earlier one was ACTIVE;
    //   * the new state is exactly ONE step newer (revision and moveCount grew by at most 1). A bigger jump is a catch-up
    //     after a reconnect / background / missed poll: silent, the board simply shows the present;
    //   * there is a baseline. The first view of a room (opening, restoring after a reload, invite link, new rematch room)
    //     has no earlier view and is silent;
    //   * the same (game, revision, status, moveCount) is never played twice (re-delivery of the same state).
    // WHAT is played (same names as the Russian mode: playSoundForMoveType(type, wasKing, delay)):
    //   "king"    - the moving piece became a king (also when it captured: like game-engine.js moveType)
    //   "capture" - an opponent piece disappeared (wasKing: the capturing piece already was a king)
    //   "move"    - a plain step
    //   end of the game (active -> finished): victory / defeat for a player (by the winner colour of THIS room),
    //   the neutral "draw" tune for a spectator or a game without a winner; the king tune is cancelled first.
    // Telegram WebView: the audio context is resumed through the module's own unlockAudioContext() before every sound
    // (the UI also calls unlock() on the player's taps). Missing module / any exception = silence, never an error.

    const OUTCOME_DELAY_MS = 450;   // the end-of-game tune starts after the knock of the last move

    function num(v) { return Number.isSafeInteger(v) && v >= 0 ? v : 0; }

    function pieceMap(game) {
        const m = Object.create(null);
        if (game && Array.isArray(game.pieces)) {
            for (const p of game.pieces) {
                if (p && Number.isInteger(p.row) && Number.isInteger(p.col)) m[p.row + "_" + p.col] = { color: p.color, king: !!p.king };
            }
        }
        return m;
    }
    function count(map, color) {
        let n = 0;
        for (const k in map) if (map[k].color === color) n++;
        return n;
    }

    // -> { move: null | {type, wasKing}, outcome: null | "victory"|"defeat"|"draw", reason }
    function classify(prev, next) {
        const none = reason => ({ move: null, outcome: null, reason });
        if (!prev || !next || !prev.room || !next.room) return none("no_baseline");
        const a = prev.room, b = next.room;
        if (a.status !== "active" || (b.status !== "active" && b.status !== "finished")) return none("not_live");
        if (!a.players || !b.players || !a.players.light || !b.players.light || !a.players.dark || !b.players.dark ||
            a.createdAt !== b.createdAt || a.players.light.id !== b.players.light.id || a.players.dark.id !== b.players.dark.id)
            return none("other_game");
        const dRev = num(b.revision) - num(a.revision), dMoves = num(b.moveCount) - num(a.moveCount);
        if (dRev < 0 || dMoves < 0) return none("older");
        if (dRev === 0 && dMoves === 0 && a.status === b.status) return none("same_state");
        if (dRev > 1 || dMoves > 1) return none("catch_up");

        let move = null;
        // Stage 6E: the Worker writes ONE revision per jump, but moveCount grows only when the whole capture chain ends. An INTERMEDIATE jump
        // (same revision step, same side to move, one piece taken) is a capture of its own and gets its capture sound, like every jump of the Russian game.
        const chainJump = dMoves === 0 && dRev === 1 && a.turn === b.turn;
        if (dMoves === 1 || chainJump) {
            const mover = a.turn === "dark" ? "dark" : "light", opp = mover === "light" ? "dark" : "light";
            const pm = pieceMap(prev.game), nm = pieceMap(next.game);
            const from = [], to = [];
            for (const k in pm) if (pm[k].color === mover && !(nm[k] && nm[k].color === mover)) from.push(pm[k]);
            for (const k in nm) if (nm[k].color === mover && !(pm[k] && pm[k].color === mover)) to.push(nm[k]);
            const captured = count(pm, opp) - count(nm, opp);
            if (chainJump) {
                // anything that is not exactly "one piece jumped and took one" (e.g. a technical finish) is no move here and never an error
                if (captured === 1 && from.length === 1 && to.length === 1 && count(pm, mover) === count(nm, mover)) move = { type: "capture", wasKing: from[0].king };
            } else if (captured < 0 || count(pm, mover) !== count(nm, mover)) return none("unrecognized");
            else if (from.length === 1 && to.length === 1) {
                const became = to[0].king && !from[0].king;
                move = { type: became ? "king" : (captured > 0 ? "capture" : "move"), wasKing: from[0].king };
            } else if (from.length === 0 && to.length === 0 && captured > 0) {
                move = { type: "capture", wasKing: true };   // a king that captured around and came back to its square
            } else {
                return none("unrecognized");
            }
        }

        let outcome = null;
        if (a.status === "active" && b.status === "finished") {
            if (next.spectator) outcome = "draw";
            else if (b.winner === "light" || b.winner === "dark") outcome = b.winner === next.color ? "victory" : "defeat";
            else outcome = "draw";
        }
        if (!move && !outcome) return none("no_event");
        return { move, outcome, reason: "ok" };
    }

    // deps (all optional): audio() -> the audio module | null; isActive() -> boolean; schedule(fn, ms)
    function create(deps) {
        deps = deps || {};
        const audio = typeof deps.audio === "function" ? deps.audio : function () { return global.RussianCheckersAudioEffects || null; };
        const isActive = typeof deps.isActive === "function" ? deps.isActive : function () { return true; };
        const kingDelay = typeof deps.kingDelayMs === "function" ? deps.kingDelayMs : function () { return 0; };   // Stage 6E: the king motif is timed to the turning crown, like the Russian screen
        const schedule = typeof deps.schedule === "function" ? deps.schedule : function (fn, ms) { return global.setTimeout(fn, ms); };
        let last = null;

        function kingDelaySafe() { try { const d = kingDelay(); return Number.isFinite(d) && d >= 0 ? d : 0; } catch (_) { return 0; } }
        function unlock() {
            try { const a = audio(); if (a && typeof a.unlockAudioContext === "function") a.unlockAudioContext(); } catch (_) { /* silence */ }
        }

        // Called for every accepted state. Returns the decision (for tests); never throws.
        function observe(prev, next) {
            let r;
            try { r = classify(prev, next); } catch (_) { return { move: null, outcome: null, reason: "error" }; }
            if (!r.move && !r.outcome) return r;
            const key = [next.room.createdAt, num(next.room.revision), next.room.status, num(next.room.moveCount)].join("|");
            if (key === last) return { move: null, outcome: null, reason: "duplicate" };
            last = key;
            let active = false;
            try { active = isActive() === true; } catch (_) { active = false; }
            if (!active) return Object.assign({}, r, { played: false, why: "inactive" });
            let a = null;
            try { a = audio(); } catch (_) { a = null; }
            if (!a) return Object.assign({}, r, { played: false, why: "no_audio" });
            try {
                unlock();
                if (r.move && typeof a.playSoundForMoveType === "function") a.playSoundForMoveType(r.move.type, r.move.wasKing, r.move.type === "king" ? kingDelaySafe() : 0);
                if (r.outcome) {
                    const tune = r.outcome === "victory" ? a.playVictorySound : r.outcome === "defeat" ? a.playDefeatSound : a.playDrawSound;
                    schedule(function () {
                        try {
                            if (typeof a.cancelKingSound === "function") a.cancelKingSound();   // the result is more important than the king motif
                            if (typeof tune === "function") tune();
                        } catch (_) { /* silence */ }
                    }, OUTCOME_DELAY_MS);
                }
            } catch (_) { /* silence: a sound can never break the game screen */ }
            return Object.assign({}, r, { played: true });
        }

        // The optimistic display of an own move (Stage OPT) plays the sound BEFORE the server answers. When that move is taken back (refused / not written),
        // the remembered key must not silence the next, different move that gets the same revision.
        function forget() { last = null; }

        return Object.freeze({ observe, unlock, forget });
    }

    const api = Object.freeze({ classify, create, OUTCOME_DELAY_MS });
    global.ItalianOnlineSound = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

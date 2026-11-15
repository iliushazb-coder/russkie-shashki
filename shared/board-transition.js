// Stage 6E: ONE neutral source of "what just happened on the board" for every ruleset (no Italian / Russian names, no DOM, no network, no rules).
// It compares two consecutive SERVER-CONFIRMED views of a room and answers: which piece moved from where to where, which opponent piece
// disappeared, whether the piece became a king, whether the capture chain goes on, and how the game ended. The sounds, the move animation,
// the last-move marks and the result window all read this one answer, so they can never disagree.
//
// A view is { room, game, color, spectator } (the projection the Italian screen keeps): room = the stored room (status, turn, revision,
// createdAt, players, winner, winReason, lastMoveReceipt), game = { pieces: [{row,col,color,king}], mustContinueFrom }.
//
// Rules of the transition (they mirror shared/italian-online-sound.js, which stays as it is):
//   * only a live baseline counts; another game, an older state, the same state and a CATCH-UP (revision jumped by more than one) give no move,
//     the board is simply drawn - nothing is animated that the player did not see happen;
//   * a Worker move is exactly ONE revision per jump (multi-capture = several revisions), and lastMoveReceipt names the jump (colour, from, to);
//   * a technical finish (the opponent did not come back) also bumps the revision but carries NO receipt of that revision -> an outcome without a move.
(function (global) {
    "use strict";

    const none = reason => ({ ok: false, reason, move: null, outcome: null });
    const isInt = n => Number.isInteger(n) && n >= 0 && n < 8;
    const num = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    const other = c => (c === "light" ? "dark" : "light");

    function pieceMap(game) {
        const m = Object.create(null);
        if (game && Array.isArray(game.pieces)) {
            for (const p of game.pieces) {
                if (p && isInt(p.row) && isInt(p.col)) m[p.row + "_" + p.col] = { row: p.row, col: p.col, color: p.color, king: !!p.king };
            }
        }
        return m;
    }

    function sameGame(a, b) {
        return !!(a.players && b.players && a.players.light && b.players.light && a.players.dark && b.players.dark &&
            a.createdAt === b.createdAt && a.players.light.id === b.players.light.id && a.players.dark.id === b.players.dark.id);
    }

    function between(prev, next) {
        if (!prev || !next || !prev.room || !next.room || !prev.game || !next.game) return none("no_baseline");
        const a = prev.room, b = next.room;
        if (a.status !== "active" || (b.status !== "active" && b.status !== "finished")) return none("not_live");
        if (!sameGame(a, b)) return none("other_game");
        const dRev = num(b.revision) - num(a.revision);
        if (dRev < 0) return none("older");
        if (dRev === 0 && a.status === b.status && num(b.moveCount) === num(a.moveCount)) return none("same_state");
        if (dRev > 1) return none("catch_up");

        let move = null;
        const receipt = b.lastMoveReceipt;
        // a move exists only when THIS revision carries its own receipt (a technical finish does not)
        if (dRev === 1 && receipt && receipt.revision === num(b.revision) && (receipt.color === "light" || receipt.color === "dark") &&
            isInt(receipt.fromRow) && isInt(receipt.fromCol) && isInt(receipt.toRow) && isInt(receipt.toCol)) {
            const mover = a.turn === "dark" ? "dark" : "light";
            if (receipt.color !== mover) return none("unrecognized");
            const pm = pieceMap(prev.game), nm = pieceMap(next.game);
            const fromKey = receipt.fromRow + "_" + receipt.fromCol, toKey = receipt.toRow + "_" + receipt.toCol;
            const was = pm[fromKey], now = nm[toKey];
            if (!was || was.color !== mover || !now || now.color !== mover) return none("unrecognized");
            const opp = other(mover);
            const captured = [];
            for (const k in pm) if (pm[k].color === opp && !(nm[k] && nm[k].color === opp)) captured.push({ row: pm[k].row, col: pm[k].col, color: opp, king: pm[k].king });
            // a jump takes exactly one piece, a step none; the pieces of the mover never change in number
            let movers = 0, moversNext = 0;
            for (const k in pm) if (pm[k].color === mover) movers++;
            for (const k in nm) if (nm[k].color === mover) moversNext++;
            if (captured.length > 1 || movers !== moversNext) return none("unrecognized");
            const becameKing = now.king && !was.king;
            move = {
                mover,
                from: { row: receipt.fromRow, col: receipt.fromCol },
                to: { row: receipt.toRow, col: receipt.toCol },
                captured,
                wasKing: was.king,
                becameKing,
                continues: !!(next.game.mustContinueFrom),
                type: becameKing ? "king" : (captured.length ? "capture" : "move")
            };
        }

        let outcome = null, winner = null;
        if (a.status === "active" && b.status === "finished") {
            winner = b.winner === "light" || b.winner === "dark" ? b.winner : null;
            if (next.spectator) outcome = "watched";
            else if (winner) outcome = winner === next.color ? "victory" : "defeat";
            else outcome = "draw";
        }
        if (!move && !outcome) return none("no_event");
        return { ok: true, reason: "ok", move, outcome, winner, winReason: outcome ? (b.winReason || null) : null };
    }

    // The last jump of a stored room, for the "last move" marks after a reload (no baseline needed).
    function lastJump(room) {
        const r = room && room.lastMoveReceipt;
        if (!r || !isInt(r.fromRow) || !isInt(r.fromCol) || !isInt(r.toRow) || !isInt(r.toCol)) return null;
        return { from: { row: r.fromRow, col: r.fromCol }, to: { row: r.toRow, col: r.toCol }, color: r.color };
    }

    const api = Object.freeze({ between, lastJump });
    global.BoardTransition = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

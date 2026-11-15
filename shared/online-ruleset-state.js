(function (global) {
    "use strict";

    if (!global.LocalRulesetAdapter || !global.CheckersRulesetRegistry) {
        throw new Error("RulesetRegistry and LocalRulesetAdapter must load before OnlineRulesetState");
    }

    function requireRuleset(id) {
        if (id === "italian" && global.LocalRulesetAdapter.has("italian")) return "italian";

        let normalized;
        try {
            normalized = global.CheckersRulesetRegistry.normalizeRoomRuleset(id);
        } catch (_error) {
            throw new Error("unsupported_online_ruleset:" + String(id));
        }
        if (normalized !== "russian" || !global.LocalRulesetAdapter.has(normalized)) {
            throw new Error("unsupported_online_ruleset:" + String(id));
        }
        return normalized;
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    // Snapshot own enumerable fields exactly once. Besides closing accessor
    // time-of-check/time-of-use gaps, skipping __proto__ prevents a room key
    // from changing the prototype of the output object during the copy.
    function snapshotObject(value) {
        const out = {};
        Object.keys(value).forEach(function (key) {
            if (key === "__proto__") return;
            out[key] = value[key];
        });
        return out;
    }

    function validItalianPiece(piece) {
        return !!piece && typeof piece === "object" && !Array.isArray(piece) &&
            Number.isInteger(piece.row) && piece.row >= 0 && piece.row < 8 &&
            Number.isInteger(piece.col) && piece.col >= 0 && piece.col < 8 &&
            (piece.color === "light" || piece.color === "dark") &&
            typeof piece.king === "boolean";
    }

    function validatePieces(ruleset, pieces) {
        if (ruleset === "italian") {
            if (!Array.isArray(pieces) || !pieces.every(validItalianPiece)) {
                throw new Error("invalid_italian_online_pieces");
            }
            return;
        }
        if (!pieces || Array.isArray(pieces) || typeof pieces !== "object") {
            throw new Error("invalid_russian_online_pieces");
        }
    }

    function validItalianPendingPiece(piece) {
        return !!piece && typeof piece === "object" && !Array.isArray(piece) &&
            Number.isInteger(piece.row) && piece.row >= 0 && piece.row < 8 &&
            Number.isInteger(piece.col) && piece.col >= 0 && piece.col < 8 &&
            (piece.color === "light" || piece.color === "dark") &&
            typeof piece.king === "boolean";
    }

    // PR-85: RTDB uses row_col keyed maps, while the Italian engine needs
    // an array. Strictly validate the serialized room BEFORE projection.
    function italianMapToArray(pieces) {
        if (!pieces || Array.isArray(pieces) || typeof pieces !== "object") {
            throw new Error("invalid_italian_online_pieces");
        }
        const keys = Object.keys(pieces);
        if (keys.length < 1 || keys.length > 24) {
            throw new Error("invalid_italian_online_pieces");
        }
        const array = [];
        for (const key of keys) {
            if (!/^[0-7]_[0-7]$/.test(key)) throw new Error("invalid_italian_online_pieces");
            const piece = pieces[key];
            if (!validItalianPiece(piece) || Object.keys(piece).length !== 4 ||
                (piece.row + piece.col) % 2 !== 1 ||
                key !== piece.row + "_" + piece.col) {
                throw new Error("invalid_italian_online_pieces");
            }
            array.push({row:piece.row,col:piece.col,color:piece.color,king:piece.king});
        }
        return array.sort(function(a,b) {return (a.row-b.row)||(a.col-b.col);});
    }
    function italianArrayToMap(pieces) {
        if (!Array.isArray(pieces) || pieces.length < 1 || pieces.length > 24) {
            throw new Error("invalid_italian_online_pieces");
        }
        const out = {};
        for (const piece of pieces) {
            if (!validItalianPiece(piece) || Object.keys(piece).length !== 4 ||
                (piece.row + piece.col) % 2 !== 1) {
                throw new Error("invalid_italian_online_pieces");
            }
            const key = piece.row + "_" + piece.col;
            if (Object.prototype.hasOwnProperty.call(out,key)) {
                throw new Error("invalid_italian_online_pieces");
            }
            out[key] = {row:piece.row,col:piece.col,color:piece.color,king:piece.king};
        }
        return out;
    }
    function projectPieces(ruleset, pieces) {
        if (ruleset === "italian" && !Array.isArray(pieces)) {
            return italianMapToArray(pieces);
        }
        validatePieces(ruleset,pieces);
        return pieces;
    }

    function validatePendingRemovals(ruleset, pending) {
        if (!Array.isArray(pending)) {
            throw new Error("invalid_" + ruleset + "_online_pending_removals");
        }
        if (ruleset === "russian") {
            if (!pending.every(function (key) { return typeof key === "string"; })) {
                throw new Error("invalid_russian_online_pending_removals");
            }
            return;
        }
        if (!pending.every(validItalianPendingPiece)) {
            throw new Error("invalid_italian_online_pending_removals");
        }
    }

    function normalizePendingRemovals(ruleset, value) {
        const pending = value == null ? [] : clone(value);
        validatePendingRemovals(ruleset, pending);
        return pending;
    }


    // Автоматические ничьи итальянских шашек (docs/PROJECT_PASSPORT_CHECKERS.md 13.10): две необязательные поля комнаты.
    // Только для "italian"; русская проекция и запись не меняются. Старые комнаты без полей читаются как «счётчик 0, истории нет».
    const ITALIAN_POSITION_KEY = /^[eldLD]{32}[ld]$/;
    function italianDrawFields(source) {
        const plies = source.drawPlies;
        if (plies !== undefined && plies !== null && (!Number.isInteger(plies) || plies < 0 || plies > 80)) {
            throw new Error("invalid_italian_draw_plies");
        }
        let history = source.positionHistory;
        if (history === undefined || history === null) history = [];
        else if (!Array.isArray(history)) {
            if (typeof history !== "object") throw new Error("invalid_italian_position_history");
            history = Object.keys(history).sort(function (a, b) { return Number(a) - Number(b); }).map(function (k) { return history[k]; });
        }
        if (history.length > 81 || !history.every(function (k) { return typeof k === "string" && ITALIAN_POSITION_KEY.test(k); })) {
            throw new Error("invalid_italian_position_history");
        }
        return { drawPlies: plies || 0, positionHistory: history.slice() };
    }

    function createInitialGameState(id) {
        const ruleset = requireRuleset(id);
        return clone(global.LocalRulesetAdapter.get(ruleset).createInitialState());
    }

    function projectGameState(room) {
        if (!room || typeof room !== "object") throw new Error("invalid_online_room");

        const roomSnapshot = snapshotObject(room);
        const ruleset = requireRuleset(roomSnapshot.ruleset);
        const pieces = projectPieces(ruleset, clone(roomSnapshot.pieces));
        const pendingRemovals = normalizePendingRemovals(ruleset, roomSnapshot.pendingRemovals);

        return {
            pieces: pieces,
            turn: roomSnapshot.turn,
            mustContinueFrom: roomSnapshot.mustContinueFrom || null,
            pendingRemovals: pendingRemovals,
            capturedDark: roomSnapshot.capturedDark || 0,
            capturedLight: roomSnapshot.capturedLight || 0,
            moveCount: roomSnapshot.moveCount || 0,
            winner: roomSnapshot.winner || null,
            winReason: roomSnapshot.winReason || null
        };
    }

    function applyGameState(room, state) {
        if (!room || typeof room !== "object" || !state || typeof state !== "object") {
            throw new Error("invalid_online_state");
        }

        const roomSnapshot = snapshotObject(room);
        const stateSnapshot = snapshotObject(state);
        const ruleset = requireRuleset(roomSnapshot.ruleset);

        const pieces = clone(stateSnapshot.pieces);
        validatePieces(ruleset,pieces);
        // Preserve the storage shape based on a VALIDATED original room:
        // engine arrays remain arrays; real Firebase Italian maps remain maps.
        // A freshly initialized local room has no stored board to check.
        // A room that explicitly carries pieces must always be validated.
        const hasStoredPieces = Object.prototype.hasOwnProperty.call(roomSnapshot, "pieces");
        const sourcePieces = hasStoredPieces ? roomSnapshot.pieces : null;
        // Only Italian stored maps need strict validation before re-encoding.
        // Russian applyGameState must preserve legacy pieces:null semantics.
        if (hasStoredPieces && ruleset === "italian") {
            if (sourcePieces == null) {
                throw new Error("invalid_italian_online_pieces");
            }
            projectPieces(ruleset, clone(sourcePieces));
        }
        const savedPieces = ruleset === "italian" && hasStoredPieces && !Array.isArray(sourcePieces) ?
            italianArrayToMap(pieces) : pieces;
        const pendingRemovals = normalizePendingRemovals(ruleset, stateSnapshot.pendingRemovals);

        const out = snapshotObject(roomSnapshot);
        out.pieces = savedPieces;
        out.turn = stateSnapshot.turn;
        out.mustContinueFrom = stateSnapshot.mustContinueFrom || null;
        out.pendingRemovals = pendingRemovals;
        out.capturedDark = stateSnapshot.capturedDark || 0;
        out.capturedLight = stateSnapshot.capturedLight || 0;
        out.moveCount = stateSnapshot.moveCount || 0;
        out.winner = stateSnapshot.winner || null;
        out.winReason = stateSnapshot.winReason || null;
        if (ruleset === "italian" && (stateSnapshot.drawPlies !== undefined || stateSnapshot.positionHistory !== undefined)) {
            const draw = italianDrawFields(stateSnapshot);
            out.drawPlies = draw.drawPlies;
            if (draw.positionHistory.length) out.positionHistory = draw.positionHistory; else delete out.positionHistory;
        }
        return out;
    }

    function projectRoom(room) {
        if (!room || typeof room !== "object") throw new Error("invalid_online_room");
        const roomSnapshot = snapshotObject(room);
        const ruleset = requireRuleset(roomSnapshot.ruleset);
        const pieces = projectPieces(ruleset, clone(roomSnapshot.pieces));
        const pendingRemovals = normalizePendingRemovals(ruleset, roomSnapshot.pendingRemovals);
        const state = {
            pieces: pieces,
            turn: roomSnapshot.turn,
            mustContinueFrom: roomSnapshot.mustContinueFrom || null,
            pendingRemovals: pendingRemovals,
            capturedDark: roomSnapshot.capturedDark || 0,
            capturedLight: roomSnapshot.capturedLight || 0,
            moveCount: roomSnapshot.moveCount || 0,
            winner: roomSnapshot.winner || null,
            winReason: roomSnapshot.winReason || null
        };
        if (ruleset === "italian") {
            const draw = italianDrawFields(roomSnapshot);
            state.drawPlies = draw.drawPlies;
            state.positionHistory = draw.positionHistory;
        }
        return { ruleset: ruleset, state: state };
    }

    // Keep the original public projection shape while exposing an atomic
    // ruleset+state projection for callers that must choose an adapter.
    projectGameState = function (room) {
        return projectRoom(room).state;
    };

    global.OnlineRulesetState = Object.freeze({
        createInitialGameState: createInitialGameState,
        projectGameState: projectGameState,
        projectRoom: projectRoom,
        applyGameState: applyGameState
    });
})(typeof window !== "undefined" ? window : globalThis);

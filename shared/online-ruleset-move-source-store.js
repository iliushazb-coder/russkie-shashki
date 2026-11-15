(function (global) {
    "use strict";

    if (!global.OnlineRulesetState) throw new Error("OnlineRulesetState must load before OnlineRulesetMoveSourceStore");

    function snapshotObject(value) {
        if (!value || typeof value !== "object") throw new Error("invalid_italian_online_move_source_state");
        const out = {};
        Object.keys(value).forEach(function (key) {
            if (key === "__proto__") return;
            out[key] = value[key];
        });
        return out;
    }

    function detachedObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_error) {
            return null;
        }
    }

    function nonNegativeInteger(value) {
        return Number.isInteger(value) && value >= 0 ? value : 0;
    }

    function positiveNumberOrNull(value) {
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    }

    function materializeItalianState(stateSource) {
        const stateSnapshot = snapshotObject(stateSource);
        const projected = global.OnlineRulesetState.projectRoom({
            ruleset: "italian",
            pieces: stateSnapshot.pieces,
            turn: stateSnapshot.turn,
            mustContinueFrom: stateSnapshot.mustContinueFrom,
            pendingRemovals: stateSnapshot.pendingRemovals,
            capturedDark: stateSnapshot.capturedDark,
            capturedLight: stateSnapshot.capturedLight,
            moveCount: stateSnapshot.moveCount,
            winner: stateSnapshot.winner,
            winReason: stateSnapshot.winReason
        });
        const state = projected.state;
        // Preserve only the already-audited presentation metadata from the
        // detached source snapshot. Gameplay validation above remains the sole
        // authority for engine state; these fields never enter move execution.
        state.players = detachedObject(stateSnapshot.players);
        state.presence = detachedObject(stateSnapshot.presence);
        state.ratingsAtStart = detachedObject(stateSnapshot.ratingsAtStart);
        state.matchNumber = nonNegativeInteger(stateSnapshot.matchNumber);
        state.timeControlSeconds = nonNegativeInteger(stateSnapshot.timeControlSeconds);
        state.turnStartedAt = positiveNumberOrNull(stateSnapshot.turnStartedAt);
        state.pieces.forEach(function (piece) { Object.freeze(piece); });
        Object.freeze(state.pieces);
        state.pendingRemovals.forEach(function (piece) { Object.freeze(piece); });
        Object.freeze(state.pendingRemovals);
        if (state.mustContinueFrom && typeof state.mustContinueFrom === "object") Object.freeze(state.mustContinueFrom);
        return Object.freeze(state);
    }

    function create() {
        let current = null;

        function replace(captured) {
            if (!captured || typeof captured !== "object") throw new Error("invalid_online_move_source_capture");

            const capturedRuleset = captured.ruleset;
            const capturedMode = captured.mode;
            const capturedSource = captured.source;
            const capturedTransactionTransport = captured.transactionTransport;

            if (capturedRuleset === "russian" && capturedMode === "legacy_russian_move_source" &&
                capturedSource === null && capturedTransactionTransport === null) {
                current = null;
                return null;
            }

            if (capturedRuleset !== "italian" || capturedMode !== "italian_move_source" ||
                !capturedSource || capturedTransactionTransport !== null) {
                throw new Error("invalid_italian_online_move_source_capture");
            }

            const sourceRuleset = capturedSource.ruleset;
            const sourceState = capturedSource.state;
            if (sourceRuleset !== "italian" || !sourceState) {
                throw new Error("invalid_italian_online_move_source_capture");
            }

            const state = materializeItalianState(sourceState);
            current = Object.freeze({
                ruleset: "italian",
                mode: "italian_move_source_stored",
                state: state
            });
            return current;
        }

        function clear() {
            current = null;
        }

        function get() {
            return current;
        }

        return Object.freeze({ replace: replace, clear: clear, get: get });
    }

    global.OnlineRulesetMoveSourceStore = Object.freeze({ create: create });
})(typeof window !== "undefined" ? window : globalThis);

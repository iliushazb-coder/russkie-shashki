(function (global) {
    "use strict";

    if (!global.OnlineRulesetState) {
        throw new Error("OnlineRulesetState must load before OnlineRulesetRetainedMovePreparation");
    }
    if (!global.LocalRulesetAdapter) {
        throw new Error("LocalRulesetAdapter must load before OnlineRulesetRetainedMovePreparation");
    }
    if (!global.OnlineRulesetRuntimeTransactionTransport) {
        throw new Error("OnlineRulesetRuntimeTransactionTransport must load before OnlineRulesetRetainedMovePreparation");
    }

    function materializeItalianState(sourceState) {
        if (!sourceState || typeof sourceState !== "object") {
            throw new Error("invalid_italian_retained_move_source_state");
        }
        return global.OnlineRulesetState.projectRoom({
            ruleset: "italian",
            pieces: sourceState.pieces,
            turn: sourceState.turn,
            mustContinueFrom: sourceState.mustContinueFrom,
            pendingRemovals: sourceState.pendingRemovals,
            capturedDark: sourceState.capturedDark,
            capturedLight: sourceState.capturedLight,
            moveCount: sourceState.moveCount,
            winner: sourceState.winner,
            winReason: sourceState.winReason
        }).state;
    }

    function prepare(storedSource, fromRow, fromCol, toRow, toCol, color) {
        if (!storedSource || typeof storedSource !== "object") {
            throw new Error("invalid_italian_retained_move_source");
        }

        // Snapshot each trust-boundary field exactly once so validation and
        // materialization cannot observe different accessor values.
        const ruleset = storedSource.ruleset;
        const mode = storedSource.mode;
        const sourceState = storedSource.state;
        if (ruleset !== "italian" ||
            mode !== "italian_move_source_stored" ||
            !sourceState) {
            throw new Error("invalid_italian_retained_move_source");
        }

        const state = materializeItalianState(sourceState);
        const result = global.LocalRulesetAdapter.get("italian").attemptMove(
            state, fromRow, fromCol, toRow, toCol, color
        );
        if (!result || !result.ok) return null;

        // Build the route seed from the SAME snapshotted retained state that
        // passed legality. It is private to the closure and contains no room
        // metadata/capability. The real move is still evaluated later against
        // Firebase's authoritative current room by the transaction callback.
        const transactionSeedRoom = global.OnlineRulesetState.applyGameState(
            { ruleset: "italian" },
            state
        );
        const transactionTransport = function (transactionTarget) {
            return global.OnlineRulesetRuntimeTransactionTransport.submit(
                transactionSeedRoom,
                fromRow, fromCol, toRow, toCol, color,
                transactionTarget
            );
        };

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_retained_move_prepared",
            optimisticResult: Object.freeze({
                state: result.state,
                transition: result.transition
            }),
            transactionTransport: transactionTransport
        });
    }

    global.OnlineRulesetRetainedMovePreparation = Object.freeze({
        prepare: prepare
    });
})(typeof window !== "undefined" ? window : globalThis);

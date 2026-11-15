(function (global) {
    "use strict";

    if (!global.OnlineRulesetMoveEntry) {
        throw new Error("OnlineRulesetMoveEntry must load before OnlineRulesetMovePreparation");
    }
    if (!global.LocalRulesetAdapter) {
        throw new Error("LocalRulesetAdapter must load before OnlineRulesetMovePreparation");
    }

    function prepare(room, fromRow, fromCol, toRow, toCol, color) {
        const entry = global.OnlineRulesetMoveEntry.resolve(room);

        if (entry.mode === "legacy_russian_move_path") {
            if (entry.ruleset !== "russian" ||
                entry.optimisticState !== null ||
                entry.transactionTransport !== null) {
                throw new Error("invalid_russian_online_move_preparation");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_move_path",
                optimisticResult: null,
                transactionTransport: null
            });
        }

        if (entry.mode !== "italian_runtime_required" ||
            entry.ruleset !== "italian" ||
            !entry.optimisticState ||
            entry.transactionTransport !== null) {
            throw new Error("invalid_italian_online_move_preparation");
        }

        const adapter = global.LocalRulesetAdapter.get("italian");
        const result = adapter.attemptMove(
            entry.optimisticState, fromRow, fromCol, toRow, toCol, color
        );

        if (!result || !result.ok) return null;

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_move_prepared",
            optimisticResult: Object.freeze({
                state: result.state,
                transition: result.transition
            }),
            transactionTransport: null
        });
    }

    global.OnlineRulesetMovePreparation = Object.freeze({
        prepare: prepare
    });
})(typeof window !== "undefined" ? window : globalThis);

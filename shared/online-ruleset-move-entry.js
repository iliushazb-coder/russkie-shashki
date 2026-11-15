(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeDispatch) {
        throw new Error("OnlineRulesetRuntimeDispatch must load before OnlineRulesetMoveEntry");
    }

    function resolve(room) {
        const route = global.OnlineRulesetRuntimeDispatch.resolve(room);

        if (route.mode === "legacy_russian_runtime") {
            if (route.ruleset !== "russian" ||
                route.optimisticState !== null ||
                route.transactionTransport !== null) {
                throw new Error("invalid_russian_online_move_entry");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_move_path",
                optimisticState: null,
                transactionTransport: null
            });
        }

        if (route.mode !== "italian_runtime_dispatch" ||
            route.ruleset !== "italian" ||
            !route.optimisticState ||
            route.transactionTransport !== null) {
            throw new Error("invalid_italian_online_move_entry");
        }

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_runtime_required",
            optimisticState: route.optimisticState,
            transactionTransport: null
        });
    }

    global.OnlineRulesetMoveEntry = Object.freeze({
        resolve: resolve
    });
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
    "use strict";

    if (!global.OnlineRulesetRoomTransactionCallback) {
        throw new Error("OnlineRulesetRoomTransactionCallback must load before OnlineRulesetRuntimeIntegration");
    }

    function resolve(room) {
        if (!room || typeof room !== "object") {
            throw new Error("invalid_online_room");
        }

        const projected = global.OnlineRulesetState.projectRoom(room);

        if (projected.ruleset === "russian") {
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                transactionCallback: null
            });
        }

        if (projected.ruleset === "italian") {
            return Object.freeze({
                ruleset: "italian",
                mode: "italian_ruleset_runtime",
                transactionCallback: global.OnlineRulesetRoomTransactionCallback.attempt
            });
        }

        throw new Error("unsupported_online_runtime_ruleset");
    }

    global.OnlineRulesetRuntimeIntegration = Object.freeze({
        resolve: resolve
    });
})(typeof window !== "undefined" ? window : globalThis);

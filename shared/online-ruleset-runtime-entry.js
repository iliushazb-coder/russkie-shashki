(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeIntegration) {
        throw new Error("OnlineRulesetRuntimeIntegration must load before OnlineRulesetRuntimeEntry");
    }

    function resolve(room) {
        const route = global.OnlineRulesetRuntimeIntegration.resolve(room);

        if (route.mode === "legacy_russian_runtime") {
            if (route.ruleset !== "russian" || route.transactionCallback !== null) {
                throw new Error("invalid_russian_online_runtime_route");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                runtimeEntry: null
            });
        }

        if (route.mode === "italian_ruleset_runtime") {
            if (route.ruleset !== "italian" || typeof route.transactionCallback !== "function") {
                throw new Error("invalid_italian_online_runtime_route");
            }
            return Object.freeze({
                ruleset: "italian",
                mode: "italian_runtime_required",
                runtimeEntry: null
            });
        }

        throw new Error("unsupported_online_runtime_route");
    }

    global.OnlineRulesetRuntimeEntry = Object.freeze({
        resolve: resolve
    });
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeSession) {
        throw new Error("OnlineRulesetRuntimeSession must load before OnlineRulesetRuntimeDispatch");
    }

    function resolve(room) {
        const runtime = global.OnlineRulesetRuntimeSession.create(room);

        if (runtime.mode === "legacy_russian_runtime") {
            if (runtime.ruleset !== "russian" || runtime.session !== null) {
                throw new Error("invalid_russian_online_runtime_session");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                optimisticState: null,
                transactionTransport: null
            });
        }

        if (runtime.mode !== "italian_runtime_session" ||
            runtime.ruleset !== "italian" ||
            !runtime.session ||
            runtime.session.ruleset !== "italian") {
            throw new Error("invalid_italian_online_runtime_session");
        }

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_runtime_dispatch",
            optimisticState: runtime.session.state,
            transactionTransport: null
        });
    }

    global.OnlineRulesetRuntimeDispatch = Object.freeze({
        resolve: resolve
    });
})(typeof window !== "undefined" ? window : globalThis);

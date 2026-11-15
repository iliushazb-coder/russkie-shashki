(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeSession || !global.OnlineRulesetRuntimeIntegration) {
        throw new Error("OnlineRulesetRuntimeSession and OnlineRulesetRuntimeIntegration must load before OnlineRulesetRuntimeController");
    }

    function snapshotObject(value) {
        if (!value || typeof value !== "object") throw new Error("invalid_online_room");
        const out = {};
        Object.keys(value).forEach(function (key) {
            if (key === "__proto__") return;
            out[key] = value[key];
        });
        return out;
    }

    function create(room) {
        // Session routing and executable transaction routing must consume one
        // materialized room snapshot. Never re-read hostile room accessors here.
        const roomSnapshot = snapshotObject(room);
        const runtime = global.OnlineRulesetRuntimeSession.create(roomSnapshot);

        if (runtime.mode === "legacy_russian_runtime") {
            if (runtime.ruleset !== "russian" || runtime.session !== null) {
                throw new Error("invalid_russian_online_runtime_session");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                controller: null
            });
        }

        if (runtime.mode !== "italian_runtime_session" ||
            runtime.ruleset !== "italian" ||
            !runtime.session ||
            runtime.session.ruleset !== "italian") {
            throw new Error("invalid_italian_online_runtime_session");
        }

        const route = global.OnlineRulesetRuntimeIntegration.resolve(roomSnapshot);
        if (route.ruleset !== "italian" ||
            route.mode !== "italian_ruleset_runtime" ||
            typeof route.transactionCallback !== "function") {
            throw new Error("invalid_italian_online_runtime_controller_route");
        }

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_runtime_controller",
            controller: Object.freeze({
                ruleset: "italian",
                state: runtime.session.state,
                transactionCallback: route.transactionCallback
            })
        });
    }

    global.OnlineRulesetRuntimeController = Object.freeze({
        create: create
    });
})(typeof window !== "undefined" ? window : globalThis);

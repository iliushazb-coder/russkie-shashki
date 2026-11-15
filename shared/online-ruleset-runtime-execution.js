(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeController) {
        throw new Error("OnlineRulesetRuntimeController must load before OnlineRulesetRuntimeExecution");
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

    function attempt(room, fromRow, fromCol, toRow, toCol, color) {
        // Route and execute from one materialized source snapshot. The original
        // hostile room must never be re-read after the controller decision.
        const roomSnapshot = snapshotObject(room);
        const runtime = global.OnlineRulesetRuntimeController.create(roomSnapshot);

        if (runtime.mode === "legacy_russian_runtime") {
            if (runtime.ruleset !== "russian" || runtime.controller !== null) {
                throw new Error("invalid_russian_online_runtime_controller");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                room: null
            });
        }

        if (runtime.mode !== "italian_runtime_controller" ||
            runtime.ruleset !== "italian" ||
            !runtime.controller ||
            runtime.controller.ruleset !== "italian" ||
            typeof runtime.controller.transactionCallback !== "function") {
            throw new Error("invalid_italian_online_runtime_controller");
        }

        const nextRoom = runtime.controller.transactionCallback(
            roomSnapshot, fromRow, fromCol, toRow, toCol, color
        );

        if (nextRoom === undefined) return null;

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_runtime_execution",
            room: nextRoom
        });
    }

    global.OnlineRulesetRuntimeExecution = Object.freeze({
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeController || !global.OnlineRulesetRuntimeExecution) {
        throw new Error("OnlineRulesetRuntimeController and OnlineRulesetRuntimeExecution must load before OnlineRulesetRuntimeTransactionAdapter");
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

    function create(room, fromRow, fromCol, toRow, toCol, color) {
        // Gate callback creation from one materialized source snapshot. This is
        // only a route decision; no move is executed until Firebase supplies
        // the authoritative current room to the returned callback.
        const roomSnapshot = snapshotObject(room);
        const runtime = global.OnlineRulesetRuntimeController.create(roomSnapshot);

        if (runtime.mode === "legacy_russian_runtime") {
            if (runtime.ruleset !== "russian" || runtime.controller !== null) {
                throw new Error("invalid_russian_online_runtime_controller");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                transactionCallback: null
            });
        }

        if (runtime.mode !== "italian_runtime_controller" ||
            runtime.ruleset !== "italian" ||
            !runtime.controller ||
            runtime.controller.ruleset !== "italian") {
            throw new Error("invalid_italian_online_runtime_controller");
        }

        const transactionCallback = function (currentRoom) {
            // Firebase may invoke a transaction callback with null when the
            // target room does not exist yet / was deleted. Treat that as a
            // normal fail-closed abort, not as an exceptional malformed-room
            // path. Other malformed non-null shapes still go through the
            // execution boundary and fail closed there.
            if (currentRoom == null) return undefined;

            const execution = global.OnlineRulesetRuntimeExecution.attempt(
                currentRoom, fromRow, fromCol, toRow, toCol, color
            );

            if (execution === null) return undefined;

            if (execution.mode === "legacy_russian_runtime") {
                if (execution.ruleset !== "russian" || execution.room !== null) {
                    throw new Error("invalid_russian_online_runtime_execution");
                }
                return undefined;
            }

            if (execution.mode !== "italian_runtime_execution" ||
                execution.ruleset !== "italian" ||
                !execution.room ||
                typeof execution.room !== "object") {
                throw new Error("invalid_italian_online_runtime_execution");
            }

            return execution.room;
        };

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_transaction_adapter",
            transactionCallback: transactionCallback
        });
    }

    global.OnlineRulesetRuntimeTransactionAdapter = Object.freeze({
        create: create
    });
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeTransactionAdapter) {
        throw new Error("OnlineRulesetRuntimeTransactionAdapter must load before OnlineRulesetRuntimeTransactionInvoker");
    }

    function invoke(room, fromRow, fromCol, toRow, toCol, color, transactionFn) {
        const route = global.OnlineRulesetRuntimeTransactionAdapter.create(
            room, fromRow, fromCol, toRow, toCol, color
        );

        if (route.mode === "legacy_russian_runtime") {
            if (route.ruleset !== "russian" || route.transactionCallback !== null) {
                throw new Error("invalid_russian_online_runtime_transaction_adapter");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                result: null
            });
        }

        if (route.mode !== "italian_transaction_adapter" ||
            route.ruleset !== "italian" ||
            typeof route.transactionCallback !== "function") {
            throw new Error("invalid_italian_online_runtime_transaction_adapter");
        }

        if (typeof transactionFn !== "function") {
            throw new Error("invalid_online_transaction_function");
        }

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_transaction_invocation",
            result: transactionFn(route.transactionCallback)
        });
    }

    global.OnlineRulesetRuntimeTransactionInvoker = Object.freeze({
        invoke: invoke
    });
})(typeof window !== "undefined" ? window : globalThis);

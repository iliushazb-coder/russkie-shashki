(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeTransactionInvoker) {
        throw new Error("OnlineRulesetRuntimeTransactionInvoker must load before OnlineRulesetRuntimeTransactionTransport");
    }

    function submit(room, fromRow, fromCol, toRow, toCol, color, transactionTarget) {
        return global.OnlineRulesetRuntimeTransactionInvoker.invoke(
            room, fromRow, fromCol, toRow, toCol, color,
            function (transactionCallback) {
                if (!transactionTarget) {
                    throw new Error("invalid_online_transaction_target");
                }
                const transaction = transactionTarget.transaction;
                if (typeof transaction !== "function") {
                    throw new Error("invalid_online_transaction_target");
                }
                return transaction.call(transactionTarget, transactionCallback);
            }
        );
    }

    global.OnlineRulesetRuntimeTransactionTransport = Object.freeze({
        submit: submit
    });
})(typeof window !== "undefined" ? window : globalThis);

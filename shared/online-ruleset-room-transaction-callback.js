(function (global) {
    "use strict";

    if (!global.OnlineRulesetRoomTransactionPlan) {
        throw new Error("OnlineRulesetRoomTransactionPlan must load before OnlineRulesetRoomTransactionCallback");
    }

    function attempt(room, fromRow, fromCol, toRow, toCol, color) {
        const plan = global.OnlineRulesetRoomTransactionPlan.attempt(
            room, fromRow, fromCol, toRow, toCol, color
        );
        if (!plan) return undefined;

        // Firebase transaction callbacks commit by returning a room and abort by
        // returning undefined. Russian/legacy deliberately abort here: their
        // production callback still owns computeNextDrawState() and must not be
        // replaced by the generic ruleset-aware room.
        if (plan.mode !== "ruleset_room") return undefined;
        if (plan.ruleset !== "italian" || !plan.room) {
            throw new Error("invalid_online_transaction_plan");
        }
        return plan.room;
    }

    global.OnlineRulesetRoomTransactionCallback = Object.freeze({
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

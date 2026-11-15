(function (global) {
    "use strict";

    if (!global.OnlineRulesetRoomMutation) {
        throw new Error("OnlineRulesetRoomMutation must load before OnlineRulesetRoomTransactionPlan");
    }

    function attempt(room, fromRow, fromCol, toRow, toCol, color) {
        const moved = global.OnlineRulesetRoomMutation.attempt(
            room, fromRow, fromCol, toRow, toCol, color
        );
        if (!moved) return null;

        // Russian online gameplay still owns legacy draw/lifecycle bookkeeping
        // in script.js. Do not expose a directly writable room for that path:
        // doing so would silently bypass computeNextDrawState().
        const writableRoom = moved.ruleset === "italian" ? moved.room : null;
        const mode = moved.ruleset === "italian"
            ? "ruleset_room"
            : "legacy_russian_draw_required";

        return Object.freeze({
            ruleset: moved.ruleset,
            mode: mode,
            room: writableRoom,
            state: moved.state,
            transition: moved.transition
        });
    }

    global.OnlineRulesetRoomTransactionPlan = Object.freeze({
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

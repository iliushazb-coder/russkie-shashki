(function (global) {
    "use strict";

    if (!global.OnlineRulesetRoomPresentation || !global.OnlineRulesetRoomSnapshot) {
        throw new Error("OnlineRulesetRoomPresentation and OnlineRulesetRoomSnapshot must load before OnlineRulesetRoomRuntime");
    }

    function attempt(room, fromRow, fromCol, toRow, toCol, color) {
        const moved = global.OnlineRulesetRoomPresentation.attempt(
            room, fromRow, fromCol, toRow, toCol, color
        );
        if (!moved) return null;

        const projected = global.OnlineRulesetRoomSnapshot.project(moved.room);
        if (projected.ruleset !== moved.ruleset) {
            throw new Error("online_ruleset_runtime_mismatch");
        }

        return Object.freeze({
            ruleset: moved.ruleset,
            room: moved.room,
            state: projected.state,
            transition: moved.transition
        });
    }

    global.OnlineRulesetRoomRuntime = Object.freeze({
        project: global.OnlineRulesetRoomSnapshot.project,
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

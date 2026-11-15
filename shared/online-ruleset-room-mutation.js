(function (global) {
    "use strict";

    if (!global.OnlineRulesetRoomRuntime) {
        throw new Error("OnlineRulesetRoomRuntime must load before OnlineRulesetRoomMutation");
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
        const roomSnapshot = snapshotObject(room);

        // Match the existing Firebase whole-room transaction gate: once a
        // normal or technical result exists, gameplay mutation is closed.
        // The guard and the move both consume this one materialized snapshot,
        // so hostile accessors cannot change the decision between check/use.
        if (roomSnapshot.winner || roomSnapshot.result) return null;

        return global.OnlineRulesetRoomRuntime.attempt(
            roomSnapshot, fromRow, fromCol, toRow, toCol, color
        );
    }

    global.OnlineRulesetRoomMutation = Object.freeze({
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

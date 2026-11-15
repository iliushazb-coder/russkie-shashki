(function (global) {
    "use strict";

    if (!global.OnlineRulesetMove || !global.OnlineRulesetState) {
        throw new Error("OnlineRulesetMove and OnlineRulesetState must load before OnlineRulesetRoomMove");
    }

    // Snapshot the untrusted room exactly once before any ruleset-dependent
    // validation or move logic. This keeps getter/accessor values stable across
    // the whole room -> move -> room transition and skips __proto__ as data.
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
        const moved = global.OnlineRulesetMove.attempt(
            roomSnapshot, fromRow, fromCol, toRow, toCol, color
        );
        if (!moved) return null;

        const nextRoom = global.OnlineRulesetState.applyGameState(roomSnapshot, moved.state);
        return Object.freeze({
            ruleset: moved.ruleset,
            room: nextRoom,
            transition: moved.transition
        });
    }

    global.OnlineRulesetRoomMove = Object.freeze({
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

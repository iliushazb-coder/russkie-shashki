(function (global) {
    "use strict";

    if (!global.OnlineRulesetRoomMove) {
        throw new Error("OnlineRulesetRoomMove must load before OnlineRulesetRoomPresentation");
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
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

    function safePoint(value) {
        if (!value || typeof value !== "object") return null;
        if (!Number.isInteger(value.row) || !Number.isInteger(value.col)) return null;
        return { row: value.row, col: value.col };
    }

    function attempt(room, fromRow, fromCol, toRow, toCol, color) {
        const roomSnapshot = snapshotObject(room);
        const moved = global.OnlineRulesetRoomMove.attempt(
            roomSnapshot, fromRow, fromCol, toRow, toCol, color
        );
        if (!moved) return null;

        const transition = moved.transition || {};
        const from = safePoint(transition.from);
        const to = safePoint(transition.to);
        if (!from || !to) throw new Error("invalid_online_move_transition");

        const continuing = !!roomSnapshot.mustContinueFrom;
        const priorPath = continuing && Array.isArray(roomSnapshot.lastMovePath)
            ? clone(roomSnapshot.lastMovePath)
            : [from];
        priorPath.push(to);

        const priorCaptured = continuing && Array.isArray(roomSnapshot.lastCapturedSquares)
            ? clone(roomSnapshot.lastCapturedSquares)
            : [];
        const captured = Array.isArray(transition.capturedSquares)
            ? clone(transition.capturedSquares)
            : [];

        const nextRoom = Object.assign({}, moved.room, {
            lastMove: { from: from, to: to },
            lastMovePath: priorPath,
            lastCapturedSquares: priorCaptured.concat(captured),
            moveType: transition.promoted
                ? "king"
                : (transition.capture ? "capture" : "move")
        });

        return Object.freeze({
            ruleset: moved.ruleset,
            room: nextRoom,
            transition: moved.transition
        });
    }

    global.OnlineRulesetRoomPresentation = Object.freeze({
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

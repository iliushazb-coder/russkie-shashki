(function (global) {
    "use strict";

    if (!global.OnlineRulesetState) {
        throw new Error("OnlineRulesetState must load before OnlineRulesetRoomSnapshot");
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

    function point(value) {
        if (!value || typeof value !== "object") return null;
        if (!Number.isInteger(value.row) || value.row < 0 || value.row > 7) return null;
        if (!Number.isInteger(value.col) || value.col < 0 || value.col > 7) return null;
        return { row: value.row, col: value.col };
    }

    function pointList(value) {
        if (value == null) return null;
        if (!Array.isArray(value)) return null;
        const out = [];
        for (let i = 0; i < value.length; i++) {
            const normalized = point(value[i]);
            if (!normalized) return null;
            out.push(normalized);
        }
        return out;
    }

    function lastMove(value) {
        if (value == null) return null;
        if (!value || typeof value !== "object") return null;
        const from = point(value.from);
        const to = point(value.to);
        return from && to ? { from: from, to: to } : null;
    }

    function moveType(value) {
        return value === "move" || value === "capture" || value === "king" ? value : null;
    }

    function detachedObject(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return null;
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (_error) {
            return null;
        }
    }

    function nonNegativeInteger(value) {
        return Number.isInteger(value) && value >= 0 ? value : 0;
    }

    function positiveNumberOrNull(value) {
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
    }

    function project(room) {
        const roomSnapshot = snapshotObject(room);
        const projected = global.OnlineRulesetState.projectRoom(roomSnapshot);
        const state = projected.state;

        return Object.freeze({
            ruleset: projected.ruleset,
            state: Object.assign({}, state, {
                lastMove: lastMove(roomSnapshot.lastMove),
                lastMovePath: pointList(roomSnapshot.lastMovePath),
                lastCapturedSquares: pointList(roomSnapshot.lastCapturedSquares),
                moveType: moveType(roomSnapshot.moveType),
                // Keep the authoritative engine state detached while carrying only
                // the room metadata needed by the already-audited presentation
                // surface. These values are presentation-only; move execution
                // continues to consume the validated ruleset state above.
                players: detachedObject(roomSnapshot.players),
                presence: detachedObject(roomSnapshot.presence),
                ratingsAtStart: detachedObject(roomSnapshot.ratingsAtStart),
                matchNumber: nonNegativeInteger(roomSnapshot.matchNumber),
                timeControlSeconds: nonNegativeInteger(roomSnapshot.timeControlSeconds),
                turnStartedAt: positiveNumberOrNull(roomSnapshot.turnStartedAt)
            })
        });
    }

    global.OnlineRulesetRoomSnapshot = Object.freeze({
        project: project
    });
})(typeof window !== "undefined" ? window : globalThis);

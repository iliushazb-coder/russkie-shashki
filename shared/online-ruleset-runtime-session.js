(function (global) {
    "use strict";

    if (!global.OnlineRulesetRuntimeEntry || !global.OnlineRulesetRoomSnapshot) {
        throw new Error("OnlineRulesetRuntimeEntry and OnlineRulesetRoomSnapshot must load before OnlineRulesetRuntimeSession");
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

    function create(room) {
        // Materialize hostile input exactly once at this boundary. Both the
        // routing decision and the projected session state must consume this
        // same snapshot; otherwise accessors could change ruleset/state between
        // OnlineRulesetRuntimeEntry.resolve() and RoomSnapshot.project().
        const roomSnapshot = snapshotObject(room);
        const entry = global.OnlineRulesetRuntimeEntry.resolve(roomSnapshot);

        if (entry.mode === "legacy_russian_runtime") {
            if (entry.ruleset !== "russian" || entry.runtimeEntry !== null) {
                throw new Error("invalid_russian_online_runtime_entry");
            }
            return Object.freeze({
                ruleset: "russian",
                mode: "legacy_russian_runtime",
                session: null
            });
        }

        if (entry.mode !== "italian_runtime_required" ||
            entry.ruleset !== "italian" ||
            entry.runtimeEntry !== null) {
            throw new Error("invalid_italian_online_runtime_entry");
        }

        const projected = global.OnlineRulesetRoomSnapshot.project(roomSnapshot);
        if (projected.ruleset !== "italian") {
            throw new Error("italian_online_runtime_session_mismatch");
        }

        return Object.freeze({
            ruleset: "italian",
            mode: "italian_runtime_session",
            session: Object.freeze({
                ruleset: "italian",
                state: Object.freeze(projected.state)
            })
        });
    }

    global.OnlineRulesetRuntimeSession = Object.freeze({
        create: create
    });
})(typeof window !== "undefined" ? window : globalThis);

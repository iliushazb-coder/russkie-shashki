(function (global) {
    "use strict";

    if (!global.OnlineRulesetMoveEntry) throw new Error("OnlineRulesetMoveEntry must load before OnlineRulesetMoveSource");

    function capture(room) {
        const entry = global.OnlineRulesetMoveEntry.resolve(room);
        if (entry.mode === "legacy_russian_move_path") {
            if (entry.ruleset !== "russian" || entry.optimisticState !== null || entry.transactionTransport !== null) throw new Error("invalid_russian_online_move_source");
            return Object.freeze({ ruleset: "russian", mode: "legacy_russian_move_source", source: null, transactionTransport: null });
        }
        if (entry.mode !== "italian_runtime_required" || entry.ruleset !== "italian" || !entry.optimisticState || entry.transactionTransport !== null) throw new Error("invalid_italian_online_move_source");
        return Object.freeze({
            ruleset: "italian",
            mode: "italian_move_source",
            source: Object.freeze({ ruleset: "italian", state: entry.optimisticState }),
            transactionTransport: null
        });
    }

    global.OnlineRulesetMoveSource = Object.freeze({ capture: capture });
})(typeof window !== "undefined" ? window : globalThis);

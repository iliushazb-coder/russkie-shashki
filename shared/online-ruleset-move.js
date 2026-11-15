(function (global) {
    "use strict";

    if (!global.OnlineRulesetState) {
        throw new Error("OnlineRulesetState must load before OnlineRulesetMove");
    }
    if (!global.LocalRulesetAdapter) {
        throw new Error("LocalRulesetAdapter must load before OnlineRulesetMove");
    }

    function attempt(room, fromRow, fromCol, toRow, toCol, color) {
        const projected = global.OnlineRulesetState.projectRoom(room);
        const ruleset = projected.ruleset;
        const state = projected.state;
        const adapter = global.LocalRulesetAdapter.get(ruleset);
        const result = adapter.attemptMove(state, fromRow, fromCol, toRow, toCol, color);

        if (!result || !result.ok) return null;

        return Object.freeze({
            ruleset: ruleset,
            state: result.state,
            transition: result.transition
        });
    }

    global.OnlineRulesetMove = Object.freeze({
        attempt: attempt
    });
})(typeof window !== "undefined" ? window : globalThis);

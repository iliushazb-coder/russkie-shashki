(function (global) {
    "use strict";

    // Ruleset foundation. Keep the proven Russian engine untouched and route
    // every variant through one small registry. Future engines register here;
    // callers must never silently reinterpret an explicit unknown ruleset.
    const LEGACY_DEFAULT_RULESET = "russian";
    const engines = Object.create(null);

    function assertEngineContract(id, engine) {
        if (!engine || typeof engine.attemptMove !== "function" ||
            typeof engine.createInitialPieces !== "function" ||
            typeof engine.hasAnyLegalMove !== "function") {
            throw new Error("invalid_ruleset_engine:" + id);
        }
    }

    function register(id, engine) {
        if (typeof id !== "string" || !id) throw new Error("invalid_ruleset_id");
        assertEngineContract(id, engine);
        if (engines[id]) throw new Error("ruleset_already_registered:" + id);
        engines[id] = engine;
        return engine;
    }

    function normalizeRoomRuleset(value) {
        // Only a genuinely missing legacy value falls back to Russian.
        // Explicit garbage (including empty string) must fail closed.
        if (value === undefined || value === null) return LEGACY_DEFAULT_RULESET;
        if (typeof value !== "string" || !engines[value]) {
            throw new Error("unknown_ruleset:" + String(value));
        }
        return value;
    }

    function getEngine(value) {
        return engines[normalizeRoomRuleset(value)];
    }

    function has(id) {
        return typeof id === "string" && !!engines[id];
    }

    if (!global.RussianCheckersEngine) {
        throw new Error("RussianCheckersEngine must load before RulesetRegistry");
    }
    register("russian", global.RussianCheckersEngine);

    global.CheckersRulesetRegistry = Object.freeze({
        LEGACY_DEFAULT_RULESET: LEGACY_DEFAULT_RULESET,
        register: register,
        normalizeRoomRuleset: normalizeRoomRuleset,
        getEngine: getEngine,
        has: has
    });
})(typeof globalThis !== "undefined" ? globalThis : window);

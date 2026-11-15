(function (global) {
    "use strict";

    if (!global.OnlineRulesetMoveSourceStore) throw new Error("OnlineRulesetMoveSourceStore must load before OnlineRulesetMoveSourceLifecycle");

    function create() {
        const store = global.OnlineRulesetMoveSourceStore.create();
        let generation = 0;
        let currentToken = null;

        function begin() {
            generation++;
            store.clear();
            currentToken = Object.freeze({ generation: generation });
            return currentToken;
        }

        function isCurrent(token) {
            return token === currentToken;
        }

        function replace(token, captured) {
            if (!isCurrent(token)) return null;
            return store.replace(captured);
        }

        function get(token) {
            if (!isCurrent(token)) return null;
            return store.get();
        }

        function clear() {
            generation++;
            currentToken = null;
            store.clear();
        }

        return Object.freeze({
            begin: begin,
            replace: replace,
            get: get,
            clear: clear
        });
    }

    global.OnlineRulesetMoveSourceLifecycle = Object.freeze({ create: create });
})(typeof window !== "undefined" ? window : globalThis);

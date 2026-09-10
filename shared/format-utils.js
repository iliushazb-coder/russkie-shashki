(function (global) {
    "use strict";

    // №43 slice 3: механически перенесено из script.js без логических
    // изменений -- то же поведение. Тот же паттерн, что shared/game-engine.js
    // (№22), shared/string-utils.js (slice 1) и shared/audio-effects.js
    // (slice 2).

    function formatTime(seconds) {
        const s = Math.max(0, Math.ceil(seconds));
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return m + ":" + (rem < 10 ? "0" : "") + rem;
    }

    const api = {
        formatTime,
    };

    global.RussianCheckersFormatUtils = api;

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);

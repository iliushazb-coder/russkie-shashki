(function (global) {
    "use strict";

    // №43: механически перенесено из script.js без логических изменений --
    // те же условия, то же поведение. Первый slice постепенной модульности
    // (frozen plan): выносим по одному модулю под существующими тестами,
    // без big rewrite. Тот же паттерн, что и shared/game-engine.js (№22).

    function escapeHtml(name) {
        const chars = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return name.replace(/[&<>"']/g, function (ch) { return chars[ch]; });
    }

    const api = {
        escapeHtml,
    };

    global.RussianCheckersStringUtils = api;

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);

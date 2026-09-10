(function (global) {
    "use strict";

    // №43 slice 4: механически перенесено из script.js без логических
    // изменений -- то же поведение, тот же runtime-паттерн. Тот же
    // паттерн, что и три предыдущих shared-модуля.
    //
    // review fix: CAPTURED_DEPTH_OPACITY остаётся module-level const
    // (создаётся ровно один раз, при загрузке модуля), как и в исходном
    // script.js -- не встроена внутрь тела функции. Первая версия этого
    // кандидата встраивала literal-массив внутрь capturedDepthOpacity(),
    // рассуждая, что раз константа нигде больше не используется, это
    // минимальный diff -- но это меняло runtime-паттерн: массив стал бы
    // аллоцироваться заново на КАЖДЫЙ вызов вместо одного раза за всё
    // время жизни модуля. Числовой результат совпадал, но это не то же
    // самое поведение. Здесь та же приватная (не экспортируемая) форма
    // module-level константы, что уже используется в
    // shared/audio-effects.js для internal-only playTone/playWoodKnock --
    // публичный API остаётся ровно { capturedDepthOpacity }, константа не
    // экспортируется.

    // Глубина стопки: передняя шашка чёткая, дальние уходят назад.
    // Дальше четвёртой не бледнеем, иначе стопка выглядит грязной.
    const CAPTURED_DEPTH_OPACITY = [1, 0.82, 0.66, 0.52, 0.45];

    function capturedDepthOpacity(fromFront) {
        const i = Math.min(fromFront, CAPTURED_DEPTH_OPACITY.length - 1);
        return CAPTURED_DEPTH_OPACITY[i];
    }

    const api = {
        capturedDepthOpacity,
    };

    global.RussianCheckersCapturedStackUtils = api;

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);

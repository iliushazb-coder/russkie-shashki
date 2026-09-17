(function (global) {
    "use strict";

    // №43 slice 5: механически перенесено из script.js -- то же поведение,
    // тот же паттерн, что и четыре предыдущих shared-модуля. Нет side
    // effect'ов при загрузке модуля -- все три функции только объявляются
    // и экспортируются, ни одна не вызывается здесь.

    function hideStartupCover() {
        const cover = document.getElementById("startup-cover");
        if (cover) cover.classList.add("hidden");
    }

    // Парная к hideStartupCover(). Нужна, чтобы кнопки меню, которые ждут
    // завершения входа, давали мгновенную реакцию: снятие класса -- операция
    // синхронная, она происходит в том же кадре, что и клик, ДО первого
    // await, поэтому пользователь видит отклик сразу, а не через паузу.
    //
    // Второй оверлей намеренно НЕ заводится: #startup-cover уже даёт
    // полупрозрачный слой, размытие фона (с -webkit- префиксом, то есть
    // работает на iOS), центрированный спиннер, safe-area и обработку
    // prefers-reduced-motion.
    //
    // Класс invite-launch-hint снимается здесь намеренно. Он живёт на
    // <html> с момента запуска по invite-ссылке и переключает текст на
    // «Подключение к столу…». Для кнопок меню это неуместно, нужен
    // нейтральный «Загрузка…». На сам invite-flow это не влияет: к моменту,
    // когда пользователь может нажать кнопку меню, стартовый cover уже
    // скрыт и своё дело сделал.
    function showStartupCover() {
        const cover = document.getElementById("startup-cover");
        if (!cover) return;
        const root = global.document && global.document.documentElement;
        if (root && root.classList) root.classList.remove("invite-launch-hint");
        cover.classList.remove("hidden");
    }

    // review fix: исходное тело script.js смешивало "window.Telegram" (первая
    // проверка) и голый "Telegram" (остальные три) -- в браузере это работает
    // одинаково (window === globalThis, bare-идентификатор резолвится через
    // global scope), но в Node голый "Telegram"/непроверенный "window" не
    // резолвится вовсе. Тот же класс адаптации, что уже сделан для
    // AudioContext в shared/audio-effects.js: единственная, последовательная
    // ссылка на "global.Telegram" (параметр этой самой IIFE, которому ниже
    // передаётся globalThis) -- поведение идентично в браузере, но модуль
    // становится тестируемым в Node без двойного стаба window+bare-global.
    //
    // Тот же прочитываемый признак, что использует checkForInviteLink() в
    // script.js — намеренно НЕ переиспользуем classList "invite-launch-hint"
    // из <head>: тот читается раньше и предназначен только для выбора
    // текста, здесь нужно самостоятельное, более позднее чтение для
    // функционального решения.
    function hasInviteIntent() {
        return !!(global.Telegram &&
            global.Telegram.WebApp &&
            global.Telegram.WebApp.initDataUnsafe &&
            global.Telegram.WebApp.initDataUnsafe.start_param);
    }

    // Late-detected invite: ранний <head>-hint мог не увидеть start_param (та
    // же причина, по которой у authenticateTelegramUser() есть защитная
    // пауза), но к этому моменту (после тех же 100мс) hasInviteIntent() уже
    // надёжен. Если early hint промахнулся, cover должен ДОГНАТЬ правильный
    // текст, а не остаться на нейтральном "Загрузка…" на весь auth+join
    // lifecycle. Переключаем ТОТ ЖЕ класс, что и early hint (идемпотентно —
    // если он уже стоит, действие не требуется), а не заводим отдельный
    // CSS-путь.
    function markStartupCoverAsInvite() {
        document.documentElement.classList.add("invite-launch-hint");
    }

    const api = {
        hideStartupCover,
        showStartupCover,
        hasInviteIntent,
        markStartupCoverAsInvite,
    };

    global.RussianCheckersStartupCoverUtils = api;

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);

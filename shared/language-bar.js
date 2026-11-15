// Переключатель языка главного меню (STEP D): кнопка #lang-toggle (флаг текущего языка + стрелка) в правом верхнем углу и выпадающий
// список #lang-menu с тремя кнопками .lang-btn[data-lang].
//
// ЭТОТ МОДУЛЬ ТОЛЬКО ОТКРЫВАЕТ / ЗАКРЫВАЕТ СПИСОК и показывает на кнопке флаг текущего языка. Выбор языка, localStorage, перевод интерфейса,
// подсветка .active и aria-pressed -- по-прежнему в script.js (обработчик click на каждом .lang-btn и applyTranslationsToDOM); модуль
// ничего про язык, правила, Firebase, Worker и карусель не знает и язык сам не меняет.
//   * закрытие: выбор языка, нажатие/касание вне списка, Escape (фокус возвращается на кнопку), уход фокуса Tab-ом, поворот/изменение размера;
//   * клавиатура: Enter/Space на кнопке открывает (фокус на текущий язык), стрелки вверх/вниз, Home/End ходят по пунктам; стрелки влево/вправо
//     внутри списка не листают верхнюю карусель (событие помечается обработанным);
//   * текущий язык берётся из того, что уже поставил script.js: у пункта .lang-btn.active (MutationObserver) -- флаг и подпись кнопки.
(function (global) {
  "use strict";

  function init(root) {
    if (!root || !root.addEventListener || root.getAttribute("data-lang-dd") === "1") return false;
    const toggle = root.querySelector(".lang-toggle"), menu = root.querySelector(".lang-menu");
    if (!toggle || !menu) return false;
    root.setAttribute("data-lang-dd", "1");
    const items = Array.prototype.slice.call(menu.querySelectorAll(".lang-btn"));
    const flag = toggle.querySelector(".lang-flag");

    function isOpen() { return !menu.hidden; }
    function active() { return menu.querySelector(".lang-btn.active") || items[0] || null; }

    // Флаг и подпись кнопки = текущий язык (из .active, который выставил script.js).
    function sync() {
      const a = active();
      if (!a) return;
      const src = a.querySelector(".lang-flag"), code = src && src.getAttribute("data-flag-icon");
      if (flag && code) {
        flag.setAttribute("data-flag-icon", code);
        const svg = global.FlagIcons && global.FlagIcons.svg ? global.FlagIcons.svg(code) : "";
        if (svg) flag.innerHTML = svg; else flag.textContent = (a.getAttribute("data-lang") || "").toUpperCase();
      }
      const name = a.querySelector(".lang-name");
      if (name && name.textContent.trim()) toggle.setAttribute("aria-label", name.textContent.trim());
    }

    function open() {
      if (isOpen()) return;
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      const a = active();
      if (a && a.focus) { try { a.focus({ preventScroll: true }); } catch (e) { a.focus(); } }
    }
    function close(returnFocus) {
      if (!isOpen()) return;
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      if (returnFocus && toggle.focus) { try { toggle.focus({ preventScroll: true }); } catch (e) { toggle.focus(); } }
    }

    toggle.addEventListener("click", function () { if (isOpen()) close(true); else open(); });
    // Выбор языка: сам выбор уже сделал обработчик на кнопке (script.js, он стоит раньше по цепочке); здесь только закрываем список.
    menu.addEventListener("click", function (e) {
      const b = e.target && e.target.closest ? e.target.closest(".lang-btn") : null;
      if (b) close(true);
    });
    // Нажатие/касание вне переключателя.
    global.document.addEventListener("pointerdown", function (e) {
      if (isOpen() && !root.contains(e.target)) close(false);
    }, true);
    root.addEventListener("focusout", function (e) {
      if (isOpen() && e.relatedTarget && !root.contains(e.relatedTarget)) close(false);
    });
    root.addEventListener("keydown", function (e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key;
      if (k === "Escape" && isOpen()) { e.preventDefault(); close(true); return; }
      if (k === "ArrowDown" && !isOpen() && e.target === toggle) { e.preventDefault(); open(); return; }
      if (!isOpen() || items.indexOf(e.target) < 0) return;
      const i = items.indexOf(e.target);
      let to = -1;
      if (k === "ArrowDown") to = (i + 1) % items.length;
      else if (k === "ArrowUp") to = (i - 1 + items.length) % items.length;
      else if (k === "Home") to = 0;
      else if (k === "End") to = items.length - 1;
      else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); return; }   // не листать верхнюю карусель
      if (to >= 0) { e.preventDefault(); items[to].focus(); }
    });
    global.addEventListener("resize", function () { close(false); });
    if (global.MutationObserver) {
      try { new global.MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ["class", "aria-pressed"], subtree: true }); } catch (e) {}
    }
    sync();
    return true;
  }

  function start() { init(global.document && global.document.getElementById("lang-dd")); }

  const api = Object.freeze({ init: init });
  global.LanguageBar = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (global.document) {
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", start);
    else start();
  }
})(typeof window !== "undefined" ? window : globalThis);

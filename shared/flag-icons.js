// Флаги стран -- простые инлайн-SVG (не emoji: emoji-флаги на Windows показываются буквами «RU», «IT»; SVG выглядит одинаково везде).
// ТОЛЬКО КАРТИНКИ: модуль ничего не знает про меню, игру, Firebase и язык. В SVG нет id / url(#...), поэтому один и тот же флаг
// можно безопасно вставлять в страницу много раз.
//   FlagIcons.svg(code)    -- строка <svg> флага страны (90×60 или своя пропорция; для «мини»-флагов 30×20); "" если кода нет;
//   FlagIcons.mini(code)   -- мини-версия (30×20) для кодов, у которых она есть; иначе "";
//   FlagIcons.has(code)    -- нарисован ли флаг;
//   FlagIcons.render(root) -- вставляет флаг в каждый элемент [data-flag-icon="КОД"] внутри root (по умолчанию -- весь документ).
// Картинки перенесены из shared/main-menu-carousel.js БЕЗ изменений (проверяет tests/flag-icons.test.js).
(function (global) {
  "use strict";

  const SVG_OPEN = '<svg viewBox="0 0 90 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true">';
  // Мини-флаги (30×20) для спутников круга «Русские шашки».
  const MINI = {
    RU: '<rect width="30" height="20" fill="#fff"/><rect y="6.7" width="30" height="6.7" fill="#1c57a5"/><rect y="13.3" width="30" height="6.7" fill="#d52b1e"/>',
    UA: '<rect width="30" height="10" fill="#0057b7"/><rect y="10" width="30" height="10" fill="#ffd700"/>',
    BY: '<rect width="30" height="20" fill="#cf101a"/><rect y="13.4" width="30" height="6.6" fill="#007c30"/><rect width="4" height="20" fill="#fff"/><path d="M0 3h4M0 8h4M0 13h4M0 18h4" stroke="#cf101a" stroke-width="1.6"/>',
    KZ: '<rect width="30" height="20" fill="#00afca"/><circle cx="15" cy="9" r="4.2" fill="#fec50c"/><path d="M5 16.2h20" stroke="#fec50c" stroke-width="1.6"/>',
    UZ: '<rect width="30" height="20" fill="#fff"/><rect width="30" height="6.3" fill="#0099b5"/><rect y="13.7" width="30" height="6.3" fill="#1eb53a"/><rect y="6.3" width="30" height="1" fill="#ce1126"/><rect y="12.7" width="30" height="1" fill="#ce1126"/><circle cx="6" cy="3.2" r="1.9" fill="#fff"/><circle cx="6.8" cy="3.2" r="1.7" fill="#0099b5"/>',
    MD: '<rect width="10" height="20" fill="#0046ae"/><rect x="10" width="10" height="20" fill="#ffd200"/><rect x="20" width="10" height="20" fill="#cc092f"/><circle cx="15" cy="10" r="2.4" fill="#a8703a"/>',
    KG: '<rect width="30" height="20" fill="#e8112d"/><polygon points="' + Array.from({ length: 80 }, function (_, k) { const a = -Math.PI / 2 + k * Math.PI / 40, r = k % 2 ? 5.3 : 6.4; return (15 + r * Math.cos(a)).toFixed(2) + "," + (10 + r * Math.sin(a)).toFixed(2); }).join(" ") + '" fill="#ffef00"/><circle cx="15" cy="10" r="3.7" fill="#e8112d"/><path d="M12.4 8.6q2.6-1.6 5.2 0M12.4 10q2.6-1.6 5.2 0M12.4 11.4q2.6-1.6 5.2 0" stroke="#ffef00" stroke-width=".55" fill="none"/>'
  };
  // Полные флаги (90×60 или своя пропорция) для круга одной страны и для половинок парных кругов.
  const FULL = {
    IT: SVG_OPEN + '<rect width="90" height="60" fill="#fff"/><rect width="30" height="60" fill="#009246"/><rect x="60" width="30" height="60" fill="#ce2b37"/></svg>',
    US: SVG_OPEN + '<rect width="90" height="60" fill="#fff"/>' +
      [0, 1, 2, 3, 4, 5, 6].map(function (i) { return '<rect y="' + (i * 2 * 60 / 13).toFixed(2) + '" width="90" height="' + (60 / 13).toFixed(2) + '" fill="#b22234"/>'; }).join("") +
      '<rect width="40" height="32.3" fill="#3c3b6e"/>' +
      [0, 1, 2, 3].map(function (r) { return [0, 1, 2, 3, 4].map(function (c) { return '<circle cx="' + (4.5 + c * 7.8 + (r % 2 ? 3.9 : 0)).toFixed(1) + '" cy="' + (4.6 + r * 7.8).toFixed(1) + '" r="1.5" fill="#fff"/>'; }).join(""); }).join("") + '</svg>',
    BR: SVG_OPEN + '<rect width="90" height="60" fill="#009b3a"/><polygon points="45,6 84,30 45,54 6,30" fill="#fedf00"/><circle cx="45" cy="30" r="13" fill="#002776"/><path d="M33 28.5c9-3 18-1.5 24 4" stroke="#fff" stroke-width="2.4" fill="none"/></svg>',
    TR: SVG_OPEN + '<rect width="90" height="60" fill="#e30a17"/><circle cx="34" cy="30" r="15" fill="#fff"/><circle cx="39" cy="30" r="12" fill="#e30a17"/><polygon points="51.7,30.0 57.0,28.2 57.1,22.6 60.5,27.1 65.8,25.4 62.6,30.0 65.8,34.6 60.5,32.9 57.1,37.4 57.0,31.8" fill="#fff"/></svg>',
    ES: SVG_OPEN + '<rect width="90" height="60" fill="#c60b1e"/><rect y="15" width="90" height="30" fill="#ffc400"/></svg>',
    GB: '<svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="60" height="30" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#c8102e" stroke-width="2.6"/><path d="M30,0 V30 M0,15 H60" stroke="#fff" stroke-width="10"/><path d="M30,0 V30 M0,15 H60" stroke="#c8102e" stroke-width="6"/></svg>',
    // Португалия: зелёное древко (2/5) и красное поле (3/5); на стыке жёлтая армиллярная сфера с белым щитом (упрощённо).
    PT: SVG_OPEN + '<rect width="90" height="60" fill="#ff0000"/><rect width="36" height="60" fill="#006600"/><circle cx="36" cy="30" r="10.5" fill="#ffcc00"/><circle cx="36" cy="30" r="8.2" fill="#ff0000"/><path d="M31.2 24.4h9.6v7.2c0 3.8-3 5.6-4.8 6.6-1.8-1-4.8-2.8-4.8-6.6z" fill="#fff" stroke="#ffcc00" stroke-width="1.1"/><path d="M33.4 27.4h5.2v3.4c0 1.8-1.4 2.8-2.6 3.4-1.2-.6-2.6-1.6-2.6-3.4z" fill="#0033a0"/></svg>',
    JM: SVG_OPEN + '<rect width="90" height="60" fill="#009b3a"/><polygon points="0,0 45,30 0,60" fill="#000"/><polygon points="90,0 45,30 90,60" fill="#000"/><path d="M0 0L90 60M90 0L0 60" stroke="#fed100" stroke-width="7"/></svg>',
    TH: SVG_OPEN + '<rect width="90" height="60" fill="#a51931"/><rect y="10" width="90" height="40" fill="#f4f5f8"/><rect y="20" width="90" height="20" fill="#2d2a4a"/></svg>',
    CZ: SVG_OPEN + '<rect width="90" height="30" fill="#fff"/><rect y="30" width="90" height="30" fill="#d7141a"/><polygon points="0,0 45,30 0,60" fill="#11457e"/></svg>',
    // Малайзия: 14 полос (красная сверху, чередуются), синий кантон на 8 полос и половину длины, жёлтый полумесяц и 14-лучевая звезда.
    MY: SVG_OPEN + Array.from({ length: 14 }, function (_, i) { return '<rect y="' + (i * 60 / 14).toFixed(2) + '" width="90" height="' + (60 / 14 + 0.05).toFixed(2) + '" fill="' + (i % 2 ? "#fff" : "#cc0001") + '"/>'; }).join("") +
      '<rect width="45" height="' + (8 * 60 / 14).toFixed(2) + '" fill="#010066"/><circle cx="17.5" cy="17.1" r="10.2" fill="#fc0"/><circle cx="21" cy="17.1" r="8.4" fill="#010066"/>' +
      '<polygon points="' + Array.from({ length: 28 }, function (_, k) { const a = -Math.PI / 2 + k * Math.PI / 14, r = k % 2 ? 3.4 : 7; return (32 + r * Math.cos(a)).toFixed(2) + "," + (17.1 + r * Math.sin(a)).toFixed(2); }).join(" ") + '" fill="#fc0"/></svg>'
  };
  function mini(code) { return '<svg viewBox="0 0 30 20" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + MINI[code] + "</svg>"; }
  function flagSvg(code) { return FULL[code] || (MINI[code] ? mini(code) : ""); }

  function miniOf(code) { return typeof code === "string" && Object.prototype.hasOwnProperty.call(MINI, code) ? mini(code) : ""; }
  function svgOf(code) { return typeof code === "string" && (Object.prototype.hasOwnProperty.call(FULL, code) || Object.prototype.hasOwnProperty.call(MINI, code)) ? flagSvg(code) : ""; }
  function has(code) { return svgOf(code) !== ""; }

  // Вставка флагов в размеченные элементы. Содержимое элемента (запасная подпись) заменяется флагом; повторный вызов безопасен.
  function render(root) {
    const doc = global.document;
    const scope = root || doc;
    if (!doc || !scope || !scope.querySelectorAll) return 0;
    let n = 0;
    scope.querySelectorAll("[data-flag-icon]").forEach(function (node) {
      const code = node.getAttribute("data-flag-icon");
      const html = svgOf(code);
      if (!html || node.getAttribute("data-flag-done") === code) return;
      node.innerHTML = html;
      node.setAttribute("data-flag-done", code);
      n++;
    });
    return n;
  }

  const api = Object.freeze({ svg: svgOf, mini: miniOf, has: has, render: render, CODES: Object.freeze(Object.keys(FULL).concat(Object.keys(MINI).filter(function (c) { return !(c in FULL); }))) });
  global.FlagIcons = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // Скрипт стоит в конце <body>: разметка уже разобрана. Если подключён раньше -- дождаться конца разбора.
  if (global.document) {
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", function () { render(); });
    else render();
  }
})(typeof window !== "undefined" ? window : globalThis);

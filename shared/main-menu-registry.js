// Реестр десяти групп шашек 8×8 для главного меню (утверждённый продуктовый список, паспорт v1.4).
//
// ТОЛЬКО ДАННЫЕ. Модуль не знает ни про Firebase, ни про Worker, ни про игровые движки, ни про картинки.
//   * id         -- ключ для текстов (mm_c_<id> / mm_n_<id> / mm_d_<id>) и для data-flag;
//   * ruleset    -- то, что понимает showModeScreen(): только "russian" и "italian"; у остальных null;
//   * available  -- можно ли начать игру. Играбельны ТОЛЬКО русские и итальянские; остальные восемь -- «Скоро»;
//   * flags      -- коды стран, чьи флаги рисуются в круге (первый -- главный). Один круг = одна группа правил;
//   * preliminary-- состав флагов/правил группы предварительный и не подтверждён: правила НЕ считать идентичными
//                   (в карточке показывается пометка), ничего про правила такой группы не утверждается;
//   * board      -- вид миниатюры доски ("classic" -- общая 8×8; "turkish" -- турецкая расстановка).
// Не включены (решение владельца): международные 10×10, канадские 12×12, панамские правила.
(function (global) {
  "use strict";

  function group(g) { g.flags = Object.freeze(g.flags.slice()); return Object.freeze(g); }

  const GROUPS = Object.freeze([
    group({ id: "russian",        ruleset: "russian", available: true,  preliminary: false, board: "classic", flags: ["RU", "UA", "BY", "KZ", "UZ", "MD", "KG"] }),
    group({ id: "italian",        ruleset: "italian", available: true,  preliminary: false, board: "classic", flags: ["IT"] }),
    group({ id: "anglo_american", ruleset: null,      available: false, preliminary: false, board: "classic", flags: ["GB", "US"] }),
    group({ id: "brazilian",      ruleset: null,      available: false, preliminary: false, board: "classic", flags: ["BR"] }),
    group({ id: "turkish",        ruleset: null,      available: false, preliminary: false, board: "turkish", flags: ["TR"] }),
    group({ id: "iberian",        ruleset: null,      available: false, preliminary: true,  board: "classic", flags: ["ES", "PT"] }),
    group({ id: "pool",           ruleset: null,      available: false, preliminary: true,  board: "classic", flags: ["JM", "US"] }),
    group({ id: "thai",           ruleset: null,      available: false, preliminary: false, board: "classic", flags: ["TH"] }),
    group({ id: "czech",          ruleset: null,      available: false, preliminary: false, board: "classic", flags: ["CZ"] }),
    group({ id: "malaysian",      ruleset: null,      available: false, preliminary: true,  board: "classic", flags: ["MY"] })
  ]);

  const api = Object.freeze({ GROUPS: GROUPS, IDS: Object.freeze(GROUPS.map(function (g) { return g.id; })) });
  global.MainMenuRegistry = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

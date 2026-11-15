/* Реестр модулей разновидностей шашек и контракт подключения.
 *
 * Это ОТДЕЛЬНЫЙ реестр. Он не заменяет и не меняет CheckersRulesetRegistry
 * (shared/ruleset-registry.js), на который опираются русские онлайн-пути и Worker:
 * тот реестр сознательно знает только русский (getEngine('italian') бросает unknown_ruleset).
 *
 * Модуль разновидности — один объект:
 *   id         строка, [a-z][a-z0-9_]{1,23}
 *   title      название для разработчика (не пользовательский текст)
 *   boardSize  8 или 10
 *   rules      адаптер правил: createInitialState(), pieceAt(state,r,c), listPieces(state),
 *              attemptMove(state,fr,fc,tr,tc,color) -> {ok,state,transition}, getLegalMoves(state,color)
 *   ai         null (бот живёт вне реестра, как у русских) или
 *              { levels:['easy','medium','hard'], chooseMove(state,color,level,options) -> move|null }
 *   online     null или описание (только данные, ничего не подключает):
 *              { namespace, workerPrefix, invitePrefix }
 *   stats      null или { botNode } (например "statsBotItalian") — только данные
 * Добавление новой страны = новый файл правил + один вызов register(); см. паспорт, раздел 12.
 */
(function (global) {
  'use strict';

  var RULES_METHODS = ['createInitialState', 'pieceAt', 'listPieces', 'attemptMove', 'getLegalMoves'];
  var ID_RE = /^[a-z][a-z0-9_]{1,23}$/;
  var LEVELS = ['easy', 'medium', 'hard'];
  var modules = Object.create(null);

  function isStr(v) { return typeof v === 'string' && v.length > 0; }

  function validate(def) {
    var errors = [];
    if (!def || typeof def !== 'object') return { ok: false, errors: ['module_not_object'] };
    if (!isStr(def.id) || !ID_RE.test(def.id)) errors.push('bad_id');
    if (!isStr(def.title)) errors.push('bad_title');
    if (def.boardSize !== 8 && def.boardSize !== 10) errors.push('bad_board_size');
    if (!def.rules || typeof def.rules !== 'object') {
      errors.push('rules_missing');
    } else {
      RULES_METHODS.forEach(function (name) {
        if (typeof def.rules[name] !== 'function') errors.push('rules_missing_' + name);
      });
    }
    if (def.ai !== null && def.ai !== undefined) {
      if (typeof def.ai.chooseMove !== 'function') errors.push('ai_missing_chooseMove');
      if (!Array.isArray(def.ai.levels) || !def.ai.levels.length ||
          def.ai.levels.some(function (l) { return LEVELS.indexOf(l) < 0; })) {
        errors.push('ai_bad_levels');
      }
    }
    if (def.online) {
      if (!isStr(def.online.namespace)) errors.push('online_bad_namespace');
      if (!isStr(def.online.workerPrefix)) errors.push('online_bad_workerPrefix');
      if (typeof def.online.invitePrefix !== 'string') errors.push('online_bad_invitePrefix');
    }
    if (def.stats && !isStr(def.stats.botNode)) errors.push('stats_bad_botNode');
    return { ok: errors.length === 0, errors: errors };
  }

  function register(def) {
    var check = validate(def);
    if (!check.ok) throw new Error('invalid_ruleset_module:' + check.errors.join(','));
    if (modules[def.id]) throw new Error('duplicate_ruleset_module:' + def.id);
    modules[def.id] = Object.freeze({
      id: def.id,
      title: def.title,
      boardSize: def.boardSize,
      rules: def.rules,
      ai: def.ai || null,
      online: def.online || null,
      stats: def.stats || null
    });
    return modules[def.id];
  }

  function has(id) { return isStr(id) && !!modules[id]; }

  function get(id) {
    if (!has(id)) throw new Error('unknown_ruleset_module:' + String(id));
    return modules[id];
  }

  function list() { return Object.keys(modules).sort(); }

  function chooseBotMove(id, state, color, level, options) {
    var mod = get(id);
    if (!mod.ai) throw new Error('ruleset_module_has_no_ai:' + id);
    if (mod.ai.levels.indexOf(level) < 0) throw new Error('unknown_ai_level:' + String(level));
    return mod.ai.chooseMove(state, color, level, options || {});
  }

  var api = Object.freeze({
    validate: validate,
    register: register,
    has: has,
    get: get,
    list: list,
    chooseBotMove: chooseBotMove,
    LEVELS: Object.freeze(LEVELS.slice())
  });
  global.RulesetModules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* Регистрация встроенных модулей. Чтобы подключить новую разновидность — добавить сюда
 * один register() рядом с файлами её правил (и бота, если он нужен). Русский модуль
 * регистрируется БЕЗ ai: русский бот остаётся в script.js без изменений. */
(function (global) {
  'use strict';
  if (!global.RulesetModules || !global.LocalRulesetAdapter) {
    throw new Error('ruleset_modules_builtin_dependencies_missing');
  }

  global.RulesetModules.register({
    id: 'russian',
    title: 'Russian draughts 8x8',
    boardSize: 8,
    rules: global.LocalRulesetAdapter.get('russian'),
    ai: null,
    online: { namespace: 'rooms', workerPrefix: '/rated', invitePrefix: '' },
    stats: { botNode: 'statsBot' }
  });

  var italianRules = global.LocalRulesetAdapter.get('italian');
  global.RulesetModules.register({
    id: 'italian',
    title: 'Italian draughts (Dama italiana) 8x8',
    boardSize: 8,
    rules: italianRules,
    ai: global.ItalianBot.createBot({ adapter: italianRules }),
    online: { namespace: 'roomsItalian', workerPrefix: '/italian', invitePrefix: 'it_' },
    stats: { botNode: 'statsBotItalian' }
  });
})(typeof window !== 'undefined' ? window : globalThis);

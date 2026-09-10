// №43 slice 5 (frozen plan): постепенная модульность script.js.
// hideStartupCover/hasInviteIntent/markStartupCoverAsInvite, вынесенные из
// script.js в shared/startup-cover-utils.js, по тому же паттерну, что и
// четыре предыдущих shared-модуля.
//
// Note: подробное behavioral-покрытие (все Telegram-комбинации, DOM
// present/absent, showScreen/bootstrapApp integration) уже есть в
// tests/startup-cover.test.js (обновлён этим же кандидатом -- секция 5
// берёт функции через require() вместо eval-извлечения из script.js).
// Здесь -- только structural/export/load-order/cache-bust/no-side-effect
// guards, не дублирующие ту секцию.
//
// Что доказывается:
//   A. Нет declaration ни одной из 3 функций в script.js.
//   B. shared/startup-cover-utils.js экспортирует ровно эти 3 функции.
//   C. index.html: startup-cover-utils.js грузится РАНЬШЕ script.js,
//      ПОСЛЕ captured-stack-utils.js, без async/defer/module.
//   D. script.js реально получает binding через fail-loud проверку;
//      6 реальных call sites мигрированы.
//   E. Нет side effect'ов при загрузке модуля (ни одна из функций не
//      вызывается на верхнем уровне).
//   F. Нет второй production-копии тел.
//   G. Cache-bust.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info !== undefined ? '  — ' + info : '')); }
}

const ROOT = path.join(__dirname, '..');
const SCRIPT_SRC = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHARED_PATH = path.join(ROOT, 'shared', 'startup-cover-utils.js');
const SHARED_SRC = fs.readFileSync(SHARED_PATH, 'utf8');
let sharedApi = null;
try { sharedApi = require(SHARED_PATH); } catch (e) { /* checked below */ }

const CLUSTER_FUNCS = ['hideStartupCover', 'hasInviteIntent', 'markStartupCoverAsInvite'];

console.log('=== A. Нет declaration ни одной из 3 функций в script.js ===');
CLUSTER_FUNCS.forEach(function (fn) {
    check('A. script.js: нет declaration ' + fn, !new RegExp('^function ' + fn + '\\(', 'm').test(SCRIPT_SRC));
});

console.log('');
console.log('=== B. shared/startup-cover-utils.js экспортирует ровно 3 функции ===');
check('B.1 shared/startup-cover-utils.js реально require\'ится', !!sharedApi);
if (sharedApi) {
    CLUSTER_FUNCS.forEach(function (fn) {
        check('B.2 экспортирует ' + fn, typeof sharedApi[fn] === 'function');
    });
    check('B.3 ровно 3 ключа в экспорте (не больше)', Object.keys(sharedApi).length === 3,
        JSON.stringify(Object.keys(sharedApi)));
}
check('B.4 IIFE + "use strict"', /^\(function \(global\) \{\s*\n\s*"use strict";/.test(SHARED_SRC));
check('B.5 экспорт через global.RussianCheckersStartupCoverUtils = api;',
    /global\.RussianCheckersStartupCoverUtils\s*=\s*api;/.test(SHARED_SRC));
check('B.6 module.exports для Node tests',
    /if \(typeof module === "object" && module\.exports\) \{\s*\n\s*module\.exports = api;/.test(SHARED_SRC));

console.log('');
console.log('=== C. index.html: порядок и способ загрузки script tags ===');
{
    const stackIdx = HTML.indexOf('shared/captured-stack-utils.js?v=1');
    const startupIdx = HTML.indexOf('shared/startup-cover-utils.js?v=1');
    const scriptVerMatch = /script\.js\?v=(\d+)/.exec(HTML);
    const scriptIdx = scriptVerMatch ? scriptVerMatch.index : -1;
    check('C.1 shared/startup-cover-utils.js?v=1 присутствует', startupIdx !== -1);
    check('C.2 порядок: captured-stack-utils.js < startup-cover-utils.js < script.js',
        stackIdx !== -1 && stackIdx < startupIdx && startupIdx < scriptIdx,
        'stack@' + stackIdx + ' startup@' + startupIdx + ' script@' + scriptIdx);
    const tagMatch = /<script src="shared\/startup-cover-utils\.js\?v=1"[^>]*><\/script>/.exec(HTML);
    check('C.3 тег без async/defer/type="module"', !!tagMatch, tagMatch ? tagMatch[0] : 'не найден');
}

console.log('');
console.log('=== D. script.js реально получает функции из RussianCheckersStartupCoverUtils ===');
{
    check('D.1 fail-loud проверка на RussianCheckersStartupCoverUtils.hasInviteIntent присутствует',
        /if \(!window\.RussianCheckersStartupCoverUtils \|\| typeof window\.RussianCheckersStartupCoverUtils\.hasInviteIntent !== "function"\) \{\s*\n\s*throw new Error\("RussianCheckersStartupCoverUtils failed to load"\);/.test(SCRIPT_SRC));
    check('D.2 destructuring всех трёх присутствует',
        SCRIPT_SRC.indexOf('const { hideStartupCover, hasInviteIntent, markStartupCoverAsInvite } = window.RussianCheckersStartupCoverUtils;') !== -1);
    check('D.3 fail-loud проверка идёт РАНЬШЕ destructuring', (function () {
        const guardPos = SCRIPT_SRC.indexOf('RussianCheckersStartupCoverUtils.hasInviteIntent !== "function"');
        const destrPos = SCRIPT_SRC.indexOf('const { hideStartupCover, hasInviteIntent, markStartupCoverAsInvite }');
        return guardPos !== -1 && destrPos !== -1 && guardPos < destrPos;
    })());
    check('D.4 нет client-side fallback-копии',
        !/=\s*window\.RussianCheckersStartupCoverUtils\s*\|\|/.test(SCRIPT_SRC));
    check('D.5 все 6 реальных production call sites на месте (4×hideStartupCover + 1×hasInviteIntent + 1×markStartupCoverAsInvite)',
        (SCRIPT_SRC.match(/hideStartupCover\(\)/g) || []).length === 4 &&
        (SCRIPT_SRC.match(/hasInviteIntent\(\)/g) || []).length === 1 &&
        (SCRIPT_SRC.match(/markStartupCoverAsInvite\(\)/g) || []).length === 1);
}

console.log('');
console.log('=== E. Нет side effect\'ов при загрузке модуля ===');
{
    // Убираем построчные //-комментарии ПЕРЕД анализом -- иначе упоминание
    // имени функции в пояснительном комментарии (например "hasInviteIntent()
    // уже надёжен") ложно засчитывается как реальный вызов.
    const withoutLineComments = SHARED_SRC.split('\n')
        .map(function (line) { return line.replace(/\/\/.*$/, ''); })
        .join('\n');
    // Ни один из экспортируемых вызовов не должен происходить после
    // объявления api (никакого self-invoke) и вне тел самих
    // function-деклараций (module-level side effect) -- в отличие,
    // например, от audio-effects.js, где document.addEventListener
    // НАМЕРЕННО остался в script.js именно по этой причине.
    const beforeApiDecl = withoutLineComments.slice(0, withoutLineComments.indexOf('const api = {'));
    const outsideFunctionBodies = beforeApiDecl.replace(/function \w+\(\) \{[\s\S]*?\n    \}/g, '');
    check('E.1 ни один экспортируемый вызов не происходит вне тел самих function-деклараций (module-level side effect, включая после api)',
        !/hideStartupCover\(\)|hasInviteIntent\(\)|markStartupCoverAsInvite\(\)/.test(outsideFunctionBodies) &&
        !/hideStartupCover\(\)|hasInviteIntent\(\)|markStartupCoverAsInvite\(\)/.test(withoutLineComments.slice(withoutLineComments.indexOf('const api = {'))));
}

console.log('');
console.log('=== F. Нет второй production-копии тел ===');
CLUSTER_FUNCS.forEach(function (fn) {
    check('F. script.js: нет declaration ' + fn, !new RegExp('^function ' + fn + '\\(', 'm').test(SCRIPT_SRC));
});

console.log('');
console.log('=== G. Cache-bust ===');
check('G.1 HTML содержит shared/startup-cover-utils.js?v=1', /shared\/startup-cover-utils\.js\?v=1/.test(HTML));
check('G.2 HTML содержит script.js?v=205 (поднят: script.js получил новую fail-loud зависимость от RussianCheckersStartupCoverUtils)',
    /script\.js\?v=205/.test(HTML));
check('G.3 HTML НЕ содержит старую script.js?v=204', !/script\.js\?v=204/.test(HTML));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

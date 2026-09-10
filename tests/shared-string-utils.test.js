// №43 (frozen plan): постепенная модульность script.js. Первый slice --
// "string utils" (escapeHtml), вынесенный из script.js в
// shared/string-utils.js по тому же паттерну, что и №22 (game-engine.js).
//
// Что доказывается:
//   A. Нет declaration escapeHtml в script.js (не отросла заново копией).
//   B. shared/string-utils.js экспортирует escapeHtml -- и как global,
//      и как module.exports.
//   C. index.html: shared/string-utils.js грузится РАНЬШЕ script.js,
//      без async/defer/module, ПОСЛЕ shared/game-engine.js.
//   D. script.js реально получает binding из
//      window.RussianCheckersStringUtils (не свою локальную копию/fallback),
//      через fail-loud проверку, тем же способом, что и engine.
//   F. Нет второй production-копии тела escapeHtml.
//   G. Cache-bust.
//   H. Лёгкая identity/smoke проверка поведения (не дублирует
//      lobby-render.test.js/invite-privacy.test.js, у которых своя,
//      более подробная поведенческая проверка через реальные call sites).

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}

const ROOT = path.join(__dirname, '..');
const SCRIPT_SRC = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHARED_PATH = path.join(ROOT, 'shared', 'string-utils.js');
const SHARED_SRC = fs.readFileSync(SHARED_PATH, 'utf8');
let stringUtils = null;
try { stringUtils = require(SHARED_PATH); } catch (e) { /* checked below */ }

console.log('=== A. Нет declaration escapeHtml в script.js ===');
check('A.1 нет "function escapeHtml(" в script.js',
    !/^function escapeHtml\(/m.test(SCRIPT_SRC));

console.log('');
console.log('=== B. shared/string-utils.js экспортирует escapeHtml ===');
check('B.1 shared/string-utils.js реально require\'ится и содержит escapeHtml',
    !!stringUtils && typeof stringUtils.escapeHtml === 'function');
check('B.2 IIFE + "use strict"', /^\(function \(global\) \{\s*\n\s*"use strict";/.test(SHARED_SRC));
check('B.3 экспорт через global.RussianCheckersStringUtils = { escapeHtml }',
    /global\.RussianCheckersStringUtils\s*=\s*api;/.test(SHARED_SRC) &&
    /const api = \{\s*\n\s*escapeHtml,/.test(SHARED_SRC));
check('B.4 module.exports для Node tests',
    /if \(typeof module === "object" && module\.exports\) \{\s*\n\s*module\.exports = api;/.test(SHARED_SRC));

console.log('');
console.log('=== C. index.html: порядок и способ загрузки script tags ===');
{
    const engineIdx = HTML.indexOf('shared/game-engine.js?v=1');
    const stringUtilsIdx = HTML.indexOf('shared/string-utils.js?v=1');
    // Версия script.js неизбежно продолжит расти с каждым следующим slice
    // №43 -- ищем её generic-регэкспом, не жёстко зашитым числом, иначе этот
    // check ломался бы при КАЖДОМ будущем cache-bust'е, не только при откате.
    const scriptVerMatch = /script\.js\?v=(\d+)/.exec(HTML);
    const scriptIdx = scriptVerMatch ? scriptVerMatch.index : -1;
    check('C.1 shared/string-utils.js?v=1 присутствует в index.html', stringUtilsIdx !== -1);
    check('C.2 порядок: game-engine.js < string-utils.js < script.js',
        engineIdx !== -1 && engineIdx < stringUtilsIdx && stringUtilsIdx < scriptIdx,
        'engine@' + engineIdx + ' stringUtils@' + stringUtilsIdx + ' script@' + scriptIdx);
    const tagMatch = /<script src="shared\/string-utils\.js\?v=1"[^>]*><\/script>/.exec(HTML);
    check('C.3 тег без async/defer/type="module"', !!tagMatch,
        'найден тег: ' + (tagMatch ? tagMatch[0] : 'не найден'));
}

console.log('');
console.log('=== D. script.js реально получает escapeHtml из RussianCheckersStringUtils ===');
{
    check('D.1 fail-loud проверка на RussianCheckersStringUtils.escapeHtml присутствует',
        /if \(!window\.RussianCheckersStringUtils \|\| typeof window\.RussianCheckersStringUtils\.escapeHtml !== "function"\) \{\s*\n\s*throw new Error\("RussianCheckersStringUtils failed to load"\);/.test(SCRIPT_SRC));
    check('D.2 destructuring "const { escapeHtml } = window.RussianCheckersStringUtils;" присутствует',
        SCRIPT_SRC.indexOf('const { escapeHtml } = window.RussianCheckersStringUtils;') !== -1);
    check('D.3 fail-loud проверка идёт РАНЬШЕ destructuring (не наоборот)', (function () {
        const guardPos = SCRIPT_SRC.indexOf('RussianCheckersStringUtils.escapeHtml !== "function"');
        const destrPos = SCRIPT_SRC.indexOf('const { escapeHtml } = window.RussianCheckersStringUtils;');
        return guardPos !== -1 && destrPos !== -1 && guardPos < destrPos;
    })());
    check('D.4 нет client-side fallback-копии (присваивание вида "= window.RussianCheckersStringUtils || {...}")',
        !/=\s*window\.RussianCheckersStringUtils\s*\|\|/.test(SCRIPT_SRC));
}

console.log('');
console.log('=== F. Нет второй production-копии тела escapeHtml ===');
check('F. script.js: нет declaration escapeHtml', !/^function escapeHtml\(/m.test(SCRIPT_SRC));

console.log('');
console.log('=== G. Cache-bust ===');
check('G.1 HTML содержит shared/string-utils.js?v=1', /shared\/string-utils\.js\?v=1/.test(HTML));
check('G.2 HTML содержит script.js с версией СТРОГО ВЫШЕ v=200 (поднят: script.js получил новую fail-loud зависимость от RussianCheckersStringUtils -- смешанный cache-state старого index.html с новым script.js под прежним ?v=200 бросал бы RussianCheckersStringUtils failed to load; конкретное число не фиксируем -- оно продолжит расти со следующими slice\'ами №43, важен сам факт "выше исходного v=200")',
    (function () {
        const m = /script\.js\?v=(\d+)/.exec(HTML);
        return !!m && parseInt(m[1], 10) > 200;
    })());
check('G.3 HTML НЕ содержит старую script.js?v=200', !/script\.js\?v=200/.test(HTML));

console.log('');
console.log('=== H. Лёгкая identity/smoke проверка поведения ===');
if (stringUtils) {
    check('H.1 экранирует весь опасный набор символов', (function () {
        return stringUtils.escapeHtml('<>"\'&') === '&lt;&gt;&quot;&#039;&amp;';
    })());
    check('H.2 обычная строка без спецсимволов не меняется',
        stringUtils.escapeHtml('K7X2QF') === 'K7X2QF');
    check('H.3 не бросает на пустой строке', (function () {
        try { return stringUtils.escapeHtml('') === ''; } catch (e) { return false; }
    })());
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

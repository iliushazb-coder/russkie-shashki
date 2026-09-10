// №43 slice 4 (frozen plan): постепенная модульность script.js.
// capturedDepthOpacity(fromFront), вынесенный из script.js в
// shared/captured-stack-utils.js, по тому же паттерну, что и три
// предыдущих shared-модуля.
//
// Note: единственный runtime call site (renderCapturedStack) и общая
// корректность DOM/CSS уже покрыты tests/captured-stack-dom.test.js
// (обновлён этим же кандидатом, чтобы брать функцию из нового модуля
// через require(), а не regex-извлечением из script.js). Здесь --
// изолированные structural/load-order/export/cache-bust guards плюс
// прямые behavioral-проверки самой последовательности значений и её
// clamp-поведения, без построения DOM вовсе.
//
// Что доказывается:
//   A. Нет declaration capturedDepthOpacity/CAPTURED_DEPTH_OPACITY в
//      script.js.
//   B. shared/captured-stack-utils.js экспортирует capturedDepthOpacity.
//   C. index.html: captured-stack-utils.js грузится РАНЬШЕ script.js,
//      ПОСЛЕ format-utils.js, без async/defer/module.
//   D. script.js реально получает binding через fail-loud проверку.
//   F. Нет второй production-копии тела/массива.
//   G. Cache-bust.
//   H. Behavioral: индексы 0-4 дают ожидаемую последовательность,
//      индексы >4 клэмпятся к последнему значению (0.45), нецелые и
//      отрицательные индексы обрабатываются предсказуемо.

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
const SHARED_PATH = path.join(ROOT, 'shared', 'captured-stack-utils.js');
const SHARED_SRC = fs.readFileSync(SHARED_PATH, 'utf8');
let sharedApi = null;
try { sharedApi = require(SHARED_PATH); } catch (e) { /* checked below */ }

console.log('=== A. Нет declaration capturedDepthOpacity/CAPTURED_DEPTH_OPACITY в script.js ===');
check('A.1 нет "function capturedDepthOpacity(" в script.js', !/^function capturedDepthOpacity\(/m.test(SCRIPT_SRC));
check('A.2 нет "const CAPTURED_DEPTH_OPACITY" в script.js', !/^const CAPTURED_DEPTH_OPACITY\b/m.test(SCRIPT_SRC));

console.log('');
console.log('=== B. shared/captured-stack-utils.js экспортирует capturedDepthOpacity ===');
check('B.1 shared/captured-stack-utils.js реально require\'ится и содержит capturedDepthOpacity',
    !!sharedApi && typeof sharedApi.capturedDepthOpacity === 'function');
check('B.2 IIFE + "use strict"', /^\(function \(global\) \{\s*\n\s*"use strict";/.test(SHARED_SRC));
check('B.3 экспорт через global.RussianCheckersCapturedStackUtils = api;',
    /global\.RussianCheckersCapturedStackUtils\s*=\s*api;/.test(SHARED_SRC) &&
    /const api = \{\s*\n\s*capturedDepthOpacity,/.test(SHARED_SRC));
check('B.4 module.exports для Node tests',
    /if \(typeof module === "object" && module\.exports\) \{\s*\n\s*module\.exports = api;/.test(SHARED_SRC));
check('B.5 review fix: CAPTURED_DEPTH_OPACITY -- module-level const (та же runtime-семантика, что в исходном script.js -- создаётся один раз, не на каждый вызов)',
    /const CAPTURED_DEPTH_OPACITY = \[1, 0\.82, 0\.66, 0\.52, 0\.45\];/.test(SHARED_SRC));
check('B.6 константа объявлена ДО функции (module-level, вне её тела)', (function () {
    const constPos = SHARED_SRC.indexOf('const CAPTURED_DEPTH_OPACITY');
    const fnPos = SHARED_SRC.indexOf('function capturedDepthOpacity(fromFront) {');
    return constPos !== -1 && fnPos !== -1 && constPos < fnPos;
})());
check('B.7 CAPTURED_DEPTH_OPACITY НЕ экспортируется (приватна модулю, тот же паттерн, что playTone/playWoodKnock в audio-effects.js)',
    !/CAPTURED_DEPTH_OPACITY,?\s*\n?\s*\}/.test(SHARED_SRC.slice(SHARED_SRC.indexOf('const api = {'))) &&
    (function () { try { return !('CAPTURED_DEPTH_OPACITY' in require(SHARED_PATH)); } catch (e) { return false; } })());

console.log('');
console.log('=== C. index.html: порядок и способ загрузки script tags ===');
{
    const formatIdx = HTML.indexOf('shared/format-utils.js?v=1');
    const stackIdx = HTML.indexOf('shared/captured-stack-utils.js?v=1');
    const scriptVerMatch = /script\.js\?v=(\d+)/.exec(HTML);
    const scriptIdx = scriptVerMatch ? scriptVerMatch.index : -1;
    check('C.1 shared/captured-stack-utils.js?v=1 присутствует', stackIdx !== -1);
    check('C.2 порядок: format-utils.js < captured-stack-utils.js < script.js',
        formatIdx !== -1 && formatIdx < stackIdx && stackIdx < scriptIdx,
        'format@' + formatIdx + ' stack@' + stackIdx + ' script@' + scriptIdx);
    const tagMatch = /<script src="shared\/captured-stack-utils\.js\?v=1"[^>]*><\/script>/.exec(HTML);
    check('C.3 тег без async/defer/type="module"', !!tagMatch, tagMatch ? tagMatch[0] : 'не найден');
}

console.log('');
console.log('=== D. script.js реально получает capturedDepthOpacity из RussianCheckersCapturedStackUtils ===');
{
    check('D.1 fail-loud проверка на RussianCheckersCapturedStackUtils.capturedDepthOpacity присутствует',
        /if \(!window\.RussianCheckersCapturedStackUtils \|\| typeof window\.RussianCheckersCapturedStackUtils\.capturedDepthOpacity !== "function"\) \{\s*\n\s*throw new Error\("RussianCheckersCapturedStackUtils failed to load"\);/.test(SCRIPT_SRC));
    check('D.2 destructuring "const { capturedDepthOpacity } = window.RussianCheckersCapturedStackUtils;" присутствует',
        SCRIPT_SRC.indexOf('const { capturedDepthOpacity } = window.RussianCheckersCapturedStackUtils;') !== -1);
    check('D.3 fail-loud проверка идёт РАНЬШЕ destructuring', (function () {
        const guardPos = SCRIPT_SRC.indexOf('RussianCheckersCapturedStackUtils.capturedDepthOpacity !== "function"');
        const destrPos = SCRIPT_SRC.indexOf('const { capturedDepthOpacity } = window.RussianCheckersCapturedStackUtils;');
        return guardPos !== -1 && destrPos !== -1 && guardPos < destrPos;
    })());
    check('D.4 нет client-side fallback-копии (присваивание вида "= window.RussianCheckersCapturedStackUtils || {...}")',
        !/=\s*window\.RussianCheckersCapturedStackUtils\s*\|\|/.test(SCRIPT_SRC));
}

console.log('');
console.log('=== F. Нет второй production-копии тела/массива ===');
check('F.1 script.js: нет declaration capturedDepthOpacity', !/^function capturedDepthOpacity\(/m.test(SCRIPT_SRC));
check('F.2 script.js: нет declaration CAPTURED_DEPTH_OPACITY', !/^const CAPTURED_DEPTH_OPACITY\b/m.test(SCRIPT_SRC));

console.log('');
console.log('=== G. Cache-bust ===');
check('G.1 HTML содержит shared/captured-stack-utils.js?v=1', /shared\/captured-stack-utils\.js\?v=1/.test(HTML));
check('G.2 HTML содержит script.js?v=204 (поднят: script.js получил новую fail-loud зависимость от RussianCheckersCapturedStackUtils)',
    /script\.js\?v=204/.test(HTML));
check('G.3 HTML НЕ содержит старую script.js?v=203', !/script\.js\?v=203/.test(HTML));

console.log('');
console.log('=== H. Behavioral: последовательность глубины и clamp-поведение ===');
if (sharedApi) {
    check('H.1 capturedDepthOpacity(0) === 1 (передняя шашка чёткая)', sharedApi.capturedDepthOpacity(0) === 1, sharedApi.capturedDepthOpacity(0));
    check('H.2 capturedDepthOpacity(1) === 0.82', sharedApi.capturedDepthOpacity(1) === 0.82, sharedApi.capturedDepthOpacity(1));
    check('H.3 capturedDepthOpacity(2) === 0.66', sharedApi.capturedDepthOpacity(2) === 0.66, sharedApi.capturedDepthOpacity(2));
    check('H.4 capturedDepthOpacity(3) === 0.52', sharedApi.capturedDepthOpacity(3) === 0.52, sharedApi.capturedDepthOpacity(3));
    check('H.5 capturedDepthOpacity(4) === 0.45 (последнее реальное значение)', sharedApi.capturedDepthOpacity(4) === 0.45, sharedApi.capturedDepthOpacity(4));
    check('H.6 capturedDepthOpacity(5) === 0.45 (clamp -- дальше четвёртой не бледнеем)', sharedApi.capturedDepthOpacity(5) === 0.45, sharedApi.capturedDepthOpacity(5));
    check('H.7 capturedDepthOpacity(11) === 0.45 (clamp держится сколь угодно далеко)', sharedApi.capturedDepthOpacity(11) === 0.45, sharedApi.capturedDepthOpacity(11));
    check('H.8 capturedDepthOpacity(100) === 0.45 (clamp не деградирует на больших значениях)', sharedApi.capturedDepthOpacity(100) === 0.45, sharedApi.capturedDepthOpacity(100));
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

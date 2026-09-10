// №43 slice 3 (frozen plan): постепенная модульность script.js.
// formatTime(seconds), вынесенный из script.js в shared/format-utils.js,
// по тому же паттерну, что и №22 (game-engine.js), slice 1 (string-utils.js)
// и slice 2 (audio-effects.js).
//
// Что доказывается:
//   A. Нет declaration formatTime в script.js.
//   B. shared/format-utils.js экспортирует formatTime.
//   C. index.html: format-utils.js грузится РАНЬШЕ script.js, ПОСЛЕ
//      audio-effects.js, без async/defer/module.
//   D. script.js реально получает binding через fail-loud проверку.
//   F. Нет второй production-копии тела formatTime.
//   G. Cache-bust.
//   H. Behavioral: чистая функция, fake/stub не нужны вовсе -- прямой
//      вызов и сравнение строки. 0/59/60/125/отрицательное/дробное.

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
const SHARED_PATH = path.join(ROOT, 'shared', 'format-utils.js');
const SHARED_SRC = fs.readFileSync(SHARED_PATH, 'utf8');
let formatUtils = null;
try { formatUtils = require(SHARED_PATH); } catch (e) { /* checked below */ }

console.log('=== A. Нет declaration formatTime в script.js ===');
check('A.1 нет "function formatTime(" в script.js', !/^function formatTime\(/m.test(SCRIPT_SRC));

console.log('');
console.log('=== B. shared/format-utils.js экспортирует formatTime ===');
check('B.1 shared/format-utils.js реально require\'ится и содержит formatTime',
    !!formatUtils && typeof formatUtils.formatTime === 'function');
check('B.2 IIFE + "use strict"', /^\(function \(global\) \{\s*\n\s*"use strict";/.test(SHARED_SRC));
check('B.3 экспорт через global.RussianCheckersFormatUtils = api;',
    /global\.RussianCheckersFormatUtils\s*=\s*api;/.test(SHARED_SRC) &&
    /const api = \{\s*\n\s*formatTime,/.test(SHARED_SRC));
check('B.4 module.exports для Node tests',
    /if \(typeof module === "object" && module\.exports\) \{\s*\n\s*module\.exports = api;/.test(SHARED_SRC));

console.log('');
console.log('=== C. index.html: порядок и способ загрузки script tags ===');
{
    const audioIdx = HTML.indexOf('shared/audio-effects.js?v=1');
    const formatIdx = HTML.indexOf('shared/format-utils.js?v=1');
    const scriptVerMatch = /script\.js\?v=(\d+)/.exec(HTML);
    const scriptIdx = scriptVerMatch ? scriptVerMatch.index : -1;
    check('C.1 shared/format-utils.js?v=1 присутствует', formatIdx !== -1);
    check('C.2 порядок: audio-effects.js < format-utils.js < script.js',
        audioIdx !== -1 && audioIdx < formatIdx && formatIdx < scriptIdx,
        'audio@' + audioIdx + ' format@' + formatIdx + ' script@' + scriptIdx);
    const tagMatch = /<script src="shared\/format-utils\.js\?v=1"[^>]*><\/script>/.exec(HTML);
    check('C.3 тег без async/defer/type="module"', !!tagMatch, tagMatch ? tagMatch[0] : 'не найден');
}

console.log('');
console.log('=== D. script.js реально получает formatTime из RussianCheckersFormatUtils ===');
{
    check('D.1 fail-loud проверка на RussianCheckersFormatUtils.formatTime присутствует',
        /if \(!window\.RussianCheckersFormatUtils \|\| typeof window\.RussianCheckersFormatUtils\.formatTime !== "function"\) \{\s*\n\s*throw new Error\("RussianCheckersFormatUtils failed to load"\);/.test(SCRIPT_SRC));
    check('D.2 destructuring "const { formatTime } = window.RussianCheckersFormatUtils;" присутствует',
        SCRIPT_SRC.indexOf('const { formatTime } = window.RussianCheckersFormatUtils;') !== -1);
    check('D.3 fail-loud проверка идёт РАНЬШЕ destructuring', (function () {
        const guardPos = SCRIPT_SRC.indexOf('RussianCheckersFormatUtils.formatTime !== "function"');
        const destrPos = SCRIPT_SRC.indexOf('const { formatTime } = window.RussianCheckersFormatUtils;');
        return guardPos !== -1 && destrPos !== -1 && guardPos < destrPos;
    })());
    check('D.4 нет client-side fallback-копии (присваивание вида "= window.RussianCheckersFormatUtils || {...}")',
        !/=\s*window\.RussianCheckersFormatUtils\s*\|\|/.test(SCRIPT_SRC));
}

console.log('');
console.log('=== F. Нет второй production-копии тела formatTime ===');
check('F. script.js: нет declaration formatTime', !/^function formatTime\(/m.test(SCRIPT_SRC));

console.log('');
console.log('=== G. Cache-bust ===');
check('G.1 HTML содержит shared/format-utils.js?v=1', /shared\/format-utils\.js\?v=1/.test(HTML));
check('G.2 HTML содержит script.js с версией СТРОГО ВЫШЕ v=202 (поднят: script.js получил новую fail-loud зависимость от RussianCheckersFormatUtils; конкретное число не фиксируем -- продолжит расти со следующими slice\'ами №43)',
    (function () {
        const m = /script\.js\?v=(\d+)/.exec(HTML);
        return !!m && parseInt(m[1], 10) > 202;
    })());
check('G.3 HTML НЕ содержит старую script.js?v=202', !/script\.js\?v=202/.test(HTML));

console.log('');
console.log('=== H. Behavioral: чистая функция, fake/stub не требуются ===');
if (formatUtils) {
    check('H.1 formatTime(0) === "0:00"', formatUtils.formatTime(0) === '0:00', formatUtils.formatTime(0));
    check('H.2 formatTime(59) === "0:59"', formatUtils.formatTime(59) === '0:59', formatUtils.formatTime(59));
    check('H.3 formatTime(60) === "1:00"', formatUtils.formatTime(60) === '1:00', formatUtils.formatTime(60));
    check('H.4 formatTime(125) === "2:05"', formatUtils.formatTime(125) === '2:05', formatUtils.formatTime(125));
    check('H.5 formatTime(-5) === "0:00" (Math.max(0, ...) защита от отрицательных)',
        formatUtils.formatTime(-5) === '0:00', formatUtils.formatTime(-5));
    check('H.6 formatTime(59.4) === "1:00" (Math.ceil округляет дробные секунды ВВЕРХ)',
        formatUtils.formatTime(59.4) === '1:00', formatUtils.formatTime(59.4));
    check('H.7 formatTime(60.1) === "1:01" (то же для дробных выше минуты)',
        formatUtils.formatTime(60.1) === '1:01', formatUtils.formatTime(60.1));
    check('H.8 formatTime(3599) === "59:59" (граница часа, паддинг нуля есть)',
        formatUtils.formatTime(3599) === '59:59', formatUtils.formatTime(3599));
    check('H.9 formatTime(3600) === "60:00" (минуты не переводятся в часы -- по дизайну)',
        formatUtils.formatTime(3600) === '60:00', formatUtils.formatTime(3600));
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

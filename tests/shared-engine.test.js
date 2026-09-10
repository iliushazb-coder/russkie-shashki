// №22: "Вынести общее чистое ядро игры" — structural/regression guards.
//
// Что доказывается:
//   A. Single source of truth: ни одна из 17 shared-функций не имеет
//      declaration в script.js (не отросла заново копией).
//   B. shared/game-engine.js экспортирует все 17 ожидаемых функций.
//   C. index.html: shared грузится РАНЬШЕ script.js, без async/defer/module.
//   D. script.js реально получает bindings из window.RussianCheckersEngine
//      (не свою локальную копию/fallback).
//   E. worker/index.mjs импортирует ИМЕННО "../shared/game-engine.js" —
//      никакого отдельного worker-copy файла.
//   F. Нигде в production-файлах нет второй declaration-копии этих же 17 тел.
//   G. Cache-bust: HTML ссылается на новые версии, не на старую v199.
//   H. Несколько лёгких identity/smoke проверок поведения через сам shared
//      модуль (не дублирование десятков existing assertions).
//
// Явно НЕ проверяется здесь (уже покрыто существующими сюитами после
// loader-миграции): E1–E8 core-rules, T-1.A/T-1.B engine-guards, draw suites,
// move-sync — эти assertions остаются в СВОИХ файлах без изменений.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const ROOT = path.join(__dirname, '..');
const SCRIPT_SRC = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker', 'index.mjs'), 'utf8');

const SHARED_FUNCS = [
  'createInitialPieces', 'pieceAt', 'countPiecesOfColor', 'canCaptureAt',
  'getCaptureJumps', 'withPendingBlockers', 'filterJumpsByMajorityRule',
  'canMoveNormally', 'hasMandatoryCapture', 'hasAnyLegalMove', 'checkWinCondition',
  'getDrawPositionKey', 'isOnLongRoad', 'analyzeLongRoadEnding', 'checkAutomaticDraw',
  'attemptMove', 'computeNextDrawState'
];

console.log('=== A. Single source of truth: НЕТ deklaration копий в script.js ===');
SHARED_FUNCS.forEach(function (fn) {
  check('A. ' + fn + ' отсутствует как declaration в script.js',
    !new RegExp('^function ' + fn + '\\(', 'm').test(SCRIPT_SRC));
});

console.log('');
console.log('=== B. shared/game-engine.js экспортирует все 17 ===');
let engine = null, loadErr = null;
try { engine = require('../shared/game-engine.js'); } catch (e) { loadErr = e.message; }
check('B.0 require("../shared/game-engine.js") не бросает', loadErr === null, loadErr);
if (engine) {
  SHARED_FUNCS.forEach(function (fn) {
    check('B. exports.' + fn + ' — function', typeof engine[fn] === 'function');
  });
}

console.log('');
console.log('=== C. Browser order: shared раньше script.js, без async/defer/module ===');
{
  const sharedTagMatch = /<script\s+src="shared\/game-engine\.js\?v=\d+"([^>]*)>/.exec(HTML);
  const scriptTagMatch = /<script\s+src="script\.js\?v=\d+"([^>]*)>/.exec(HTML);
  check('C.1 shared/game-engine.js тег присутствует', !!sharedTagMatch);
  check('C.2 script.js тег присутствует', !!scriptTagMatch);
  check('C.3 shared идёт РАНЬШЕ script.js в документе',
    !!sharedTagMatch && !!scriptTagMatch && HTML.indexOf(sharedTagMatch[0]) < HTML.indexOf(scriptTagMatch[0]));
  const attrs = sharedTagMatch ? sharedTagMatch[1] : '';
  check('C.4 shared-тег без async', !/\basync\b/.test(attrs));
  check('C.5 shared-тег без defer', !/\bdefer\b/.test(attrs));
  check('C.6 shared-тег без type="module"', !/type=["']module["']/.test(attrs));
}

console.log('');
console.log('=== D. script.js реально получает bindings из window.RussianCheckersEngine ===');
{
  check('D.1 destructuring из window.RussianCheckersEngine присутствует',
    /const\s*\{[\s\S]{0,600}\}\s*=\s*window\.RussianCheckersEngine;/.test(SCRIPT_SRC));
  check('D.2 все 17 имён встречаются внутри этого destructuring', (function () {
    const m = /const\s*\{([\s\S]{0,600})\}\s*=\s*window\.RussianCheckersEngine;/.exec(SCRIPT_SRC);
    if (!m) return false;
    return SHARED_FUNCS.every(function (fn) { return m[1].indexOf(fn) !== -1; });
  })());
  check('D.3 fail-fast guard присутствует ДО destructuring', (function () {
    const guardPos = SCRIPT_SRC.indexOf('RussianCheckersEngine failed to load');
    const destrPos = SCRIPT_SRC.indexOf('} = window.RussianCheckersEngine;');
    return guardPos !== -1 && destrPos !== -1 && guardPos < destrPos;
  })());
  check('D.4 нет client-side fallback-копии (присваивание вида "= window.RussianCheckersEngine || {...}")',
    !/=\s*window\.RussianCheckersEngine\s*\|\|/.test(SCRIPT_SRC));
}

console.log('');
console.log('=== E. Worker импортирует ИМЕННО "../shared/game-engine.js" ===');
{
  check('E.1 import "../shared/game-engine.js" присутствует',
    /import\s+["']\.\.\/shared\/game-engine\.js["'];/.test(WORKER_SRC));
  check('E.2 fail-fast invariant на globalThis.RussianCheckersEngine.attemptMove',
    /globalThis\.RussianCheckersEngine[\s\S]{0,80}attemptMove[\s\S]{0,40}function/.test(WORKER_SRC));
  check('E.3 Worker ИСПОЛЬЗУЕТ engine функционально (№23 закономерно меняет №22-era инвариант "no premature functional use" — destructuring теперь ожидаем)',
    /const\s*\{[^}]*\}\s*=\s*globalThis\.RussianCheckersEngine/.test(WORKER_SRC));
  check('E.4 import — top-level statement (колонка 0), не внутри какого-либо handler/функции', (function () {
    return /^import "\.\.\/shared\/game-engine\.js";$/m.test(WORKER_SRC);
  })());
}

console.log('');
console.log('=== F. Нет второй production-копии тел этих 17 функций ===');
{
  const PROD_FILES = ['script.js', path.join('worker', 'index.mjs')];
  PROD_FILES.forEach(function (relPath) {
    const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
    SHARED_FUNCS.forEach(function (fn) {
      check('F. ' + relPath + ': нет declaration ' + fn,
        !new RegExp('^function ' + fn + '\\(', 'm').test(src));
    });
  });
}

console.log('');
console.log('=== G. Cache-bust ===');
{
  check('G.1 HTML содержит script.js?v=201', /script\.js\?v=201/.test(HTML));
  check('G.2 HTML НЕ содержит старую script.js?v=199', !/script\.js\?v=199/.test(HTML));
  check('G.3 HTML содержит shared/game-engine.js?v=1', /shared\/game-engine\.js\?v=1/.test(HTML));
}

console.log('');
console.log('=== H. Лёгкие identity/smoke проверки поведения shared-модуля ===');
if (engine) {
  check('H.1 createInitialPieces(): 24 фигуры, 12 light + 12 dark', (function () {
    const p = engine.createInitialPieces();
    const keys = Object.keys(p);
    const light = keys.filter(function (k) { return p[k].color === 'light'; }).length;
    const dark = keys.filter(function (k) { return p[k].color === 'dark'; }).length;
    return keys.length === 24 && light === 12 && dark === 12;
  })());
  check('H.2 attemptMove(...) возвращает null на нелегальный ход (turn mismatch)', (function () {
    const state = { pieces: engine.createInitialPieces(), turn: 'light', mustContinueFrom: null,
      capturedDark: 0, capturedLight: 0, moveCount: 0 };
    return engine.attemptMove(state, 2, 1, 3, 2, 'dark') === null;
  })());
  check('H.3 getDrawPositionKey/isOnLongRoad/checkAutomaticDraw/computeNextDrawState существуют и вызываемы без throw', (function () {
    try {
      engine.getDrawPositionKey(engine.createInitialPieces(), 'light');
      engine.isOnLongRoad(0, 1);
      engine.checkAutomaticDraw({}, 0, 0, [], 'x', 0);
      engine.computeNextDrawState({}, { mustContinueFrom: null, capturedDark: 0, capturedLight: 0, lastMove: { to: { row: 0, col: 1 } }, pieces: {} }, false);
      return true;
    } catch (e) { return false; }
  })());
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

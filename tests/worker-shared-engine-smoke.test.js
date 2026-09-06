// №22: доказательство ИСПОЛНЕНИЕМ (не string-search), что worker/index.mjs
// реально может получить shared engine тем же способом, каким он это делает
// сам — side-effect import из настоящего ESM-контекста (.mjs, без
// package.json "type":"module" рядом), с чтением через globalThis.
//
// Это НЕ модульный тестовый раннер (tests/run.js исполняет .js файлы через
// execFileSync с обычным node) — этот файл сам по себе .mjs и запускается
// отдельно, затем сверяется тем же script-runner'ом по своему stdout.

const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

console.log('=== №22: Worker/Node ESM interop — реальное исполнение ===');

const probePath = path.join(__dirname, 'helpers', 'worker-esm-probe.mjs');
let output = null, execError = null;
try {
  output = execFileSync('node', [probePath], { encoding: 'utf8', timeout: 10000 });
} catch (e) {
  execError = e.stdout ? (e.stdout + '\n' + (e.stderr || '')) : e.message;
}

check('1. .mjs-пробник исполнился без ошибок', execError === null, execError);

if (output !== null) {
  const lines = output.trim().split('\n');
  const get = (key) => { const l = lines.find(function (x) { return x.startsWith(key + '='); }); return l ? l.slice(key.length + 1) : null; };

  check('2. await import("../shared/game-engine.js") из реального .mjs-контекста прошёл',
    get('IMPORT_OK') === 'true');
  check('3. globalThis.RussianCheckersEngine существует после import',
    get('ENGINE_TYPEOF') === 'object');
  check('4. typeof globalThis.RussianCheckersEngine.attemptMove === "function"',
    get('ATTEMPTMOVE_TYPEOF') === 'function');
  check('5. createInitialPieces() возвращает 24 фигуры (12+12), не мок',
    get('TOTAL_PIECES') === '24' && get('LIGHT_PIECES') === '12' && get('DARK_PIECES') === '12');
} else {
  check('2. (пропущено — .mjs-пробник не дал вывода)', false);
  check('3. (пропущено)', false);
  check('4. (пропущено)', false);
  check('5. (пропущено)', false);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

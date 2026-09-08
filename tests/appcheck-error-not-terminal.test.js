// №26: статическая проверка исходника script.js -- "app_check_unavailable"
// не должен присутствовать ни в RATED_JOIN_TERMINAL_ERRORS, ни в
// RATED_ACTION_DEFINITIVE_ERRORS. Обе -- явные allowlist'ы; отсутствие в
// них автоматически означает "не terminal/definitive", то есть клиент
// корректно продолжает считать эту ошибку transient/retryable без
// какого-либо дополнительного кода. Это регресс-guard именно ПРОТИВ
// случайного добавления кода в одну из этих allowlist в будущем.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const src = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

function extractArray(name) {
  const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];'));
  if (!m) throw new Error(name + ' не найден в script.js');
  return m[1];
}

const joinTerminal = extractArray('RATED_JOIN_TERMINAL_ERRORS');
const actionDefinitive = extractArray('RATED_ACTION_DEFINITIVE_ERRORS');

check('app_check_unavailable отсутствует в RATED_JOIN_TERMINAL_ERRORS', joinTerminal.indexOf('app_check_unavailable') === -1);
check('app_check_unavailable отсутствует в RATED_ACTION_DEFINITIVE_ERRORS', actionDefinitive.indexOf('app_check_unavailable') === -1);

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

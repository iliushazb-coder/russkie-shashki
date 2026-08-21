// Загружает функции из ../../script.js по имени и отдаёт их исходник для eval.
// Тесты СПЕЦИАЛЬНО работают с реальным production-файлом, а не с копией:
// так они ломаются, если продакшен изменится несовместимо.
const fs = require('fs');
const path = require('path');
// TARGET_SCRIPT позволяет прогнать тесты против ДРУГОЙ версии файла —
// используется для проверки, что тест реально ловит известный баг.
// В обычном запуске (npm test) переменная не задана и берётся файл репозитория.
const SCRIPT_PATH = process.env.TARGET_SCRIPT || path.join(__dirname, '..', '..', 'script.js');
const SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');

function extractFunc(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{', 'g');
  const m = re.exec(SRC);
  if (!m) throw new Error('Функция не найдена в script.js: ' + name);
  let s = m.index, i = SRC.indexOf('{', s), d = 1; i++;
  while (d > 0) { if (SRC[i] === '{') d++; else if (SRC[i] === '}') d--; i++; }
  return SRC.slice(s, i);
}
function extractObjectLiteral(constName) {
  const m = new RegExp('const ' + constName + ' = \\{').exec(SRC);
  if (!m) throw new Error('Константа не найдена: ' + constName);
  let s = SRC.indexOf('{', m.index), i = s, d = 1; i++;
  while (d > 0) { if (SRC[i] === '{') d++; else if (SRC[i] === '}') d--; i++; }
  return SRC.slice(s, i);
}
module.exports = { SRC, SCRIPT_PATH, extractFunc, extractObjectLiteral };

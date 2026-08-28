// Единая точка запуска: node tests/run.js  (или npm test)
// Зависимостей нет — только стандартный Node.
//
// НАДЁЖНОСТЬ РАННЕРА. Раньше здесь было два пути определения результата
// сюиты, и оба могли соврать.
//
//   1. Ненулевой код возврата помечался hardFail, но затем вывод всё равно
//      разбирался, и числа из него попадали в общий счёт. Итоговая строка
//      могла показать «0 провалено» при упавшей сюите.
//   2. Если строки ИТОГ не было, счёт шёл ПОДСЧЁТОМ СИМВОЛОВ ✅ и ❌ в
//      произвольном тексте. Символы встречаются в НАЗВАНИЯХ тестов — в
//      четырнадцати сюитах они там уже есть. Проходящий тест с ❌ в имени
//      давал несуществующий провал и портил общий счёт.
//
// Теперь путь ровно один: строгая машинно-читаемая строка итога. Всё
// остальное — ошибка, а не повод считать символы.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const FILES = [
  ['A. ONLINE STATS',        'online-stats.test.js'],
  ['B. BACK BUTTON / DOM',   'back-button.test.js'],
  ['C. DRAW RULES',          'draw-rules.test.js'],
  ['C. DRAW RULES (взаимодействие)', 'draw-interaction.test.js'],
  ['C/D. DRAW STATE LIFECYCLE + SERIALIZE', 'draw-state-lifecycle.test.js'],
  ['E. CORE RULES',          'core-rules.test.js'],
  ['F. INVITE-LINK JOIN',    'invite-join.test.js'],
  ['G. ROOM LIFECYCLE CLEANUP', 'room-cleanup.test.js'],
  ['H. PRESENCE LIFECYCLE (A+B+C+C-1, v171)', 'presence-lifecycle.test.js'],
  ['I. ONLINE ELO RATING (Этап 1)', 'elo-rating.test.js'],
  ['J. COINS / ECONOMY (Этап 2)', 'coins-economy.test.js'],
  ['K. LEADERBOARD UI 50/50 + BOT DETAILS', 'leaderboard-ui.test.js'],
  ['M. REMATCH RESULT ATTRIBUTION', 'rematch-attribution.test.js'],
  ['N. ONLINE MOVE SYNC', 'move-sync.test.js'],
  ['O. ONLINE PRESENCE / RECONNECT', 'presence-reconnect.test.js'],
  ['P. LOBBY RENDER / ЭКРАНИРОВАНИЕ КЛЮЧА (S-1)', 'lobby-render.test.js'],
  ['Q. ENGINE GUARDS: ход назад + турецкий удар (T-1)', 'engine-guards.test.js'],
  ['R. ПРИВАТНОСТЬ ПРИГЛАШЕНИЯ (BUG №1)', 'invite-privacy.test.js'],
  ['S. BOTH-OFFLINE 60s + ЗАКРЫТИЕ ПУТЕЙ ВОСКРЕШЕНИЯ (v184)', 'both-offline-abandoned.test.js'],
  ['T. CLOCK SAFETY — серверное время вместо часов телефона', 'clock-safety.test.js'],
  ['U. ТАБЛИЦА СТАТИСТИКИ — ВСЕ ИГРОКИ В ОБЕИХ ВКЛАДКАХ', 'leaderboard-all-players.test.js'],
  ['V. НАДЁЖНОСТЬ САМОГО РАННЕРА', 'runner-selftest.test.js'],
];

// Строка итога: ТОЛЬКО отдельной строкой целиком, от начала и до конца.
// Якоря обязательны: строки результатов тестов начинаются с "  ✅ " или
// "  ❌ ", поэтому текст внутри названия теста не может выдать себя за итог.
const SUMMARY_RE = /^[ \t]*ИТОГ[^\n:]*:[ \t]*(\d+)[ \t]*\/[ \t]*(\d+)[ \t]*$/gm;

// Единственная точка принятия решения по сюите.
// Возвращает { ok, pass, fail, reason }.
// ok === false означает, что сюите нельзя верить: её числа в общий счёт
// НЕ попадают, а весь прогон обязан завершиться ненулевым кодом.
function evaluateSuite(output, exitCode) {
  // 1. Код возврата важнее любого текста. Сюита могла напечатать красивый
  //    итог и упасть после него — например, в асинхронном колбэке.
  if (exitCode !== 0) {
    return { ok: false, pass: 0, fail: 0, reason: 'ненулевой код возврата: ' + exitCode };
  }

  // 2. Итог обязан быть. Берём ПОСЛЕДНЕЕ совпадение: сюита может печатать
  //    промежуточные строки, решает финальная.
  SUMMARY_RE.lastIndex = 0;
  let m, last = null;
  while ((m = SUMMARY_RE.exec(output)) !== null) last = m;
  if (!last) {
    return { ok: false, pass: 0, fail: 0, reason: 'нет машинно-читаемой строки ИТОГ' };
  }

  const pass = Number(last[1]);
  const total = Number(last[2]);

  // 3. Итог обязан быть осмысленным.
  if (!Number.isFinite(pass) || !Number.isFinite(total)) {
    return { ok: false, pass: 0, fail: 0, reason: 'нечисловой итог' };
  }
  if (total === 0) {
    return { ok: false, pass: 0, fail: 0, reason: 'итог 0/0 — сюита не выполнила ни одной проверки' };
  }
  if (pass > total) {
    return { ok: false, pass: 0, fail: 0, reason: 'повреждённый итог: пройдено больше, чем всего (' + pass + '/' + total + ')' };
  }

  const fail = total - pass;
  return { ok: fail === 0, pass: pass, fail: fail, reason: fail === 0 ? '' : fail + ' проверок провалено' };
}

function main() {
  let totalPass = 0, totalFail = 0;
  const broken = [];

  for (const [title, file] of FILES) {
    const full = path.join(__dirname, file);
    if (!fs.existsSync(full)) {
      console.log('\n=== ' + title + ' (' + file + ') ===');
      console.log('  ОШИБКА: файл сюиты не найден');
      broken.push(file + ' — файла нет');
      continue;
    }
    console.log('\n=== ' + title + ' (' + file + ') ===');

    let out = '', code = 0;
    try {
      out = execFileSync(process.execPath, [full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
      code = (typeof e.status === 'number') ? e.status : 1;
    }
    process.stdout.write(out);

    const r = evaluateSuite(out, code);
    if (r.ok) {
      totalPass += r.pass;
    } else if (r.fail > 0) {
      // Сюита отработала корректно, но часть проверок провалена:
      // её числа достоверны и попадают в счёт.
      totalPass += r.pass;
      totalFail += r.fail;
      broken.push(file + ' — ' + r.reason);
    } else {
      // Сюите верить нельзя: числа НЕ учитываем, чтобы молча не уменьшить итог.
      console.log('  !! СЮИТА НЕДОСТОВЕРНА: ' + r.reason);
      broken.push(file + ' — ' + r.reason);
    }
  }

  console.log('\n============================================');
  console.log('ВСЕГО: ' + totalPass + ' пройдено, ' + totalFail + ' провалено');
  if (broken.length) {
    console.log('--------------------------------------------');
    console.log('ПРОБЛЕМНЫЕ СЮИТЫ (' + broken.length + '):');
    broken.forEach(function (b) { console.log('  - ' + b); });
  }
  console.log('============================================');
  process.exit(broken.length > 0 ? 1 : 0);
}

module.exports = { evaluateSuite, SUMMARY_RE, FILES };

if (require.main === module) main();

// Единая точка запуска: node tests/run.js  (или npm test)
// Зависимостей нет — только стандартный Node.
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
  ['R. ПРИВАТНОСТЬ ПРИГЛАШЕНИЯ (BUG №1)', 'invite-privacy.test.js']
];

let totalPass = 0, totalFail = 0, hardFail = false;
for (const [title, file] of FILES) {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) { console.log('ПРОПУЩЕН (нет файла): ' + file); hardFail = true; continue; }
  console.log('\n=== ' + title + ' (' + file + ') ===');
  let out = '';
  try {
    out = execFileSync(process.execPath, [full], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
    hardFail = true;
  }
  process.stdout.write(out);
  const m = out.match(/ИТОГ[^:]*:\s*(\d+)\s*\/\s*(\d+)/);
  if (m) {
    totalPass += Number(m[1]);
    totalFail += Number(m[2]) - Number(m[1]);
  } else {
    const p = (out.match(/✅/g) || []).length, f = (out.match(/❌/g) || []).length;
    totalPass += p; totalFail += f;
    if (p + f === 0) hardFail = true;
  }
}
console.log('\n============================================');
console.log('ВСЕГО: ' + totalPass + ' пройдено, ' + totalFail + ' провалено');
console.log('============================================');
process.exit((totalFail > 0 || hardFail) ? 1 : 0);

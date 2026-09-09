// №33: dead code cleanup -- статический guard по РЕАЛЬНЫМ исходникам.
//
// Две задачи, одинаково важные:
// (1) удалённые символы действительно не вернулись;
// (2) scope не расползся -- то, что аудит признал ЖИВЫМ (GROUP_ID и его
//     runtime use-sites, App Check backoff state), осталось на месте.
// Второе не менее важно первого: удалить лишнее здесь опаснее, чем не
// удалить достаточно.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.mjs'), 'utf8');

function wordCount(src, word) {
  return (src.match(new RegExp('\\b' + word + '\\b', 'g')) || []).length;
}

console.log('=== 1. удалённые символы отсутствуют в production source ===');

const REMOVED_FROM_SCRIPT = [
  'statsMySummary',
  'statsLeaderboardLosses',
  'ELO_MAX_WRITE_ATTEMPTS',
  'matchmakingDecisionMade',
  'isMatchmakingResolved',
  'isMyOwnBotGameRoom'
];
for (const sym of REMOVED_FROM_SCRIPT) {
  check(`${sym} отсутствует в script.js`, wordCount(SCRIPT, sym) === 0,
    'найдено вхождений: ' + wordCount(SCRIPT, sym));
}
check('appCheckLastError отсутствует в worker/index.mjs', wordCount(WORKER, 'appCheckLastError') === 0,
  'найдено вхождений: ' + wordCount(WORKER, 'appCheckLastError'));

console.log('=== 1b. осиротевшие комментарии удалённых символов не остались ===');

// Привязка к смысловому якорю, а не к полному тексту: проверяем только,
// что комментарий, описывавший УДАЛЁННУЮ константу, исчез вместе с ней.
check('нет комментария, описывающего удалённый ELO_MAX_WRITE_ATTEMPTS',
  !/ограничиваем число попыток вместо бесконечного повтора/.test(SCRIPT));
check('нет комментария, описывающего удалённый matchmaking-флаг',
  !/гонки условий в матчмейкинге/.test(SCRIPT));

console.log('=== 2. SCOPE GUARD: GROUP_ID жив (3 runtime-чтения доказаны аудитом) ===');

check('GROUP_ID declaration на месте', /const GROUP_ID = /.test(SCRIPT));
const groupIdUses = (SCRIPT.match(/groupId: GROUP_ID/g) || []).length;
check('минимум 3 runtime use-site `groupId: GROUP_ID` сохранены',
  groupIdUses >= 3, 'найдено: ' + groupIdUses);

console.log('=== 3. SCOPE GUARD: App Check backoff state (№26/№27) не задет ===');

check('appCheckFailureCount остался', wordCount(WORKER, 'appCheckFailureCount') > 0);
check('appCheckFailUntilMs остался', wordCount(WORKER, 'appCheckFailUntilMs') > 0);
check('safe (код ошибки для логирования) по-прежнему используется в appCheckLog',
  /const safe = allowed\.indexOf\(code\)/.test(WORKER) && /line = prefix \+ " error=" \+ safe/.test(WORKER));
check('console.error в appCheckLog сохранён', /console\.error\(line\)/.test(WORKER));
check('backoff-константы на месте',
  /APPCHECK_BACKOFF_MIN_MS/.test(WORKER) && /APPCHECK_BACKOFF_MAX_MS/.test(WORKER));

console.log('=== 4. SCOPE GUARD: прочие символы, признанные живыми, не удалены ===');

for (const sym of ['RATED_JOIN_TRANSIENT_ERRORS', 'opponentLeftText', 'offlineOpponentText']) {
  check(`${sym} остался в script.js`, wordCount(SCRIPT, sym) > 0);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

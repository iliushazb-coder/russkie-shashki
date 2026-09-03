const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
let passed = 0, failed = 0;

function check(name, condition, info) {
    if (condition) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? ' — ' + info : '')); }
}

function grab(name) {
    const m = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + name);
    return m[0];
}

console.log('=== №10. ELO СЧИТАЕТ ТОЛЬКО WORKER ===');

check('N10.1 клиентский computeEloDeltas удалён',
    !/\bfunction\s+computeEloDeltas\s*\(/.test(SRC));
check('N10.2 клиентский ELO_K удалён', !/\bELO_K\b/.test(SRC));
check('N10.3 normalizeEloRating сохранён для UI/leaderboard',
    /\bfunction\s+normalizeEloRating\s*\(/.test(SRC));
check('N10.4 старый getEloMatchContext удалён',
    !/\bgetEloMatchContext\b/.test(SRC));

const rated = grab('isRatedMatchReadyForSettlement');
check('N10.5 сохранены online/bot/spectator guards',
    /!isOnlineGame \|\| isBotGame \|\| isSpectator/.test(rated));
check('N10.6 сохранены room/user/winner guards',
    /!roomCode \|\| !myTelegramId/.test(rated)
    && /!currentState \|\| !currentState\.winner/.test(rated));
check('N10.7 сохранены participant и distinct-player guards',
    /!lightId \|\| !darkId \|\| lightId === darkId/.test(rated)
    && /myTelegramId !== lightId && myTelegramId !== darkId/.test(rated));
check('N10.8 серверная регистрация остаётся обязательной',
    /registeredMatchIdForState\(currentState, roomCode\)/.test(rated));
check('N10.9 результат валидируется без расчёта Elo',
    /result === "light" \|\| result === "dark" \|\| result === "draw"/.test(rated));

const record = grab('recordGameResult');
check('N10.10 rated flow вызывает server settlement через boolean-check',
    /if \(isRatedMatchReadyForSettlement\(\)\) \{[\s\S]{0,160}requestSettlement\(\);[\s\S]{0,80}return;/.test(record));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

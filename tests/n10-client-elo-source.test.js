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

const ratedSource = grab('isRatedMatchReadyForSettlement');
check('N10.5 сохранены online/bot/spectator guards',
    /!isOnlineGame \|\| isBotGame \|\| isSpectator/.test(ratedSource));
check('N10.6 сохранены room/user/winner guards',
    /!roomCode \|\| !myTelegramId/.test(ratedSource)
    && /!currentState \|\| !currentState\.winner/.test(ratedSource));
check('N10.7 сохранены participant и distinct-player guards',
    /!lightId \|\| !darkId \|\| lightId === darkId/.test(ratedSource)
    && /myTelegramId !== lightId && myTelegramId !== darkId/.test(ratedSource));
check('N10.8 серверная регистрация остаётся обязательной',
    /registeredMatchIdForState\(currentState, roomCode\)/.test(ratedSource));
check('N10.9 результат валидируется без расчёта Elo',
    /result === "light" \|\| result === "dark" \|\| result === "draw"/.test(ratedSource));

const record = grab('recordGameResult');
check('N10.10 rated flow вызывает server settlement через boolean-check',
    /if \(isRatedMatchReadyForSettlement\(\)\) \{[\s\S]{0,160}requestSettlement\(\);[\s\S]{0,80}return;/.test(record));

// Поведенческая проверка: исполняем реальные production-функции, а не только regex.
const buildEloMatchId = eval('(' + grab('buildEloMatchId') + ')');
const expectedRatedMatchIdForState = eval('(' + grab('expectedRatedMatchIdForState') + ')');
const registeredMatchIdForState = eval('(' + grab('registeredMatchIdForState') + ')');

let isOnlineGame = true;
let isBotGame = false;
let isSpectator = false;
let roomCode = 'ROOM1';
let myTelegramId = 'tg_101';
let currentState = null;
const isRatedMatchReadyForSettlement = eval('(' + ratedSource + ')');

function makeRatedState(winner) {
    const state = {
        winner: winner || 'light',
        createdAt: 1700000000000,
        matchNumber: 2,
        players: {
            light: { id: 'tg_101' },
            dark: { id: 'tg_202' }
        },
        ratingsAtStart: { light: 1000, dark: 1000 }
    };
    state.ratedMatchId = buildEloMatchId(roomCode, state.createdAt, state.matchNumber);
    return state;
}

function resetValid() {
    isOnlineGame = true;
    isBotGame = false;
    isSpectator = false;
    roomCode = 'ROOM1';
    myTelegramId = 'tg_101';
    currentState = makeRatedState('light');
}

console.log('\n=== №10. ПОВЕДЕНЧЕСКИЕ GUARDS ===');
resetValid();
check('N10.B1 валидный участник registered rated-партии -> true',
    isRatedMatchReadyForSettlement() === true);

resetValid(); isSpectator = true;
check('N10.B2 зритель -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); isBotGame = true;
check('N10.B3 bot-партия -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); isOnlineGame = false;
check('N10.B4 не-online партия -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); myTelegramId = 'tg_999';
check('N10.B5 посторонний UID -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); currentState.players.dark.id = 'tg_101';
check('N10.B6 одинаковые игроки -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); currentState.ratedMatchId = null;
check('N10.B7 нет server ratedMatchId -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); currentState.ratedMatchId = 'elo_stale_generation';
check('N10.B8 stale ratedMatchId -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); delete currentState.ratingsAtStart.dark;
check('N10.B9 неполный ratingsAtStart -> false', isRatedMatchReadyForSettlement() === false);

resetValid(); currentState = makeRatedState('draw');
check('N10.B10 зарегистрированная ничья -> true', isRatedMatchReadyForSettlement() === true);

resetValid(); currentState = makeRatedState('unexpected');
check('N10.B11 неизвестный winner -> false', isRatedMatchReadyForSettlement() === false);

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

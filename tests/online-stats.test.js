// ==========================================================================
// ONLINE STATS: КЛИЕНТ БОЛЬШЕ НЕ ПИШЕТ ИХ ВООБЩЕ.
//
// До v194 клиент писал wins/losses сам, и сюита проверяла корректность
// этой записи. В C1 запись ушла на сервер, поэтому проверяется обратное:
// онлайновый путь НЕ трогает stats ни при каких условиях, а ветка бота
// работает как раньше.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(n, c, i) {
    if (c) { passed++; console.log('  ✅ ' + n); }
    else { failed++; console.log('  ❌ ' + n + (i ? '  — ' + i : '')); }
}
function grab(n) {
    const m = new RegExp('^(?:async )?function ' + n + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}

// --- поведенческая часть: гоняем настоящий recordGameResult ---
let writes = [];
const chain = {
    transaction: function (fn) {
        writes.push(this.__path);
        const r = fn(null);
        return Promise.resolve({ committed: r !== undefined, snapshot: { val: () => r } });
    },
    set: function () { writes.push(this.__path); return Promise.resolve(); },
    update: function () { writes.push(this.__path); return Promise.resolve(); },
    once: () => Promise.resolve({ val: () => null })
};
global.database = { ref: function (p) { const c = Object.create(chain); c.__path = p; return c; } };
global.firebase = { database: { ServerValue: { TIMESTAMP: 'TS' } } };
global.myTelegramId = 'tg_101';
global.myTelegramName = 'Аня';
global.isSpectator = false;
global.statsInFlightForRoom = null;
global.statsInFlightOnlineMarker = null;
global.statsRecordedForRoom = null;
global.currentBotMatchId = 'bot_1';
global.botDifficulty = 'hard';
global.myColor = 'light';
['renderPlayerPanels','renderEndGameModal','updateBotStatsUI','showInfoModal']
    .forEach(n => { if (!global[n]) global[n] = function () {}; });
global.t = k => k;
global.canUseFirebase = () => true;
global.localOnlyBotGame = false;
global.recordBotGameResultIdempotent = function () {
    global.database.ref('statsBot/' + global.myTelegramId).transaction(function (c) { return c || {}; });
    return Promise.resolve();
};
global.firebaseAuthReady = true;
global.roomCode = 'R';
global.auth = { currentUser: { uid: 'tg_101' } };
global.requestSettlement = function () {};
global.getEloMatchContext = () => null;
global.TECHNICAL_WIN_REASON = 'disconnect';
global.resolveMyOnlineResult = () => 'win';

eval(grab('recordGameResult'));

console.log('=== 1. ОНЛАЙН НЕ ПИШЕТ stats ===');
{
    global.isOnlineGame = true; global.isBotGame = false;
    global.currentState = { winner: 'light', matchNumber: 0, moveCount: 40,
        players: { light: { id: 'tg_101' }, dark: { id: 'tg_202' } } };
    global.isLocalStateOptimistic = false;
    writes = []; global.statsInFlightOnlineMarker = 'm1';
    recordGameResult('m1');
    const statWrites = writes.filter(p => String(p).indexOf('stats/') === 0);
    check('1.1 победа: ни одной записи в stats', statWrites.length === 0, JSON.stringify(writes));
    check('1.2 маркер освобождён для повтора', global.statsInFlightOnlineMarker === null);

    writes = []; global.resolveMyOnlineResult = () => 'loss';
    global.statsInFlightOnlineMarker = 'm2';
    recordGameResult('m2');
    check('1.3 поражение: тоже ничего', writes.filter(p => String(p).indexOf('stats/') === 0).length === 0);

    writes = []; global.currentState.winner = 'draw';
    global.statsInFlightOnlineMarker = 'm3';
    recordGameResult('m3');
    check('1.4 ничья: тоже ничего', writes.filter(p => String(p).indexOf('stats/') === 0).length === 0);
    check('1.5 ничья без pointer освобождает marker для позднего ratedMatchId', global.statsInFlightOnlineMarker === null);
}

console.log('\n=== 2. ЗРИТЕЛЬ ===');
{
    global.isSpectator = true; writes = [];
    global.currentState.winner = 'light';
    recordGameResult('m4');
    check('2.1 зритель не пишет ничего', writes.length === 0, JSON.stringify(writes));
    global.isSpectator = false;
}

console.log('\n=== 3. ВЕТКА БОТА НЕ ЗАТРОНУТА ===');
{
    global.isOnlineGame = false; global.isBotGame = true;
    global.currentState = { winner: 'light', moveCount: 30 };
    writes = []; global.statsInFlightForRoom = 'bot_1';
    recordGameResult();
    const botWrites = writes.filter(p => String(p).indexOf('statsBot/') === 0);
    check('3.1 бот по-прежнему пишет statsBot', botWrites.length > 0, JSON.stringify(writes));
    check('3.2 и НЕ пишет в stats',
        writes.filter(p => String(p).indexOf('stats/') === 0).length === 0);
}

console.log('\n=== 4. СТАТИЧЕСКИЕ ГАРАНТИИ ===');
{
    const r = grab('recordGameResult');
    check('4.1 прямой stats write удалён из recordGameResult',
        r.indexOf('database.ref(statsPath') === -1
        && r.indexOf('database.ref("stats/') === -1,
        'C1 не должен даже хранить мёртвый fallback direct-write');
    check('4.2 клиент не пишет eloMatches', !/updates\["eloMatches\//.test(SRC));
    check('4.3 клиент не пишет stats через multi-update', !/updates\["stats\//.test(SRC));
    check('4.4 расчёт запрашивается у сервера', /requestSettlement\(\)/.test(SRC));
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

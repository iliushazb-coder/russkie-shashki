// COINS / ECONOMY (Этап 2) — regression-тесты.
//
// ЧТО ЗАПУСКАЕТСЯ ПО-НАСТОЯЩЕМУ: реальные функции из script.js —
// normalizeEconomy, awardCoinsForMatch, getCurrentCoinReward,
// getCurrentRewardMatchId, recordCoinResultOnce, renderBotStatsRow,
// getEloMatchContext (только читается), claimWelcomeBonus/claimDailyBonus.
//
// ЧТО МОКИРУЕТСЯ: Firebase database (in-memory с настоящей семантикой
// transaction: return undefined => отмена), DOM.
//
// ГЛАВНОЕ СВОЙСТВО, КОТОРОЕ ЗДЕСЬ ПРОВЕРЯЕТСЯ: одна партия оплачивается
// РОВНО один раз на игрока, а игры против бота не создают в economy вообще
// ничего. Каждый клиент платит только СЕБЕ (economy/<свой id>), поэтому
// "два клиента" здесь — это два устройства ОДНОГО аккаунта.
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

let DB, READS, TX_ABORTED;

function getPath(path) {
    const parts = path.split('/').filter(Boolean);
    let node = DB;
    for (const p of parts) {
        if (node === undefined || node === null) return null;
        node = node[p];
    }
    return node === undefined ? null : node;
}
function setPath(path, value) {
    const parts = path.split('/').filter(Boolean);
    let node = DB;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
}

let FAIL_ECONOMY_TX = false;

function makeRef(path) {
    return {
        once: function () {
            READS.push(path);
            return Promise.resolve({ val: function () { return getPath(path); } });
        },
        set: function (v) { setPath(path, v); return Promise.resolve(); },
        update: function (v) { return Promise.resolve(); },
        orderByChild: function () { return this; },
        limitToLast: function () { return this; },
        transaction: function (fn) {
            if (FAIL_ECONOMY_TX && path.indexOf('economy/') === 0) {
                return Promise.reject(new Error('economy write failed'));
            }
            const next = fn(getPath(path));
            if (next === undefined) {
                TX_ABORTED++;
                return Promise.resolve({ committed: false, snapshot: { val: function () { return getPath(path); } } });
            }
            setPath(path, JSON.parse(JSON.stringify(next)));
            return Promise.resolve({ committed: true, snapshot: { val: function () { return getPath(path); } } });
        }
    };
}

global.firebase = { database: { ServerValue: { TIMESTAMP: 1700000000000, increment: function (d) { return { __inc: d }; } } } };
global.database = { ref: function (p) { return makeRef(p === undefined ? '' : p); } };

function stubEl() {
    return {
        className: '', textContent: '', children: [], style: {},
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; }, toggle: function () {} },
        appendChild: function (c) { this.children.push(c); return c; },
        addEventListener: function () {}, setAttribute: function () {}
    };
}

// ===== Загрузка реального кода =====
let loadError = null;
const REWARDS = {};
try {
    const block = /const COIN_REWARDS = \{([\s\S]*?)\n\};/.exec(SRC)[1];
    block.replace(/(\w+):\s*(-?\d+)/g, function (_, k, v) { REWARDS[k] = Number(v); return ''; });
    global.COIN_REWARDS = REWARDS;
    global.ELO_START_RATING = Number(/const ELO_START_RATING = (\d+);/.exec(SRC)[1]);
    global.ELO_K = Number(/const ELO_K = (\d+);/.exec(SRC)[1]);
    eval(extractFunc('normalizeEconomy'));
    eval(extractFunc('normalizeEloRating'));
    eval(extractFunc('computeEloDeltas'));
    eval(extractFunc('buildEloMatchId'));
    eval(extractFunc('getEloMatchContext'));
    eval(extractFunc('awardCoinsForMatch'));
    eval(extractFunc('getCurrentCoinReward'));
    eval(extractFunc('getCurrentRewardMatchId'));
    eval(extractFunc('recordCoinResultOnce'));
    eval(extractFunc('renderRankAndName'));
    eval(extractFunc('renderBotStatsRow'));
} catch (e) { loadError = e.message; }

function reset() {
    DB = { economy: {}, stats: {}, rooms: {} };
    READS = []; TX_ABORTED = 0; FAIL_ECONOMY_TX = false;
    global.myTelegramId = 'tg_1'; global.myTelegramName = 'Light Player';
    global.myColor = 'light'; global.roomCode = 'ROOM1';
    global.isOnlineGame = true; global.isBotGame = false; global.isSpectator = false;
    global.isLocalStateOptimistic = false;
    global.botDifficulty = 'hard'; global.currentBotMatchId = null;
    global.currentCoinBalance = 0;
    global.coinRewardAttemptForMatch = null;
    global.currentState = null;
    global.showCoinPopup = function () {};
    global.t = function (k) { return k; };
    global.updateCoinBalanceUI = function (b) { global.currentCoinBalance = b; };
    global.document = {
        createElement: function () { return stubEl(); },
        getElementById: function () { return stubEl(); },
        createTextNode: function (t) { return { nodeValue: t, textContent: t }; }
    };
}

function ratedState(winner, matchNumber) {
    return {
        winner: winner, moveCount: 40,
        matchNumber: (typeof matchNumber === 'number') ? matchNumber : 0,
        createdAt: 1700000000000,
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } },
        ratingsAtStart: { light: 1000, dark: 1000 }
    };
}
function legacyState(winner, matchNumber) {
    const s = ratedState(winner, matchNumber);
    s.ratingsAtStart = null; // комната старого клиента
    return s;
}
const E = () => DB.economy.tg_1 || {};

(async function () {
    if (loadError) {
        check('0. функции economy присутствуют в script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exit(1);
    }

    // =================================================================
    console.log('НОМИНАЛЫ');
    // =================================================================
    check('1a. online: победа +20', REWARDS.onlineWin === 20);
    check('1b. online: ничья +10', REWARDS.onlineDraw === 10);
    check('1c. online: поражение +5 (монеты больше НЕ отнимаются)',
        REWARDS.onlineLoss === 5);
    check('1d. welcome +500 и daily +25 сохранены',
        REWARDS.welcome === 500 && REWARDS.daily === 25);
    check('1e. ВСЕ bot-номиналы обнулены', (function () {
        return Object.keys(REWARDS).filter(function (k) { return k.indexOf('bot') === 0; })
            .every(function (k) { return REWARDS[k] === 0; });
    })());

    // =================================================================
    console.log('ONLINE: КТО СКОЛЬКО ПОЛУЧАЕТ');
    // =================================================================
    // Каждый клиент платит только СЕБЕ, поэтому проверяем обе роли отдельно.
    reset();
    global.currentState = ratedState('light');
    global.myColor = 'light';
    check('2. победитель (light) видит награду +20', getCurrentCoinReward() === 20);
    global.myColor = 'dark'; global.myTelegramId = 'tg_2';
    check('3. проигравший (dark) видит награду +5', getCurrentCoinReward() === 5);

    reset();
    global.currentState = ratedState('dark');
    global.myColor = 'light';
    check('4. при победе dark: light получает +5', getCurrentCoinReward() === 5);
    global.myColor = 'dark'; global.myTelegramId = 'tg_2';
    check('5. при победе dark: dark получает +20', getCurrentCoinReward() === 20);

    reset();
    global.currentState = ratedState('draw');
    global.myColor = 'light';
    const drawLight = getCurrentCoinReward();
    global.myColor = 'dark'; global.myTelegramId = 'tg_2';
    check('6. ничья: +10 КАЖДОМУ', drawLight === 10 && getCurrentCoinReward() === 10);

    // =================================================================
    console.log('ФАКТИЧЕСКАЯ ВЫПЛАТА');
    // =================================================================
    reset();
    DB.economy.tg_1 = { name: 'L', balance: 300, lifetimeEarned: 800, lifetimeSpent: 120, lastDailyClaim: '2026-08-01', welcomeClaimed: true, rewardedMatches: {} };
    global.currentState = ratedState('light');
    recordCoinResultOnce();
    await tick();
    check('7. balance увеличился ровно на 20', E().balance === 320, String(E().balance));
    check('8. lifetimeEarned увеличился на 20', E().lifetimeEarned === 820, String(E().lifetimeEarned));
    check('9. lifetimeSpent НЕ изменился матчем', E().lifetimeSpent === 120);
    check('10. rewardedMatches получил Elo matchId', (function () {
        const keys = Object.keys(E().rewardedMatches || {});
        return keys.length === 1 && keys[0] === 'elo_ROOM1_1700000000000_0' && E().rewardedMatches[keys[0]] === true;
    })(), JSON.stringify(E().rewardedMatches));

    // повтор той же партии — без повторной выплаты
    global.coinRewardAttemptForMatch = null;
    recordCoinResultOnce();
    await tick();
    check('11. повтор той же партии: баланс не изменился', E().balance === 320);
    check('12. transaction была отменена сервером (дедуп сработал)', TX_ABORTED === 1);

    // два устройства одного аккаунта: у второго своя память, локальный флаг пуст
    global.coinRewardAttemptForMatch = null;
    recordCoinResultOnce();
    await tick();
    global.coinRewardAttemptForMatch = null;
    recordCoinResultOnce();
    await tick();
    check('13. два устройства одного аккаунта не удваивают награду', E().balance === 320);

    // reconnect: тот же matchId, состояние перечитано с сервера
    global.coinRewardAttemptForMatch = null;
    global.currentState = ratedState('light'); // как после reconnect
    recordCoinResultOnce();
    await tick();
    check('14. reconnect не даёт повторную выплату', E().balance === 320);

    // rematch: новый matchNumber -> новый matchId -> новая выплата ОДИН раз
    global.coinRewardAttemptForMatch = null;
    global.currentState = ratedState('dark', 1); // реванш, я проиграл
    recordCoinResultOnce();
    await tick();
    check('15. rematch: новая выплата (+5 за поражение)', E().balance === 325, String(E().balance));
    check('16. rewardedMatches содержит ОБА matchId, второй с matchNumber=1', (function () {
        const keys = Object.keys(E().rewardedMatches || {}).sort();
        return keys.length === 2 &&
            keys.indexOf('elo_ROOM1_1700000000000_0') !== -1 &&
            keys.indexOf('elo_ROOM1_1700000000000_1') !== -1;
    })(), JSON.stringify(Object.keys(E().rewardedMatches || {})));

    // ничья реально начисляет обоим по 10
    reset();
    DB.economy.tg_1 = { name: 'L', balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, lastDailyClaim: '', welcomeClaimed: true, rewardedMatches: {} };
    global.currentState = ratedState('draw');
    recordCoinResultOnce();
    await tick();
    check('17. ничья фактически начисляет +10', E().balance === 10 && E().lifetimeEarned === 10);

    // =================================================================
    console.log('MATCH ID: РЕЙТИНГОВАЯ vs LEGACY КОМНАТА');
    // =================================================================
    reset();
    global.currentState = ratedState('light');
    check('18. рейтинговая комната -> Elo matchId',
        getCurrentRewardMatchId() === 'elo_ROOM1_1700000000000_0', getCurrentRewardMatchId());

    reset();
    global.currentState = legacyState('light');
    check('19. legacy-комната без снимка -> СТАРЫЙ economy matchId',
        getCurrentRewardMatchId() === 'online_ROOM1_0', getCurrentRewardMatchId());

    reset();
    global.currentState = legacyState('light');
    global.currentState.ratingsAtStart = { light: 1000 }; // половина снимка
    check('20. неполный снимок -> тоже старый ID (не рейтинговая)',
        getCurrentRewardMatchId() === 'online_ROOM1_0');

    check('21. пространства ключей не пересекаются (переходное окно безопасно)',
        'elo_ROOM1_1700000000000_0'.indexOf('online_') !== 0 &&
        'online_ROOM1_0'.indexOf('elo_') !== 0);

    // legacy-комната реально оплачивается по старому ключу
    reset();
    DB.economy.tg_1 = { name: 'L', balance: 0, lifetimeEarned: 0, lifetimeSpent: 0, lastDailyClaim: '', welcomeClaimed: true, rewardedMatches: {} };
    global.currentState = legacyState('light');
    recordCoinResultOnce();
    await tick();
    check('22. legacy-партия оплачена ровно один раз по старому ключу',
        E().balance === 20 && Object.keys(E().rewardedMatches)[0] === 'online_ROOM1_0');

    // =================================================================
    console.log('БОТ: НОЛЬ МОНЕТ ВСЕГДА');
    // =================================================================
    for (const level of ['easy', 'medium', 'hard']) {
        for (const res of ['win', 'loss', 'draw']) {
            reset();
            global.isBotGame = true; global.isOnlineGame = false;
            global.botDifficulty = level;
            global.currentBotMatchId = 'bot_' + level + '_1';
            DB.economy.tg_1 = { name: 'L', balance: 500, lifetimeEarned: 500, lifetimeSpent: 0, lastDailyClaim: '', welcomeClaimed: true, rewardedMatches: {} };
            global.currentState = {
                winner: res === 'win' ? 'light' : (res === 'loss' ? 'dark' : 'draw'),
                moveCount: 30, players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'bot', name: 'Bot' } }
            };
            const reward = getCurrentCoinReward();
            recordCoinResultOnce();
            await tick();
            check('23. бот ' + level + '/' + res + ': награды нет, economy не тронута',
                reward === null && E().balance === 500 && Object.keys(E().rewardedMatches).length === 0,
                'reward=' + reward + ' balance=' + E().balance);
        }
    }

    // bot rematch — тоже ноль
    reset();
    global.isBotGame = true; global.isOnlineGame = false;
    global.currentBotMatchId = 'bot_hard_2'; // реванш = новый bot matchId
    DB.economy.tg_1 = { name: 'L', balance: 500, lifetimeEarned: 500, lifetimeSpent: 0, lastDailyClaim: '', welcomeClaimed: true, rewardedMatches: {} };
    global.currentState = { winner: 'light', moveCount: 20, players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'bot', name: 'Bot' } } };
    recordCoinResultOnce();
    await tick();
    check('24. реванш с ботом: тоже ноль и никаких записей',
        E().balance === 500 && Object.keys(E().rewardedMatches).length === 0);

    check('25. бот не участвует в Elo-контексте (значит и в Elo matchId)', (function () {
        return getEloMatchContext() === null;
    })());

    // =================================================================
    console.log('ИЗОЛЯЦИЯ: ОШИБКА ECONOMY НЕ ЛОМАЕТ ELO/STATS');
    // =================================================================
    reset();
    DB.stats.tg_1 = { wins: 5, losses: 5, name: 'L', rating: 1016, draws: 0 };
    DB.eloMatches = { 'elo_ROOM1_1700000000000_0': { result: 'light' } }; // Elo уже записан
    global.currentState = ratedState('light');
    FAIL_ECONOMY_TX = true;
    let threw = false;
    try { recordCoinResultOnce(); await tick(); } catch (e) { threw = true; }
    check('26. падение economy не выбрасывает исключение наверх', !threw);
    check('27. уже записанные Elo и stats не пострадали',
        DB.stats.tg_1.rating === 1016 && DB.stats.tg_1.wins === 5 &&
        !!DB.eloMatches['elo_ROOM1_1700000000000_0']);
    check('28. после сетевой ошибки повтор разрешён (локальный флаг снят)',
        global.coinRewardAttemptForMatch === null);

    // зритель не платит
    reset();
    global.isSpectator = true;
    DB.economy.tg_1 = { name: 'L', balance: 100, lifetimeEarned: 100, lifetimeSpent: 0, lastDailyClaim: '', welcomeClaimed: true, rewardedMatches: {} };
    global.currentState = ratedState('light');
    recordCoinResultOnce();
    await tick();
    check('29. зритель монет не получает', E().balance === 100);

    // =================================================================
    console.log('WELCOME / DAILY НЕ СЛОМАНЫ');
    // =================================================================
    reset();
    const welcomeSrc = /function claimWelcomeCoins[\s\S]*?\n}/.exec(SRC);
    check('30. welcome-бонус по-прежнему опирается на welcomeClaimed и COIN_REWARDS.welcome',
        !!welcomeSrc && /economy\.welcomeClaimed/.test(welcomeSrc[0]) && /COIN_REWARDS\.welcome/.test(welcomeSrc[0]));
    const dailySrc = /function claimDailyCoins[\s\S]*?\n}/.exec(SRC);
    check('31. daily-бонус по-прежнему опирается на lastDailyClaim и COIN_REWARDS.daily',
        !!dailySrc && /lastDailyClaim/.test(dailySrc[0]) && /COIN_REWARDS\.daily/.test(dailySrc[0]));
    check('32. Этап 2 не тронул awardCoinsForMatch (дедуп + атомарность на месте)',
        /if \(economy\.rewardedMatches\[matchId\] === true\) \{\s*\n\s*return;/.test(SRC) &&
        /economy\.rewardedMatches\[matchId\] = true;/.test(SRC));

    // normalizeEconomy не потеряла поля
    reset();
    const norm = normalizeEconomy({ balance: 42, lifetimeEarned: 100, lifetimeSpent: 7, lastDailyClaim: '2026-01-01', welcomeClaimed: true, rewardedMatches: { a: true } });
    check('33. normalizeEconomy сохраняет все существующие поля',
        norm.balance === 42 && norm.lifetimeEarned === 100 && norm.lifetimeSpent === 7 &&
        norm.lastDailyClaim === '2026-01-01' && norm.welcomeClaimed === true && norm.rewardedMatches.a === true);

    // =================================================================
    console.log('BOT LEADERBOARD БЕЗ МОНЕТ');
    // =================================================================
    reset();
    const botRow = renderBotStatsRow(1, 'Player', 7, 3, { medium: { wins: 4, losses: 1 } });
    const botText = botRow.children[0].children[1].textContent;
    check('34. строка bot-рейтинга НЕ содержит 🪙', botText.indexOf('🪙') === -1, botText);
    check('35. строка bot-рейтинга сохранила 🏆 ❌ 🎮',
        botText.indexOf('🏆7') !== -1 && botText.indexOf('❌3') !== -1 && botText.indexOf('🎮10') !== -1, botText);
    check('36. openStatsModal больше не читает economy для bot-топа',
        !/database\.ref\("economy\/" \+ entry\.id \+ "\/balance"\)/.test(SRC));
    check('37. игровая панель ПРОДОЛЖАЕТ показывать общий баланс (statusForColor)',
        /const coinsPart = \(stats && typeof stats\.coins === "number"\) \? \(" · 🪙" \+ stats\.coins\) : "";/.test(SRC) &&
        /database\.ref\("economy\/" \+ id \+ "\/balance"\)/.test(SRC));
    check('38. капсула общего баланса в интерфейсе не тронута',
        /function updateCoinBalanceUI/.test(SRC) && /coin-balance-value/.test(SRC));

    // =================================================================
    console.log('ELO НЕ ИЗМЕНЁН ЭТАПОМ 2');
    // =================================================================
    check('39. Elo-функции не содержат обращений к economy/монетам', (function () {
        const names = ['computeEloDeltas', 'buildEloMatchId', 'getEloMatchContext',
            'ensureMyRatingSnapshot', 'recordEloMatchResult', 'ensureStatsInitialized'];
        return names.every(function (n) {
            const m = new RegExp('function ' + n + '[\\s\\S]*?\\n}').exec(SRC);
            return m && !/economy|COIN_REWARDS|awardCoins/.test(m[0]);
        });
    })());
    check('40. receipt и снимок рейтингов на месте',
        /updates\["eloMatches\/" \+ ctx\.matchId\]/.test(SRC) &&
        /updates\["ratingsAtStart"\] = null;/.test(SRC));
    check('41. Elo-ветка recordGameResult не тронута',
        /const eloCtx = getEloMatchContext\(\);\s*\n\s*if \(eloCtx\) \{\s*\n\s*recordEloMatchResult\(eloCtx, onlineMarker\);/.test(SRC));
    check('42. presence-фиксы v171 по-прежнему на месте',
        /onDisconnect\(\)\.update\(\{ online: false \}\);/.test(SRC) &&
        /roomCode && !document\.hidden/.test(SRC));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

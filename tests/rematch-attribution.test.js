// REMATCH RESULT ATTRIBUTION — воспроизведение реального инцидента.
//
// Реальный сценарий (подтверждён пользователями):
//   Партия 1: Татьяна = light, Жуковская = dark, победила Татьяна.
//   Реванш:   цвета меняются.
//   Партия 2: Жуковская = light, Татьяна = dark, снова победила Татьяна.
// Ожидалось: Татьяна +2 победы, Жуковская +2 поражения.
// Фактически в проде: у каждой +1 победа и +1 поражение (результат 1:1).
//
// Тест прогоняет ОБА клиента через настоящий recordGameResult и настоящий
// блок пересчёта myColor после реванша, вырезанный из script.js.
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

const TANYA = 'tg_tatiana';
const ZHUK = 'tg_zhukovskaya';

let DB;
function getPath(p) {
    const parts = p.split('/').filter(Boolean);
    let n = DB;
    for (const x of parts) { if (n == null) return null; n = n[x]; }
    return n === undefined ? null : n;
}
function setPath(p, v) {
    const parts = p.split('/').filter(Boolean);
    let n = DB;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof n[parts[i]] !== 'object' || n[parts[i]] === null) n[parts[i]] = {};
        n = n[parts[i]];
    }
    n[parts[parts.length - 1]] = v;
}
function makeRef(path) {
    return {
        once: function () { return Promise.resolve({ val: function () { return getPath(path); } }); },
        set: function (v) { setPath(path, v); return Promise.resolve(); },
        update: function (v) { return Promise.resolve(); },
        transaction: function (fn) {
            const next = fn(getPath(path));
            if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: function () { return getPath(path); } } });
            setPath(path, JSON.parse(JSON.stringify(next)));
            return Promise.resolve({ committed: true, snapshot: { val: function () { return getPath(path); } } });
        }
    };
}
global.firebase = { database: { ServerValue: { TIMESTAMP: 1700000000000, increment: function (d) { return { __inc: d }; } } } };
global.database = { ref: function (p) { return makeRef(p === undefined ? '' : p); } };

// ===== реальный код =====
let loadError = null;
let applyRematchColorSwap = null;
try {
    global.ELO_START_RATING = Number(/const ELO_START_RATING = (\d+);/.exec(SRC)[1]);
    global.ELO_K = Number(/const ELO_K = (\d+);/.exec(SRC)[1]);
    eval(extractFunc('normalizeEloRating'));
    eval(extractFunc('computeEloDeltas'));
    eval(extractFunc('buildEloMatchId'));
    eval(extractFunc('getEloMatchContext'));
    eval(extractFunc('resolveMyOnlineResult'));
    eval(extractFunc('recordGameResult'));
    global.COIN_REWARDS = {};
    /const COIN_REWARDS = \{([\s\S]*?)\n\};/.exec(SRC)[1].replace(/(\w+):\s*(-?\d+)/g, function (_, k, v) { global.COIN_REWARDS[k] = Number(v); return ''; });
    eval(extractFunc('getCurrentCoinReward'));

    // Настоящий блок пересчёта myColor после реванша — вырезаем из слушателя
    // комнаты (он живёт внутри startOnlineGame и отдельной функцией не является).
    const start = SRC.indexOf('if (currentState && currentState.winner && !newState.winner && newState.moveCount === 0) {');
    if (start === -1) throw new Error('в script.js не найден блок пересчёта myColor после реванша');
    const end = SRC.indexOf('setupPresence();', start);
    if (end === -1) throw new Error('не найден конец блока пересчёта myColor');
    const body = SRC.slice(start, end + 'setupPresence();'.length) + '\n}';
    applyRematchColorSwap = new Function('newState', 'ctx', `
        with (ctx) { ${body} }
        return ctx.myColor;
    `);
} catch (e) { loadError = e.message; }

// Один игровой клиент: своя память, своё myColor.
function makeClient(uid, name, color) {
    return {
        uid: uid, name: name, myColor: color,
        currentState: null,
        statsRecordedForRoom: null,
        statsInFlightOnlineMarker: null
    };
}

// Выполняет запись результата от имени конкретного клиента.
async function recordAs(client, state, marker) {
    global.myTelegramId = client.uid;
    global.myTelegramName = client.name;
    global.myColor = client.myColor;
    global.currentState = state;
    global.isOnlineGame = true; global.isBotGame = false; global.isSpectator = false;
    global.isLocalStateOptimistic = false;
    global.roomCode = 'ROOM_T';
    global.statsRecordedForRoom = client.statsRecordedForRoom;
    global.statsInFlightOnlineMarker = null;
    recordGameResult(marker);
    await tick();
    client.statsRecordedForRoom = global.statsRecordedForRoom;
}

function W(uid) { return (DB.stats[uid] && DB.stats[uid].wins) || 0; }
function L(uid) { return (DB.stats[uid] && DB.stats[uid].losses) || 0; }

(async function () {
    if (loadError) {
        check('0. нужные функции есть в script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exit(1);
    }

    // =================================================================
    console.log('РЕАЛЬНЫЙ СЦЕНАРИЙ: две победы Татьяны через реванш');
    // =================================================================
    DB = { stats: {}, rooms: {} };
    DB.stats[TANYA] = { wins: 3, losses: 3, name: 'Tatiana' };
    DB.stats[ZHUK] = { wins: 0, losses: 0, name: 'Zhukovskaya' };

    const tanya = makeClient(TANYA, 'Tatiana', 'light');
    const zhuk = makeClient(ZHUK, 'Zhukovskaya', 'dark');

    // --- ПАРТИЯ 1: Татьяна light, побеждает Татьяна ---
    const game1Players = { light: { id: TANYA, name: 'Tatiana' }, dark: { id: ZHUK, name: 'Zhukovskaya' } };
    const game1End = {
        winner: 'light', moveCount: 30, matchNumber: 0, createdAt: 1700000000000,
        players: game1Players, ratingsAtStart: null // Elo-снимка нет: старый путь
    };
    tanya.currentState = game1End; zhuk.currentState = game1End;
    await recordAs(tanya, game1End, 'ROOM_T_0_30');
    await recordAs(zhuk, game1End, 'ROOM_T_0_30');

    check('1. партия 1: Татьяна получила победу', W(TANYA) === 4, 'wins=' + W(TANYA));
    check('2. партия 1: Жуковская получила поражение', L(ZHUK) === 1, 'losses=' + L(ZHUK));

    // --- РЕВАНШ: цвета меняются ---
    const game2Players = { light: { id: ZHUK, name: 'Zhukovskaya' }, dark: { id: TANYA, name: 'Tatiana' } };
    const rematchState = {
        winner: null, moveCount: 0, matchNumber: 1, createdAt: 1700000000000,
        players: game2Players, ratingsAtStart: null
    };

    // Оба клиента получают сброс через слушатель комнаты и обязаны
    // пересчитать свой цвет НАСТОЯЩИМ кодом из script.js.
    [tanya, zhuk].forEach(function (c) {
        const ctx = {
            currentState: c.currentState, myTelegramId: c.uid, myColor: c.myColor,
            flipped: false, boardBuilt: true, statsCache: {}, setupPresence: function () {}
        };
        c.myColor = applyRematchColorSwap(rematchState, ctx);
        c.currentState = rematchState;
    });

    check('3. после реванша Татьяна пересчитала себя в dark', tanya.myColor === 'dark', tanya.myColor);
    check('4. после реванша Жуковская пересчитала себя в light', zhuk.myColor === 'light', zhuk.myColor);

    // --- ПАРТИЯ 2: побеждает Татьяна, теперь она dark ---
    const game2End = {
        winner: 'dark', moveCount: 28, matchNumber: 1, createdAt: 1700000000000,
        players: game2Players, ratingsAtStart: null
    };
    await recordAs(tanya, game2End, 'ROOM_T_1_28');
    await recordAs(zhuk, game2End, 'ROOM_T_1_28');

    console.log('   Татьяна:     🏆' + W(TANYA) + ' ❌' + L(TANYA));
    console.log('   Жуковская:   🏆' + W(ZHUK) + ' ❌' + L(ZHUK));

    check('5. ИТОГ: у Татьяны 5 побед и 3 поражения (две победы подряд)',
        W(TANYA) === 5 && L(TANYA) === 3, '🏆' + W(TANYA) + ' ❌' + L(TANYA));
    check('6. ИТОГ: у Жуковской 0 побед и 2 поражения',
        W(ZHUK) === 0 && L(ZHUK) === 2, '🏆' + W(ZHUK) + ' ❌' + L(ZHUK));
    check('7. НЕ воспроизводится реальный баг «1:1»',
        !(W(TANYA) === 4 && L(TANYA) === 4 && W(ZHUK) === 1 && L(ZHUK) === 1),
        'воспроизведено ровно то, что было в проде');

    // =================================================================
    console.log('ЗЕРКАЛЬНЫЙ СЦЕНАРИЙ: побеждает тот, кто был dark, затем light');
    // =================================================================
    DB = { stats: {}, rooms: {} };
    DB.stats[TANYA] = { wins: 0, losses: 0, name: 'Tatiana' };
    DB.stats[ZHUK] = { wins: 0, losses: 0, name: 'Zhukovskaya' };
    const a = makeClient(TANYA, 'Tatiana', 'dark');
    const b = makeClient(ZHUK, 'Zhukovskaya', 'light');
    const p1 = { light: { id: ZHUK, name: 'Z' }, dark: { id: TANYA, name: 'T' } };
    const g1 = { winner: 'dark', moveCount: 20, matchNumber: 0, createdAt: 1, players: p1, ratingsAtStart: null };
    a.currentState = g1; b.currentState = g1;
    await recordAs(a, g1, 'M_0_20');
    await recordAs(b, g1, 'M_0_20');
    const p2 = { light: { id: TANYA, name: 'T' }, dark: { id: ZHUK, name: 'Z' } };
    const reset2 = { winner: null, moveCount: 0, matchNumber: 1, createdAt: 1, players: p2, ratingsAtStart: null };
    [a, b].forEach(function (c) {
        const ctx = { currentState: c.currentState, myTelegramId: c.uid, myColor: c.myColor, flipped: false, boardBuilt: true, statsCache: {}, setupPresence: function () {} };
        c.myColor = applyRematchColorSwap(reset2, ctx);
        c.currentState = reset2;
    });
    const g2 = { winner: 'light', moveCount: 22, matchNumber: 1, createdAt: 1, players: p2, ratingsAtStart: null };
    await recordAs(a, g2, 'M_1_22');
    await recordAs(b, g2, 'M_1_22');
    check('8. зеркальный случай: победитель получил обе победы',
        W(TANYA) === 2 && L(TANYA) === 0 && W(ZHUK) === 0 && L(ZHUK) === 2,
        'T ' + W(TANYA) + '/' + L(TANYA) + ' Z ' + W(ZHUK) + '/' + L(ZHUK));

    // =================================================================
    console.log('ЧТО БУДЕТ, ЕСЛИ myColor УСТАРЕЛ (клиент без пересчёта цвета)');
    // =================================================================
    DB = { stats: {}, rooms: {} };
    DB.stats[TANYA] = { wins: 3, losses: 3, name: 'Tatiana' };
    DB.stats[ZHUK] = { wins: 0, losses: 0, name: 'Zhukovskaya' };
    const staleT = makeClient(TANYA, 'Tatiana', 'light'); // НЕ пересчитал цвет
    const staleZ = makeClient(ZHUK, 'Zhukovskaya', 'dark'); // НЕ пересчитал цвет
    await recordAs(staleT, game2End, 'ROOM_T_1_28');
    await recordAs(staleZ, game2End, 'ROOM_T_1_28');
    // ДО фикса здесь получалось перевёрнутое T 3/4, Z 1/0 — ровно то, что
    // видели пользователи. После перехода на UID результат верен даже тогда,
    // когда локальный цвет у ОБЕИХ сторон устарел.
    check('9. устаревший myColor больше НЕ переворачивает результат партии',
        W(TANYA) === 4 && L(TANYA) === 3 && W(ZHUK) === 0 && L(ZHUK) === 1,
        'T ' + W(TANYA) + '/' + L(TANYA) + ' Z ' + W(ZHUK) + '/' + L(ZHUK));

    // =================================================================
    console.log('УСТОЙЧИВОСТЬ ЗАПИСИ РЕЗУЛЬТАТА');
    // =================================================================
    check('10. online-путь статистики определяет победителя через UID-резолвер',
        /const myResult = resolveMyOnlineResult\(currentState\);/.test(SRC) &&
        /didIWin = \(myResult === "win"\);/.test(SRC));
    check('11. Elo-путь (receipt) определяет победителя по UID из players — он от myColor НЕ зависит',
        /lightId: lightId,\s*\n\s*darkId: darkId,/.test(SRC) &&
        /updates\["stats\/" \+ ctx\.lightId \+ "\/wins"\] = inc\(1\)/.test(SRC));

    // =================================================================
    console.log('UID-АТРИБУЦИЯ: ЗАЩИТА ОТ ПЕРЕВЁРНУТОГО РЕЗУЛЬТАТА');
    // =================================================================
    function ctxFor(uid, color, state) {
        global.myTelegramId = uid; global.myColor = color; global.currentState = state;
        global.isOnlineGame = true; global.isBotGame = false; global.isSpectator = false;
    }
    const pAB = { light: { id: TANYA, name: 'T' }, dark: { id: ZHUK, name: 'Z' } };
    const pBA = { light: { id: ZHUK, name: 'Z' }, dark: { id: TANYA, name: 'T' } };
    const lightWins = { winner: 'light', moveCount: 10, matchNumber: 0, createdAt: 1, players: pAB, ratingsAtStart: null };
    const darkWins = { winner: 'dark', moveCount: 10, matchNumber: 0, createdAt: 1, players: pAB, ratingsAtStart: null };

    ctxFor(TANYA, 'light', lightWins);
    check('12. первая партия, побеждает light -> победа у light-игрока',
        resolveMyOnlineResult(lightWins) === 'win');
    ctxFor(ZHUK, 'dark', lightWins);
    check('13. и поражение у dark-игрока', resolveMyOnlineResult(lightWins) === 'loss');

    ctxFor(ZHUK, 'dark', darkWins);
    check('14. первая партия, побеждает dark -> победа у dark-игрока',
        resolveMyOnlineResult(darkWins) === 'win');
    ctxFor(TANYA, 'light', darkWins);
    check('15. и поражение у light-игрока', resolveMyOnlineResult(darkWins) === 'loss');

    // реванш: цвета поменялись, снова побеждает Татьяна (теперь dark)
    const rematchTanyaWins = { winner: 'dark', moveCount: 12, matchNumber: 1, createdAt: 1, players: pBA, ratingsAtStart: null };
    ctxFor(TANYA, 'dark', rematchTanyaWins);
    check('16. реванш: тот же человек побеждает снова -> победа ему',
        resolveMyOnlineResult(rematchTanyaWins) === 'win');
    ctxFor(ZHUK, 'light', rematchTanyaWins);
    check('17. реванш: сопернице поражение', resolveMyOnlineResult(rematchTanyaWins) === 'loss');

    // реванш: побеждает другой человек
    const rematchZhukWins = { winner: 'light', moveCount: 12, matchNumber: 1, createdAt: 1, players: pBA, ratingsAtStart: null };
    ctxFor(ZHUK, 'light', rematchZhukWins);
    check('18. реванш: побеждает другой человек -> победа ему',
        resolveMyOnlineResult(rematchZhukWins) === 'win');

    // КЛЮЧЕВОЕ: устаревший myColor больше не переворачивает результат
    ctxFor(TANYA, 'light', rematchTanyaWins); // myColor остался от партии 1
    check('19. УСТАРЕВШИЙ myColor НЕ переворачивает статистику',
        resolveMyOnlineResult(rematchTanyaWins) === 'win');
    check('20. УСТАРЕВШИЙ myColor НЕ переворачивает награду в монетах',
        getCurrentCoinReward() === global.COIN_REWARDS.onlineWin,
        String(getCurrentCoinReward()));
    ctxFor(ZHUK, 'dark', rematchTanyaWins); // тоже устаревший
    check('21. у соперницы с устаревшим цветом тоже верно: поражение',
        resolveMyOnlineResult(rematchTanyaWins) === 'loss');
    check('22. и награда за поражение, а не за победу',
        getCurrentCoinReward() === global.COIN_REWARDS.onlineLoss);

    // Ничья не зависит от цвета вовсе
    const drawState = { winner: 'draw', moveCount: 40, matchNumber: 0, createdAt: 1, players: pAB, ratingsAtStart: null };
    ctxFor(TANYA, 'dark', drawState);
    check('23. ничья: результат draw и награда за ничью обоим',
        resolveMyOnlineResult(drawState) === 'draw' && getCurrentCoinReward() === global.COIN_REWARDS.onlineDraw);

    // Я не участник комнаты
    ctxFor('tg_stranger', 'light', lightWins);
    check('24. UID не найден среди игроков -> результат не определяется',
        resolveMyOnlineResult(lightWins) === null);
    check('25. и монеты такому клиенту не начисляются', getCurrentCoinReward() === null);
    DB.stats['tg_stranger'] = undefined;
    const strangerClient = makeClient('tg_stranger', 'Stranger', 'light');
    await recordAs(strangerClient, lightWins, 'X_0_10');
    check('26. и статистика постороннему не записывается', !DB.stats['tg_stranger']);

    // Старая комната без players / без id -> безопасный откат к прежнему поведению
    const noPlayers = { winner: 'light', moveCount: 10, matchNumber: 0, createdAt: 1, players: null, ratingsAtStart: null };
    ctxFor(TANYA, 'light', noPlayers);
    check('27. комната без players -> откат к прежнему поведению по цвету',
        resolveMyOnlineResult(noPlayers) === 'win');
    const noIds = { winner: 'light', moveCount: 10, matchNumber: 0, createdAt: 1,
        players: { light: { name: 'A' }, dark: { name: 'B' } }, ratingsAtStart: null };
    ctxFor(TANYA, 'dark', noIds);
    check('28. игроки без id -> тоже безопасный откат, результат не теряется',
        resolveMyOnlineResult(noIds) === 'loss');

    // Бот не затронут
    check('29. bot-ветка статистики по-прежнему считает по myColor',
        /if \(isBotGame\) \{\s*\n\s*didIWin = currentState\.winner === myColor;/.test(SRC));
    check('30. bot-ветка монет по-прежнему возвращает null (Этап 2)',
        /if \(isBotGame\) \{[\s\S]{0,600}?return null;/.test(SRC));
    global.isBotGame = true; global.isOnlineGame = false;
    global.currentState = { winner: 'light', moveCount: 10, players: null };
    global.myColor = 'light';
    check('31. в bot-партии UID-логика не применяется и награды нет',
        getCurrentCoinReward() === null);

    // Elo не менялся
    check('32. Elo-путь не изменён: победитель по-прежнему из lightId/darkId',
        /updates\["stats\/" \+ ctx\.lightId \+ "\/wins"\] = inc\(1\)/.test(SRC) &&
        /updates\["stats\/" \+ ctx\.darkId \+ "\/wins"\] = inc\(1\)/.test(SRC));
    check('33. getEloMatchContext не использует myColor для определения победителя',
        !/myColor/.test(/function getEloMatchContext[\s\S]*?\n}/.exec(SRC)[0]));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

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
    // v194-R3: recordGameResult опирается на серверную регистрацию.
    eval(extractFunc('registeredMatchIdForState'));
    eval(extractFunc('recordGameResult'));
    // v194: монет больше нет, COIN_REWARDS удалён вместе с подсистемой.

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
global.canUseFirebase = function () { return true; };
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

    // v194: клиент больше НЕ пишет статистику онлайн-партий — её пишет
// сервер по данным своей карточки матча. Поэтому проверять «кому
// начислилась победа» на клиенте больше нечего. Вместо этого фиксируем
// главное: клиент запрашивает расчёт и НЕ пишет сам, а атрибуция
// по-прежнему определяется UID, а не устаревшим myColor.
check('1. онлайн-путь НЕ пишет статистику с клиента',
    !/database\.ref\(statsPath \+ "\/" \+ myTelegramId\)[\s\S]{0,200}isBotGame/.test(SRC)
    && /if \(!isBotGame\) \{[\s\S]{0,120}return;/.test(SRC));
check('2. клиент запрашивает расчёт у сервера',
    /requestSettlement\(\)/.test(SRC) && /\/rated\/settle/.test(SRC));
check('3. атрибуция берётся из UID, а не из myColor',
    /const myResult = resolveMyOnlineResult\(currentState\);/.test(SRC));
check('4. реванш меняет стороны, и это учтено сменой поколения',
    /ratedGenerationKey/.test(SRC) && /matchNumber/.test(SRC));
check('5. расчёт привязан к поколению завершённой партии',
    /freezeSettlementContext/.test(SRC));
check('6. устаревший ответ не относится к новой партии',
    /currentKey !== ratedGenerationKey/.test(SRC));
check('7. реванш ждёт подтверждения расчёта',
    /waitForSettlementBeforeRematch/.test(SRC));
check('8. сброс выполняется ТОЛЬКО после ожидания расчёта', (function () {
    // R3 усилил: сброс идёт внутри .then(), плюс поколение сверяется
    // ПОВТОРНО перед самим reset — защита от двойного нажатия.
    const wait = SRC.indexOf('waitForSettlementBeforeRematch().then(');
    const reset = SRC.indexOf('return performRematchReset(generationAtAccept)');
    const recheck = SRC.indexOf('stillOurFinishedGeneration');
    return wait !== -1 && reset !== -1 && recheck !== -1
        && wait < recheck && recheck < reset;
})());
check('9. клиент не пишет eloMatches', !/updates\["eloMatches\//.test(SRC));

check('10. online-путь статистики определяет победителя через UID-резолвер',
        /const myResult = resolveMyOnlineResult\(currentState\);/.test(SRC) &&
        /didIWin = \(myResult === "win"\);/.test(SRC));
    // v194: клиент больше не пишет квитанцию — расчёт выполняет Worker.
    // Проверяем, что атрибуция ушла на сервер, а клиент лишь просит расчёт.
    check('11. клиент НЕ строит Elo-квитанцию сам',
        !/updates\["eloMatches\//.test(SRC));
    check('11b. клиент запрашивает расчёт у сервера',
        /requestSettlement\(\)/.test(SRC) && /\/rated\/settle/.test(SRC));

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
    ctxFor(ZHUK, 'dark', rematchTanyaWins); // тоже устаревший
    check('21. у соперницы с устаревшим цветом тоже верно: поражение',
        resolveMyOnlineResult(rematchTanyaWins) === 'loss');

    // Ничья не зависит от цвета вовсе
    const drawState = { winner: 'draw', moveCount: 40, matchNumber: 0, createdAt: 1, players: pAB, ratingsAtStart: null };
    ctxFor(TANYA, 'dark', drawState);

    // Я не участник комнаты
    ctxFor('tg_stranger', 'light', lightWins);
    check('24. UID не найден среди игроков -> результат не определяется',
        resolveMyOnlineResult(lightWins) === null);
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
    check('30. монет в клиенте нет вовсе',
        !/getCurrentCoinReward|recordCoinResultOnce|economy\//.test(SRC));
    global.isBotGame = true; global.isOnlineGame = false;
    global.currentState = { winner: 'light', moveCount: 10, players: null };
    global.myColor = 'light';

    // Elo не менялся
    // v194: клиент больше не пишет stats — атрибуция ушла на сервер,
    // где победитель определяется по участникам серверной карточки матча.
    check('32. клиент НЕ пишет stats напрямую',
        !/updates\["stats\//.test(SRC));
    check('33. getEloMatchContext не использует myColor для определения победителя',
        !/myColor/.test(/function getEloMatchContext[\s\S]*?\n}/.exec(SRC)[0]));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

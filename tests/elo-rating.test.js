// ONLINE ELO (Этап 1) — regression-тесты.
//
// ЧТО ЗАПУСКАЕТСЯ ПО-НАСТОЯЩЕМУ: реальные функции из script.js —
// normalizeEloRating, computeEloDeltas, buildEloMatchId, getEloMatchContext,
// ensureStatsInitialized, recordEloMatchResult, ensureMyRatingSnapshot,
// recordGameResult, compareLeaderboardEntries, renderOnlineStatsRow.
//
// ЧТО МОКИРУЕТСЯ: Firebase database (in-memory, с поддержкой multi-location
// update, ServerValue.increment и правила "receipt пишется один раз"), DOM.
//
// Мок Rules сознательно повторяет ОПУБЛИКОВАННЫЕ правила в той части, которая
// критична для этих тестов: eloMatches/<matchId> пишется только если его ещё
// нет, а отказ любого пути отменяет ВЕСЬ multi-location update. Это позволяет
// проверить главное свойство архитектуры — невозможность двойного учёта.
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

// ===== Мок Firebase =====

const INC = '__INCREMENT__';
global.firebase = {
    database: {
        ServerValue: {
            TIMESTAMP: 1700000000000,
            increment: function (delta) { return { __op: INC, delta: delta }; }
        }
    }
};

let DB, WRITE_LOG, REJECTED, TX_FAIL_NEXT;

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
    if (parts.length === 0) return;
    node[parts[parts.length - 1]] = value;
}

// Применение одного пути с поддержкой increment (как это делает сервер RTDB).
function applyOne(path, value) {
    if (value && value.__op === INC) {
        const cur = getPath(path);
        setPath(path, (typeof cur === 'number' ? cur : 0) + value.delta);
    } else {
        setPath(path, JSON.parse(JSON.stringify(value)));
    }
}

// Мок серверных Rules — только то, что важно для этих тестов.
function rulesAllow(path, value) {
    if (path.indexOf('eloMatches/') === 0) {
        // ".write": "!data.exists() && newData.exists()" — ровно один раз.
        if (getPath(path) !== null) return false;
        if (!value) return false;
    }
    if (path.indexOf('stats/') === 0) {
        // ".write" на stats/$uid требует wins+losses+name у ИТОГОВОЙ записи.
        const uid = path.split('/')[1];
        const node = getPath('stats/' + uid);
        const merged = Object.assign({}, node || {});
        const leaf = path.split('/')[2];
        if (leaf) merged[leaf] = true;
        if (!('wins' in merged) || !('losses' in merged) || !('name' in merged)) return false;
        // ".validate" rating/draws >= 0 — проверяем ИТОГ после increment.
        if (leaf === 'rating' || leaf === 'draws' || leaf === 'wins' || leaf === 'losses') {
            const cur = getPath(path);
            const next = (value && value.__op === INC)
                ? (typeof cur === 'number' ? cur : 0) + value.delta
                : value;
            if (typeof next === 'number' && next < 0) return false;
        }
    }
    return true;
}

function makeRef(path) {
    return {
        set: function (v) { WRITE_LOG.push({ path: path, value: v }); applyOne(path, v); return Promise.resolve(); },
        once: function () { return Promise.resolve({ val: function () { return getPath(path); } }); },
        transaction: function (fn) {
            if (TX_FAIL_NEXT > 0) { TX_FAIL_NEXT--; return Promise.reject(new Error('network')); }
            const next = fn(getPath(path));
            if (next === undefined) return Promise.resolve({ committed: false, snapshot: { val: function () { return getPath(path); } } });
            setPath(path, next);
            return Promise.resolve({ committed: true, snapshot: { val: function () { return getPath(path); } } });
        },
        // multi-location update: применяется ЦЕЛИКОМ или НЕ ПРИМЕНЯЕТСЯ ВООБЩЕ
        update: function (updates) {
            const paths = Object.keys(updates);
            for (const p of paths) {
                const full = path ? (path + '/' + p) : p;
                if (!rulesAllow(full, updates[p])) {
                    REJECTED.push(full);
                    return Promise.reject(new Error('PERMISSION_DENIED at ' + full));
                }
            }
            for (const p of paths) {
                const full = path ? (path + '/' + p) : p;
                WRITE_LOG.push({ path: full, value: updates[p] });
                applyOne(full, updates[p]);
            }
            return Promise.resolve();
        }
    };
}

global.database = { ref: function (p) { return makeRef(p === undefined ? '' : p); } };

// ===== Загрузка реального кода =====

// Против версии БЕЗ Elo (например v171 через TARGET_SCRIPT) тесты обязаны
// падать — но осмысленно, а не стектрейсом.
const mStart = /const ELO_START_RATING = (\d+);/.exec(SRC);
const mK = /const ELO_K = (\d+);/.exec(SRC);
const mAttempts = /const ELO_MAX_WRITE_ATTEMPTS = (\d+);/.exec(SRC);
if (!mStart || !mK || !mAttempts) {
    console.log('  ❌ 0. в script.js нет констант Elo (ELO_START_RATING / ELO_K / ELO_MAX_WRITE_ATTEMPTS)');
    console.log('\nИТОГ: 0/1');
    process.exit(1);
}
global.ELO_START_RATING = Number(mStart[1]);
global.ELO_K = Number(mK[1]);
global.ELO_MAX_WRITE_ATTEMPTS = Number(mAttempts[1]);

let loadError = null;
try {
    eval(extractFunc('normalizeEloRating'));
    eval(extractFunc('computeEloDeltas'));
    eval(extractFunc('buildEloMatchId'));
    eval(extractFunc('getEloMatchContext'));
    eval(extractFunc('ensureStatsInitialized'));
    eval(extractFunc('recordEloMatchResult'));
    eval(extractFunc('ensureMyRatingSnapshot'));
    eval(extractFunc('resolveMyOnlineResult'));
    eval(extractFunc('recordGameResult'));
    eval(extractFunc('compareLeaderboardEntries'));
    eval(extractFunc('renderRankAndName'));
    eval(extractFunc('renderOnlineStatsRow'));
} catch (e) { loadError = e.message; }

function stubEl() {
    return {
        className: '', textContent: '', children: [],
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
        appendChild: function (c) { this.children.push(c); return c; },
        setAttribute: function () {}
    };
}

function reset() {
    DB = { stats: {}, rooms: {}, eloMatches: {} };
    WRITE_LOG = []; REJECTED = []; TX_FAIL_NEXT = 0;
    global.isOnlineGame = true; global.isBotGame = false; global.isSpectator = false;
    global.roomCode = 'ROOM1'; global.myColor = 'light';
    global.myTelegramId = 'tg_1'; global.myTelegramName = 'Light Player';
    global.botDifficulty = 'hard'; global.currentBotMatchId = null;
    global.isLocalStateOptimistic = false;
    global.currentState = null;
    global.statsRecordedForRoom = null;
    global.statsInFlightForRoom = null;
    global.statsInFlightOnlineMarker = null;
    global.eloWriteAttempts = {};
    global.eloWriteInFlightMatchId = null;
    global.ratingSnapshotWrittenFor = null;
    global.recordBotGameResultIdempotent = function () { return Promise.resolve(); };
    global.document = { createElement: function () { return stubEl(); }, createTextNode: function (t) { return { text: t }; } };
    global.TELEGRAM_USERNAMES = {};
}

// Состояние законченной online-партии с полным снимком рейтингов.
function finishedState(winner, lightRating, darkRating, matchNumber) {
    return {
        winner: winner,
        moveCount: 40,
        matchNumber: (typeof matchNumber === 'number') ? matchNumber : 0,
        createdAt: 1700000000000,
        players: { light: { id: 'tg_1', name: 'Light Player' }, dark: { id: 'tg_2', name: 'Dark Player' } },
        ratingsAtStart: { light: lightRating, dark: darkRating }
    };
}

function seedStats(id, obj) { DB.stats[id] = obj; }
const S = (id) => DB.stats[id] || {};

(async function () {
    if (loadError) {
        check('0. все Elo-функции существуют в script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exit(1);
    }

    // =================================================================
    console.log('МАТЕМАТИКА ELO');
    // =================================================================
    reset();
    let d = computeEloDeltas(1000, 1000, 'light');
    check('1. 1000 vs 1000, победа light -> 1016 / 984',
        1000 + d.light === 1016 && 1000 + d.dark === 984, JSON.stringify(d));

    d = computeEloDeltas(1000, 1400, 'light');
    check('2. слабый (1000) обыграл сильного (1400) -> большая прибавка (>16)',
        d.light > 16 && d.dark === -d.light, JSON.stringify(d));

    d = computeEloDeltas(1400, 1000, 'light');
    check('3. фаворит (1400) обыграл слабого (1000) -> маленькая прибавка (<16, >0)',
        d.light > 0 && d.light < 16 && d.dark === -d.light, JSON.stringify(d));

    d = computeEloDeltas(1000, 1000, 'draw');
    check('4. ничья равных -> 0 / 0', d.light === 0 && d.dark === 0, JSON.stringify(d));

    d = computeEloDeltas(1200, 1000, 'draw');
    check('5a. ничья разных: фаворит теряет, аутсайдер получает',
        d.light < 0 && d.dark > 0, JSON.stringify(d));
    d = computeEloDeltas(1000, 1200, 'draw');
    check('5b. зеркальный случай ничьей', d.light > 0 && d.dark < 0, JSON.stringify(d));

    // Clamp срабатывает там, где МАТЕМАТИЧЕСКАЯ дельта глубже остатка рейтинга:
    // равные рейтинги по 10 дали бы -16, но ниже нуля уходить нельзя.
    d = computeEloDeltas(10, 10, 'dark');
    check('6a. clamp: рейтинг 10 при поражении теряет ровно 10, не 16',
        d.light === -10 && 10 + d.light === 0, JSON.stringify(d));
    d = computeEloDeltas(0, 2000, 'dark');
    check('6b. clamp у самого нуля -> дельта 0', d.light === 0 && 0 + d.light === 0, JSON.stringify(d));

    check('7. legacy без rating -> 1000', normalizeEloRating(undefined) === 1000 && normalizeEloRating(null) === 1000);
    check('7b. битый rating (строка/NaN/отрицательный) -> 1000',
        normalizeEloRating('1500') === 1000 && normalizeEloRating(NaN) === 1000 && normalizeEloRating(-5) === 1000);

    // Сумма дельт: 0 в норме, положительная только при clamp (см. Rules >= 0).
    let sumOk = true;
    for (let rl = 0; rl <= 2400; rl += 37) {
        for (let rd = 0; rd <= 2400; rd += 53) {
            for (const res of ['light', 'dark', 'draw']) {
                const x = computeEloDeltas(rl, rd, res);
                const sum = x.light + x.dark;
                if (sum < 0 || sum > 32) sumOk = false;
                if (x.light < -32 || x.light > 32 || x.dark < -32 || x.dark > 32) sumOk = false;
                if (rl + x.light < 0 || rd + x.dark < 0) sumOk = false;
                if (res === 'light' && !(x.light >= 0 && x.dark <= 0)) sumOk = false;
                if (res === 'dark' && !(x.dark >= 0 && x.light <= 0)) sumOk = false;
            }
        }
    }
    check('8. все дельты удовлетворяют опубликованным Rules (перебор рейтингов)', sumOk);

    // =================================================================
    console.log('MATCH ID');
    // =================================================================
    reset();
    check('9. matchId стабилен при одинаковых входных данных',
        buildEloMatchId('AB12', 1700, 0) === buildEloMatchId('AB12', 1700, 0));
    check('10. реванш даёт ДРУГОЙ matchId',
        buildEloMatchId('AB12', 1700, 0) !== buildEloMatchId('AB12', 1700, 1));
    check('11. тот же roomCode в другой раз (другой createdAt) не конфликтует',
        buildEloMatchId('AB12', 1700, 0) !== buildEloMatchId('AB12', 9900, 0));
    check('12. комната без createdAt не ломает ID (fallback 0)',
        buildEloMatchId('AB12', null, 0) === 'elo_AB12_0_0');
    check('13. длина matchId укладывается в лимит Rules (<150)',
        buildEloMatchId('ABCDEF', 1767225600000, 99).length < 150);

    // =================================================================
    console.log('КОНТЕКСТ РЕЙТИНГОВОЙ ПАРТИИ (гейт)');
    // =================================================================
    reset();
    global.currentState = finishedState('light', 1000, 1000);
    check('14. полный снимок -> партия рейтинговая', getEloMatchContext() !== null);

    reset();
    global.currentState = finishedState('light', 1000, 1000);
    global.currentState.ratingsAtStart = { light: 1000 }; // соперник на старом коде
    check('15. НЕПОЛНЫЙ снимок -> НЕ рейтинговая (переходная совместимость)',
        getEloMatchContext() === null);

    reset();
    global.currentState = finishedState('light', 1000, 1000);
    global.currentState.ratingsAtStart = null;
    check('16. старая комната без снимка -> НЕ рейтинговая', getEloMatchContext() === null);

    reset();
    global.isSpectator = true;
    global.currentState = finishedState('light', 1000, 1000);
    check('17. зритель не формирует контекст', getEloMatchContext() === null);

    reset();
    global.isBotGame = true; global.isOnlineGame = false;
    global.currentState = finishedState('light', 1000, 1000);
    check('18. бот не участвует в Elo', getEloMatchContext() === null);

    reset();
    global.myTelegramId = 'tg_999'; // не участник
    global.currentState = finishedState('light', 1000, 1000);
    check('19. посторонний id не формирует контекст', getEloMatchContext() === null);

    reset();
    global.currentState = finishedState('light', 1000, 1000);
    global.currentState.players.dark = { id: 'tg_1', name: 'Same' }; // сам с собой
    check('20. lightId === darkId запрещён (совпадает с Rules)', getEloMatchContext() === null);

    reset();
    global.currentState = finishedState('light', 1000, 1000);
    global.currentState.winner = null;
    check('21. незаконченная партия не формирует контекст', getEloMatchContext() === null);

    // =================================================================
    console.log('ЛЕНИВАЯ ИНИЦИАЛИЗАЦИЯ LEGACY STATS');
    // =================================================================
    reset();
    seedStats('tg_1', { wins: 7, losses: 3, name: 'Old Player' });
    await ensureStatsInitialized('tg_1', 'Whatever');
    check('22. legacy получает rating=1000 и draws=0', S('tg_1').rating === 1000 && S('tg_1').draws === 0);
    check('23. существующие wins/losses/name НЕ тронуты',
        S('tg_1').wins === 7 && S('tg_1').losses === 3 && S('tg_1').name === 'Old Player');

    seedStats('tg_1', { wins: 7, losses: 3, name: 'Old Player', rating: 1234, draws: 5 });
    await ensureStatsInitialized('tg_1', 'Whatever');
    check('24. повторная инициализация НЕ сбрасывает rating/draws (идемпотентна)',
        S('tg_1').rating === 1234 && S('tg_1').draws === 5);

    reset();
    await ensureStatsInitialized('tg_new', 'Newbie');
    check('25. игрок без записи вообще -> полный корректный объект',
        S('tg_new').wins === 0 && S('tg_new').losses === 0 &&
        S('tg_new').name === 'Newbie' && S('tg_new').rating === 1000 && S('tg_new').draws === 0);

    // =================================================================
    console.log('АТОМАРНЫЙ RECEIPT');
    // =================================================================
    reset();
    seedStats('tg_1', { wins: 5, losses: 5, name: 'L', rating: 1000, draws: 0 });
    seedStats('tg_2', { wins: 5, losses: 5, name: 'D', rating: 1000, draws: 0 });
    global.currentState = finishedState('light', 1000, 1000);
    recordGameResult('marker1');
    await tick();
    check('26. рейтинги обоих применены из ОДНОГО снимка',
        S('tg_1').rating === 1016 && S('tg_2').rating === 984,
        S('tg_1').rating + '/' + S('tg_2').rating);
    check('27. wins/losses начислены одним update',
        S('tg_1').wins === 6 && S('tg_2').losses === 6);
    check('28. receipt записан с ожидаемыми полями', (function () {
        const r = DB.eloMatches['elo_ROOM1_1700000000000_0'];
        return r && r.lightId === 'tg_1' && r.darkId === 'tg_2' && r.result === 'light' &&
            r.lightRatingBefore === 1000 && r.darkRatingBefore === 1000 &&
            r.lightDelta === 16 && r.darkDelta === -16 && typeof r.createdAt === 'number' &&
            Object.keys(r).length === 8;
    })());
    check('29. проигравший НЕ получил лишний wins', S('tg_2').wins === 5 && S('tg_1').losses === 5);

    // ВТОРОЙ КЛИЕНТ той же партии — Rules обязаны отклонить всё целиком
    const before = JSON.stringify(DB.stats);
    global.statsRecordedForRoom = null;
    global.statsInFlightOnlineMarker = null;
    global.eloWriteAttempts = {};
    global.eloWriteInFlightMatchId = null;
    global.myTelegramId = 'tg_2'; global.myColor = 'dark'; global.myTelegramName = 'D';
    recordGameResult('marker1');
    await tick();
    check('30. повтор того же matchId отклонён', REJECTED.length === 1 && REJECTED[0].indexOf('eloMatches/') === 0);
    check('31. НИЧЕГО не применилось при отказе: ни rating, ни wins, ни losses',
        JSON.stringify(DB.stats) === before, JSON.stringify(DB.stats));

    // Ещё попытки — но не бесконечно
    for (let i = 0; i < 6; i++) {
        global.statsInFlightOnlineMarker = null;
        recordGameResult('marker1');
        await tick();
    }
    check('32. число попыток ограничено ELO_MAX_WRITE_ATTEMPTS',
        REJECTED.length === global.ELO_MAX_WRITE_ATTEMPTS, 'отказов: ' + REJECTED.length);
    check('33. состояние базы после всех попыток по-прежнему не изменилось',
        JSON.stringify(DB.stats) === before);

    // =================================================================
    console.log('НИЧЬЯ');
    // =================================================================
    reset();
    seedStats('tg_1', { wins: 1, losses: 1, name: 'L', rating: 1000, draws: 2 });
    seedStats('tg_2', { wins: 1, losses: 1, name: 'D', rating: 1000, draws: 4 });
    global.currentState = finishedState('draw', 1000, 1000);
    recordGameResult('markerDraw');
    await tick();
    check('34. ничья: draws +1 ОБОИМ', S('tg_1').draws === 3 && S('tg_2').draws === 5);
    check('35. ничья не меняет wins/losses',
        S('tg_1').wins === 1 && S('tg_1').losses === 1 && S('tg_2').wins === 1 && S('tg_2').losses === 1);
    check('36. ничья равных не меняет рейтинги', S('tg_1').rating === 1000 && S('tg_2').rating === 1000);
    check('37. receipt ничьей записан с result="draw"',
        DB.eloMatches['elo_ROOM1_1700000000000_0'].result === 'draw');

    // =================================================================
    console.log('ЗАЩИТА ОТ ДВОЙНОГО УЧЁТА СО СТАРЫМ МЕХАНИЗМОМ');
    // =================================================================
    reset();
    seedStats('tg_1', { wins: 5, losses: 5, name: 'L', rating: 1000, draws: 0 });
    seedStats('tg_2', { wins: 5, losses: 5, name: 'D', rating: 1000, draws: 0 });
    global.currentState = finishedState('light', 1000, 1000);
    recordGameResult('m');
    await tick();
    const winsAfterElo = S('tg_1').wins;
    const oldPathWrites = WRITE_LOG.filter(function (w) { return w.path === 'stats/tg_1' && !w.value.__op; });
    check('38. рейтинговая партия НЕ трогает старый путь записи stats/<id>',
        winsAfterElo === 6 && oldPathWrites.length === 0, 'wins=' + winsAfterElo);

    // Старый путь ДОЛЖЕН работать, когда снимка нет (комната старого клиента)
    reset();
    seedStats('tg_1', { wins: 5, losses: 5, name: 'L' });
    global.currentState = finishedState('light', 1000, 1000);
    global.currentState.ratingsAtStart = null;
    recordGameResult('m2');
    await tick();
    check('39. НЕрейтинговая партия идёт старым путём (только свой wins)',
        S('tg_1').wins === 6 && !DB.eloMatches['elo_ROOM1_1700000000000_0']);
    check('40. старый путь не трогает рейтинг и соперника',
        S('tg_1').rating === undefined && DB.stats.tg_2 === undefined);

    // Ничья в НЕрейтинговой партии по-прежнему не пишется никуда (как в v171)
    reset();
    seedStats('tg_1', { wins: 5, losses: 5, name: 'L' });
    global.currentState = finishedState('draw', 1000, 1000);
    global.currentState.ratingsAtStart = null;
    recordGameResult('m3');
    await tick();
    check('41. ничья без снимка не пишется (поведение v171 сохранено)',
        S('tg_1').wins === 5 && S('tg_1').losses === 5 && S('tg_1').draws === undefined);

    // Зритель не пишет ничего
    reset();
    seedStats('tg_1', { wins: 5, losses: 5, name: 'L', rating: 1000, draws: 0 });
    seedStats('tg_2', { wins: 5, losses: 5, name: 'D', rating: 1000, draws: 0 });
    global.isSpectator = true;
    global.currentState = finishedState('light', 1000, 1000);
    recordGameResult('m4');
    await tick();
    check('42. зритель не записывает НИЧЕГО', WRITE_LOG.length === 0 && S('tg_1').wins === 5);

    // =================================================================
    console.log('СНИМОК РЕЙТИНГОВ (ratingsAtStart)');
    // =================================================================
    reset();
    seedStats('tg_1', { wins: 2, losses: 1, name: 'L', rating: 1111, draws: 0 });
    let room = {
        status: 'active', winner: null, matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } }
    };
    ensureMyRatingSnapshot(room);
    await tick();
    check('43. пишется ТОЛЬКО своя половина снимка',
        getPath('rooms/ROOM1/ratingsAtStart/light') === 1111 &&
        getPath('rooms/ROOM1/ratingsAtStart/dark') === null);

    // Повторные апдейты комнаты (reconnect) не создают новый снимок
    WRITE_LOG = [];
    room.ratingsAtStart = { light: 1111 };
    ensureMyRatingSnapshot(room);
    ensureMyRatingSnapshot(room);
    await tick();
    check('44. reconnect НЕ пересоздаёт существующий снимок', WRITE_LOG.length === 0);

    // Снимок не пишется у законченной партии — он заморожен
    reset();
    seedStats('tg_1', { wins: 0, losses: 0, name: 'L', rating: 1000, draws: 0 });
    ensureMyRatingSnapshot({
        status: 'active', winner: 'light', matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } }
    });
    await tick();
    check('45. после конца партии снимок заморожен (оба клиента видят одно и то же)',
        WRITE_LOG.length === 0);

    // Пока соперника нет — снимка нет (рейтинг dark не угадываем)
    reset();
    seedStats('tg_1', { wins: 0, losses: 0, name: 'L', rating: 1000, draws: 0 });
    ensureMyRatingSnapshot({
        status: 'waiting', winner: null, matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'L' }, dark: null }
    });
    await tick();
    check('46. waiting-комната без соперника снимок не создаёт', WRITE_LOG.length === 0);

    // Зритель снимок не пишет
    reset();
    global.isSpectator = true;
    ensureMyRatingSnapshot({
        status: 'active', winner: null, matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } }
    });
    await tick();
    check('47. зритель снимок не пишет', WRITE_LOG.length === 0);

    // Реванш: новый matchNumber -> своя половина пишется заново
    reset();
    seedStats('tg_1', { wins: 3, losses: 1, name: 'L', rating: 1016, draws: 0 });
    ensureMyRatingSnapshot({
        status: 'active', winner: null, matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } }
    });
    await tick();
    global.myColor = 'dark'; // реванш меняет стороны
    ensureMyRatingSnapshot({
        status: 'active', winner: null, matchNumber: 1, ratingsAtStart: null,
        players: { light: { id: 'tg_2', name: 'D' }, dark: { id: 'tg_1', name: 'L' } }
    });
    await tick();
    check('48. реванш пишет снимок заново, уже на новую сторону',
        getPath('rooms/ROOM1/ratingsAtStart/dark') === 1016);

    // Снимок инициализирует legacy-игрока и пишет 1000
    reset();
    seedStats('tg_1', { wins: 9, losses: 9, name: 'Legacy' });
    ensureMyRatingSnapshot({
        status: 'active', winner: null, matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'Legacy' }, dark: { id: 'tg_2', name: 'D' } }
    });
    await tick();
    check('49. legacy-игрок получает 1000 в снимке и в своей записи stats',
        getPath('rooms/ROOM1/ratingsAtStart/light') === 1000 && S('tg_1').rating === 1000);
    check('50. его wins/losses при этом сохранены', S('tg_1').wins === 9 && S('tg_1').losses === 9);

    // =================================================================
    console.log('УЗКИЙ АУДИТ ratingsAtStart');
    // =================================================================

    // (1,2) НЕПОЛНЫЙ снимок в ОБЕ стороны -> receipt не пишется вообще
    reset();
    seedStats('tg_1', { wins: 0, losses: 0, name: 'L', rating: 1000, draws: 0 });
    seedStats('tg_2', { wins: 0, losses: 0, name: 'D', rating: 1000, draws: 0 });
    global.currentState = finishedState('light', 1000, 1000);
    global.currentState.ratingsAtStart = { dark: 1000 }; // есть только dark
    check('63. есть только dark -> контекста нет', getEloMatchContext() === null);
    recordGameResult('mHalfDark');
    await tick();
    check('64. есть только dark -> receipt НЕ записан и рейтинги не тронуты',
        Object.keys(DB.eloMatches).length === 0 && S('tg_1').rating === 1000 && S('tg_2').rating === 1000);

    global.statsRecordedForRoom = null; global.statsInFlightOnlineMarker = null;
    global.currentState.ratingsAtStart = { light: 1000, dark: null };
    check('65. половина = null (а не число) -> контекста нет', getEloMatchContext() === null);
    global.currentState.ratingsAtStart = { light: 1000, dark: '1000' };
    check('66. половина = строка -> контекста нет (guard требует именно число)',
        getEloMatchContext() === null);
    global.currentState.ratingsAtStart = { light: 1000, dark: 1000 };
    check('67. обе половины числа -> контекст появляется', getEloMatchContext() !== null);

    // (3) reconnect не перезаписывает — отдельно для dark
    reset();
    seedStats('tg_2', { wins: 0, losses: 0, name: 'D', rating: 1300, draws: 0 });
    global.myTelegramId = 'tg_2'; global.myColor = 'dark'; global.myTelegramName = 'D';
    const roomWithDark = {
        status: 'active', winner: null, matchNumber: 0,
        ratingsAtStart: { light: 1000, dark: 1300 },
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } }
    };
    ensureMyRatingSnapshot(roomWithDark);
    ensureMyRatingSnapshot(roomWithDark);
    await tick();
    check('68. reconnect: половина dark не перезаписывается', WRITE_LOG.length === 0);

    // (4) два устройства одного игрока пишут одну и ту же половину
    reset();
    seedStats('tg_1', { wins: 4, losses: 4, name: 'L', rating: 1234, draws: 1 });
    const roomNoSnap = {
        status: 'active', winner: null, matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } }
    };
    ensureMyRatingSnapshot(roomNoSnap);          // устройство A
    global.ratingSnapshotWrittenFor = null;      // устройство B — свой процесс, своя память
    ensureMyRatingSnapshot(roomNoSnap);          // устройство B (room ещё без снимка)
    await tick();
    check('69. два устройства: обе записи дают ОДНО значение, гонка безвредна',
        getPath('rooms/ROOM1/ratingsAtStart/light') === 1234 &&
        S('tg_1').wins === 4 && S('tg_1').losses === 4 && S('tg_1').draws === 1,
        String(getPath('rooms/ROOM1/ratingsAtStart/light')));

    // (9) снимок берёт РЕАЛЬНЫЙ рейтинг, а не default 1000
    reset();
    seedStats('tg_1', { wins: 4, losses: 4, name: 'L', rating: 1587, draws: 0 });
    ensureMyRatingSnapshot({
        status: 'active', winner: null, matchNumber: 0,
        players: { light: { id: 'tg_1', name: 'L' }, dark: { id: 'tg_2', name: 'D' } }
    });
    await tick();
    check('70. в снимок попадает существующий rating (1587), а не default 1000',
        getPath('rooms/ROOM1/ratingsAtStart/light') === 1587,
        String(getPath('rooms/ROOM1/ratingsAtStart/light')));

    // (5,6) окно после rematch reset: снимок неполный -> Elo не пишется
    reset();
    seedStats('tg_1', { wins: 1, losses: 0, name: 'L', rating: 1016, draws: 0 });
    seedStats('tg_2', { wins: 0, losses: 1, name: 'D', rating: 984, draws: 0 });
    // реванш: matchNumber=1, стороны поменялись, снимок обнулён
    global.myColor = 'dark';
    let rematchRoom = {
        status: 'active', winner: null, matchNumber: 1, ratingsAtStart: null,
        players: { light: { id: 'tg_2', name: 'D' }, dark: { id: 'tg_1', name: 'L' } }
    };
    ensureMyRatingSnapshot(rematchRoom);   // только я успел записать свою половину
    await tick();
    global.currentState = {
        winner: 'dark', moveCount: 30, matchNumber: 1, createdAt: 1700000000000,
        players: rematchRoom.players,
        ratingsAtStart: { dark: 1016 } // соперник ещё не записал свою
    };
    recordGameResult('mRematchWindow');
    await tick();
    check('71. окно после rematch (снимок неполный) -> Elo НЕ записывается',
        Object.keys(DB.eloMatches).length === 0 && S('tg_1').rating === 1016 && S('tg_2').rating === 984);

    // ...а когда обе половины на месте — пишется, и уже под НОВЫМ matchId
    global.statsRecordedForRoom = null; global.statsInFlightOnlineMarker = null;
    global.currentState.ratingsAtStart = { light: 984, dark: 1016 };
    recordGameResult('mRematchDone');
    await tick();
    check('72. полный снимок реванша -> receipt под НОВЫМ matchId (matchNumber=1)',
        !!DB.eloMatches['elo_ROOM1_1700000000000_1'] && !DB.eloMatches['elo_ROOM1_1700000000000_0']);
    check('73. рейтинги реванша посчитаны из НОВОГО снимка, а не старого',
        S('tg_1').rating > 1016 && S('tg_2').rating < 984,
        S('tg_1').rating + '/' + S('tg_2').rating);

    // старая партия не может воспользоваться новым снимком: без winner выход раньше
    WRITE_LOG = [];
    global.currentState.winner = null;
    global.statsRecordedForRoom = null; global.statsInFlightOnlineMarker = null;
    recordGameResult('mStale');
    await tick();
    check('74. незавершённая/старая партия ничего не пишет', WRITE_LOG.length === 0);

    // (10) ОБА клиента одновременно увидели полный снимок и стартовали receipt
    reset();
    seedStats('tg_1', { wins: 0, losses: 0, name: 'L', rating: 1000, draws: 0 });
    seedStats('tg_2', { wins: 0, losses: 0, name: 'D', rating: 1000, draws: 0 });
    const sharedState = finishedState('light', 1000, 1000);
    const ctxLight = (function () {
        global.myTelegramId = 'tg_1'; global.myColor = 'light';
        global.currentState = sharedState;
        return getEloMatchContext();
    })();
    const ctxDark = (function () {
        global.myTelegramId = 'tg_2'; global.myColor = 'dark';
        global.currentState = sharedState;
        return getEloMatchContext();
    })();
    check('75. оба клиента вычислили ИДЕНТИЧНЫЙ matchId и дельты',
        ctxLight.matchId === ctxDark.matchId &&
        ctxLight.lightDelta === ctxDark.lightDelta &&
        ctxLight.darkDelta === ctxDark.darkDelta);
    // одновременный старт: ни один не дождался другого
    recordEloMatchResult(ctxLight, 'mRace');
    global.eloWriteInFlightMatchId = null; // второй клиент — отдельный процесс
    recordEloMatchResult(ctxDark, 'mRace');
    await tick();
    check('76. одновременная гонка: применился РОВНО один результат',
        S('tg_1').rating === 1016 && S('tg_2').rating === 984 &&
        S('tg_1').wins === 1 && S('tg_2').losses === 1,
        S('tg_1').rating + '/' + S('tg_2').rating + ' wins=' + S('tg_1').wins);
    check('77. второй результат отклонён целиком, receipt один',
        Object.keys(DB.eloMatches).length === 1 && REJECTED.length === 1);

    // (7,8) createdAt и matchId в исходнике
    check('78. createdAt пишется во ВСЕХ живых путях создания online-комнаты', (function () {
        const creations = (SRC.match(/database\.ref\("rooms\/" \+ (?:roomCode|myPendingOnlineRoom)\)\.set\(initialState\)/g) || []).length;
        const stamps = (SRC.match(/createdAt: firebase\.database\.ServerValue\.TIMESTAMP,\n\s*groupId: GROUP_ID/g) || []).length;
        return creations === 3 && stamps === 3;
    })());
    check('79. createdAt нигде не переписывается после создания (rematch/resume/reconnect)',
        !/updates\["createdAt"\]/.test(SRC) && !/ratingsAtStart\/"[\s\S]{0,40}createdAt/.test(SRC));
    reset();
    const entries = [
        { id: 'c', name: 'C', wins: 20, losses: 1, draws: 0, rating: 900 },
        { id: 'a', name: 'A', wins: 2, losses: 2, draws: 0, rating: 1500 },
        { id: 'b', name: 'B', wins: 5, losses: 5, draws: 0, rating: 1500 },
        { id: 'd', name: 'D', wins: 5, losses: 2, draws: 0, rating: 1500 }
    ];
    entries.sort(compareLeaderboardEntries);
    check('51. сортировка rating↓ -> wins↓ -> losses↑ -> id',
        entries.map(function (e) { return e.id; }).join(',') === 'd,b,a,c',
        entries.map(function (e) { return e.id; }).join(','));

    const legacyMix = [
        { id: 'x', name: 'X', wins: 1, losses: 0, draws: 0 },              // без rating -> 1000
        { id: 'y', name: 'Y', wins: 50, losses: 0, draws: 0, rating: 900 }
    ];
    legacyMix.sort(compareLeaderboardEntries);
    check('52. игрок без rating считается за 1000 и не проваливается вниз',
        legacyMix[0].id === 'x');

    const botLike = [
        { id: 'p', name: 'P', wins: 3, losses: 0 },
        { id: 'q', name: 'Q', wins: 9, losses: 0 }
    ];
    botLike.sort(compareLeaderboardEntries);
    check('53. bot-рейтинг (rating нет ни у кого) сортируется как раньше — по wins',
        botLike[0].id === 'q');

    const row = renderOnlineStatsRow(1, 'Player', 10, 4, 3, 1087);
    // UI 50/50: статистика теперь лежит в отдельных grid-ячейках — собираем их текст
    const text = row.children[row.children.length - 1].children.map(function (c) { return c.textContent; }).join(' ');
    check('54. строка показывает ⭐ рейтинг', text.indexOf('⭐1087') !== -1, text);
    check('55. 🎮 = wins + losses + draws', text.indexOf('🎮17') !== -1, text);

    const legacyRow = renderOnlineStatsRow(2, 'Old', 6, 4, undefined, undefined);
    const legacyText = legacyRow.children[legacyRow.children.length - 1].children.map(function (c) { return c.textContent; }).join(' ');
    check('56. старая запись без rating/draws отображается корректно',
        legacyText.indexOf('⭐1000') !== -1 && legacyText.indexOf('🎮10') !== -1, legacyText);

    // =================================================================
    console.log('ИСХОДНИК: инварианты, которые нельзя потерять');
    // =================================================================
    check('57. receipt содержит РОВНО поля опубликованных Rules', (function () {
        const m = /updates\["eloMatches\/" \+ ctx\.matchId\] = \{([\s\S]*?)\};/.exec(SRC);
        if (!m) return false;
        const fields = (m[1].match(/^\s{12}(\w+):/gm) || []).map(function (x) { return x.trim().replace(':', ''); });
        const expected = ['lightId', 'darkId', 'result', 'lightRatingBefore', 'darkRatingBefore', 'lightDelta', 'darkDelta', 'createdAt'];
        return fields.length === expected.length && expected.every(function (f) { return fields.indexOf(f) !== -1; });
    })());
    check('58. рейтинг пишется через increment, а не абсолютной перезаписью',
        /updates\["stats\/" \+ ctx\.lightId \+ "\/rating"\] = inc\(ctx\.lightDelta\)/.test(SRC));
    check('59. реванш обнуляет снимок рейтингов',
        /updates\["ratingsAtStart"\] = null;/.test(SRC));
    check('60. sweep-интервал лобби не тронут Этапом 1 (8000 мс)',
        /LOBBY_STALE_CHECK_INTERVAL_MS = 8000/.test(SRC));
    check('61. presence-фиксы v171 на месте (onDisconnect без lastSeen)',
        /onDisconnect\(\)\.update\(\{[\s\S]{0,80}online: false/.test(SRC) &&
        /away: !!document\.hidden/.test(SRC));
    check('62. Elo-код не зависит от номиналов монет (Этап 2: 20/10/5, бот 0)',
        /onlineWin: 20/.test(SRC) && /onlineDraw: 10/.test(SRC) && /onlineLoss: 5/.test(SRC) &&
        /botMediumWin: 0/.test(SRC) && /botHardWin: 0/.test(SRC) &&
        !/COIN_REWARDS/.test(/function recordEloMatchResult[\s\S]*?\n}/.exec(SRC)[0]));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

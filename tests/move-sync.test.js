// ONLINE MOVE SYNC — regression-тесты защиты от ситуации
// «оба игрока ждут друг друга».
//
// ЧТО ЗАПУСКАЕТСЯ ПО-НАСТОЯЩЕМУ: реальные функции из script.js —
// computeSyncStatus, isMoveAwaitingConfirmation, runSyncRecovery,
// forceResyncFromServer, attemptMove (настоящий движок ходов).
//
// ЧТО МОКИРУЕТСЯ: Firebase (in-memory, с УПРАВЛЯЕМЫМ моментом разрешения
// транзакции — именно это позволяет смоделировать зависшую сеть), DOM, время.
//
// САМОЕ ВАЖНОЕ ЗДЕСЬ — два критических сценария:
//   * поздний commit ПОСЛЕ восстановления не должен применить ход дважды;
//   * между восстановлением и поздним commit игрок не должен успеть
//     отправить конфликтующий второй ход.
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }
const tick = () => new Promise(r => setImmediate(() => setImmediate(() => setImmediate(r))));

let DB, READS, WRITES, PENDING_TX, FAIL_READ;

function getPath(path) {
    const parts = path.split('/').filter(Boolean);
    let node = DB;
    for (const p of parts) { if (node == null) return null; node = node[p]; }
    return node === undefined ? null : node;
}
function setPath(path, v) {
    const parts = path.split('/').filter(Boolean);
    let node = DB;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = v;
}

function makeRef(path) {
    return {
        once: function () {
            READS.push(path);
            if (FAIL_READ) return Promise.reject(new Error('network'));
            return Promise.resolve({ val: function () { return getPath(path); } });
        },
        set: function (v) { WRITES.push(path); setPath(path, v); return Promise.resolve(); },
        update: function (v) { WRITES.push(path); return Promise.resolve(); },
        remove: function () { WRITES.push(path); return Promise.resolve(); },
        on: function () {}, off: function () {},
        onDisconnect: function () { return { update: function () {}, cancel: function () {}, remove: function () {} }; },
        // Транзакция НЕ выполняется сразу: кладём её в очередь, чтобы тест сам
        // решал, когда сеть «ответит». Так моделируется зависший promise.
        transaction: function (fn) {
            let resolveFn, rejectFn;
            const promise = new Promise(function (res, rej) { resolveFn = res; rejectFn = rej; });
            PENDING_TX.push({
                path: path, fn: fn,
                commit: function () {
                    const next = fn(getPath(path));
                    if (next === undefined) { resolveFn({ committed: false, snapshot: { val: function () { return getPath(path); } } }); return false; }
                    setPath(path, JSON.parse(JSON.stringify(next)));
                    WRITES.push(path);
                    resolveFn({ committed: true, snapshot: { val: function () { return getPath(path); } } });
                    return true;
                },
                fail: function () { rejectFn(new Error('network')); }
            });
            return promise;
        }
    };
}

global.firebase = { database: { ServerValue: { TIMESTAMP: 1700000500000, increment: function (d) { return { __inc: d }; } } } };
global.database = { ref: function (p) { return makeRef(p === undefined ? '' : p); } };

function stubEl() {
    const el = {
        className: '', textContent: '', id: '', children: [], parentNode: null, style: {},
        classList: { _s: {}, add: function (c) { this._s[c] = true; }, remove: function (c) { delete this._s[c]; },
            contains: function (c) { return !!this._s[c]; }, toggle: function () {} },
        appendChild: function (c) { this.children.push(c); c.parentNode = this; return c; },
        removeChild: function (c) { this.children = this.children.filter(function (x) { return x !== c; }); c.parentNode = null; },
        addEventListener: function (ev, fn) { this._click = fn; },
        setAttribute: function () {}
    };
    return el;
}

// ===== Загрузка реального кода =====
let loadError = null;
try {
    const mStall = /const MOVE_CONFIRM_STALL_MS = (\d+);/.exec(SRC);
    if (!mStall) throw new Error('в script.js нет механизма синхронизации хода (MOVE_CONFIRM_STALL_MS)');
    global.MOVE_CONFIRM_STALL_MS = Number(mStall[1]);
    eval(extractFunc('isMoveAwaitingConfirmation'));
    eval(extractFunc('computeSyncStatus'));
    eval(extractFunc('renderSyncRetryButton'));
    eval(extractFunc('runSyncRecovery'));
    eval(extractFunc('forceResyncFromServer'));
    eval(extractFunc('pieceAt'));
    eval(extractFunc('getCaptureJumps'));
    eval(extractFunc('filterJumpsByMajorityRule'));
    eval(extractFunc('canCaptureAt'));
    eval(extractFunc('withPendingBlockers'));
    eval(extractFunc('hasMandatoryCapture'));
    eval(extractFunc('countPiecesOfColor'));
    eval(extractFunc('canMoveNormally'));
    eval(extractFunc('checkWinCondition'));
    eval(extractFunc('hasAnyLegalMove'));
    eval(extractFunc('attemptMove'));
    eval(extractFunc('computeGameSignature'));
} catch (e) { loadError = e.message; }

function reset() {
    DB = { rooms: {} };
    READS = []; WRITES = []; PENDING_TX = []; FAIL_READ = false;
    global.isOnlineGame = true; global.isBotGame = false; global.isSpectator = false;
    global.roomCode = 'R1'; global.myColor = 'light'; global.myTelegramId = 'tg_1';
    global.isFirebaseConnected = true;
    global.pendingMoveStartedAt = null;
    global.syncRecoveryInFlight = false;
    global.syncRecoveryFailed = false;
    global.isLocalStateOptimistic = false;
    global.lastSeenMoveCount = -1;
    global.selectedFrom = null;
    global.lastRenderedSignature = null;
    global.currentState = { winner: null, turn: 'light', moveCount: 4, players: { light: { id: 'tg_1' }, dark: { id: 'tg_2' } } };
    global.turnTimerDiv = stubEl();
    global.syncRetryButton = null;
    global.document = { createElement: function () { return stubEl(); } };
    global.t = function (k) { return k; };
    global.renderBoard = function () {};
    global.showInfoModal = function () {};
    global.updateTimerDisplay = function () {};
}

// Реальная позиция с возможной рубкой: light на 5_2 бьёт dark на 4_3 -> 3_4,
// затем второй прыжок через dark на 2_5 -> 1_6.
function chainRoom() {
    return {
        pieces: {
            '5_2': { color: 'light', king: false },
            '4_3': { color: 'dark', king: false },
            '2_5': { color: 'dark', king: false },
            '0_1': { color: 'dark', king: false }
        },
        turn: 'light', moveCount: 4, mustContinueFrom: null,
        capturedDark: 0, capturedLight: 0, positionHistory: [],
        players: { light: { id: 'tg_1' }, dark: { id: 'tg_2' } }, status: 'active'
    };
}

(async function () {
    if (loadError) {
        check('0. функции синхронизации есть в script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exit(1);
    }

    // =================================================================
    console.log('СОСТОЯНИЯ ИНДИКАТОРА');
    // =================================================================
    reset();
    check('1. без отправленного хода индикатора нет', computeSyncStatus() === null);

    global.pendingMoveStartedAt = Date.now();
    let st = computeSyncStatus();
    check('2. сразу после хода -> «Отправляю ход…»', st && st.key === 'sync_sending_move' && !st.showRetry);

    global.isFirebaseConnected = false;
    st = computeSyncStatus();
    check('3. связь пропала -> сразу «Нет связи», БЕЗ ожидания 12 секунд',
        st && st.key === 'sync_no_connection', st && st.key);

    global.isFirebaseConnected = true;
    st = computeSyncStatus();
    check('4. связь вернулась -> снова «Отправляю ход…» (ход НЕ считается подтверждённым)',
        st && st.key === 'sync_sending_move');

    global.pendingMoveStartedAt = Date.now() - (global.MOVE_CONFIRM_STALL_MS + 500);
    st = computeSyncStatus();
    check('5. связь есть, молчание >= 12 сек -> «Проверяю соединение…»',
        st && st.key === 'sync_checking');

    global.pendingMoveStartedAt = Date.now() - (global.MOVE_CONFIRM_STALL_MS - 2000);
    check('6. до порога остаётся «Отправляю ход…» (нет ложной тревоги на медленной сети)',
        computeSyncStatus().key === 'sync_sending_move');

    global.syncRecoveryFailed = true;
    st = computeSyncStatus();
    check('7. восстановление не удалось -> «Не удалось обновить игру» + кнопка',
        st && st.key === 'sync_failed' && st.showRetry === true);

    check('8. порог равен 12 секундам', global.MOVE_CONFIRM_STALL_MS === 12000);

    // =================================================================
    console.log('ГДЕ ИНДИКАТОР НЕ ДОЛЖЕН ПОЯВЛЯТЬСЯ');
    // =================================================================
    reset(); global.pendingMoveStartedAt = Date.now();
    global.isSpectator = true;
    check('9. зритель индикатора не видит', computeSyncStatus() === null);

    reset(); global.pendingMoveStartedAt = Date.now();
    global.isBotGame = true; global.isOnlineGame = false;
    check('10. игра с ботом — индикатора нет', computeSyncStatus() === null);

    reset(); global.pendingMoveStartedAt = Date.now();
    global.isOnlineGame = false;
    check('11. локальная игра — индикатора нет', computeSyncStatus() === null);

    reset(); global.pendingMoveStartedAt = Date.now();
    global.currentState.winner = 'light';
    check('12. законченная партия — индикатора нет', computeSyncStatus() === null);

    reset(); global.pendingMoveStartedAt = Date.now();
    global.roomCode = null;
    check('13. после выхода из комнаты — индикатора нет', computeSyncStatus() === null);

    reset(); global.pendingMoveStartedAt = Date.now();
    global.currentState = null;
    check('14. до начала партии (нет состояния) — индикатора нет', computeSyncStatus() === null);

    // =================================================================
    console.log('АВТОМАТИЧЕСКОЕ ВОССТАНОВЛЕНИЕ');
    // =================================================================
    reset();
    DB.rooms.R1 = chainRoom();
    DB.rooms.R1.moveCount = 9; DB.rooms.R1.turn = 'dark'; // сервер ход УЖЕ принял
    global.pendingMoveStartedAt = Date.now() - 13000;
    global.isLocalStateOptimistic = true;
    global.lastSeenMoveCount = 9;
    runSyncRecovery(false);
    await tick();
    check('15. восстановление: сервер содержит ход -> состояние подтверждено',
        global.currentState.turn === 'dark' && global.currentState.moveCount === 9 &&
        global.pendingMoveStartedAt === null && global.isLocalStateOptimistic === false);
    check('16. ровно одно чтение комнаты', READS.length === 1 && READS[0] === 'rooms/R1');
    check('17. восстановление НЕ пишет в Firebase (ход не переотправляется)', WRITES.length === 0);

    // сервер ход НЕ содержит -> откат к реальной позиции
    reset();
    DB.rooms.R1 = chainRoom(); // сервер на moveCount 4, ход light
    global.pendingMoveStartedAt = Date.now() - 13000;
    global.isLocalStateOptimistic = true;
    global.lastSeenMoveCount = 5; // мы оптимистично ушли вперёд
    runSyncRecovery(false);
    await tick();
    check('18. восстановление: сервер ход НЕ содержит -> откат к серверной позиции',
        global.currentState.moveCount === 4 && global.currentState.turn === 'light' &&
        global.lastSeenMoveCount === 4 && global.isLocalStateOptimistic === false);

    // параллельные запуски
    reset();
    DB.rooms.R1 = chainRoom();
    global.pendingMoveStartedAt = Date.now() - 13000;
    runSyncRecovery(false); runSyncRecovery(false); runSyncRecovery(false);
    await tick();
    check('19. несколько срабатываний тика -> РОВНО одно восстановление', READS.length === 1, 'чтений: ' + READS.length);

    // ошибка восстановления -> состояние ошибки, без модалки
    reset();
    let modalShown = false;
    global.showInfoModal = function () { modalShown = true; };
    FAIL_READ = true;
    global.pendingMoveStartedAt = Date.now() - 13000;
    runSyncRecovery(false);
    await tick();
    check('20. ошибка восстановления -> состояние «не удалось», БЕЗ модалки',
        global.syncRecoveryFailed === true && modalShown === false);
    check('21. после ошибки не остаётся «зависшего» флага', global.syncRecoveryInFlight === false);

    // ручное «Повторить» — только синхронизация
    FAIL_READ = false;
    DB.rooms.R1 = chainRoom();
    runSyncRecovery(true);
    await tick();
    check('22. ручное «Повторить»: успешная синхронизация снимает состояние ошибки',
        global.syncRecoveryFailed === false && global.currentState.moveCount === 4);
    check('23. ручное «Повторить» НЕ переотправляет ход (только чтение)',
        WRITES.length === 0 && PENDING_TX.length === 0);

    // =================================================================
    console.log('КРИТИЧЕСКОЕ: ПОЗДНИЙ COMMIT ПОСЛЕ ВОССТАНОВЛЕНИЯ');
    // =================================================================
    reset();
    DB.rooms.R1 = chainRoom();
    const roomBefore = JSON.parse(JSON.stringify(DB.rooms.R1));

    // T0: игрок бьёт 5_2 -> 3_4. Транзакция уходит и ЗАВИСАЕТ.
    const tx = makeRef('rooms/R1').transaction(function (room) {
        const state = {
            pieces: room.pieces, turn: room.turn, mustContinueFrom: room.mustContinueFrom || null,
            capturedDark: room.capturedDark || 0, capturedLight: room.capturedLight || 0,
            moveCount: room.moveCount || 0, positionHistory: room.positionHistory || []
        };
        const result = attemptMove(state, 5, 2, 3, 4, 'light');
        if (!result) return;
        const newRoom = {};
        for (const k in room) newRoom[k] = room[k];
        newRoom.pieces = result.pieces; newRoom.turn = result.turn;
        newRoom.mustContinueFrom = result.mustContinueFrom;
        newRoom.moveCount = result.moveCount;
        newRoom.capturedDark = result.capturedDark;
        newRoom.lastMovePath = result.lastMovePath;
        newRoom.pendingRemovals = result.pendingRemovals;
        return newRoom;
    });
    let txSettled = false;
    tx.then(function () { txSettled = true; global.pendingMoveStartedAt = null; });
    global.pendingMoveStartedAt = Date.now() - 13000;
    global.isLocalStateOptimistic = true;
    global.lastSeenMoveCount = 5;
    await tick();
    check('24. транзакция действительно «зависла» (promise не разрешён)',
        txSettled === false && JSON.stringify(DB.rooms.R1) === JSON.stringify(roomBefore));

    // T+12: восстановление откатывает к серверу (ход там ещё не применён)
    runSyncRecovery(false);
    await tick();
    check('25. после восстановления доска = серверная позиция (ход не применён)',
        global.currentState.moveCount === 4 && global.currentState.turn === 'light');

    // T+13: «ожившая» транзакция наконец применяется
    const committed = PENDING_TX[0].commit();
    await tick();
    check('26. поздний commit применил ход РОВНО один раз', committed === true &&
        DB.rooms.R1.moveCount === 5 && DB.rooms.R1.pieces['3_4'] && !DB.rooms.R1.pieces['5_2'],
        'moveCount=' + DB.rooms.R1.moveCount);
    check('27. moveCount вырос на 1, а не на 2', DB.rooms.R1.moveCount === 5);
    check('28. рубка продолжается: turn остался за light, mustContinueFrom выставлен',
        DB.rooms.R1.turn === 'light' && !!DB.rooms.R1.mustContinueFrom &&
        DB.rooms.R1.mustContinueFrom.row === 3 && DB.rooms.R1.mustContinueFrom.col === 4);
    check('29. поздний commit снял ожидание', txSettled === true && global.pendingMoveStartedAt === null);

    // =================================================================
    console.log('КРИТИЧЕСКОЕ: ВТОРОЙ ХОД В ОКНЕ МЕЖДУ ВОССТАНОВЛЕНИЕМ И COMMIT');
    // =================================================================
    // Гарантия №1 (интерфейс): пока ход не получил ответа, доска не принимает клики.
    check('30. клик по доске заблокирован, пока ход ждёт подтверждения',
        /if \(isOnlineGame && isMoveAwaitingConfirmation\(\)\) return;/.test(SRC));

    // Гарантия №2 (данные): даже если второй ход всё же уйдёт, транзакция
    // заново сверяет его с СЕРВЕРНЫМ turn и отменяется — движок, не наша проверка.
    reset();
    DB.rooms.R1 = chainRoom();
    // сервер уже принял первый ход: ход light продолжает рубку с 3_4
    const afterFirst = attemptMove({
        pieces: chainRoom().pieces, turn: 'light', mustContinueFrom: null,
        capturedDark: 0, capturedLight: 0, moveCount: 4, positionHistory: []
    }, 5, 2, 3, 4, 'light');
    DB.rooms.R1.pieces = afterFirst.pieces;
    DB.rooms.R1.turn = afterFirst.turn;
    DB.rooms.R1.mustContinueFrom = afterFirst.mustContinueFrom;
    DB.rooms.R1.moveCount = afterFirst.moveCount;
    // игрок пытается сходить ДРУГОЙ шашкой (как будто рубки не было)
    const conflicting = attemptMove({
        pieces: DB.rooms.R1.pieces, turn: DB.rooms.R1.turn,
        mustContinueFrom: DB.rooms.R1.mustContinueFrom,
        capturedDark: 0, capturedLight: 0, moveCount: DB.rooms.R1.moveCount, positionHistory: []
    }, 5, 2, 4, 1, 'light');
    check('31. конфликтующий второй ход отклоняется движком (mustContinueFrom)',
        conflicting === null);

    // и ход не своим цветом тоже
    const wrongTurn = attemptMove({
        pieces: chainRoom().pieces, turn: 'dark', mustContinueFrom: null,
        capturedDark: 0, capturedLight: 0, moveCount: 4, positionHistory: []
    }, 5, 2, 3, 4, 'light');
    check('32. ход не в свою очередь отклоняется движком', wrongTurn === null);

    // =================================================================
    console.log('МНОГОХОДОВАЯ РУБКА: ОБЫЧНАЯ ШАШКА И ДАМКА');
    // =================================================================
    reset();
    DB.rooms.R1 = chainRoom();
    DB.rooms.R1.pieces = afterFirst.pieces;
    DB.rooms.R1.turn = 'light';
    DB.rooms.R1.mustContinueFrom = { row: 3, col: 4 };
    DB.rooms.R1.moveCount = 5;
    DB.rooms.R1.lastMovePath = afterFirst.lastMovePath;
    DB.rooms.R1.pendingRemovals = afterFirst.pendingRemovals;
    global.pendingMoveStartedAt = Date.now() - 13000;
    global.isLocalStateOptimistic = true;
    global.lastSeenMoveCount = 6; // второй прыжок показан локально, сервером не принят
    runSyncRecovery(false);
    await tick();
    check('33. рубка: mustContinueFrom восстановлен с сервера',
        global.currentState.mustContinueFrom &&
        global.currentState.mustContinueFrom.row === 3 && global.currentState.mustContinueFrom.col === 4);
    check('34. рубка: нужная шашка снова выбрана — игрок продолжит именно оттуда',
        global.selectedFrom && global.selectedFrom.row === 3 && global.selectedFrom.col === 4);
    check('35. рубка: ход НЕ перешёл сопернику', global.currentState.turn === 'light');
    check('36. рубка: pendingRemovals и lastMovePath не потеряны',
        !!global.currentState.pendingRemovals && !!global.currentState.lastMovePath);
    // и рубку можно продолжить с восстановленного состояния
    const secondJump = attemptMove({
        pieces: global.currentState.pieces, turn: 'light',
        mustContinueFrom: global.currentState.mustContinueFrom,
        capturedDark: 0, capturedLight: 0, moveCount: 5,
        lastMovePath: global.currentState.lastMovePath,
        pendingRemovals: global.currentState.pendingRemovals, positionHistory: []
    }, 3, 4, 1, 6, 'light');
    check('37. рубка продолжается с восстановленной позиции', secondJump !== null);
    check('38. после последнего прыжка рубка корректно завершается: ход переходит сопернику',
        secondJump && secondJump.mustContinueFrom === null && secondJump.turn === 'dark',
        secondJump && (secondJump.turn + '/' + JSON.stringify(secondJump.mustContinueFrom)));

    // дамка
    reset();
    DB.rooms.R1 = chainRoom();
    DB.rooms.R1.pieces = {
        '7_0': { color: 'light', king: true },
        '4_3': { color: 'dark', king: false },
        // вторая жертва стоит на продолжении диагонали от точки приземления,
        // поэтому рубка дамки обязана продолжиться
        '1_6': { color: 'dark', king: false }
    };
    const kingFirst = attemptMove({
        pieces: DB.rooms.R1.pieces, turn: 'light', mustContinueFrom: null,
        capturedDark: 0, capturedLight: 0, moveCount: 4, positionHistory: []
    }, 7, 0, 3, 4, 'light');
    check('39. дамка: первый прыжок принят и рубка продолжается',
        kingFirst && kingFirst.mustContinueFrom && kingFirst.turn === 'light');
    DB.rooms.R1.pieces = kingFirst.pieces;
    DB.rooms.R1.turn = 'light';
    DB.rooms.R1.mustContinueFrom = kingFirst.mustContinueFrom;
    DB.rooms.R1.moveCount = kingFirst.moveCount;
    DB.rooms.R1.pendingRemovals = kingFirst.pendingRemovals;
    global.pendingMoveStartedAt = Date.now() - 13000;
    global.isLocalStateOptimistic = true;
    global.lastSeenMoveCount = 6;
    runSyncRecovery(false);
    await tick();
    check('40. дамка: mustContinueFrom восстановлен после восстановления',
        global.currentState.mustContinueFrom &&
        global.currentState.mustContinueFrom.row === kingFirst.mustContinueFrom.row &&
        global.selectedFrom !== null);

    // =================================================================
    console.log('ТРАФИК И ИЗОЛЯЦИЯ');
    // =================================================================
    reset();
    DB.rooms.R1 = chainRoom();
    global.pendingMoveStartedAt = Date.now(); // обычный быстрый ход
    computeSyncStatus(); computeSyncStatus(); computeSyncStatus();
    check('41. обычный быстрый ход не порождает НИ одного лишнего запроса',
        READS.length === 0 && WRITES.length === 0);
    check('42. состояние связи берётся из существующей подписки .info/connected',
        /isFirebaseConnected = \(snap\.val\(\) === true\);/.test(SRC));
    check('43. авто-восстановление не запускается без связи',
        /isMoveAwaitingConfirmation\(\) && isFirebaseConnected &&/.test(SRC));
    check('44. ожидание снимается при ЛЮБОМ ответе сервера (и .then, и .catch)',
        (SRC.match(/pendingMoveStartedAt = null;/g) || []).length >= 4);
    check('45. состояние сбрасывается при новой партии/реванше',
        (SRC.match(/pendingSyncChain = Promise\.resolve\(\);\n\s*\/\/ Ожидание хода/g) || []).length === 2);
    check('46. индикатор живёт в существующем #turn-timer (доска не прыгает)',
        /turnTimerDiv\.textContent = t\(sync\.key\);/.test(SRC) && /min-height/.test(require('fs').readFileSync(__dirname + '/../style.css', 'utf8')));
    check('47. переводы есть во всех трёх языках (ru/en/it)', (function () {
        const keys = ['sync_sending_move', 'sync_no_connection', 'sync_checking', 'sync_failed', 'btn_sync_retry'];
        function countOf(needle) {
            let n = 0, i = 0;
            while ((i = SRC.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
            return n;
        }
        // префикс пробелами, чтобы не поймать существующий err_resync_failed
        return keys.every(function (k) { return countOf('        ' + k + ':') === 3; });
    })());
    check('48. движок ходов и транзакция хода не тронуты',
        /if \(turn !== actingColor\) return null;/.test(SRC) &&
        /return database\.ref\("rooms\/" \+ roomCode\)\.transaction\(function \(room\)/.test(SRC));

    // =================================================================
    console.log('СОВМЕСТИМОСТЬ С UID-ФИКСОМ v175');
    // =================================================================
    check('49. UID-резолвер результата на месте и не тронут sync-патчем',
        /function resolveMyOnlineResult\(state\) \{/.test(SRC) &&
        /const winnerId = \(state\.winner === "light"\) \? lightId : darkId;/.test(SRC));
    check('50. online-статистика по-прежнему считает результат по UID',
        /didIWin = \(myResult === "win"\);/.test(SRC));
    check('51. online-монеты по-прежнему считают результат по UID',
        /const myResult = resolveMyOnlineResult\(currentState\);\s*\n\s*if \(myResult === null\) return null;/.test(SRC));
    check('52. bot-ветка статистики не тронута ни UID-фиксом, ни sync-патчем',
        /if \(isBotGame\) \{\s*\n\s*didIWin = currentState\.winner === myColor;/.test(SRC));
    check('53. восстановление обновляет players, из которых берётся UID', (function () {
        const m = /function forceResyncFromServer[\s\S]*?\n}/.exec(SRC);
        return m && /players: room\.players/.test(m[0]);
    })());
    check('54. sync-состояние нигде не влияет на определение победителя', (function () {
        const m = /function resolveMyOnlineResult[\s\S]*?\n}/.exec(SRC);
        return m && !/pendingMoveStartedAt|syncRecovery|isFirebaseConnected/.test(m[0]);
    })());
    check('55. Elo-квитанция не зависит от sync-состояния', (function () {
        const m = /function recordEloMatchResult[\s\S]*?\n}/.exec(SRC);
        return m && !/pendingMoveStartedAt|syncRecovery|isFirebaseConnected/.test(m[0]);
    })());
    check('56. движок ходов и правила шашек не тронуты',
        /if \(turn !== actingColor\) return null;/.test(SRC) &&
        /mustContinueFrom\.row !== fromRow/.test(SRC));
    check('57. реванш не изменён: снимок рейтингов по-прежнему обнуляется',
        /updates\["ratingsAtStart"\] = null;/.test(SRC));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

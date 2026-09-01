// ROOM LIFECYCLE CLEANUP — regression-тесты двух багов аудита v169:
//
// П3: после удаления комнаты соперником старый клиент через ранее взведённый
//     onDisconnect() или через глобальный .info/connected-реконнект снова
//     создавал rooms/<code> в виде огрызка {presence:{...}}.
// П4: loadActiveRooms() обращался к room.presence ДО проверки room на null,
//     из-за чего metadata удалённой комнаты не самоочищалась, а список
//     «Мои игры» мог не дорисоваться.
//
// ЧТО ЗАПУСКАЕТСЯ ПО-НАСТОЯЩЕМУ: реальные функции из script.js
// (startOnlineGame, setupPresence, detachMyPresence, stopPresenceHeartbeat,
// handleVisibilityChange, loadActiveRooms) плюс РЕАЛЬНЫЙ top-level блок
// connectedRef.on(...) — он вырезается из исходника и исполняется как есть.
//
// ЧТО МОКИРУЕТСЯ (честно): Firebase database (in-memory дерево), DOM,
// таймеры. Семантика onDisconnect эмулируется по документации RTDB:
// взведённая операция хранится НА СЕРВЕРЕ и выполняется при разрыве
// соединения, если её не отменили cancel(); update() по несуществующему
// пути создаёт его. Это НЕ доказательство реального сервера Firebase —
// но именно эта семантика уже дважды подтверждена живыми тестами проекта.
const { SRC, extractFunc } = require('./helpers/loader');

// v194-R3: панель показывает рейтинг отдельным сегментом, окно итога —
// изменение рейтинга, а окно статистики — место игрока. Харнессу нужны
// эти элементы и функции.
if (!global.statsYourRank) global.statsYourRank = { textContent: '' };
if (!global.endGameRating) global.endGameRating = { textContent: '' };
if (!global.rematchWaitNote) global.rematchWaitNote = { textContent: '' };
if (!global.lastSettlementDisplay) global.lastSettlementDisplay = null;
if (!global.resetSettlementDisplay) global.resetSettlementDisplay = function () {};
if (!global.ratingSegmentForColor) global.ratingSegmentForColor = function () { return ''; };
if (!global.requestSettlement) global.requestSettlement = function () {};
if (!global.requestRatedJoin) global.requestRatedJoin = function () {};


// v193 auth harness: these legacy behavioural suites exercise already-authenticated flows.
global.firebaseAuthReady = true;
global.localOnlyBotGame = false;
global.canUseFirebase = function () { return true; };
global.requireFirebaseAuth = function () { return true; };
let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

// ===== Общая инфраструктура моков =====

global.firebase = { database: { ServerValue: { TIMESTAMP: '__TS__' } } };

const env = {};

function applyWrite(path, value, merge) {
    // update()/set() по несуществующему пути СОЗДАЮТ его (реальная семантика RTDB)
    const parts = path.split('/');
    let node = env.serverData;
    for (let i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (merge && typeof node[leaf] === 'object' && node[leaf] !== null && typeof value === 'object') {
        for (const k in value) node[leaf][k] = value[k];
    } else {
        node[leaf] = JSON.parse(JSON.stringify(value));
    }
    env.writes.push({ path: path, value: value });
}

function readPath(path) {
    const parts = path.split('/');
    let node = env.serverData;
    for (const p of parts) {
        if (node === undefined || node === null) return null;
        node = node[p];
    }
    return node === undefined ? null : node;
}

function makeRef(path) {
    return {
        on: function (type, cb) {
            if (path.indexOf('rooms/') === 0 && type === 'value') env.roomValueCb = cb;
            if (path === '.info/connected') env.connectedCb = cb;
        },
        off: function () {},
        once: function () {
            env.onceReads.push(path);
            const behave = env.onceBehavior && env.onceBehavior[path];
            const snap = { val: function () { const v = readPath(path); return v === null ? null : JSON.parse(JSON.stringify(v)); } };
            if (behave === 'defer') {
                return new Promise(function (res) { realSetTimeout(function () { res(snap); }, 5); });
            }
            return Promise.resolve(snap);
        },
        set: function (v) { applyWrite(path, v, false); return Promise.resolve(); },
        update: function (v) { applyWrite(path, v, true); return Promise.resolve(); },
        remove: function () {
            env.removes.push(path);
            const parts = path.split('/');
            let node = env.serverData;
            for (let i = 0; i < parts.length - 1; i++) {
                node = node && node[parts[i]];
            }
            if (node) delete node[parts[parts.length - 1]];
            return Promise.resolve();
        },
        onDisconnect: function () {
            return {
                update: function (v) { env.armed.push({ path: path, value: v, op: 'update' }); return Promise.resolve(); },
                remove: function () { env.armed.push({ path: path, op: 'remove' }); },
                cancel: function () { env.armed = env.armed.filter(function (a) { return a.path !== path; }); }
            };
        }
    };
}

// Сервер применяет взведённые onDisconnect-операции при разрыве соединения
function simulateDisconnectNow() {
    const ops = env.armed.slice();
    env.armed = [];
    ops.forEach(function (a) {
        if (a.op === 'update') applyWrite(a.path, a.value, true);
        if (a.op === 'remove') {
            /* не используется в этих сценариях */
        }
    });
}

function stubEl() {
    const el = {
        children: [], className: '', textContent: '', innerHTML: '', title: '',
        classList: {
            _s: {},
            add: function (c) { this._s[c] = true; },
            remove: function (c) { delete this._s[c]; },
            toggle: function () {}, contains: function (c) { return !!this._s[c]; }
        },
        appendChild: function (ch) { this.children.push(ch); return ch; },
        addEventListener: function () {}
    };
    return el;
}

const realSetTimeout = setTimeout;
const realSetImmediate = setImmediate;
const flush = () => new Promise(function (r) { realSetTimeout(r, 20); });

// ===== Загрузка реального кода =====

let loadError = null;
try {
    eval(extractFunc('stopPresenceHeartbeat'));
    eval(extractFunc('handleVisibilityChange'));
    eval(extractFunc('detachMyPresence'));
    eval(extractFunc('setupPresence'));
    eval(extractFunc('startOnlineGame'));
    eval(extractFunc('loadActiveRooms'));
} catch (e) { loadError = e.message; }

// Реальный top-level блок .info/connected — вырезаем из исходника как есть.
function evalConnectedBlock() {
    const start = SRC.indexOf('const connectedRef = database.ref(".info/connected")');
    if (start === -1) throw new Error('Блок connectedRef не найден в script.js');
    const end = SRC.indexOf('\n});', start);
    if (end === -1) throw new Error('Конец блока connectedRef не найден');
    eval(SRC.slice(start, end + 4));
}

// ===== Общие глобали =====

function setupCommonGlobals() {
    env.serverData = { rooms: {} };
    env.writes = []; env.removes = []; env.armed = []; env.onceReads = [];
    env.timers = []; env.intervals = []; env.screens = []; env.modals = [];
    env.loadActiveRoomsCalls = 0;
    env.roomValueCb = null; env.connectedCb = null;
    env.onceBehavior = null;

    global.database = { ref: makeRef };
    global.myTelegramId = 'ME'; global.myTelegramName = 'Me';
    global.isBotGame = false; global.isOnlineGame = false; global.isSpectator = false;
    global.flipped = false; global.myColor = 'light'; global.roomCode = null;
    global.lastSeenMoveCount = -1; global.isLocalStateOptimistic = false;
    global.selectedFrom = null; global.lastAnimatedMoveCount = null;
    global.endGameShownForRoom = null; global.statsRecordedForRoom = null;
    global.statsInFlightOnlineMarker = null; global.coinRewardAttemptForMatch = null;
    global.statsCache = {}; global.opponentAbsenceHandled = false;
    global.lastRenderedSignature = null; global.boardBuilt = false;
    global.pendingSyncChain = null; global.opponentGraceTimer = null;
    // ONLINE PRESENCE (v177): переменные единой шкалы отсутствия
    global.isFirebaseConnected = true;
    global.connectedSinceMono = -60000;
    global.connectionGeneration = 1;
    global.listenerGeneration = 0;
    global.resetRoomFreshnessProof = function () { global.listenerGeneration++; };
    global.serverAckSinceConnect = true;
    global.roomSnapshotSeenSinceConnect = true;
    global.getMonotonicNow = function () { return 0; };
    global.noteServerAck = function () { global.serverAckSinceConnect = true; };
    global.connectedSinceMs = Date.now() - 60000;
    global.CONNECTION_SETTLE_MS = 15000;
    global.serverTimeOffsetReady = true;
    global.cachedServerTimeOffsetMs = 0;
    global.getEstimatedServerNow = function () { return Date.now(); };
    global.mustCaptureHintTimer = null; global.myPresenceRef = null;
    global.presenceHeartbeatInterval = null; global.currentState = null;
    global.reactionsRow = stubEl();
    global.roomListenerRef = null;
    global.menuScreen = 'MENU'; global.gameScreen = 'GAME';
    global.showScreen = function (s) { env.screens.push(s); };
    global.showInfoModal = function (txt) { env.modals.push(txt); };
    global.loadActiveRoomsMockable = null;
    global.t = function (k) { return k; };
    global.STALE_MS = 20000;

    global.document = {
        hidden: false,
        addEventListener: function () {}, removeEventListener: function () {},
        getElementById: function (id) { return env.dom ? env.dom[id] : undefined; },
        createElement: function () { return stubEl(); }
    };

    global.setInterval = function (fn, ms) { const id = env.intervals.length + 1; env.intervals.push({ id: id, fn: fn, ms: ms, cleared: false }); return id; };
    global.clearInterval = function (id) { const t = env.intervals[id - 1]; if (t) t.cleared = true; };
    global.setTimeout = function (fn, ms) { const id = env.timers.length + 1; env.timers.push({ id: id, fn: fn, ms: ms, cleared: false }); return id; };
    global.clearTimeout = function (id) { const t = env.timers[id - 1]; if (t) t.cleared = true; };
}

(async function () {
    if (loadError) {
        check('0. функции присутствуют в script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exit(1);
    }

    // =====================================================================
    console.log('П3. Presence после удаления комнаты соперником');
    // =====================================================================
    setupCommonGlobals();
    // Ветка удаления вызывает НАСТОЯЩИЙ loadActiveRooms — даём ему DOM-заглушки
    // и фиксируем вызов по наблюдаемому признаку: чтению users/ME/rooms.
    env.dom = {
        'active-rooms-section': stubEl(),
        'active-rooms-list': stubEl(),
        'no-active-game-text': stubEl()
    };

    evalConnectedBlock();
    // Соединение установлено — как в реальном приложении при старте.
    env.connectedCb({ val: function () { return true; } });

    // Игрок в активной online-комнате R1
    env.serverData.rooms.R1 = {
        pieces: { '5_0': { color: 'light', king: false } }, turn: 'light', status: 'active',
        players: { light: { id: 'ME', name: 'Me' }, dark: { id: 'OPP', name: 'Opp' } }
    };
    global.roomCode = 'R1';
    global.myColor = 'light';
    global.currentState = null;

    startOnlineGame();
    await flush();

    check('подготовка: presence записан, пока комната жива',
        readPath('rooms/R1/presence/light') !== null);
    check('подготовка: onDisconnect взведён на стороне сервера',
        env.armed.some(function (a) { return a.path === 'rooms/R1/presence/light'; }));
    check('подготовка: heartbeat запущен',
        env.intervals.some(function (i) { return i.ms === 4000 && !i.cleared; }));

    // ДРУГОЙ КЛИЕНТ удаляет комнату целиком
    delete env.serverData.rooms.R1;
    const writesBeforeRemoval = env.writes.length;

    // Наш listener получает room === null
    env.roomValueCb({ val: function () { return null; } });
    await flush();

    check('1. heartbeat остановлен',
        env.intervals.filter(function (i) { return i.ms === 4000; }).every(function (i) { return i.cleared; }));

    const onceReadsAfterRemoval = env.onceReads.length;
    check('2. UI: возврат в меню + перезагрузка списка игр',
        env.screens.indexOf('MENU') !== -1 &&
        env.onceReads.indexOf('users/ME/rooms') !== -1);
    check('3. показано «Соперник покинул игру»',
        env.modals.length === 1);

    // Реконнект после удаления: .info/connected снова true
    env.connectedCb({ val: function () { return true; } });
    await flush();
    check('4. reconnect НЕ пересоздал presence удалённой комнаты',
        readPath('rooms/R1') === null,
        'rooms/R1 = ' + JSON.stringify(readPath('rooms/R1')));

    // Игрок закрывает приложение: сервер применяет взведённые onDisconnect
    simulateDisconnectNow();
    check('5. старый onDisconnect НЕ воскресил rooms/R1 огрызком presence',
        readPath('rooms/R1') === null,
        'rooms/R1 = ' + JSON.stringify(readPath('rooms/R1')));
    check('6. после удаления вообще не было записей в rooms/R1/*',
        env.writes.slice(writesBeforeRemoval).every(function (w) { return w.path.indexOf('rooms/R1') !== 0; }),
        JSON.stringify(env.writes.slice(writesBeforeRemoval)));

    // =====================================================================
    console.log('');
    console.log('П4. loadActiveRooms: metadata указывает на удалённую комнату');
    // =====================================================================
    setupCommonGlobals();
    env.dom = {
        'active-rooms-section': stubEl(),
        'active-rooms-list': stubEl(),
        'no-active-game-text': stubEl()
    };
    const now = Date.now();
    env.serverData = {
        users: { ME: { rooms: {
            DEAD: { opponentName: 'Призрак', myColor: 'light' },
            LIVE: { opponentName: 'Полина', myColor: 'dark' }
        } } },
        rooms: {
            LIVE: {
                pieces: { '5_0': { color: 'light', king: false } }, turn: 'light', status: 'active',
                turnStartedAt: now,
                players: { light: { id: 'OPP2', name: 'Полина' }, dark: { id: 'ME', name: 'Me' } },
                presence: {
                    light: { online: true, lastSeen: now },
                    dark: { online: true, lastSeen: now }
                }
            }
            // DEAD отсутствует — комната удалена, metadata осталась
        }
    };
    // Мёртвая комната резолвится ПОСЛЕДНЕЙ — худший порядок для старого кода
    // (в нём финальный рендер списка находился внутри упавшего колбэка).
    env.onceBehavior = { 'rooms/DEAD': 'defer' };

    let thrown = null;
    try { loadActiveRooms(); } catch (e) { thrown = e; }
    await flush(); await flush();

    check('1. синхронного TypeError нет', thrown === null, thrown && thrown.message);
    check('2. мёртвая metadata самоочистилась (users/ME/rooms/DEAD удалена)',
        env.removes.indexOf('users/ME/rooms/DEAD') !== -1,
        'removes=' + JSON.stringify(env.removes));
    check('3. живая комната обработана и попала в список',
        env.dom['active-rooms-list'].children.length === 1,
        'детей в списке: ' + env.dom['active-rooms-list'].children.length);
    check('4. в строке списка — имя реального соперника',
        JSON.stringify(env.dom['active-rooms-list'].children).indexOf('Полина') !== -1);
    check('5. секция «Мои игры» показана, заглушка скрыта',
        !env.dom['active-rooms-section'].classList.contains('hidden') &&
        env.dom['no-active-game-text'].classList.contains('hidden'));
    check('6. живая metadata НЕ удалена',
        env.removes.indexOf('users/ME/rooms/LIVE') === -1);

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

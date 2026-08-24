// PRESENCE LIFECYCLE (v171) — regression-тесты исправлений A+B+C+C-1
// живого аудита production v170:
//
// A: onDisconnect писал { online:false, lastSeen:TS }. Сервер выполняет его
//    через ~45-90с после жёсткого закрытия приложения — свежий lastSeen
//    "омолаживал" ушедшего игрока, и все отсчёты (absence у соперника,
//    staleness в лобби) начинались заново → лишняя вторая минута.
// B: глобальный .info/connected-реаниматор писал online:true даже при
//    document.hidden === true — скрытый, но живой WebView мог "оживить"
//    ушедшего игрока и сбросить таймер checkOpponentAbsence у соперника.
// C: waiting-комнаты физически никогда не удалялись — только скрывались
//    из лобби; копились в Firebase навсегда.
// C-1: чтобы C не ломал сценарий "нажал Поделиться → ушёл в чат отправить
//    ссылку", heartbeat создателя waiting-комнаты без соперника продолжает
//    обновлять lastSeen (и ТОЛЬКО lastSeen) при document.hidden.
//
// ЧТО ЗАПУСКАЕТСЯ ПО-НАСТОЯЩЕМУ: реальные функции из script.js
// (setupPresence, stopPresenceHeartbeat, handleVisibilityChange,
// detachMyPresence, startOnlineGame, isRoomPlayerStale, runLobbyStaleSweep,
// statusForColor, checkOpponentAbsence) плюс реальный top-level блок
// connectedRef.on(...) — вырезается из исходника и исполняется как есть.
//
// ЧТО МОКИРУЕТСЯ: Firebase database (in-memory), DOM, таймеры — та же
// инфраструктура, что в room-cleanup.test.js.
//
// Проверка "тест ловит баг": TARGET_SCRIPT=<путь к v170 script.js> — тесты
// 1, 2, 4, 5, 6 обязаны падать на v170 и проходить на исправленной версии.
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

// ===== Общая инфраструктура моков (как в room-cleanup.test.js) =====

global.firebase = { database: { ServerValue: { TIMESTAMP: '__TS__' } } };

const env = {};

function applyWrite(path, value, merge) {
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
            if (path === '.info/connected') env.connectedCb = cb;
        },
        off: function () {},
        once: function () {
            const snap = { val: function () { const v = readPath(path); return v === null ? null : JSON.parse(JSON.stringify(v)); } };
            return Promise.resolve(snap);
        },
        set: function (v) { applyWrite(path, v, false); return Promise.resolve(); },
        update: function (v) { applyWrite(path, v, true); return Promise.resolve(); },
        remove: function () {
            env.removes.push(path);
            const parts = path.split('/');
            let node = env.serverData;
            for (let i = 0; i < parts.length - 1; i++) node = node && node[parts[i]];
            if (node) delete node[parts[parts.length - 1]];
            return Promise.resolve();
        },
        onDisconnect: function () {
            return {
                update: function (v) { env.armed.push({ path: path, value: v, op: 'update' }); },
                remove: function () { env.armed.push({ path: path, op: 'remove' }); },
                cancel: function () { env.armed = env.armed.filter(function (a) { return a.path !== path; }); }
            };
        }
    };
}

function stubEl() {
    return {
        children: [], className: '', textContent: '', innerHTML: '',
        classList: {
            _s: {},
            add: function (c) { this._s[c] = true; },
            remove: function (c) { delete this._s[c]; },
            toggle: function () {}, contains: function (c) { return !!this._s[c]; }
        },
        appendChild: function (ch) { this.children.push(ch); return ch; },
        addEventListener: function () {}
    };
}

// ===== Загрузка реального кода =====

let loadError = null;
try {
    eval(extractFunc('stopPresenceHeartbeat'));
    eval(extractFunc('handleVisibilityChange'));
    eval(extractFunc('detachMyPresence'));
    eval(extractFunc('setupPresence'));
    eval(extractFunc('startOnlineGame'));
    eval(extractFunc('isRoomPlayerStale'));
    eval(extractFunc('runLobbyStaleSweep'));
    eval(extractFunc('statusForColor'));
    eval(extractFunc('getOpponentAbsenceMs'));
    eval(extractFunc('canTrustAbsenceForCleanup'));
    eval(extractFunc('checkOpponentAbsence'));
} catch (e) { loadError = e.message; }

function evalConnectedBlock() {
    const start = SRC.indexOf('const connectedRef = database.ref(".info/connected")');
    if (start === -1) throw new Error('Блок connectedRef не найден в script.js');
    const end = SRC.indexOf('\n});', start);
    if (end === -1) throw new Error('Конец блока connectedRef не найден');
    eval(SRC.slice(start, end + 4));
}

function setupCommonGlobals() {
    env.serverData = { rooms: {} };
    env.writes = []; env.removes = []; env.armed = [];
    env.timers = []; env.intervals = [];
    env.connectedCb = null;

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
    global.getEstimatedServerNow = function () { return Date.now(); };
    global.mustCaptureHintTimer = null; global.myPresenceRef = null;
    global.presenceHeartbeatInterval = null; global.currentState = null;
    global.myWaitingRoomNoOpponent = false; // в v170 не существует — глобаль безвредна
    global.reactionsRow = stubEl();
    global.roomListenerRef = null;
    global.menuScreen = 'MENU'; global.gameScreen = 'GAME';
    global.showScreen = function () {};
    global.showInfoModal = function () {};
    global.loadActiveRooms = function () {};
    global.scheduleLobbyRender = function () {};
    global.cleanupAbandonedRoom = function () { env.cleanupCalls = (env.cleanupCalls || 0) + 1; };
    global.fetchAndCacheStatsIfNeeded = function () {};
    global.t = function (k) { return k; };
    global.STALE_MS = 20000;
    global.RECONNECT_GRACE_MS = 60000;
    global.PRESENCE_STALE_WARNING_MS = 12000;
    global.lobbyRoomsByCode = {};
    global.opponentLeftText = stubEl();
    global.opponentLeftModal = stubEl();
    global.opponentLeftModal.classList.add('hidden');
    env.cleanupCalls = 0;

    global.document = {
        hidden: false,
        addEventListener: function () {}, removeEventListener: function () {},
        getElementById: function () { return stubEl(); },
        createElement: function () { return stubEl(); }
    };

    global.setInterval = function (fn, ms) { const id = env.intervals.length + 1; env.intervals.push({ id: id, fn: fn, ms: ms, cleared: false }); return id; };
    global.clearInterval = function (id) { const t = env.intervals[id - 1]; if (t) t.cleared = true; };
    global.setTimeout = function (fn, ms) { const id = env.timers.length + 1; env.timers.push({ id: id, fn: fn, ms: ms, cleared: false }); return id; };
    global.clearTimeout = function (id) { const t = env.timers[id - 1]; if (t) t.cleared = true; };
}

function heartbeatTick() {
    // единственный интервал, который заводит setupPresence — 4000мс
    const hb = env.intervals.filter(function (i) { return i.ms === 4000 && !i.cleared; }).pop();
    if (!hb) throw new Error('heartbeat-интервал не найден');
    hb.fn();
}

function presenceWrites() {
    return env.writes.filter(function (w) { return w.path.indexOf('/presence/') !== -1; });
}

(function () {
    if (loadError) {
        check('0. функции присутствуют в script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exit(1);
    }

    // =====================================================================
    console.log('1. onDisconnect payload не содержит lastSeen (правка A)');
    // =====================================================================
    setupCommonGlobals();
    global.roomCode = 'R1'; global.myColor = 'light';
    setupPresence();
    const armed = env.armed.find(function (a) { return a.path === 'rooms/R1/presence/light' && a.op === 'update'; });
    check('onDisconnect взведён на свою presence-ячейку', !!armed);
    check('payload содержит online:false', !!armed && armed.value && armed.value.online === false);
    check('payload НЕ содержит lastSeen', !!armed && armed.value && !('lastSeen' in armed.value),
        'lastSeen в onDisconnect "омолаживает" ушедшего игрока при позднем срабатывании');

    // =====================================================================
    console.log('2. active + document.hidden → .info/connected НЕ пишет online:true (правка B)');
    // =====================================================================
    setupCommonGlobals();
    global.roomCode = 'R1'; global.isOnlineGame = true; global.myColor = 'light';
    setupPresence();
    evalConnectedBlock();
    env.writes = [];
    global.document.hidden = true;
    env.connectedCb({ val: function () { return true; } });
    check('скрытый WebView не оживляет presence', presenceWrites().length === 0,
        'записано: ' + JSON.stringify(presenceWrites()));

    // =====================================================================
    console.log('3. active + visible → .info/connected пишет online:true (reconnect не сломан)');
    // =====================================================================
    env.writes = [];
    global.document.hidden = false;
    env.connectedCb({ val: function () { return true; } });
    const burst = presenceWrites().find(function (w) { return w.value && w.value.online === true; });
    check('видимый reconnect мгновенно пишет online:true', !!burst);

    // =====================================================================
    console.log('4. waiting-создатель без dark + hidden → heartbeat продолжает lastSeen (C-1)');
    // =====================================================================
    setupCommonGlobals();
    global.roomCode = 'W1'; global.myColor = 'light'; global.isOnlineGame = true;
    global.myWaitingRoomNoOpponent = true; // как выставляет createRoomAndShowWaiting
    setupPresence();
    env.writes = [];
    global.document.hidden = true;
    heartbeatTick();
    const hiddenHb = presenceWrites();
    check('lastSeen продолжает обновляться в фоне', hiddenHb.length === 1 && 'lastSeen' in hiddenHb[0].value,
        'без этого sweep удалит комнату, пока создатель отправляет ссылку в чате');
    check('фоновая запись НЕ выставляет online:true', hiddenHb.length === 1 && hiddenHb[0].value.online !== true);
    // исходник действительно взводит флаг в обеих живых точках входа создателя
    const createIdx = SRC.indexOf('function createRoomAndShowWaiting');
    const setInCreate = createIdx !== -1 && SRC.indexOf('myWaitingRoomNoOpponent = true', createIdx) !== -1;
    const inviteWaitingIdx = SRC.indexOf('myPendingFriendRoomCode = roomCode;\n\n                settled = true;');
    const setInInvite = SRC.indexOf('myWaitingRoomNoOpponent = true; // (v171) моя waiting-комната') !== -1;
    check('флаг взводится в createRoomAndShowWaiting', setInCreate);
    check('флаг взводится при повторном открытии своей waiting-комнаты по ссылке', setInInvite && inviteWaitingIdx !== -1);

    // =====================================================================
    console.log('5. dark появился / участие кончилось → фоновый heartbeat прекращается (C-1)');
    // =====================================================================
    // startOnlineGame() (вызывается у создателя, когда друг подключился) снимает флаг
    global.startOnlineGameProbe = true;
    startOnlineGame();
    check('startOnlineGame снимает myWaitingRoomNoOpponent', global.myWaitingRoomNoOpponent === false,
        'иначе фоновый heartbeat продолжится и во время active-партии');
    env.writes = [];
    global.document.hidden = true;
    heartbeatTick();
    check('после начала партии hidden-heartbeat молчит', presenceWrites().length === 0);
    // detachMyPresence тоже снимает флаг (выход/удаление комнаты/зритель)
    global.myWaitingRoomNoOpponent = true;
    detachMyPresence();
    check('detachMyPresence снимает myWaitingRoomNoOpponent', global.myWaitingRoomNoOpponent === false);

    // =====================================================================
    console.log('6. sweep удаляет мёртвую waiting-комнату + users metadata (правка C)');
    // =====================================================================
    setupCommonGlobals();
    global.lobbyRoomsByCode = {
        W1: {
            status: 'waiting',
            players: { light: { id: 'CR', name: 'Creator' }, dark: null },
            presence: { light: { online: false, lastSeen: Date.now() - 70000 } }
        }
    };
    runLobbyStaleSweep();
    check('rooms/W1 удалена', env.removes.indexOf('rooms/W1') !== -1,
        'в v170 waiting-комнаты не удалялись никогда');
    check('users/CR/rooms/W1 удалена', env.removes.indexOf('users/CR/rooms/W1') !== -1);

    // =====================================================================
    console.log('7. waiting-создатель stale < 60с → комната НЕ удаляется');
    // =====================================================================
    setupCommonGlobals();
    global.lobbyRoomsByCode = {
        W2: {
            status: 'waiting',
            players: { light: { id: 'CR', name: 'Creator' }, dark: null },
            presence: { light: { online: false, lastSeen: Date.now() - 30000 } }
        }
    };
    runLobbyStaleSweep();
    check('свежая waiting-комната цела', env.removes.length === 0, 'удалено: ' + JSON.stringify(env.removes));

    // =====================================================================
    console.log('8. active-комнаты новая waiting-ветка не трогает');
    // =====================================================================
    setupCommonGlobals();
    global.lobbyRoomsByCode = {
        A1: { // один stale, второй живой — не удалять (прежнее поведение)
            status: 'active',
            players: { light: { id: 'P1' }, dark: { id: 'P2' } },
            presence: {
                light: { online: false, lastSeen: Date.now() - 120000 },
                dark: { online: true, lastSeen: Date.now() - 2000 }
            }
        },
        A2: { // оба давно оффлайн — существующая очистка ОБЯЗАНА сработать
            status: 'active',
            players: { light: { id: 'P3' }, dark: { id: 'P4' } },
            presence: {
                light: { online: false, lastSeen: Date.now() - 120000 },
                dark: { online: false, lastSeen: Date.now() - 120000 }
            }
        }
    };
    runLobbyStaleSweep();
    check('active с одним живым игроком цела', env.removes.indexOf('rooms/A1') === -1);
    check('active с двумя мёртвыми по-прежнему удаляется', env.removes.indexOf('rooms/A2') !== -1);

    // =====================================================================
    console.log('9. свернул Telegram на 30-50с во время active → не считается ушедшим');
    // =====================================================================
    setupCommonGlobals();
    // online:false (visibilitychange) при СВЕЖЕМ lastSeen — это "свернул", не "ушёл"
    const backgrounded = {
        status: 'active',
        players: { light: { id: 'P1' }, dark: { id: 'P2' } },
        presence: {
            light: { online: false, lastSeen: Date.now() - 40000 },
            dark: { online: false, lastSeen: Date.now() - 40000 }
        }
    };
    check('isRoomPlayerStale игнорирует online:false при lastSeen < 60с',
        isRoomPlayerStale(backgrounded, 'light') === false && isRoomPlayerStale(backgrounded, 'dark') === false);
    global.lobbyRoomsByCode = { B1: backgrounded };
    runLobbyStaleSweep();
    check('комната обоих свернувших НЕ удалена', env.removes.indexOf('rooms/B1') === -1);

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

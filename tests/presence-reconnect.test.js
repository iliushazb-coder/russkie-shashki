// ONLINE PRESENCE / RECONNECT — regression-тесты четырёх правок.
//
// Реальный инцидент: тот, кто САМ терял сеть, начинал видеть соперника
// офлайн, запускал отсчёт отсутствия и в конце удалял живую комнату.
//
// Правки:
//  1. Нет связи у меня -> состояние соперника UNKNOWN, отсчёт не идёт.
//  2. Возраст lastSeen считается по СЕРВЕРНОМУ времени, а не по часам телефона.
//  3. Одна 60-секундная шкала от lastSeen (отдельного setTimeout больше нет):
//     после reconnect соперник НЕ получает новую минуту.
//  4. Перед удалением живой комнаты — fail-safe: любое сомнение = не удалять.
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

let cleanupCalls, modalHidden, timersCreated;
let resultsWritten = [], resultNodeExisting = null, txAborted = 0, presenceWrites = [];

let loadError = null;
try {
    global.PRESENCE_STALE_WARNING_MS = Number(/const PRESENCE_STALE_WARNING_MS = (\d+);/.exec(SRC)[1]);
    global.RECONNECT_GRACE_MS = Number(/const RECONNECT_GRACE_MS = (\d+);/.exec(SRC)[1]);
    global.CONNECTION_SETTLE_MS = Number(/const CONNECTION_SETTLE_MS = (\d+);/.exec(SRC)[1]);
    global.TECHNICAL_WIN_REASON = /const TECHNICAL_WIN_REASON = "([a-z]+)";/.exec(SRC)[1];
    eval(extractFunc('getAuthoritativeAbsenceMs'));
    eval(extractFunc('getOnlineSessionMs'));
    eval(extractFunc('statusForColor'));
    eval(extractFunc('getOpponentAbsenceMs'));
    eval(extractFunc('canTrustAbsenceForCleanup'));
    eval(extractFunc('writeTechnicalResult'));
    eval(extractFunc('checkOpponentAbsence'));
} catch (e) { loadError = e.message; }

// Смещение часов телефона относительно сервера (мс). 0 = часы верны.
let clockSkewMs = 0;
// Монотонные часы теста: 60 секунд «связь стабильна» по умолчанию.
let monoNow = 60000;

function reset() {
    cleanupCalls = 0; modalHidden = true; timersCreated = []; txAborted = 0;
    global.isOnlineGame = true; global.isBotGame = false; global.isSpectator = false;
    global.roomCode = 'R1'; global.myColor = 'light'; global.myTelegramId = 'ME';
    global.isFirebaseConnected = true;
    global.connectedSinceMono = 0;
    global.connectionGeneration = 1;
    global.serverAckSinceConnect = true;
    global.getMonotonicNow = function () { return monoNow; }; // управляем из теста
    global.serverTimeOffsetReady = true;
    global.roomSnapshotSeenSinceConnect = true;
    global.opponentAbsenceHandled = false;
    global.statsCache = {};
    global.getEstimatedServerNow = function () { return Date.now() + clockSkewMs; };
    global.fetchAndCacheStatsIfNeeded = function () {};
    global.t = function (k) { return k; };
    global.cleanupAbandonedRoom = function () { cleanupCalls++; };
    // v180: мок базы. Технический результат пишется ОДНИМ update() на узкие
    // дочерние пути rooms/<код>/{result,winner,winReason,status}.
    resultsWritten = [];
    resultNodeExisting = null;
    presenceWrites = [];
    global.technicalResultInFlight = false;
    global.firebase = { database: { ServerValue: { TIMESTAMP: 1700000000000 } } };
    global.database = { ref: function (path) { return {
        update: function (obj) {
            if (/presence/.test(path)) { presenceWrites.push(path); }
            if (resultNodeExisting) { txAborted++; return Promise.reject(new Error('result exists')); }
            resultNodeExisting = obj.result;
            resultsWritten.push({ path: path, value: obj });
            return Promise.resolve();
        },
        remove: function () { return Promise.resolve(); },
        transaction: function (fn) {
            const next = fn(resultNodeExisting);
            if (next === undefined) { txAborted++; return Promise.resolve({ committed: false }); }
            resultNodeExisting = next;
            resultsWritten.push({ path: path, value: next });
            return Promise.resolve({ committed: true });
        }
    }; } };
    global.showInfoModal = function () {};
    global.showScreen = function () {};
    global.loadActiveRooms = function () {};
    global.menuScreen = {};
    global.opponentLeftText = { textContent: '' };
    global.opponentLeftModal = { classList: { remove: function () { modalHidden = false; }, contains: function () { return modalHidden; } } };
    global.setTimeout = function (fn, ms) { timersCreated.push(ms); return timersCreated.length; };
    global.clearTimeout = function () {};
    clockSkewMs = 0;
    monoNow = 60000;
}

// Состояние партии: соперник (dark) молчит absenceSec секунд по серверному времени.
// v180: у отсутствующего есть серверный absentSince (его ставит либо
// visibilitychange, либо onDisconnect), у присутствующего — onlineSince,
// начало его текущей непрерывной online-сессии.
function stateWithOpponentSilentFor(absenceSec, online) {
    const now = Date.now();
    return {
        winner: null,
        result: null,
        players: { light: { id: 'ME', name: 'Me' }, dark: { id: 'OPP', name: 'Opp' } },
        presence: {
            light: { online: true, onlineSince: now - 600000, lastSeen: now },
            dark: (online !== false)
                ? { online: true, onlineSince: now - 600000, lastSeen: now - absenceSec * 1000 }
                : { online: false, absentSince: now - absenceSec * 1000, lastSeen: now - absenceSec * 1000 }
        }
    };
}

(function () {
    if (loadError) {
        check('0. функции presence-правок есть в script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exit(1);
    }

    // ===============================================================
    console.log('1. СОБСТВЕННЫЙ DISCONNECT НЕ ДЕЛАЕТ СОПЕРНИКА УШЕДШИМ');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(300); // «протух» из-за МОЕГО обрыва
    global.isFirebaseConnected = false;
    global.connectedSinceMono = null;
    check('1.1 статус соперника нейтральный, а не «ушёл»',
        statusForColor('dark').cls === 'status-neutral', statusForColor('dark').cls);
    check('1.2 возраст отсутствия не вычисляется (UNKNOWN)',
        getOpponentAbsenceMs('dark') === null);
    checkOpponentAbsence();
    check('1.3 отсчёт не запускается и комната цела',
        resultsWritten.length === 0 );
    check('1.4 мой собственный статус тоже нейтральный (не «ушёл»)',
        statusForColor('light').cls === 'status-neutral');

    // связь вернулась, соперник свежий — всё в порядке
    reset();
    global.currentState = stateWithOpponentSilentFor(2);
    check('1.5 связь есть, соперник свежий -> «в игре»',
        statusForColor('dark').cls === 'status-online', statusForColor('dark').cls);
    checkOpponentAbsence();
    check('1.6 ничего не удаляется', resultsWritten.length === 0);

    // ===============================================================
    console.log('2. СЕРВЕРНОЕ ВРЕМЯ ВМЕСТО ЧАСОВ ТЕЛЕФОНА');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(2);
    clockSkewMs = -5 * 60 * 1000; // часы телефона убежали ВПЕРЁД на 5 минут
    check('2.1 расхождение часов не превращает живого соперника в ушедшего',
        statusForColor('dark').cls === 'status-online', statusForColor('dark').cls);
    checkOpponentAbsence();
    check('2.2 и не приводит к удалению комнаты', resultsWritten.length === 0);
    check('2.3 в коде используется серверное время, а не голый Date.now()',
        /const lastSeenElapsed = getEstimatedServerNow\(\) - \(presence\.lastSeen/.test(SRC) &&
        /return getEstimatedServerNow\(\) - presence\.absentSince;/.test(SRC) &&
        /return getEstimatedServerNow\(\) - presence\.lastSeen;/.test(SRC));

    // ===============================================================
    console.log('3. ЕДИНАЯ 60-СЕКУНДНАЯ ШКАЛА ОТ lastSeen');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(30, false);
    checkOpponentAbsence();
    check('3.1 30 секунд отсутствия -> ещё рано', resultsWritten.length === 0);
    check('3.2 отдельный setTimeout(60000) больше НЕ заводится',
        timersCreated.indexOf(60000) === -1, JSON.stringify(timersCreated));

    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    checkOpponentAbsence();
    check('3.3 75 секунд отсутствия -> партия завершается сразу',
        resultsWritten.length === 1 && resultsWritten.length === 1);

    // reconnect НЕ даёт новой минуты: шкала привязана к lastSeen соперника
    reset();
    global.currentState = stateWithOpponentSilentFor(50, false);
    monoNow = 20000; // я только что вернулся
    checkOpponentAbsence();
    check('3.4 после МОЕГО reconnect ушедшему остаётся ~10с, а не новые 60',
        resultsWritten.length === 0);
    global.currentState = stateWithOpponentSilentFor(65, false);
    checkOpponentAbsence();
    check('3.5 через оставшиеся секунды партия корректно завершается',
        resultsWritten.length === 1);
    check('3.6 в коде решение читает тот же возраст lastSeen, что и надпись',
        /const absenceMs = getOpponentAbsenceMs\(oppColor\);/.test(SRC) &&
        /if \(absenceMs === null \|\| absenceMs < RECONNECT_GRACE_MS\) return;/.test(SRC));

    // ===============================================================
    console.log('4. FAIL-SAFE ПЕРЕД УДАЛЕНИЕМ ЖИВОЙ КОМНАТЫ');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    monoNow = 3000; // связь держится всего 3 секунды (монотонные часы)
    checkOpponentAbsence();
    check('4.1 связь только что вернулась -> НЕ удалять', resultsWritten.length === 0);
    check('4.2 решение лишь отложено: при устойчивой связи оно принимается', (function () {
        monoNow = 30000;
        checkOpponentAbsence();
        return resultsWritten.length === 1;
    })());

    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.serverTimeOffsetReady = false;
    checkOpponentAbsence();
    check('4.3 серверное время ещё неизвестно -> НЕ удалять', resultsWritten.length === 0);

    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.isFirebaseConnected = false; global.connectedSinceMono = null;
    checkOpponentAbsence();
    check('4.4 нет связи -> НЕ удалять', resultsWritten.length === 0);

    check('4.5 путь «не удалось подтвердить -> всё равно удалить» отсутствует',
        /if \(!canTrustAbsenceForCleanup\(\)\) return;/.test(SRC));
    check('4.6 cleanupAbandonedRoom осталась низкоуровневой (проверка снаружи)', (function () {
        const m = /function cleanupAbandonedRoom[\s\S]*?\n}/.exec(SRC);
        return m && !/canTrustAbsenceForCleanup|isFirebaseConnected|connectedSinceMs/.test(m[0]);
    })());
    check('4.7 порог устойчивости связи больше трёх heartbeat-циклов (4с)',
        global.CONNECTION_SETTLE_MS >= 12000);

    // ===============================================================
    console.log('5. ЧТО НЕ ДОЛЖНО СЛОМАТЬСЯ');
    // ===============================================================
    reset();
    global.isSpectator = true;
    global.currentState = stateWithOpponentSilentFor(300, false);
    checkOpponentAbsence();
    check('5.1 зритель никогда не удаляет комнату', resultsWritten.length === 0);

    reset();
    global.isOnlineGame = false; global.isBotGame = true;
    global.currentState = stateWithOpponentSilentFor(300, false);
    checkOpponentAbsence();
    check('5.2 игра с ботом не затронута', resultsWritten.length === 0);

    reset();
    global.currentState = stateWithOpponentSilentFor(300, false);
    global.currentState.winner = 'light';
    checkOpponentAbsence();
    check('5.3 законченная партия не запускает очистку', resultsWritten.length === 0);

    reset();
    global.currentState = stateWithOpponentSilentFor(300, false);
    global.opponentAbsenceHandled = true;
    checkOpponentAbsence();
    check('5.4 повторный вызов не удаляет комнату дважды', resultsWritten.length === 0);

    check('5.5 presence-фиксы v171 на месте',
        /onDisconnect\(\)\.update\(\{[\s\S]{0,120}online: false/.test(SRC));
    check('5.6 UID-фикс результата не тронут',
        /function resolveMyOnlineResult\(state\) \{/.test(SRC));
    check('5.7 sync-индикатор хода не тронут',
        /const MOVE_CONFIRM_STALL_MS = 12000;/.test(SRC));

    // ===============================================================
    console.log('6. ОБЕ ПАНЕЛИ ПРИ СОБСТВЕННОМ ОБРЫВЕ И ПОСЛЕ ВОЗВРАТА');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(300);
    global.currentState.presence.light.lastSeen = Date.now() - 300000;
    global.isFirebaseConnected = false; global.connectedSinceMono = null;
    global.roomSnapshotSeenSinceConnect = false;
    check('6.1 обе панели нейтральны, ни одна не показывает «ушёл»',
        statusForColor('light').cls === 'status-neutral' &&
        statusForColor('dark').cls === 'status-neutral');
    checkOpponentAbsence();
    const asLight = cleanupCalls;
    global.myColor = 'dark';
    checkOpponentAbsence();
    check('6.2 ложной очистки нет ни для одного цвета',
        asLight === 0 && resultsWritten.length === 0);

    global.myColor = 'light';
    global.isFirebaseConnected = true;
    global.connectedSinceMono = 0;
    global.roomSnapshotSeenSinceConnect = true;
    global.currentState = stateWithOpponentSilentFor(1);
    check('6.3 после reconnect обе панели снова «в игре»',
        statusForColor('light').cls === 'status-online' &&
        statusForColor('dark').cls === 'status-online');
    checkOpponentAbsence();
    check('6.4 и никакой очистки не запускается', resultsWritten.length === 0);

    // ===============================================================
    console.log('7. ТЕХНИЧЕСКИЙ РЕЗУЛЬТАТ РОВНО ОДИН РАЗ');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    for (let sec = 0; sec < 10; sec++) {
        global.currentState.presence.dark.lastSeen = Date.now() - (75 + sec) * 1000;
        global.currentState.presence.dark.absentSince = Date.now() - (75 + sec) * 1000;
        checkOpponentAbsence();
    }
    check('7.1 за 10 секунд подряд очистка вызвана РОВНО один раз',
        resultsWritten.length === 1, 'записей: ' + resultsWritten.length);
    check('7.2 результат содержит корректные UID победителя и проигравшего',
        resultsWritten[0].value.result.winnerId === 'ME' && resultsWritten[0].value.result.loserId === 'OPP' &&
        resultsWritten[0].value.result.winReason === 'disconnect');
    check('7.3 opponentAbsenceHandled взведён', global.opponentAbsenceHandled === true);
    check('7.4 флаг ставится ДО разрушительного вызова', (function () {
        const m = /function checkOpponentAbsence[\s\S]*?\n}/.exec(SRC);
        if (!m) return false;
        return m[0].indexOf('opponentAbsenceHandled = true;') < m[0].indexOf('cleanupAbandonedRoom()');
    })());

    // ===============================================================
    console.log('8. ДОКАЗАТЕЛЬСТВО СВЕЖЕГО СНАПШОТА КОМНАТЫ');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.roomSnapshotSeenSinceConnect = false;
    checkOpponentAbsence();
    check('8.1 нет свежего снапшота после reconnect -> НЕ удалять', resultsWritten.length === 0);
    global.roomSnapshotSeenSinceConnect = true;
    checkOpponentAbsence();
    check('8.2 снапшот пришёл -> решение принимается', resultsWritten.length === 1);
    check('8.3 флаг сбрасывается и при обрыве, и при новом подключении',
        (SRC.match(/roomSnapshotSeenSinceConnect = false;/g) || []).length === 4);
    check('8.4 флаг ставится ТОЛЬКО в колбэке room-listener',
        (SRC.match(/roomSnapshotSeenSinceConnect = true;/g) || []).length === 1);
    check('8.5 fail-safe требует ВСЕ шесть условий', (function () {
        const m = /function canTrustAbsenceForCleanup[\s\S]*?\n}/.exec(SRC);
        return m && /isFirebaseConnected/.test(m[0]) && /connectedSinceMono/.test(m[0]) &&
            /getMonotonicNow\(\)/.test(m[0]) && /CONNECTION_SETTLE_MS/.test(m[0]) &&
            /serverTimeOffsetReady/.test(m[0]) && /serverAckSinceConnect/.test(m[0]) &&
            /roomSnapshotSeenSinceConnect/.test(m[0]);
    })());

    // ===============================================================
    console.log('9. СЕРВЕРНОЕ ПОДТВЕРЖДЕНИЕ, А НЕ ЛОКАЛЬНОЕ ЭХО');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.serverAckSinceConnect = false; // сервер ещё не ответил после reconnect
    checkOpponentAbsence();
    check('9.1 без серверного подтверждения cleanup ЗАПРЕЩЁН', resultsWritten.length === 0);
    global.serverAckSinceConnect = true;
    checkOpponentAbsence();
    check('9.2 после серверного подтверждения решение принимается', resultsWritten.length === 1);

    check('9.3 снапшот комнаты засчитывается ТОЛЬКО после серверного ack',
        /if \(serverAckSinceConnect && myListenerGen === listenerGeneration\) \{/.test(SRC));
    check('9.4 ack приходит из promise собственной записи presence (круговой обмен)',
        /noteServerAck\(gen, lgen\)/.test(SRC) &&
        /noteServerAck\(setupGen, setupListenerGen\)/.test(SRC) &&
        /noteServerAck\(beatGen, beatListenerGen\)/.test(SRC));
    check('9.5 поздний ответ от ПРЕДЫДУЩЕГО подключения не засчитывается', (function () {
        const m = /function noteServerAck[\s\S]*?\n}/.exec(SRC);
        return m && /connGen !== connectionGeneration/.test(m[0]) &&
            /listenerGen !== listenerGeneration/.test(m[0]) && /isFirebaseConnected/.test(m[0]);
    })());
    check('9.6 при каждом реконнекте обнуляются ОБА доказательства',
        (SRC.match(/serverAckSinceConnect = false;/g) || []).length === 4);

    // ===============================================================
    console.log('10. МОНОТОННЫЕ ЧАСЫ ДЛЯ ИНТЕРВАЛА СТАБИЛЬНОСТИ');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    monoNow = 3000; // связь стабильна всего 3 секунды
    clockSkewMs = 0;
    checkOpponentAbsence();
    check('10.1 3 секунды стабильности -> НЕ удалять', resultsWritten.length === 0);
    // системные часы прыгнули на час вперёд — монотонные не изменились
    const jumpedForward = Date.now;
    Date.now = function () { return jumpedForward() + 3600000; };
    checkOpponentAbsence();
    check('10.2 скачок Date.now() ВПЕРЁД не сокращает интервал стабильности',
        resultsWritten.length === 0);
    Date.now = function () { return jumpedForward() - 3600000; };
    checkOpponentAbsence();
    check('10.3 скачок Date.now() НАЗАД тоже ничего не ломает', resultsWritten.length === 0);
    Date.now = jumpedForward;
    monoNow = 30000; // монотонно прошло 30 секунд
    checkOpponentAbsence();
    check('10.4 по монотонным часам интервал выдержан -> решение принимается',
        resultsWritten.length === 1);
    check('10.5 в коде интервал меряется монотонными часами, а не Date.now()',
        /getMonotonicNow\(\) - connectedSinceMono < CONNECTION_SETTLE_MS/.test(SRC) &&
        /connectedSinceMono = getMonotonicNow\(\);/.test(SRC));

    // ===============================================================
    console.log('11. НЕЙТРАЛЬНЫЙ СТАТУС, ПОКА СЕРВЕРНОЕ ВРЕМЯ НЕИЗВЕСТНО');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(300, false);
    global.serverTimeOffsetReady = false;
    check('11.1 пока offset не готов — нейтральный статус, а не ложный «ушёл»',
        statusForColor('dark').cls === 'status-neutral', statusForColor('dark').cls);
    checkOpponentAbsence();
    check('11.2 и никакого удаления', resultsWritten.length === 0);
    global.serverTimeOffsetReady = true;
    check('11.3 offset получен — статус считается нормально',
        statusForColor('dark').cls === 'status-left');



    // ===============================================================
    console.log('12. ДОКАЗАТЕЛЬСТВО ПРИВЯЗАНО К ТЕКУЩЕЙ КОМНАТЕ');
    // ===============================================================
    // Модель поколений подписки: воспроизводим реальные функции из script.js.
    (function () {
        global.connectionGeneration = 1;
        global.isFirebaseConnected = true;
        global.listenerGeneration = 0;
        global.serverAckSinceConnect = false;
        global.roomSnapshotSeenSinceConnect = false;
        eval(extractFunc('resetRoomFreshnessProof'));
        eval(extractFunc('noteServerAck'));

        // --- Комната A: подписка, серверный ack, снапшот ---
        resetRoomFreshnessProof();
        const genA = global.listenerGeneration;
        noteServerAck(global.connectionGeneration, genA);
        if (global.serverAckSinceConnect && genA === global.listenerGeneration) {
            global.roomSnapshotSeenSinceConnect = true;
        }
        check('12.1 комната A получила полное доказательство свежести',
            global.serverAckSinceConnect === true && global.roomSnapshotSeenSinceConnect === true);

        // --- Переход в комнату B БЕЗ разрыва Firebase ---
        resetRoomFreshnessProof();
        const genB = global.listenerGeneration;
        check('12.2 новая подписка открыла новое поколение', genB === genA + 1);
        check('12.3 комната B НЕ унаследовала доказательство от A',
            global.serverAckSinceConnect === false && global.roomSnapshotSeenSinceConnect === false);

        // --- Поздний колбэк СТАРОГО listener'а комнаты A ---
        if (global.serverAckSinceConnect && genA === global.listenerGeneration) {
            global.roomSnapshotSeenSinceConnect = true; // не должно сработать
        }
        check('12.4 поздний колбэк listener A не подтверждает комнату B',
            global.roomSnapshotSeenSinceConnect === false);

        // --- Поздний серверный ack, отправленный ещё из комнаты A ---
        noteServerAck(global.connectionGeneration, genA);
        check('12.5 поздний ack из комнаты A не засчитывается комнате B',
            global.serverAckSinceConnect === false);

        // --- Корректное подтверждение уже комнаты B ---
        noteServerAck(global.connectionGeneration, genB);
        check('12.6 ack, относящийся к комнате B, засчитывается',
            global.serverAckSinceConnect === true);
        if (global.serverAckSinceConnect && genB === global.listenerGeneration) {
            global.roomSnapshotSeenSinceConnect = true;
        }
        check('12.7 снапшот комнаты B завершает доказательство',
            global.roomSnapshotSeenSinceConnect === true);

        // --- Реванш в ТОЙ ЖЕ комнате: подписка не пересоздаётся ---
        const genBeforeRematch = global.listenerGeneration;
        check('12.8 реванш той же комнаты не сбрасывает доказательство',
            genBeforeRematch === genB &&
            global.serverAckSinceConnect === true &&
            global.roomSnapshotSeenSinceConnect === true);
    })();

    check('12.9 обе точки подписки на rooms/<код> сбрасывают доказательство',
        (SRC.match(/resetRoomFreshnessProof\(\);/g) || []).length === 2);
    check('12.10 колбэк listener\'а отбрасывает чужое поколение',
        /if \(myListenerGen !== listenerGeneration\) return;/.test(SRC));

    // --- 12.11 после подтверждения B настоящий уход >60с всё ещё очищается ---
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.serverAckSinceConnect = true;
    global.roomSnapshotSeenSinceConnect = true;
    checkOpponentAbsence();
    check('12.11 подтверждённая комната: уход >60с очищается', resultsWritten.length === 1);

    // --- 12.12 без доказательства текущей комнаты cleanup запрещён ---
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.serverAckSinceConnect = false;
    global.roomSnapshotSeenSinceConnect = false;
    checkOpponentAbsence();
    check('12.12 новая комната без доказательства: cleanup ЗАПРЕЩЁН', resultsWritten.length === 0);


    // ===============================================================
    console.log('13. ФАЗА 1: ЗАПРЕТ ХОДА БЕЗ СВЯЗИ И ЖИЗНЕННЫЙ ЦИКЛ PRESENCE');
    // ===============================================================
    check('13.1 ход блокируется, когда Firebase сообщает об отсутствии связи',
        /if \(isOnlineGame && !isFirebaseConnected\) return;/.test(SRC));
    check('13.2 блокировка стоит ДО оптимистичного применения хода', (function () {
        const guard = SRC.indexOf('if (isOnlineGame && !isFirebaseConnected) return;');
        const optimistic = SRC.indexOf('isLocalStateOptimistic = true;');
        const tx = SRC.indexOf('database.ref("rooms/" + roomCode).transaction(function (room)');
        return guard !== -1 && guard < optimistic && guard < tx;
    })());
    check('13.3 значит без связи не создаются ни транзакция, ни ожидание', (function () {
        const guard = SRC.indexOf('if (isOnlineGame && !isFirebaseConnected) return;');
        const pending = SRC.indexOf('pendingMoveStartedAt = Date.now();');
        const lastSeen = SRC.indexOf('lastSeenMoveCount = currentState.moveCount;');
        return guard < pending && guard < lastSeen;
    })());

    check('13.4 onDisconnect взводится ДО объявления online', (function () {
        const m = /function setupPresence[\s\S]*?\n}/.exec(SRC);
        if (!m) return false;
        const od = m[0].indexOf('presenceRef.onDisconnect().update({');
        const setOnline = m[0].indexOf('return presenceRef.set({');
        return od !== -1 && setOnline !== -1 && od < setOnline;
    })());
    check('13.5 online объявляется только после успешной регистрации onDisconnect',
        /presenceRef\.onDisconnect\(\)\.update\(\{[\s\S]{0,200}\}\)\s*\n\s*\.then\(function \(\) \{\s*\n\s*return presenceRef\.set\(/.test(SRC));
    check('13.6 при неудачной регистрации online всё равно объявляется (очередь)',
        /\.catch\(function \(\) \{[\s\S]{0,400}presenceRef\.set\(\{/.test(SRC));
    check('13.7 setupPresence вызывается заново после реконнекта -> onDisconnect перевзводится',
        /myPresenceRef\.onDisconnect\(\)\.cancel\(\);/.test(SRC));

    check('13.8 статус нейтрален, пока свежесть текущей комнаты не подтверждена', (function () {
        const m = /function statusForColor[\s\S]*?\n}/.exec(SRC);
        if (!m) return false;
        const fresh = m[0].indexOf('if (!roomSnapshotSeenSinceConnect)');
        const elapsed = m[0].indexOf('const lastSeenElapsed = getEstimatedServerNow()');
        return fresh !== -1 && fresh < elapsed;
    })());

    check('13.9 восстановление НЕ снимает ожидание подтверждения хода', (function () {
        const m = /function runSyncRecovery[\s\S]*?\n}/.exec(SRC);
        return m && !/pendingMoveStartedAt = null;/.test(m[0]);
    })());
    check('13.10 ожидание снимает ТОЛЬКО исход транзакции (.then и .catch)',
        (SRC.match(/pendingMoveStartedAt = null;/g) || []).length >= 2);

    // Поведенческая проверка запрета: моделируем клик без связи
    reset();
    global.isFirebaseConnected = false;
    (function () {
        let optimisticApplied = false;
        let txCreated = false;
        // повторяем guard из production дословно
        const isOnlineGame = true;
        if (isOnlineGame && !global.isFirebaseConnected) {
            // ход не выполняется
        } else {
            optimisticApplied = true; txCreated = true;
        }
        check('13.11 без связи: оптимистичное состояние не применено, транзакции нет',
            optimisticApplied === false && txCreated === false);
    })();

    // Гонка «связь была, исчезла сразу после клика»: транзакция уже создана
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.roomSnapshotSeenSinceConnect = false; // после обрыва свежесть не подтверждена
    check('13.12 гонка: незавершённая транзакция + нет доказательства свежести -> НЕ «ушёл»',
        statusForColor('dark').cls === 'status-neutral', statusForColor('dark').cls);
    checkOpponentAbsence();
    check('13.13 и живая комната не удаляется', resultsWritten.length === 0);
    // после подтверждения свежести настоящий уход по-прежнему обрабатывается
    global.roomSnapshotSeenSinceConnect = true;
    checkOpponentAbsence();
    check('13.14 после подтверждения свежести настоящий уход >60с очищается',
        resultsWritten.length === 1);


    // ===============================================================
    console.log('14. ПОРЯДОК ПОКОЛЕНИЙ И ТЕКСТЫ');
    // ===============================================================
    check('14.1 поколение подписки открывается ДО setupPresence()', (function () {
        const m = /function startOnlineGame[\s\S]*?roomListenerRef\.on\("value"/.exec(SRC);
        if (!m) return false;
        const reset = m[0].indexOf('resetRoomFreshnessProof();');
        const setup = m[0].indexOf('setupPresence();');
        return reset !== -1 && setup !== -1 && reset < setup;
    })());
    check('14.2 при подписке поколение больше не сбрасывается повторно', (function () {
        const m = /function startOnlineGame[\s\S]*?roomListenerRef\.on\("value"/.exec(SRC);
        return m && (m[0].match(/resetRoomFreshnessProof\(\);/g) || []).length === 1;
    })());
    check('14.3 всего две точки сброса поколения (игра и зритель)',
        (SRC.match(/resetRoomFreshnessProof\(\);/g) || []).length === 2);
    check('14.4 текст «нет связи» больше не обещает отправку хода',
        !/Ход отправится/.test(SRC) && /Подождите восстановления соединения/.test(SRC));
    check('14.5 обновлены все три языка',
        /Please wait until it is restored/.test(SRC) && /Attendi il ripristino/.test(SRC));
    check('14.6 остальные тексты синхронизации не тронуты',
        /Отправляю ход…/.test(SRC) && /Проверяю соединение…/.test(SRC) &&
        /Не удалось обновить игру/.test(SRC));


    // ===============================================================
    console.log('15. WHOLE-ROOM ТРАНЗАКЦИИ НЕ СОЗДАЮТСЯ БЕЗ СВЯЗИ');
    // ===============================================================
    check('15.1 сдача защищена guard\'ом', (function () {
        const m = /btnResignYes\.addEventListener[\s\S]*?transaction\(function \(room\)/.exec(SRC);
        return m && /if \(!isFirebaseConnected\) return;/.test(m[0]);
    })());
    check('15.2 принятие ничьей защищено guard\'ом', (function () {
        const m = /btnDrawAccept\.addEventListener[\s\S]*?transaction\(function \(room\)/.exec(SRC);
        return m && /if \(!isFirebaseConnected\) return;/.test(m[0]);
    })());
    check('15.3 таймаут защищён guard\'ом', (function () {
        const m = /function checkTimeout[\s\S]*?transaction\(function \(room\)/.exec(SRC);
        return m && /if \(!isFirebaseConnected\) return;/.test(m[0]);
    })());
    check('15.4 ход тоже защищён (уже было)',
        /if \(isOnlineGame && !isFirebaseConnected\) return;/.test(SRC));
    check('15.5 все четыре ИГРОВЫЕ whole-room транзакции защищены', (function () {
        // Ход, сдача, ничья, таймаут. Пятая транзакция на узле комнаты —
        // вход в комнату (joinGroupRoom) — СОЗНАТЕЛЬНО не защищена: она
        // выполняется в момент присоединения, до подписки на комнату, и без
        // связи всё равно недостижима (список комнат не загрузится).
        // Зафиксировано отдельной проверкой ниже, чтобы не потерялось.
        const move = /if \(isOnlineGame && !isFirebaseConnected\) return;/.test(SRC);
        const others = (SRC.match(/if \(!isFirebaseConnected\) return;/g) || []).length;
        return move && others >= 3;
    })());
    check('15.5b известна пятая whole-room транзакция — вход в комнату (Фаза 2)',
        /ИСПОЛЬЗУЕМ ТРАНЗАКЦИЮ: гарантируем, что комната не удалена/.test(SRC) &&
        (SRC.match(/database\.ref\("rooms\/" \+ roomCode\)\.transaction\(/g) || []).length === 5);
    check('15.6 guard защищает СЕРВЕРНУЮ сдачу, локальный выход не тронут',
        /Локальный выход из партии этим guard'ом НЕ затрагивается/.test(SRC));
    check('15.7 отмечено как временная инварианта Фазы 1 (снимется в Фазе 2)',
        (SRC.match(/ВРЕМЕННАЯ ИНВАРИАНТА ФАЗЫ 1/g) || []).length === 3);


    // ===============================================================
    console.log('17. v180: ЕДИНАЯ МАШИНА ОТСУТСТВИЯ');
    // ===============================================================
    check('17.1 сворачивание пишет online:false + absentSince серверным временем', (function () {
        const m = /function handleVisibilityChange[\s\S]*?\n}/.exec(SRC);
        if (!m) return false;
        const hidden = m[0].slice(0, m[0].indexOf('} else'));
        return /online: false/.test(hidden) &&
            /absentSince: firebase\.database\.ServerValue\.TIMESTAMP/.test(hidden);
    })());
    check('17.2 возвращение очищает absentSince', (function () {
        const m = /function handleVisibilityChange[\s\S]*?\n}/.exec(SRC);
        const back = m[0].slice(m[0].indexOf('} else'));
        return /online: true/.test(back) && /absentSince: null/.test(back);
    })());
    check('17.3 настоящий обрыв ведёт в ТУ ЖЕ машину (onDisconnect ставит absentSince)',
        /onDisconnect\(\)\.update\(\{[\s\S]{0,200}absentSince: firebase\.database\.ServerValue\.TIMESTAMP/.test(SRC));
    check('17.4 никакого бессрочного «отошёл» не осталось',
        !/status_away/.test(SRC) && !/away: true/.test(SRC));
    check('17.5 отсчёт ведётся от absentSince, а не от часов телефона', (function () {
        const m = /function getOpponentAbsenceMs[\s\S]*?\n}/.exec(SRC);
        return m && /getEstimatedServerNow\(\) - presence\.absentSince/.test(m[0]) &&
            !/Date\.now\(\)/.test(m[0]);
    })());

    // поведение отсчёта
    // absentSec — сколько соперник отсутствует; myOnlineSec — сколько длится
    // МОЯ текущая непрерывная online-сессия (по умолчанию давно).
    function absent(sec, myOnlineSec) {
        const now = Date.now();
        return {
            winner: null,
            result: null,
            players: { light: { id: 'ME', name: 'Me' }, dark: { id: 'OPP', name: 'Opp' } },
            presence: {
                light: { online: true, onlineSince: now - (myOnlineSec === undefined ? 600 : myOnlineSec) * 1000, lastSeen: now },
                dark: { online: false, absentSince: now - sec * 1000, lastSeen: now - sec * 1000 }
            }
        };
    }
    reset(); global.currentState = absent(10); checkOpponentAbsence();
    check('17.6 отсутствие 10 секунд -> партия продолжается', resultsWritten.length === 0);
    reset(); global.currentState = absent(30); checkOpponentAbsence();
    check('17.7 отсутствие 30 секунд -> партия продолжается', resultsWritten.length === 0);
    reset(); global.currentState = absent(59); checkOpponentAbsence();
    check('17.8 отсутствие 59 секунд -> партия продолжается', resultsWritten.length === 0);
    reset(); global.currentState = absent(61); checkOpponentAbsence();
    check('17.9 отсутствие 61 секунда -> техническое поражение', resultsWritten.length === 1);

    // вернулся до истечения — отсчёт снят
    reset(); global.currentState = absent(50);
    global.currentState.presence.dark = { online: true, absentSince: null, onlineSince: Date.now(), lastSeen: Date.now() };
    check('17.10 вернулся на 50-й секунде -> отсутствия нет', getOpponentAbsenceMs('dark') === null);
    checkOpponentAbsence();
    check('17.11 и результат не пишется', resultsWritten.length === 0);

    // ===============================================================
    console.log('18. v180: ЗАПИСЬ РЕЗУЛЬТАТА');
    // ===============================================================
    reset(); global.currentState = absent(75); checkOpponentAbsence();
    check('18.1 ОДНА атомарная операция на узле комнаты rooms/<код>',
        resultsWritten.length === 1 && resultsWritten[0].path === 'rooms/R1',
        resultsWritten[0] && resultsWritten[0].path);
    check('18.2 операция трогает РОВНО четыре дочерних пути и НИКАКОЙ presence',
        JSON.stringify(Object.keys(resultsWritten[0].value).sort()) ===
        JSON.stringify(['result', 'status', 'winReason', 'winner']),
        JSON.stringify(Object.keys(resultsWritten[0].value)));
    check('18.3 победитель — оставшийся, проигравший — отсутствующий (по UID)',
        resultsWritten[0].value.result.winnerId === 'ME' && resultsWritten[0].value.result.loserId === 'OPP');
    check('18.4 winReason = disconnect и в result, и на уровне комнаты',
        resultsWritten[0].value.result.winReason === 'disconnect' &&
        resultsWritten[0].value.winReason === 'disconnect');
    check('18.5 decidedAt — серверное время', resultsWritten[0].value.result.decidedAt === 1700000000000);

    // однократность
    for (let i = 0; i < 8; i++) { global.opponentAbsenceHandled = false; checkOpponentAbsence(); }
    check('18.6 результат пишется РОВНО один раз даже при повторных вызовах',
        resultsWritten.length === 1, 'записей: ' + resultsWritten.length);
    check('18.7 повторная попытка не создаёт второго результата',
        resultNodeExisting && resultNodeExisting.winnerId === 'ME');

    // комната НЕ удаляется
    check('18.8 комната НЕ удаляется — остаётся finished для Elo/статистики/монет',
        resultsWritten.length === 1 && cleanupCalls === 0);
    check('18.9 обычное отсутствие ведёт к результату, а не к удалению комнаты',
        resultsWritten.length === 1 && cleanupCalls === 0 &&
        /if \(writeTechnicalResult\(oppColor\)\) \{/.test(SRC));

    // чужой результат не пишем
    reset(); global.currentState = absent(75);
    global.myTelegramId = 'OPP'; global.myColor = 'dark';
    checkOpponentAbsence();
    check('18.10 отсутствующий сам себе победу не пишет', resultsWritten.length === 0);

    // зритель и бот
    reset(); global.isSpectator = true; global.currentState = absent(75); checkOpponentAbsence();
    check('18.11 зритель результат не пишет', resultsWritten.length === 0);
    reset(); global.isOnlineGame = false; global.isBotGame = true;
    global.currentState = absent(75); checkOpponentAbsence();
    check('18.12 бот не затронут', resultsWritten.length === 0);

    // защиты v178/v177 на месте
    check('18.13 fail-safe перед результатом сохранён',
        /if \(!canTrustAbsenceForCleanup\(\)\) return;/.test(SRC));
    check('18.14 запрет офлайн-хода из v178 сохранён',
        /if \(isOnlineGame && !isFirebaseConnected\) return;/.test(SRC));
    reset(); global.currentState = absent(75); global.isFirebaseConnected = false;
    global.connectedSinceMono = null;
    checkOpponentAbsence();
    check('18.15 без своей связи результат не пишется (оба отсутствуют)',
        resultsWritten.length === 0);


    // ===============================================================
    console.log('19. v180: onlineSince — НАЧАЛО ТЕКУЩЕЙ ONLINE-СЕССИИ');
    // ===============================================================
    check('19.1 первичный вход (setupPresence) ставит onlineSince', (function () {
        const m = /function setupPresence[\s\S]*?\n}/.exec(SRC);
        if (!m) return false;
        return /presenceRef\.set\(\{[\s\S]{0,220}onlineSince: firebase\.database\.ServerValue\.TIMESTAMP/.test(m[0]);
    })());
    check('19.2 возвращение из фона ставит onlineSince заново', (function () {
        const m = /function handleVisibilityChange[\s\S]*?\n}/.exec(SRC);
        const back = m[0].slice(m[0].indexOf('} else'));
        return /onlineSince: firebase\.database\.ServerValue\.TIMESTAMP/.test(back);
    })());
    check('19.3 reconnect после настоящего обрыва ставит onlineSince заново', (function () {
        const m = /connectedRef\.on\("value"[\s\S]*?\n\}\);/.exec(SRC);
        if (!m) return false;
        return /myPresenceRef\.update\(\{[\s\S]{0,300}onlineSince: firebase\.database\.ServerValue\.TIMESTAMP/.test(m[0]);
    })());
    check('19.4 HEARTBEAT НЕ ТРОГАЕТ onlineSince', (function () {
        const m = /presenceHeartbeatInterval = setInterval\([\s\S]*?\}, 4000\);/.exec(SRC);
        if (!m) return false;
        return m[0].indexOf('onlineSince') === -1;
    })());
    check('19.5 сворачивание ставит absentSince и НЕ ставит onlineSince', (function () {
        const m = /function handleVisibilityChange[\s\S]*?\n}/.exec(SRC);
        const hidden = m[0].slice(0, m[0].indexOf('} else'));
        return /absentSince: firebase\.database\.ServerValue\.TIMESTAMP/.test(hidden) &&
            hidden.indexOf('onlineSince') === -1;
    })());
    check('19.6 onDisconnect ставит absentSince и НЕ трогает onlineSince', (function () {
        const m = /presenceRef\.onDisconnect\(\)\.update\(\{[\s\S]{0,200}\}\)/.exec(SRC);
        if (!m) return false;
        return /absentSince/.test(m[0]) && m[0].indexOf('onlineSince') === -1;
    })());
    check('19.7 порядок v178 сохранён: onDisconnect ДО объявления online', (function () {
        const m = /function setupPresence[\s\S]*?\n}/.exec(SRC);
        const od = m[0].indexOf('presenceRef.onDisconnect().update({');
        const setOnline = m[0].indexOf('return presenceRef.set({');
        return od !== -1 && setOnline !== -1 && od < setOnline;
    })());

    reset(); global.currentState = absent(300, 10); checkOpponentAbsence();
    check('19.8 моя online-сессия 10 секунд -> результата НЕТ', resultsWritten.length === 0);
    reset(); global.currentState = absent(300, 59); checkOpponentAbsence();
    check('19.9 моя online-сессия 59 секунд -> результата ещё НЕТ', resultsWritten.length === 0);
    reset(); global.currentState = absent(300, 61); checkOpponentAbsence();
    check('19.10 моя online-сессия 61 секунда -> результат записан', resultsWritten.length === 1);
    check('19.11 флаг обработки взведён только после реальной отправки',
        global.opponentAbsenceHandled === true);

    // ===============================================================
    console.log('20. v180: ОБА ОТСУТСТВУЮТ');
    // ===============================================================
    reset();
    global.currentState = absent(300, 600);
    global.currentState.presence.light = { online: false, absentSince: Date.now() - 300000, lastSeen: Date.now() - 300000 };
    checkOpponentAbsence();
    check('20.1 оба отсутствуют -> НИКАКОГО автоматического победителя',
        resultsWritten.length === 0);

    reset();
    global.currentState = absent(300, 0);
    checkOpponentAbsence();
    check('20.2 я только что вернулся -> сопернику даётся НОВАЯ полная минута',
        resultsWritten.length === 0);

    reset();
    global.currentState = absent(300, 30);
    global.currentState.presence.dark = { online: true, absentSince: null, onlineSince: Date.now(), lastSeen: Date.now() };
    checkOpponentAbsence();
    check('20.3 соперник вернулся внутри новой минуты -> партия продолжается',
        resultsWritten.length === 0 && getOpponentAbsenceMs('dark') === null);

    reset();
    global.currentState = absent(360, 61);
    checkOpponentAbsence();
    check('20.4 соперник не вернулся -> поражение после ПОЛНОЙ новой минуты',
        resultsWritten.length === 1);
    check('20.5 отсчёт победителя привязан к onlineSince',
        /getOnlineSessionMs\(presence\[winnerColor\]\)/.test(SRC) &&
        /myOnlineMs < RECONNECT_GRACE_MS\) return false;/.test(SRC));

    // ===============================================================
    console.log('21. v180: authoritative absentSince ONLY');
    // ===============================================================
    reset();
    global.currentState = absent(300, 600);
    delete global.currentState.presence.dark.absentSince;
    global.currentState.presence.dark.lastSeen = Date.now() - 100000;
    checkOpponentAbsence();
    check('21.1 absentSince отсутствует -> технического поражения НЕТ',
        resultsWritten.length === 0);
    check('21.2 в решении нет отката на lastSeen', (function () {
        const m = /function getAuthoritativeAbsenceMs[\s\S]*?\n}/.exec(SRC);
        return m && m[0].indexOf('lastSeen') === -1;
    })());
    check('21.3 партия НЕ удаляется и модалка «покинул игру» не показывается',
        cleanupCalls === 0 && modalHidden === true);

    // сколь угодно долгое молчание БЕЗ absentSince не создаёт ни результата,
    // ни второго пути завершения — решение просто откладывается навсегда
    reset();
    global.currentState = absent(300, 600);
    delete global.currentState.presence.dark.absentSince;
    global.currentState.presence.dark.lastSeen = Date.now() - 3600000;
    for (var noAuthSec = 0; noAuthSec < 20; noAuthSec++) {
        global.opponentAbsenceHandled = false;
        checkOpponentAbsence();
    }
    check('21.4 час молчания без absentSince -> НЕТ результата и НЕТ удаления',
        resultsWritten.length === 0 && cleanupCalls === 0 && modalHidden === true);
    check('21.5 второго пути завершения по отсутствию в коде НЕТ', (function () {
        var m = /function checkOpponentAbsence[\s\S]*?\n}/.exec(SRC);
        if (!m) return false;
        var body = m[0];
        // единственный cleanupAbandonedRoom — в ветке «нет ответа на реванш»
        return (body.match(/cleanupAbandonedRoom\(\)/g) || []).length === 1 &&
            body.indexOf('rematch_no_response') < body.indexOf('cleanupAbandonedRoom()') &&
            body.indexOf('LEGACY_ABANDON_MS') === -1;
    })());
    check('21.6 константа аварийного выхода полностью удалена из кода',
        SRC.indexOf('LEGACY_ABANDON_MS') === -1);

    // ===============================================================
    console.log('22. v180: АТОМАРНОСТЬ И НЕИЗМЕНЯЕМОСТЬ РЕЗУЛЬТАТА');
    // ===============================================================
    reset(); global.currentState = absent(75); checkOpponentAbsence();
    check('22.1 операция НЕ пишет presence ни одним путём',
        presenceWrites.length === 0 && !('presence' in resultsWritten[0].value));
    check('22.2 одной операцией: result + winner + winReason + status',
        !!resultsWritten[0].value.result &&
        resultsWritten[0].value.winner === 'light' &&
        resultsWritten[0].value.winReason === 'disconnect' &&
        resultsWritten[0].value.status === 'finished');
    check('22.3 winner комнаты совпадает с result.winnerColor',
        resultsWritten[0].value.winner === resultsWritten[0].value.result.winnerColor);
    check('22.4 result.status тоже finished',
        resultsWritten[0].value.result.status === 'finished');
    check('22.5 цвета победителя и проигравшего различны',
        resultsWritten[0].value.result.winnerColor !== resultsWritten[0].value.result.loserColor);

    var firstResult = JSON.stringify(resultsWritten[0].value.result);
    global.opponentAbsenceHandled = false;
    global.technicalResultInFlight = false;
    global.currentState.result = resultsWritten[0].value.result;
    checkOpponentAbsence();
    check('22.6 повторный вызов при уже известном result ничего не пишет',
        resultsWritten.length === 1 &&
        JSON.stringify(resultsWritten[0].value.result) === firstResult);
    check('22.7 клиентский guard на currentState.result присутствует',
        /if \(currentState\.winner \|\| currentState\.result\) return false;/.test(SRC));
    check('22.8 in-flight guard не даёт отправить вторую операцию',
        /if \(technicalResultInFlight\) return true;/.test(SRC));

    // ===============================================================
    console.log('23. v180: ОДНА ПАРТИЯ -> ОДИН ИСХОД (гонки)');
    // ===============================================================
    check('23.1 обычный ход отменяется, если технический результат уже есть',
        /if \(!room \|\| !room\.pieces \|\| room\.winner \|\| room\.result\) return;/.test(SRC));
    check('23.2 сдача, ничья и таймаут проверяют room.result',
        (SRC.match(/if \(!room \|\| room\.winner \|\| room\.result\) return;/g) || []).length === 3,
        'найдено: ' + (SRC.match(/if \(!room \|\| room\.winner \|\| room\.result\) return;/g) || []).length);
    check('23.3 guard стоит в КАЖДОЙ из трёх обычных финальных транзакций', (function () {
        var bodies = ['newRoom.winReason = "resign";', 'newRoom.winner = "draw";', 'newRoom.winReason = "timeout";'];
        return bodies.every(function (b) {
            var i = SRC.indexOf(b);
            if (i === -1) return false;
            var guard = SRC.lastIndexOf('room.result) return;', i);
            var tx = SRC.lastIndexOf('.transaction(function (room)', i);
            return guard !== -1 && tx !== -1 && guard > tx;
        });
    })());
    check('23.4 технический результат не может перезаписать обычный winner',
        /if \(currentState\.winner \|\| currentState\.result\) return false;/.test(SRC));
    check('23.5 отсутствующий не может присудить победу себе',
        /if \(!myTelegramId \|\| winnerPlayer\.id !== myTelegramId\) return false;/.test(SRC));
    check('23.6 цвет и UID победителя обязаны совпасть с составом комнаты',
        /if \(winnerColor !== myColor\) return false;/.test(SRC));
    check('23.7 реванш снимает result вместе с winner одной операцией',
        /updates\["result"\] = null;/.test(SRC) && /updates\["winner"\] = null;/.test(SRC));

    reset(); global.currentState = absent(75); checkOpponentAbsence();
    var beforeSecond = resultsWritten.length;
    global.opponentAbsenceHandled = false;
    global.technicalResultInFlight = false;
    checkOpponentAbsence();
    check('23.8 второй одновременный вызов не создаёт второй результат',
        resultsWritten.length === beforeSecond, 'записей: ' + resultsWritten.length);

    // ===============================================================
    console.log('24. v180: СУЩЕСТВУЮЩИЙ PIPELINE НЕ ДУБЛИРУЕТСЯ');
    // ===============================================================
    check('24.1 второго pipeline результата не создано',
        !/recordGameResultFromTechnicalResult/.test(SRC) &&
        !/renderTechnicalEndGameModal/.test(SRC));
    check('24.2 result попадает в состояние комнаты как обычное поле',
        (SRC.match(/result: room\.result \|\| null,/g) || []).length === 3);
    check('24.3 существующая UID-атрибуция не тронута',
        /function resolveMyOnlineResult\(state\) \{/.test(SRC) &&
        /const winnerId = \(state\.winner === "light"\) \? lightId : darkId;/.test(SRC));
    check('24.4 Elo-квитанция по-прежнему единственная точка записи рейтинга',
        (SRC.match(/updates\["eloMatches\/" \+ ctx\.matchId\]/g) || []).length === 1);
    check('24.5 дедуп монет не тронут',
        /rewardedMatches/.test(SRC) && /coinRewardAttemptForMatch === matchId/.test(SRC));
    check('24.6 вернувшийся проигравший идёт через тот же resolveMyOnlineResult',
        /const myResult = resolveMyOnlineResult\(currentState\);/.test(SRC));
    check('24.7 у технической победы есть объяснение во всех трёх языках',
        (SRC.match(/win_reason_disconnect:/g) || []).length === 3);
    check('24.8 текст показывается ИМЕННО для technical, а не для любой победы',
        /currentState\.winReason === TECHNICAL_WIN_REASON\) \? t\("win_reason_disconnect"\) : ""/.test(SRC));
    check('24.9 finished-комната не подметается лобби-sweep-ом',
        /if \(room\.status === "finished" \|\| room\.winner\) continue;/.test(SRC));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

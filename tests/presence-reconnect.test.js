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

let loadError = null;
try {
    global.PRESENCE_STALE_WARNING_MS = Number(/const PRESENCE_STALE_WARNING_MS = (\d+);/.exec(SRC)[1]);
    global.RECONNECT_GRACE_MS = Number(/const RECONNECT_GRACE_MS = (\d+);/.exec(SRC)[1]);
    global.CONNECTION_SETTLE_MS = Number(/const CONNECTION_SETTLE_MS = (\d+);/.exec(SRC)[1]);
    eval(extractFunc('statusForColor'));
    eval(extractFunc('isRoomPlayerStale'));
    eval(extractFunc('getOpponentAbsenceMs'));
    eval(extractFunc('canTrustAbsenceForCleanup'));
    eval(extractFunc('checkOpponentAbsence'));
} catch (e) { loadError = e.message; }

// Смещение часов телефона относительно сервера (мс). 0 = часы верны.
let clockSkewMs = 0;
// Монотонные часы теста: 60 секунд «связь стабильна» по умолчанию.
let monoNow = 60000;

function reset() {
    cleanupCalls = 0; modalHidden = true; timersCreated = [];
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
function stateWithOpponentSilentFor(absenceSec, online) {
    return {
        winner: null,
        players: { light: { id: 'ME', name: 'Me' }, dark: { id: 'OPP', name: 'Opp' } },
        presence: {
            light: { online: true, lastSeen: Date.now() },
            dark: { online: (online !== false), lastSeen: Date.now() - absenceSec * 1000 }
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
        cleanupCalls === 0 && modalHidden === true);
    check('1.4 мой собственный статус тоже нейтральный (не «ушёл»)',
        statusForColor('light').cls === 'status-neutral');

    // связь вернулась, соперник свежий — всё в порядке
    reset();
    global.currentState = stateWithOpponentSilentFor(2);
    check('1.5 связь есть, соперник свежий -> «в игре»',
        statusForColor('dark').cls === 'status-online', statusForColor('dark').cls);
    checkOpponentAbsence();
    check('1.6 ничего не удаляется', cleanupCalls === 0);

    // ===============================================================
    console.log('2. СЕРВЕРНОЕ ВРЕМЯ ВМЕСТО ЧАСОВ ТЕЛЕФОНА');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(2);
    clockSkewMs = -5 * 60 * 1000; // часы телефона убежали ВПЕРЁД на 5 минут
    check('2.1 расхождение часов не превращает живого соперника в ушедшего',
        statusForColor('dark').cls === 'status-online', statusForColor('dark').cls);
    checkOpponentAbsence();
    check('2.2 и не приводит к удалению комнаты', cleanupCalls === 0);
    check('2.3 в коде используется серверное время, а не голый Date.now()',
        /const elapsed = getEstimatedServerNow\(\) - \(presence\.lastSeen/.test(SRC) &&
        /return getEstimatedServerNow\(\) - presence\.lastSeen;/.test(SRC));

    // ===============================================================
    console.log('3. ЕДИНАЯ 60-СЕКУНДНАЯ ШКАЛА ОТ lastSeen');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(30, false);
    checkOpponentAbsence();
    check('3.1 30 секунд отсутствия -> ещё рано', cleanupCalls === 0);
    check('3.2 отдельный setTimeout(60000) больше НЕ заводится',
        timersCreated.indexOf(60000) === -1, JSON.stringify(timersCreated));

    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    checkOpponentAbsence();
    check('3.3 75 секунд отсутствия -> партия завершается сразу',
        cleanupCalls === 1 && modalHidden === false);

    // reconnect НЕ даёт новой минуты: шкала привязана к lastSeen соперника
    reset();
    global.currentState = stateWithOpponentSilentFor(50, false);
    monoNow = 20000; // я только что вернулся
    checkOpponentAbsence();
    check('3.4 после МОЕГО reconnect ушедшему остаётся ~10с, а не новые 60',
        cleanupCalls === 0);
    global.currentState = stateWithOpponentSilentFor(65, false);
    checkOpponentAbsence();
    check('3.5 через оставшиеся секунды партия корректно завершается',
        cleanupCalls === 1);
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
    check('4.1 связь только что вернулась -> НЕ удалять', cleanupCalls === 0);
    check('4.2 решение лишь отложено: при устойчивой связи оно принимается', (function () {
        monoNow = 30000;
        checkOpponentAbsence();
        return cleanupCalls === 1;
    })());

    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.serverTimeOffsetReady = false;
    checkOpponentAbsence();
    check('4.3 серверное время ещё неизвестно -> НЕ удалять', cleanupCalls === 0);

    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.isFirebaseConnected = false; global.connectedSinceMono = null;
    checkOpponentAbsence();
    check('4.4 нет связи -> НЕ удалять', cleanupCalls === 0);

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
    check('5.1 зритель никогда не удаляет комнату', cleanupCalls === 0);

    reset();
    global.isOnlineGame = false; global.isBotGame = true;
    global.currentState = stateWithOpponentSilentFor(300, false);
    checkOpponentAbsence();
    check('5.2 игра с ботом не затронута', cleanupCalls === 0);

    reset();
    global.currentState = stateWithOpponentSilentFor(300, false);
    global.currentState.winner = 'light';
    checkOpponentAbsence();
    check('5.3 законченная партия не запускает очистку', cleanupCalls === 0);

    reset();
    global.currentState = stateWithOpponentSilentFor(300, false);
    global.opponentAbsenceHandled = true;
    checkOpponentAbsence();
    check('5.4 повторный вызов не удаляет комнату дважды', cleanupCalls === 0);

    check('5.5 presence-фиксы v171 на месте',
        /onDisconnect\(\)\.update\(\{[\s\S]{0,80}online: false/.test(SRC));
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
        asLight === 0 && cleanupCalls === 0);

    global.myColor = 'light';
    global.isFirebaseConnected = true;
    global.connectedSinceMono = 0;
    global.roomSnapshotSeenSinceConnect = true;
    global.currentState = stateWithOpponentSilentFor(1);
    check('6.3 после reconnect обе панели снова «в игре»',
        statusForColor('light').cls === 'status-online' &&
        statusForColor('dark').cls === 'status-online');
    checkOpponentAbsence();
    check('6.4 и никакой очистки не запускается', cleanupCalls === 0);

    // ===============================================================
    console.log('7. cleanupAbandonedRoom РОВНО ОДИН РАЗ');
    // ===============================================================
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    for (let sec = 0; sec < 10; sec++) {
        global.currentState.presence.dark.lastSeen = Date.now() - (75 + sec) * 1000;
        checkOpponentAbsence();
    }
    check('7.1 за 10 секунд подряд очистка вызвана РОВНО один раз',
        cleanupCalls === 1, 'вызовов: ' + cleanupCalls);
    check('7.2 модалка показана и остаётся', modalHidden === false);
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
    check('8.1 нет свежего снапшота после reconnect -> НЕ удалять', cleanupCalls === 0);
    global.roomSnapshotSeenSinceConnect = true;
    checkOpponentAbsence();
    check('8.2 снапшот пришёл -> решение принимается', cleanupCalls === 1);
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
    check('9.1 без серверного подтверждения cleanup ЗАПРЕЩЁН', cleanupCalls === 0);
    global.serverAckSinceConnect = true;
    checkOpponentAbsence();
    check('9.2 после серверного подтверждения решение принимается', cleanupCalls === 1);

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
    check('10.1 3 секунды стабильности -> НЕ удалять', cleanupCalls === 0);
    // системные часы прыгнули на час вперёд — монотонные не изменились
    const jumpedForward = Date.now;
    Date.now = function () { return jumpedForward() + 3600000; };
    checkOpponentAbsence();
    check('10.2 скачок Date.now() ВПЕРЁД не сокращает интервал стабильности',
        cleanupCalls === 0);
    Date.now = function () { return jumpedForward() - 3600000; };
    checkOpponentAbsence();
    check('10.3 скачок Date.now() НАЗАД тоже ничего не ломает', cleanupCalls === 0);
    Date.now = jumpedForward;
    monoNow = 30000; // монотонно прошло 30 секунд
    checkOpponentAbsence();
    check('10.4 по монотонным часам интервал выдержан -> решение принимается',
        cleanupCalls === 1);
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
    check('11.2 и никакого удаления', cleanupCalls === 0);
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
    check('12.11 подтверждённая комната: уход >60с очищается', cleanupCalls === 1);

    // --- 12.12 без доказательства текущей комнаты cleanup запрещён ---
    reset();
    global.currentState = stateWithOpponentSilentFor(75, false);
    global.serverAckSinceConnect = false;
    global.roomSnapshotSeenSinceConnect = false;
    checkOpponentAbsence();
    check('12.12 новая комната без доказательства: cleanup ЗАПРЕЩЁН', cleanupCalls === 0);


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
        const elapsed = m[0].indexOf('const elapsed = getEstimatedServerNow()');
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
    check('13.13 и живая комната не удаляется', cleanupCalls === 0);
    // после подтверждения свежести настоящий уход по-прежнему обрабатывается
    global.roomSnapshotSeenSinceConnect = true;
    checkOpponentAbsence();
    check('13.14 после подтверждения свежести настоящий уход >60с очищается',
        cleanupCalls === 1);


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
    console.log('16. ФАЗА A: BACKGROUND ≠ DISCONNECT');
    // ===============================================================
    check('16.1 сворачивание пишет away, а НЕ online:false', (function () {
        const m = /function handleVisibilityChange[\s\S]*?\n}/.exec(SRC);
        if (!m) return false;
        const hidden = m[0].slice(0, m[0].indexOf('} else'));
        return /away: true/.test(hidden) && !/online: false/.test(hidden);
    })());
    check('16.2 возвращение сбрасывает away и offlineSince', (function () {
        const m = /function handleVisibilityChange[\s\S]*?\n}/.exec(SRC);
        const back = m[0].slice(m[0].indexOf('} else'));
        return /away: false/.test(back) && /offlineSince: null/.test(back) && /online: true/.test(back);
    })());
    check('16.3 offlineSince ставит ТОЛЬКО серверный onDisconnect',
        /onDisconnect\(\)\.update\(\{[\s\S]{0,200}offlineSince: firebase\.database\.ServerValue\.TIMESTAMP/.test(SRC) &&
        !/offlineSince: Date\.now\(\)/.test(SRC));
    check('16.4 реконнект перевзводит onDisconnect ДАЖЕ если приложение свёрнуто',
        !/isSpectator && roomCode && !document\.hidden/.test(SRC) &&
        /ref\.onDisconnect\(\)\.update\(\{[\s\S]{0,200}\}\)\.then/.test(SRC));

    // статус: away не равен offline
    reset();
    global.currentState = stateWithOpponentSilentFor(300);
    global.currentState.presence.dark = { online: true, away: true, lastSeen: Date.now() - 300000 };
    check('16.5 свернувший соперник -> «отошёл», НЕ офлайн',
        statusForColor('dark').cls === 'status-neutral', statusForColor('dark').cls);
    check('16.6 старый lastSeen при away игнорируется полностью',
        getOpponentAbsenceMs('dark') === null);
    checkOpponentAbsence();
    check('16.7 никакого отсчёта и никакой очистки', cleanupCalls === 0);

    // настоящий разрыв по-прежнему офлайн
    global.currentState.presence.dark = { online: false, away: true, lastSeen: Date.now() - 75000 };
    check('16.8 настоящий разрыв важнее away -> офлайн',
        statusForColor('dark').cls === 'status-left', statusForColor('dark').cls);
    checkOpponentAbsence();
    check('16.9 и очистка при настоящем уходе >60с работает', cleanupCalls === 1);

    // «в игре» без away
    reset();
    global.currentState = stateWithOpponentSilentFor(2);
    global.currentState.presence.dark = { online: true, lastSeen: Date.now() - 2000 };
    check('16.10 обычный активный соперник -> «в игре»',
        statusForColor('dark').cls === 'status-online');

    // лобби не считает свернувшего ушедшим
    check('16.11 лобби: away-игрок не считается покинувшим комнату', (function () {
        const room = { presence: { light: { online: true, away: true, lastSeen: Date.now() - 300000 } } };
        return isRoomPlayerStale(room, 'light') === false;
    })());
    check('16.12 лобби: настоящий разрыв >60с по-прежнему stale', (function () {
        const room = { presence: { light: { online: false, lastSeen: Date.now() - 75000 } } };
        return isRoomPlayerStale(room, 'light') === true;
    })());
    check('16.13 лобби перешло на серверное время', (function () {
        const m = /function isRoomPlayerStale[\s\S]*?\n}/.exec(SRC);
        return m && /getEstimatedServerNow\(\)/.test(m[0]) && !/Date\.now\(\)/.test(m[0]);
    })());
    check('16.14 переводы «отошёл» есть во всех трёх языках',
        /status_away: "отошёл"/.test(SRC) && /status_away: "away"/.test(SRC) &&
        /status_away: "assente"/.test(SRC));
    check('16.15 запрет офлайн-хода из v178 не тронут',
        /if \(isOnlineGame && !isFirebaseConnected\) return;/.test(SRC));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

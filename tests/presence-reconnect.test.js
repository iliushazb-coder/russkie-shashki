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
        /onDisconnect\(\)\.update\(\{ online: false \}\);/.test(SRC));
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

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

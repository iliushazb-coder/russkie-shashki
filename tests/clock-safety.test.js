// ==========================================================================
// CLOCK SAFETY — серверное время вместо часов телефона.
//
// turnStartedAt и lastSeen пишутся через ServerValue.TIMESTAMP, то есть это
// СЕРВЕРНОЕ время. Сравнение с голым Date.now() давало ошибки в обе стороны:
//   часы отстают -> таймер щедрее, мёртвая комната висит вечно
//   часы спешат  -> поражение по времени раньше срока, живую комнату удаляют
//
// Проверки поведенческие: вызываются НАСТОЯЩИЕ production-функции при
// расхождении часов +10 и -10 минут.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}
function grab(n) {
    const m = new RegExp('^function ' + n + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}
function body(n) {
    return grab(n).split('\n').filter(l => l.trim().indexOf('//') !== 0).join('\n');
}

const SERVER_NOW = 1800000000000;
const MIN = 60000;
const SKEW_SLOW = 10 * MIN;    // телефон ОТСТАЁТ на 10 минут
const SKEW_FAST = -10 * MIN;   // телефон СПЕШИТ на 10 минут

global.RECONNECT_GRACE_MS = 60000;
global.CONNECTION_SETTLE_MS = 15000;
global.getMonotonicNow = function () { return 999999; };
global.connectedSinceMono = 0;
global.serverAckSinceConnect = true;
global.isFirebaseConnected = true;
global.serverTimeOffsetReady = true;

let phoneClock = SERVER_NOW;
global.cachedServerTimeOffsetMs = 0;
const realNow = Date.now;
Date.now = function () { return phoneClock; };

// Расхождение: телефон показывает своё, offset компенсирует до серверного.
function setSkew(ms) { phoneClock = SERVER_NOW - ms; cachedServerTimeOffsetMs = ms; }

eval(grab('getEstimatedServerNow'));
eval(grab('canJudgeStaleByServerTime'));
eval(grab('canDeleteStaleRoomFromLobby'));
eval(grab('isRoomPlayerStale'));

// --- заглушки для checkTimeout ---
let transactions = [];
global.isSpectator = false;
global.isOnlineGame = true;
global.roomCode = 'R1';
global.database = { ref: function () { return {
    transaction: function (fn) { transactions.push(fn); return { then: function () { return this; }, catch: function () { return this; } }; }
}; } };
global.firebase = { database: { ServerValue: { TIMESTAMP: 'TS' } } };
eval(grab('checkTimeout'));

function gameState(o) {
    return Object.assign({
        timeControlSeconds: 60,
        turnStartedAt: SERVER_NOW - 30000,   // ход идёт 30 секунд ПО СЕРВЕРУ
        turn: 'light', winner: null, result: null
    }, o || {});
}
function runTimeout(state) {
    transactions = [];
    global.currentState = state;
    checkTimeout();
    return transactions.length > 0;   // была ли попытка записать поражение
}

console.log('=== 1. ЧАСЫ ОТСТАЮТ НА 10 МИНУТ ===');
setSkew(SKEW_SLOW);

check('1.1 ход идёт 30с из 60 — таймаут НЕ срабатывает',
    runTimeout(gameState()) === false);
check('1.2 ход идёт 90с из 60 — таймаут срабатывает',
    runTimeout(gameState({ turnStartedAt: SERVER_NOW - 90000 })) === true);
check('1.3 КОНТРОЛЬ: со старой формулой на Date.now() истёкший ход НЕ ловился', (function () {
    const elapsed = (Date.now() - (SERVER_NOW - 90000)) / 1000;
    return elapsed <= 60;   // прежний код решил бы, что время ещё есть
})());

const deadRoom = { status: 'active',
    presence: { light: { online: false, lastSeen: SERVER_NOW - 5 * MIN },
                dark:  { online: false, lastSeen: SERVER_NOW - 5 * MIN } } };
const liveRoom = { status: 'active',
    presence: { light: { online: true, lastSeen: SERVER_NOW - 1000 },
                dark:  { online: true, lastSeen: SERVER_NOW - 1000 } } };

check('1.4 мёртвая комната ПРИЗНАНА устаревшей несмотря на отставание часов',
    isRoomPlayerStale(deadRoom, 'light') && isRoomPlayerStale(deadRoom, 'dark'));
check('1.5 живая комната НЕ признана устаревшей',
    !isRoomPlayerStale(liveRoom, 'light'));
check('1.6 КОНТРОЛЬ: старая формула считала мёртвую комнату живой', (function () {
    return (Date.now() - (SERVER_NOW - 5 * MIN)) <= RECONNECT_GRACE_MS;
})());

console.log('\n=== 2. ЧАСЫ СПЕШАТ НА 10 МИНУТ ===');
setSkew(SKEW_FAST);

check('2.1 ход идёт 30с из 60 — поражение НЕ засчитано',
    runTimeout(gameState()) === false);
check('2.2 КОНТРОЛЬ: старая формула засчитала бы поражение прямо сейчас', (function () {
    const elapsed = (Date.now() - (SERVER_NOW - 30000)) / 1000;
    return elapsed > 60;   // прежний код решил бы, что время вышло
})());
check('2.3 живая комната НЕ признана устаревшей',
    !isRoomPlayerStale(liveRoom, 'light') && !isRoomPlayerStale(liveRoom, 'dark'));
check('2.4 КОНТРОЛЬ: старая формула удалила бы ЖИВУЮ комнату', (function () {
    return (Date.now() - (SERVER_NOW - 1000)) > RECONNECT_GRACE_MS;
})());
check('2.5 мёртвая по-прежнему признана устаревшей',
    isRoomPlayerStale(deadRoom, 'light'));

console.log('\n=== 3. ЧАСЫ СОВПАДАЮТ — прежнее поведение ===');
setSkew(0);

check('3.1 30с из 60 — таймаута нет', runTimeout(gameState()) === false);
check('3.2 61с из 60 — таймаут есть',
    runTimeout(gameState({ turnStartedAt: SERVER_NOW - 61000 })) === true);
check('3.3 ровно 60с — таймаута ещё нет (строгое сравнение)',
    runTimeout(gameState({ turnStartedAt: SERVER_NOW - 60000 })) === false);
check('3.4 граница staleness: ровно порог — не устарел',
    isRoomPlayerStale({ presence: { light: { lastSeen: SERVER_NOW - RECONNECT_GRACE_MS } } }, 'light') === false);
check('3.5 граница staleness: порог + 1мс — устарел',
    isRoomPlayerStale({ presence: { light: { lastSeen: SERVER_NOW - RECONNECT_GRACE_MS - 1 } } }, 'light') === true);

console.log('\n=== 4. FAIL CLOSED: серверное время ещё не получено ===');
setSkew(0);
serverTimeOffsetReady = false;

check('4.1 таймаут НЕ засчитывается без подтверждённого смещения',
    runTimeout(gameState({ turnStartedAt: SERVER_NOW - 5 * MIN })) === false);
check('4.2 staleness не судится — комната не скрывается',
    isRoomPlayerStale(deadRoom, 'light') === false);
check('4.3 разрушительное удаление запрещено',
    canDeleteStaleRoomFromLobby() === false);
serverTimeOffsetReady = true;
check('4.4 смещение получено — таймаут снова работает',
    runTimeout(gameState({ turnStartedAt: SERVER_NOW - 5 * MIN })) === true);
check('4.5 и staleness снова судится', isRoomPlayerStale(deadRoom, 'light') === true);

console.log('\n=== 5. ПОРОГ ДЛЯ РАЗРУШИТЕЛЬНОГО УДАЛЕНИЯ ===');

check('5.1 всё в порядке — удалять можно', canDeleteStaleRoomFromLobby() === true);
isFirebaseConnected = false;
check('5.2 нет связи — нельзя', canDeleteStaleRoomFromLobby() === false);
isFirebaseConnected = true;
connectedSinceMono = 999999 - 5000;
check('5.3 связь поднялась 5 секунд назад — нельзя',
    canDeleteStaleRoomFromLobby() === false);
connectedSinceMono = 0;
// ОЖИДАНИЕ ИЗМЕНЕНО ОСОЗНАННО. serverAckSinceConnect выставляется только из
// presence-путей (3 места в setupPresence, 1 в revivePresenceAfterReconnect).
// Человек, открывший «Кто играет?» и не заходивший в партию, presence не
// создаёт, поэтому флаг у него навсегда false. С ним обычный посетитель
// лобби не убрал бы НИ ОДНОЙ протухшей комнаты.
serverAckSinceConnect = false;
check('5.4 порог НЕ зависит от presence-специфичного serverAckSinceConnect',
    canDeleteStaleRoomFromLobby() === true);
check('5.4b и это ровно сценарий чистого посетителя лобби', (function () {
    // всё как у только что зашедшего человека: связь есть, устоялась,
    // смещение получено, но ни одной presence-записи он не делал
    return isFirebaseConnected === true && serverAckSinceConnect === false &&
        serverTimeOffsetReady === true && canDeleteStaleRoomFromLobby() === true;
})());
check('5.4c в теле порога нет упоминания serverAckSinceConnect',
    body('canDeleteStaleRoomFromLobby').indexOf('serverAckSinceConnect') === -1);
serverAckSinceConnect = true;
serverTimeOffsetReady = false;
check('5.5 без смещения по-прежнему нельзя', canDeleteStaleRoomFromLobby() === false);
serverTimeOffsetReady = true;
check('5.6 всё восстановлено — можно', canDeleteStaleRoomFromLobby() === true);

console.log('\n=== 6. ХОД НЕ БЛОКИРУЕТСЯ ОТСУТСТВИЕМ СМЕЩЕНИЯ ===');

check('6.1 сам ход НЕ блокируется отсутствием смещения', (function () {
    // Ход должен проходить всегда. Запрещён только ранний return ДО
    // выполнения хода; условная метка ниже — это не блокировка.
    const b = body('performMove');
    return /if \(!serverTimeOffsetReady\) return;/.test(b) === false;
})());
check('6.2 при готовом смещении метка ставится в серверном базисе',
    /serverTimeOffsetReady\s*\?\s*getEstimatedServerNow\(\)/.test(body('performMove')));
check('6.2b без смещения недостоверная метка НЕ ставится вовсе', (function () {
    // ПОВЕДЕНЧЕСКАЯ проверка, а не поиск строки: вытаскиваем ИМЕННО то
    // присваивание turnStartedAt из performMove и исполняем его при обоих
    // состояниях смещения. Текстовая проверка здесь обманывала: в performMove
    // есть ещё два посторонних ": null;", и регулярка цеплялась за них.
    const m = /currentState\.turnStartedAt\s*=\s*([\s\S]*?);/.exec(body('performMove'));
    if (!m) return false;
    const expr = m[1];
    let ready, out;
    const evalExpr = function () {
        return eval('(function (serverTimeOffsetReady, getEstimatedServerNow) {'
            + ' return ' + expr + '; })')(ready, function () { return SERVER_NOW; });
    };
    ready = false; out = evalExpr();
    if (out !== null) return false;          // без смещения — только null
    ready = true;  out = evalExpr();
    return out === SERVER_NOW;               // со смещением — серверное время
})());
check('6.3 голого Date.now() для turnStartedAt в performMove больше нет',
    body('performMove').indexOf('turnStartedAt = Date.now()') === -1);

console.log('\n=== 7. КОД: голых Date.now() в решениях о времени не осталось ===');

check('7.1 updateTimerDisplay считает по серверному времени',
    /getEstimatedServerNow\(\) - currentState\.turnStartedAt/.test(body('updateTimerDisplay')));
check('7.2 checkTimeout считает по серверному времени',
    /getEstimatedServerNow\(\) - currentState\.turnStartedAt/.test(body('checkTimeout')));
check('7.3 checkTimeout имеет fail-closed по смещению',
    /if \(!serverTimeOffsetReady\) return;/.test(body('checkTimeout')));
check('7.4 isRoomPlayerStale считает по серверному времени',
    /getEstimatedServerNow\(\) - \(p\.lastSeen \|\| 0\)/.test(body('isRoomPlayerStale')));
check('7.5 sweep вычисляет порог удаления один раз',
    /const mayDelete = canDeleteStaleRoomFromLobby\(\);/.test(SRC));
check('7.6 удаление waiting-комнаты под порогом',
    /if \(mayDelete &&\s*\n\s*room\.status === "waiting"/.test(SRC));
check('7.7 удаление active-комнаты под порогом',
    /if \(mayDelete && room\.status === "active" && lightIsStale && darkIsStale\)/.test(SRC));

console.log('\n=== 8. ЧУЖИЕ ПОДСИСТЕМЫ НЕ ЗАТРОНУТЫ ===');

check('8.1 isRoomAbandonedNow (v184) не изменена',
    body('isRoomAbandonedNow').indexOf('canJudgeStaleByServerTime') === -1 &&
    /MAX|Math\.max/.test(body('isRoomAbandonedNow')));
check('8.2 checkOpponentAbsence не тронута',
    body('checkOpponentAbsence').indexOf('canJudgeStaleByServerTime') === -1);
check('8.3 writeTechnicalResult не тронута',
    body('writeTechnicalResult').indexOf('canDeleteStaleRoomFromLobby') === -1);
// ОЖИДАНИЕ ПЕРЕВЁРНУТО ОСОЗНАННО. Раньше здесь закреплялось ОТСУТСТВИЕ
// порога у ветки v184. Это оказалось дырой: isRoomAbandonedNow fail-closed
// только по serverTimeOffsetReady, а смещение остаётся true и после обрыва
// связи. Отключённое лобби с замороженным кешем ставило remove() в
// offline-очередь, и та применялась к уже живой комнате после реконнекта.
check('8.4 v184-ветка abandoned в sweep ТОЖЕ под порогом', (function () {
    const sw = grab('runLobbyStaleSweep');
    return /if \(mayDelete && isRoomAbandonedNow\(room\)\)/.test(sw);
})());
check('8.4b но САМ предикат v184 не изменён', (function () {
    const b = body('isRoomAbandonedNow');
    return b.indexOf('mayDelete') === -1 &&
        b.indexOf('canDeleteStaleRoomFromLobby') === -1 &&
        b.indexOf('isFirebaseConnected') === -1;
})());

console.log('\n=== 9. STARTUP RACE: ход ДО смещения, потом смещение пришло ===');

(function () {
    // Точный сценарий: телефон отстаёт на 10 минут; смещение ещё не получено;
    // игрок делает ход; оптимистичная метка ставится; ЗАТЕМ смещение
    // приходит РАНЬШЕ серверного снимка комнаты; checkTimeout разблокируется.
    //
    // Со старым кодом метка была бы в локальном базисе, и
    // getEstimatedServerNow() - метка дало бы ровно величину расхождения,
    // то есть 600 секунд — ложное поражение при контроле в 60 секунд.

    // 1. смещение ещё не получено, часы отстают на 10 минут
    serverTimeOffsetReady = false;
    phoneClock = SERVER_NOW - SKEW_SLOW;
    cachedServerTimeOffsetMs = 0;          // до готовности offset равен нулю

    // 2. игрок делает ход — воспроизводим ровно ту строку из performMove
    const optimisticMark = serverTimeOffsetReady ? getEstimatedServerNow() : null;

    check('9.1 ход прошёл, но недостоверная метка НЕ поставлена',
        optimisticMark === null);

    // 3. смещение пришло, серверный снимок ЕЩЁ НЕ пришёл
    serverTimeOffsetReady = true;
    cachedServerTimeOffsetMs = SKEW_SLOW;

    const stateAfterMove = gameState({ turnStartedAt: optimisticMark });
    check('9.2 ЛОЖНОГО таймаута нет: checkTimeout выходит по охране метки',
        runTimeout(stateAfterMove) === false);
    check('9.3 таймер тоже молчит, а не показывает чушь',
        !stateAfterMove.turnStartedAt);

    check('9.4 КОНТРОЛЬ: со старой безусловной меткой был бы ложный таймаут', (function () {
        // как было до исправления: метка в локальном базисе
        const badMark = SERVER_NOW - SKEW_SLOW;
        const elapsed = (getEstimatedServerNow() - badMark) / 1000;
        return elapsed > 60;      // 600 секунд против контроля в 60
    })());
    check('9.5 и это именно ~600 секунд, а не случайное превышение', (function () {
        const badMark = SERVER_NOW - SKEW_SLOW;
        const elapsed = (getEstimatedServerNow() - badMark) / 1000;
        return Math.abs(elapsed - 600) < 1;
    })());

    // 4. серверный снимок пришёл — партия считается нормально
    const stateFromServer = gameState({ turnStartedAt: SERVER_NOW - 30000 });
    check('9.6 после серверного снимка 30с из 60 — таймаута нет',
        runTimeout(stateFromServer) === false);
    check('9.7 после серверного снимка 90с из 60 — таймаут есть',
        runTimeout(gameState({ turnStartedAt: SERVER_NOW - 90000 })) === true);

    // 5. зеркальный случай: телефон СПЕШИТ
    serverTimeOffsetReady = false;
    phoneClock = SERVER_NOW - SKEW_FAST;
    cachedServerTimeOffsetMs = 0;
    const mark2 = serverTimeOffsetReady ? getEstimatedServerNow() : null;
    serverTimeOffsetReady = true;
    cachedServerTimeOffsetMs = SKEW_FAST;
    check('9.8 при спешащих часах тоже нет ложного исхода',
        mark2 === null && runTimeout(gameState({ turnStartedAt: mark2 })) === false);

    // 6. если смещение УЖЕ было — метка ставится и работает нормально
    serverTimeOffsetReady = true;
    setSkew(SKEW_SLOW);
    const goodMark = serverTimeOffsetReady ? getEstimatedServerNow() : null;
    check('9.9 при готовом смещении метка ставится в серверном базисе',
        Math.abs(goodMark - SERVER_NOW) < 5);
    check('9.10 и сразу после хода таймаута нет',
        runTimeout(gameState({ turnStartedAt: goodMark })) === false);
})();

console.log('\n=== 10. RUN LOBBY STALE SWEEP: разрушительные записи под порогом ===');

(function () {
    // Прогоняем НАСТОЯЩИЙ runLobbyStaleSweep и смотрим, какие пути записи он
    // реально дёрнул. Не регулярка по исходнику: проверяем поведение.
    const removed = [];
    global.database = { ref: function (path) { return {
        remove: function () { removed.push(path); return { then: function () { return this; }, catch: function () { return this; } }; },
        transaction: function () { return { then: function () { return this; }, catch: function () { return this; } }; }
    }; } };
    global.scheduleLobbyRender = function () {};
    eval(grab('isRoomAbandonedNow'));
    eval(grab('runLobbyStaleSweep'));

    // Комната с зависшим предложением реванша: отвечающий давно не выходил
    // на связь по СЕРВЕРНОМУ времени.
    function roomWithStaleRematch() {
        return { ROOM1: { status: 'active',
            players: { light: { id: 'A' }, dark: { id: 'B' } },
            rematchProposal: { by: 'light' },
            presence: { light: { online: true,  lastSeen: SERVER_NOW - 1000 },
                        dark:  { online: false, lastSeen: SERVER_NOW - 5 * MIN } } } };
    }
    // Комната, где presence отвечающего ОТСУТСТВУЕТ вовсе.
    function roomWithNoPresence() {
        return { ROOM2: { status: 'active',
            players: { light: { id: 'A' }, dark: { id: 'B' } },
            rematchProposal: { by: 'light' },
            presence: { light: { online: true, lastSeen: SERVER_NOW - 1000 } } } };
    }
    function sweep(rooms) {
        removed.length = 0;
        global.lobbyRoomsByCode = rooms;
        runLobbyStaleSweep();
        return removed.slice();
    }
    const wasRematchRemoved = function (list) {
        return list.some(function (p) { return p.indexOf('rematchProposal') !== -1; });
    };

    // --- порог закрыт: смещение не получено ---
    setSkew(0);
    serverTimeOffsetReady = false;
    isFirebaseConnected = true;
    connectedSinceMono = 0;
    check('10.1 mayDelete=false -> rematchProposal НЕ удаляется',
        wasRematchRemoved(sweep(roomWithStaleRematch())) === false);

    // --- порог закрыт: нет связи ---
    serverTimeOffsetReady = true;
    isFirebaseConnected = false;
    check('10.2 нет связи -> remove НЕ уходит (и не попадает в очередь)',
        sweep(roomWithStaleRematch()).length === 0);

    // --- порог закрыт: связь только что поднялась ---
    isFirebaseConnected = true;
    connectedSinceMono = 999999 - 5000;
    check('10.3 связь держится 5с из 15 -> НЕ удаляется',
        wasRematchRemoved(sweep(roomWithStaleRematch())) === false);

    // --- порог открыт и отвечающий реально устарел ---
    connectedSinceMono = 0;
    check('10.4 mayDelete=true и answerer stale -> удаляется как раньше',
        wasRematchRemoved(sweep(roomWithStaleRematch())) === true);

    // --- отвечающий на связи: удалять нечего ---
    check('10.5 answerer НЕ stale -> предложение не трогаем', (function () {
        const rooms = roomWithStaleRematch();
        rooms.ROOM1.presence.dark = { online: true, lastSeen: SERVER_NOW - 1000 };
        return wasRematchRemoved(sweep(rooms)) === false;
    })());

    // --- отсутствие presence само по себе ---
    serverTimeOffsetReady = false;
    check('10.6 отсутствие presence БЕЗ доверенного времени НЕ разрешает remove',
        wasRematchRemoved(sweep(roomWithNoPresence())) === false);
    serverTimeOffsetReady = true;
    check('10.7 отсутствие presence ПРИ доверенном времени — удаляется',
        wasRematchRemoved(sweep(roomWithNoPresence())) === true);

    check('10.8 КОРЕНЬ: isRoomPlayerStale отвечает true на отсутствующий presence ДО проверки времени', (function () {
        serverTimeOffsetReady = false;
        const r = isRoomPlayerStale({ presence: {} }, 'dark') === true;
        serverTimeOffsetReady = true;
        return r;   // именно поэтому порог обязан стоять снаружи
    })());

    // --- ветка v184 не задета ---
    check('10.9 v184 abandoned ТОЖЕ под порогом', (function () {
        const sw = grab('runLobbyStaleSweep');
        return /if \(mayDelete && isRoomAbandonedNow\(room\)\)/.test(sw);
    })());
    check('10.10 ВСЕ ЧЕТЫРЕ разрушительные ветки под порогом', (function () {
        const sw = grab('runLobbyStaleSweep');
        return /if \(mayDelete && room\.rematchProposal\)/.test(sw) &&
            /if \(mayDelete &&\s*\n\s*room\.status === "waiting"/.test(sw) &&
            /if \(mayDelete && isRoomAbandonedNow\(room\)\)/.test(sw) &&
            /if \(mayDelete && room\.status === "active" && lightIsStale && darkIsStale\)/.test(sw);
    })());
    check('10.11 порог вычисляется ДО цикла, а не на каждой комнате', (function () {
        // Прежняя формулировка считала лишь число вхождений и проходила бы,
        // даже если объявление переехало внутрь for — то есть утверждала
        // больше, чем проверяла. Смотрим позицию относительно цикла.
        const sw = grab('runLobbyStaleSweep');
        const decl = sw.indexOf('const mayDelete = canDeleteStaleRoomFromLobby();');
        const loop = sw.indexOf('for (const code in lobbyRoomsByCode)');
        return decl !== -1 && loop !== -1 && decl < loop &&
            (sw.match(/canDeleteStaleRoomFromLobby\(\)/g) || []).length === 1;
    })());
})();

console.log('\n=== 11. OFFLINE-ОЧЕРЕДЬ: устаревший кеш не удаляет живую комнату ===');

(function () {
    // Точный сценарий: лобби видело обоих offline, потеряло связь, кеш
    // заморожен. Один игрок вернулся раньше минуты, но отключённый клиент
    // этого не знает. Через минуту предикат на СТАРОМ кеше становится true.
    // Без порога remove() ушёл бы в offline-очередь Firebase и применился
    // после реконнекта — к уже живой комнате.
    const removed = [];
    global.database = { ref: function (p) { return {
        remove: function () { removed.push(p); return { then: function () { return this; }, catch: function () { return this; } }; },
        transaction: function () { return { then: function () { return this; }, catch: function () { return this; } }; }
    }; } };
    global.scheduleLobbyRender = function () {};
    eval(grab('isRoomAbandonedNow'));
    eval(grab('runLobbyStaleSweep'));

    // Кеш, замороженный на состоянии «оба ушли больше минуты назад».
    function cachedBothOffline() {
        return { DEAD1: { status: 'active',
            players: { light: { id: 'A' }, dark: { id: 'B' } },
            presence: {
                light: { online: false, absentSince: SERVER_NOW - 5 * MIN, lastSeen: SERVER_NOW - 5 * MIN },
                dark:  { online: false, absentSince: SERVER_NOW - 5 * MIN, lastSeen: SERVER_NOW - 5 * MIN } } } };
    }
    function sweep(rooms) {
        removed.length = 0;
        global.lobbyRoomsByCode = rooms;
        runLobbyStaleSweep();
        return removed.slice();
    }
    const roomRemoved = function (list) {
        return list.some(function (p) { return p === 'rooms/DEAD1'; });
    };

    setSkew(0);
    serverTimeOffsetReady = true;

    // 1. связь потеряна — кеш устарел, предикат по нему истинен
    isFirebaseConnected = false;
    connectedSinceMono = 0;
    check('11.1 предикат по устаревшему кешу ИСТИНЕН', (function () {
        return isRoomAbandonedNow(cachedBothOffline().DEAD1) === true;
    })());
    check('11.2 но при потерянной связи remove НЕ вызывается',
        roomRemoved(sweep(cachedBothOffline())) === false);
    check('11.3 и вообще ни одной записи в очередь не уходит',
        sweep(cachedBothOffline()).length === 0);

    // 2. связь вернулась, но ещё не устоялась
    isFirebaseConnected = true;
    connectedSinceMono = 999999 - 3000;
    check('11.4 связь держится 3с из 15 — remove по-прежнему НЕ уходит',
        roomRemoved(sweep(cachedBothOffline())) === false);

    // 3. связь устоялась — кеш к этому моменту уже обновлён слушателем,
    //    и комната действительно брошена
    connectedSinceMono = 0;
    check('11.5 связь устоялась и партия реально брошена — удаление работает',
        roomRemoved(sweep(cachedBothOffline())) === true);

    // 4. смещение не получено — по-прежнему нельзя
    serverTimeOffsetReady = false;
    check('11.6 без доверенного времени удаления нет',
        roomRemoved(sweep(cachedBothOffline())) === false);
    serverTimeOffsetReady = true;

    // 5. живая комната не трогается ни при каких условиях
    check('11.7 живая комната (один вернулся) не удаляется', (function () {
        const alive = cachedBothOffline();
        alive.DEAD1.presence.light = { online: true, onlineSince: SERVER_NOW - 1000, lastSeen: SERVER_NOW - 1000 };
        return roomRemoved(sweep(alive)) === false;
    })());

    // 6. логическая блокировка abandoned НЕ ослаблена
    check('11.8 предикат по-прежнему судит без оглядки на связь', (function () {
        isFirebaseConnected = false;
        const verdict = isRoomAbandonedNow(cachedBothOffline().DEAD1);
        isFirebaseConnected = true;
        return verdict === true;   // resume/deep-link/render продолжают отказывать
    })());
})();

Date.now = realNow;
console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

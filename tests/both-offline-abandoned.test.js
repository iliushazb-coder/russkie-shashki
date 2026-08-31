// ==========================================================================
// v184 — BOTH-OFFLINE ABANDONED (60 секунд) + закрытие путей воскрешения.
//
// Часть A: предикат «оба отсутствуют непрерывно минуту».
// Часть B: точки чтения — лобби, resume, deep-link, зритель, возврат из фона.
// Часть C: ЕДИНОЕ ПРАВИЛО — при отсутствии связи обычные клиентские записи
//          присутствия не выполняются. Четыре пути воскрешения из реальной
//          v183: heartbeat, hidden, visible, setupPresence().catch().
// Часть D: реконнект — свежее чтение, проверка, перевооружение onDisconnect,
//          и только потом online:true.
// Часть E: существующее техническое поражение при ОДНОМ отсутствующем
//          не изменено.
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
function body(n) {   // тело без строк-комментариев
    return grab(n).split('\n').filter(l => l.trim().indexOf('//') !== 0).join('\n');
}
const CONNECTED_BLOCK = /connectedRef\.on\("value"[\s\S]*?\n\}\);/.exec(SRC)[0];
const HEARTBEAT = /presenceHeartbeatInterval = setInterval\([\s\S]*?\}, 4000\);/.exec(SRC)[0];

const NOW = 1800000000000, MIN = 60000;
global.RECONNECT_GRACE_MS = MIN;
global.serverTimeOffsetReady = true;
global.cachedServerTimeOffsetMs = 0;
let clock = NOW;
global.getEstimatedServerNow = function () { return clock; };
eval(grab('isRoomAbandonedNow'));
eval(grab('getAuthoritativeAbsenceMs'));

function pres(o) {
    return {
        light: o.lOn ? { online: true, onlineSince: NOW - 600000, lastSeen: NOW }
                     : { online: false, absentSince: o.lAbs, lastSeen: o.lAbs },
        dark: o.dOn ? { online: true, onlineSince: NOW - 600000, lastSeen: NOW }
                    : { online: false, absentSince: o.dAbs, lastSeen: o.dAbs }
    };
}
function room(o) {
    o = o || {};
    return Object.assign({
        status: 'active', pieces: { '5_0': { color: 'light', king: false } }, turn: 'light',
        players: { light: { id: 'A', name: 'Илья' }, dark: { id: 'B', name: 'Татьяна' } },
        presence: pres(o.p || { lOn: true, dOn: true })
    }, o.over || {});
}

console.log('=== A. ПРЕДИКАТ: ПОРОГ ОТ УХОДА ВТОРОГО ===');
check('1. оба online — жива', isRoomAbandonedNow(room({ p: { lOn: true, dOn: true } })) === false);
check('2. A offline 60с, B online — НЕ abandoned (путь техпоражения)',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 2 * MIN, dOn: true } })) === false);
check('3. оба offline 10с — жива',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 10000, dOn: false, dAbs: NOW - 10000 } })) === false);
check('4. оба offline 59с — жива',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 59000, dOn: false, dAbs: NOW - 59000 } })) === false);
check('5. оба offline 60с — мертва',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - MIN, dOn: false, dAbs: NOW - MIN } })) === true);
check('5b. отсчёт от ухода ВТОРОГО, а не первого',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 5 * MIN, dOn: false, dAbs: NOW - 30000 } })) === false);
check('5c. и созревает через минуту после второго',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 5 * MIN, dOn: false, dAbs: NOW - MIN } })) === true);
check('5d. online:true с остаточным absentSince — НЕ abandoned', (function () {
    const r = room({ p: { lOn: false, lAbs: NOW - 5 * MIN, dOn: false, dAbs: NOW - 5 * MIN } });
    r.presence.light.online = true;
    return isRoomAbandonedNow(r) === false;
})());
check('5e. завершённая партия предикатом не трогается',
    isRoomAbandonedNow(room({ over: { winner: 'light' },
        p: { lOn: false, lAbs: NOW - 5 * MIN, dOn: false, dAbs: NOW - 5 * MIN } })) === false);
check('5f. waiting-комната не трогается', isRoomAbandonedNow({
    status: 'waiting', players: { light: { id: 'A' } },
    presence: { light: { online: false, absentSince: NOW - 10 * MIN } } }) === false);

console.log('\n=== B. ТОЧКИ ЧТЕНИЯ ===');
let renderedHtml = '';
function stubEl() {
    return { set innerHTML(v) { renderedHtml = v; }, get innerHTML() { return renderedHtml; },
        querySelectorAll: function () { return { forEach: function () {} }; },
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; } } };
}
const listEl = stubEl();
global.document = { getElementById: function (id) { return id === 'group-rooms-list' ? listEl : null; } };
global.myTelegramId = 'STRANGER';
global.t = function (k) { return k; };
eval(grab('escapeHtml'));
// CLOCK SAFETY (v185): staleness считается по серверному времени и требует
// подтверждённого .info/serverTimeOffset; разрушительное удаление — ещё и
// живой связи. Подставляем в харнесс то, что в бою даёт приложение.
global.serverTimeOffsetReady = (typeof serverTimeOffsetReady !== 'undefined') ? serverTimeOffsetReady : true;
global.cachedServerTimeOffsetMs = global.cachedServerTimeOffsetMs || 0;
global.getEstimatedServerNow = global.getEstimatedServerNow || function () { return Date.now() + cachedServerTimeOffsetMs; };
global.isFirebaseConnected = (typeof isFirebaseConnected !== 'undefined') ? isFirebaseConnected : true;
global.connectedSinceMono = (typeof connectedSinceMono !== 'undefined') ? connectedSinceMono : 0;
global.serverAckSinceConnect = (typeof serverAckSinceConnect !== 'undefined') ? serverAckSinceConnect : true;
global.CONNECTION_SETTLE_MS = global.CONNECTION_SETTLE_MS || 15000;
global.getMonotonicNow = global.getMonotonicNow || function () { return 999999; };
eval(grab('canJudgeStaleByServerTime'));
eval(grab('canDeleteStaleRoomFromLobby'));
eval(grab('isRoomPlayerStale'));
eval(grab('renderLobbyListFromCache'));
function render(rooms) { renderedHtml = ''; global.lobbyRoomsByCode = rooms; renderLobbyListFromCache(); return renderedHtml; }

const dead = room({ p: { lOn: false, lAbs: NOW - 3 * MIN, dOn: false, dAbs: NOW - 2 * MIN } });
const live = room({ p: { lOn: true, dOn: true } });
let html = render({ DEAD: dead });
check('6. брошенная не показывается в лобби',
    html.indexOf('group-room-card') === -1 && /lobby_empty/.test(html));
check('6b. имена не раскрыты', html.indexOf('Илья') === -1 && html.indexOf('Татьяна') === -1);
html = render({ DEAD: dead, LIVE: live });
check('7. третий пользователь видит только живую',
    (html.match(/group-room-card/g) || []).length === 1 && html.indexOf('group-watch-btn') !== -1);
check('8. resume отказывает ДО startOnlineGame', (function () {
    const f = body('resumeOwnActiveRoom');
    const c = f.indexOf('isRoomAbandonedNow(room)'), s = f.indexOf('startOnlineGame()');
    return c !== -1 && s !== -1 && c < s;
})());
check('9. deep-link отказывает тем же существующим сообщением',
    /room\.winner \|\|\s*\n\s*isRoomAbandonedNow\(room\)/.test(grab('checkForInviteLink')) &&
    grab('checkForInviteLink').indexOf('err_no_active_game') !== -1);
check('9b. зритель отсекается', /isRoomAbandonedNow\(cached\)/.test(grab('watchGroupRoom')));
check('9c. возврат из фона идёт через свежее чтение, а НЕ через кеш', (function () {
    // Комментарии вырезаем: в них currentState упоминается как объяснение
    // прежней ошибки, и без этого позиция бралась бы из комментария.
    const f = body('handleVisibilityChange');
    return f.indexOf('isRoomAbandonedNow(currentState)') === -1 &&
        /revivePresenceAfterReconnect\(\)/.test(f);
})());
check('10. один вернулся до 60с — abandoned отменяется',
    isRoomAbandonedNow(room({ p: { lOn: true, dOn: false, dAbs: NOW - 40000 } })) === false);
check('11. хотя бы один online — не брошена',
    isRoomAbandonedNow(room({ p: { lOn: true, dOn: false, dAbs: NOW - 10 * MIN } })) === false);
check('12. предикат ничего не пишет',
    body('isRoomAbandonedNow').indexOf('.set(') === -1 &&
    body('isRoomAbandonedNow').indexOf('.update(') === -1);
check('13. уборка не зовёт Elo/coins/stats', (function () {
    const sw = grab('runLobbyStaleSweep'), i = sw.indexOf('isRoomAbandonedNow(room)');
    const b = sw.slice(i, i + 600);
    return i !== -1 && b.indexOf('recordGameResult') === -1 &&
        b.indexOf('awardCoinsForMatch') === -1 && b.indexOf('writeTechnicalResult') === -1;
})());
check('13b. тихий выход не создаёт результата',
    body('leaveAbandonedRoomToMenu').indexOf('winner') === -1 &&
    body('leaveAbandonedRoomToMenu').indexOf('result') === -1);

console.log('\n=== C. ЕДИНОЕ ПРАВИЛО: БЕЗ СВЯЗИ НЕ ПИШЕМ ===');
check('C1. heartbeat выходит без связи', /if \(!isFirebaseConnected\) return;/.test(HEARTBEAT));
check('C2. heartbeat пишет ТОЛЬКО lastSeen (online:true убран)',
    HEARTBEAT.indexOf('online: true') === -1 && HEARTBEAT.indexOf('lastSeen') !== -1);
check('C2b. heartbeat по-прежнему не трогает onlineSince', HEARTBEAT.indexOf('onlineSince') === -1);
check('C3. hidden не ставит absentSince в очередь', (function () {
    const f = grab('handleVisibilityChange');
    const g = f.indexOf('if (!isFirebaseConnected) return;');
    const w = f.indexOf('absentSince: firebase.database.ServerValue.TIMESTAMP');
    return g !== -1 && w !== -1 && g < w;
})());
check('C4. visible вообще не пишет присутствие сама', (function () {
    const f = grab('handleVisibilityChange');
    const tail = f.slice(f.indexOf('} else {'));
    return tail.indexOf('online: true') === -1 &&
        /revivePresenceAfterReconnect\(\)/.test(tail);
})());
check('C5. setupPresence().catch() не ставит online:true в очередь', (function () {
    const m = /\.catch\(function \(\) \{[\s\S]{0,900}presenceRef\.set\(\{/.exec(SRC);
    return !!m && /if \(!isFirebaseConnected\) return;/.test(m[0]);
})());
check('C5b. при живой связи прежний fallback сохранён',
    /\.catch\(function \(\) \{[\s\S]{0,900}presenceRef\.set\(\{[\s\S]{0,200}online: true/.test(SRC));
check('C6. ни один путь не пишет без проверки связи', (function () {
    // heartbeat, hidden, catch + две охраны внутри реконнекта.
    // visible охраны не нужна: она вообще не пишет, а делегирует.
    const guards = (SRC.match(/if \(!isFirebaseConnected\) return;/g) || []).length;
    return guards >= 4;
})());

console.log('\n=== D. РЕКОННЕКТ: ЧТЕНИЕ -> ПРОВЕРКА -> ARM -> ONLINE ===');
check('D1. обработчик .info/connected больше не пишет presence напрямую',
    CONNECTED_BLOCK.indexOf('online: true') === -1 &&
    /revivePresenceAfterReconnect\(\)/.test(CONNECTED_BLOCK));
check('D2. реконнект читает СВЕЖЕЕ состояние комнаты', (function () {
    const f = body('revivePresenceAfterReconnect');
    return /roomRef\.get\(\)/.test(f) && /once\("value"\)/.test(f);
})());
check('D3. проверка both-offline ДО объявления online', (function () {
    const f = body('revivePresenceAfterReconnect');
    const c = f.indexOf('isRoomAbandonedNow(room)'), o = f.indexOf('online: true');
    return c !== -1 && o !== -1 && c < o;
})());
check('D4. onDisconnect перевооружается ДО объявления online', (function () {
    const f = body('revivePresenceAfterReconnect');
    const a = f.indexOf('presenceRef.onDisconnect().update('), o = f.indexOf('online: true');
    return a !== -1 && o !== -1 && a < o;
})());
check('D5. брошенная партия при реконнекте НЕ воскресает',
    /leaveAbandonedRoomToMenu\(\);/.test(body('revivePresenceAfterReconnect')));
check('D6. смена комнаты во время чтения делает продолжение no-op',
    (body('revivePresenceAfterReconnect').match(/roomCode !== targetRoom/g) || []).length >= 2);
check('D7. пропавшая связь во время чтения делает продолжение no-op',
    (body('revivePresenceAfterReconnect').match(/if \(!isFirebaseConnected\) return;/g) || []).length >= 2);

console.log('\n=== E. ТЕХНИЧЕСКОЕ ПОРАЖЕНИЕ НЕ ИЗМЕНЕНО ===');
check('E1. checkOpponentAbsence не тронута', grab('checkOpponentAbsence').indexOf('isRoomAbandonedNow') === -1);
check('E2. writeTechnicalResult не тронута', grab('writeTechnicalResult').indexOf('isRoomAbandonedNow') === -1);
check('E3. getAuthoritativeAbsenceMs считает как раньше',
    getAuthoritativeAbsenceMs({ online: false, absentSince: NOW - 90000 }) === 90000);
check('E4. один offline 90с при online сопернике — НЕ abandoned',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 90000, dOn: true } })) === false);
check('E5. предикат не встречается в result/Elo/coins-путях',
    grab('resolveMyOnlineResult').indexOf('isRoomAbandonedNow') === -1 &&
    grab('recordGameResult').indexOf('isRoomAbandonedNow') === -1);

console.log('\n=== F. FAIL CLOSED ===');
serverTimeOffsetReady = false;
check('F1. без serverTimeOffset не судим',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 5 * MIN, dOn: false, dAbs: NOW - 5 * MIN } })) === false);
serverTimeOffsetReady = true;
check('F2. offset получен — судим',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: NOW - 5 * MIN, dOn: false, dAbs: NOW - 5 * MIN } })) === true);
check('F3. частичные данные presence — не судим',
    isRoomAbandonedNow(room({ p: { lOn: false, lAbs: undefined, dOn: false, dAbs: NOW - 5 * MIN } })) === false);

console.log('\n=== G. ПОВЕДЕНЧЕСКИЙ: currentState БЕЗ status не воскрешает партию ===');
(function () {
    // ТОЧНАЯ production-форма currentState. Строится в слушателе комнаты из
    // фиксированного списка полей — поля status там НЕТ. Именно поэтому
    // прежняя проверка isRoomAbandonedNow(currentState) всегда возвращала
    // false и ветка visible воскрешала брошенную партию.
    function productionCurrentState(p) {
        return {
            pieces: { '5_0': { color: 'light', king: false } }, turn: 'light',
            mustContinueFrom: null, capturedDark: 0, capturedLight: 0,
            moveCount: 7, matchNumber: 0, ratingsAtStart: null,
            createdAt: NOW - 900000, kingOnlyStreak: 0, noProgressStreak: 0,
            positionHistory: [], longRoadAttacker: null, longRoadStreak: 0,
            lastMove: null, moveType: null, lastMovePath: null,
            lastCapturedSquares: null, pendingRemovals: null,
            players: { light: { id: 'A', name: 'Илья' }, dark: { id: 'B', name: 'Татьяна' } },
            presence: p, spectators: null, timeControlSeconds: 0,
            turnStartedAt: NOW - 900000, winner: null, winReason: null,
            result: null, rematchProposal: null, drawProposal: null
        };
    }
    const bothGone = pres({ lOn: false, lAbs: NOW - 3 * MIN, dOn: false, dAbs: NOW - 2 * MIN });
    const cached = productionCurrentState(bothGone);

    check('G1. КОРЕНЬ ДЕФЕКТА: production currentState не имеет поля status',
        !('status' in cached), 'ключи: ' + Object.keys(cached).length);
    check('G2. и поэтому предикат по кешу всегда ложен, хотя оба ушли 3 минуты назад',
        isRoomAbandonedNow(cached) === false);
    check('G3. а по НАСТОЯЩЕЙ комнате с сервера — истинен', (function () {
        const fresh = Object.assign({ status: 'active' }, cached);
        return isRoomAbandonedNow(fresh) === true;
    })());

    // --- реальный прогон ветки visible ---
    const writes = [];
    let leftToMenu = false;
    const freshRoom = Object.assign({ status: 'active' }, cached);

    global.currentState = cached;
    global.isOnlineGame = true;
    global.isSpectator = false;
    global.roomCode = 'R1';
    global.isFirebaseConnected = true;
    global.connectionGeneration = 1;
    global.listenerGeneration = 1;
    global.noteServerAck = function () {};
    global.firebase = { database: { ServerValue: { TIMESTAMP: 'TS' } } };
    global.showScreen = function () {}; global.loadActiveRooms = function () {};
    global.showInfoModal = function () {}; global.menuScreen = 'MENU';
    global.detachMyPresence = function () { leftToMenu = true; };
    global.stopPresenceHeartbeat = function () {};

    function thenable(v) {
        return { then: function (c) { return thenable(c ? c(v) : v); },
                 catch: function () { return thenable(v); } };
    }
    global.myPresenceRef = {
        update: function (v) { writes.push(v); return thenable(); },
        onDisconnect: function () {
            return { update: function (v) { writes.push({ __onDisconnect: v }); return thenable(); },
                     cancel: function () {} };
        }
    };
    global.database = { ref: function () {
        return { get: function () { return thenable({ val: function () { return freshRoom; } }); } };
    } };
    global.document = { hidden: false, addEventListener: function () {}, removeEventListener: function () {} };

    eval(grab('leaveAbandonedRoomToMenu'));
    eval(grab('revivePresenceAfterReconnect'));
    global.canUseFirebase = function () { return true; };
eval(grab('handleVisibilityChange'));

    handleVisibilityChange();   // возврат на экран

    const wroteOnline = writes.some(function (w) { return w && w.online === true; });
    check('G4. ВОЗВРАТ VISIBLE НЕ ПИШЕТ online:true при брошенной партии',
        wroteOnline === false, 'записано: ' + JSON.stringify(writes));
    check('G5. и не стирает absentSince',
        writes.every(function (w) { return !w || w.absentSince !== null; }));
    check('G6. вместо этого происходит тихий выход в меню', leftToMenu === true);

    // --- контроль: живая партия по-прежнему возвращается в игру ---
    writes.length = 0; leftToMenu = false;
    const aliveRoom = Object.assign({ status: 'active' }, productionCurrentState(
        pres({ lOn: false, lAbs: NOW - 20000, dOn: true })));
    global.database = { ref: function () {
        return { get: function () { return thenable({ val: function () { return aliveRoom; } }); } };
    } };

    handleVisibilityChange();

    check('G7. КОНТРОЛЬ: в живой партии возврат объявляет online:true',
        writes.some(function (w) { return w && w.online === true; }),
        JSON.stringify(writes));
    check('G8. и делает это ПОСЛЕ перевооружения onDisconnect', (function () {
        const arm = writes.findIndex(function (w) { return w && w.__onDisconnect; });
        const on = writes.findIndex(function (w) { return w && w.online === true; });
        return arm !== -1 && on !== -1 && arm < on;
    })());
    check('G9. и в меню при этом никто не выходит', leftToMenu === false);
})();

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

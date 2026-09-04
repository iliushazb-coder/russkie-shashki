// ==========================================================================
// v183 / BUG №1: ПРИВАТНОСТЬ ПРИГЛАШЕНИЯ «ИГРАТЬ С ДРУГОМ»
//
// Комната в состоянии waiting создаётся только «Играть с другом» и войти в
// неё можно только по Telegram-ссылке. Публичный экран «Кто играет?» не
// должен показывать её вообще: раньше он рисовал её всем подряд с кнопкой
// «Играть», и посторонний занимал место приглашённого друга.
//
// Проверяется РЕАЛЬНЫЙ renderLobbyListFromCache: функция вызывается на
// подготовленном кеше комнат, а результат разбирается как HTML.
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

// --- минимальный разбор HTML: теги и атрибуты ---
function parseHtml(html) {
    const nodes = [];
    const tagRe = /<\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*\/?>/g;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const attrs = {};
        const attrRe = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;
        let a;
        while ((a = attrRe.exec(m[2])) !== null) {
            if (!a[1]) continue;
            attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
        }
        nodes.push({ tag: m[1].toLowerCase(), attrs: attrs, cls: attrs['class'] || '' });
    }
    return nodes;
}

// --- окружение для настоящего рендера ---
let renderedHtml = '';
function stubEl() {
    return {
        set innerHTML(v) { renderedHtml = v; },
        get innerHTML() { return renderedHtml; },
        querySelectorAll: function () { return { forEach: function () {} }; },
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; } }
    };
}
const listEl = stubEl();
global.document = { getElementById: function (id) { return id === 'group-rooms-list' ? listEl : null; } };
global.myTelegramId = 'ME';
global.t = function (k) { return k; };
global.RECONNECT_GRACE_MS = 60000;
global.getEstimatedServerNow = function () { return Date.now(); };
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
global.serverTimeOffsetReady = (typeof serverTimeOffsetReady !== 'undefined') ? serverTimeOffsetReady : true;
global.cachedServerTimeOffsetMs = global.cachedServerTimeOffsetMs || 0;
global.getEstimatedServerNow = global.getEstimatedServerNow || function () { return Date.now() + cachedServerTimeOffsetMs; };
global.RECONNECT_GRACE_MS = global.RECONNECT_GRACE_MS || 60000;
global.isFirebaseConnected = (typeof isFirebaseConnected !== 'undefined') ? isFirebaseConnected : true;
eval(grab('isRoomAbandonedNow'));
eval(grab('renderLobbyListFromCache'));

const NOW = Date.now();
function waitingRoom(creatorId) {
    return {
        status: 'waiting',
        players: { light: { id: creatorId, name: 'Создатель' }, dark: null },
        presence: { light: { online: true, lastSeen: NOW } }
    };
}
function activeRoom() {
    return {
        status: 'active',
        players: { light: { id: 'A', name: 'Илья' }, dark: { id: 'B', name: 'Татьяна' } },
        presence: { light: { online: true, lastSeen: NOW }, dark: { online: true, lastSeen: NOW } }
    };
}
function render(rooms) {
    renderedHtml = '';
    global.lobbyRoomsByCode = rooms;
    renderLobbyListFromCache();
    return parseHtml(renderedHtml);
}
// Пустой список рисует заглушку «пока никто не играет» — это не комната.
function roomCards(nodes) {
    return nodes.filter(function (n) { return n.cls.indexOf('group-room-card') !== -1; });
}
function buttons(nodes, cls) {
    return nodes.filter(function (n) { return n.tag === 'button' && n.cls.indexOf(cls) !== -1; });
}

console.log('=== 1. ПРИВАТНОЕ ПРИГЛАШЕНИЕ НЕ ВИДНО ПОСТОРОННЕМУ ===');

let nodes = render({ INV1: waitingRoom('FRIEND_HOST') });
check('1.1 чужая waiting-комната НЕ показывается вообще',
    roomCards(nodes).length === 0 && /lobby_empty/.test(renderedHtml),
    'карточек: ' + roomCards(nodes).length + ' :: ' + renderedHtml.trim().slice(0, 120));
check('1.2 кнопки «Играть» в разметке нет', buttons(nodes, 'group-join-btn').length === 0);
check('1.3 имя создателя не раскрыто', renderedHtml.indexOf('Создатель') === -1);

nodes = render({ INV1: waitingRoom('ME') });
check('1.4 собственная waiting-комната тоже не в публичном списке',
    roomCards(nodes).length === 0, 'карточек: ' + roomCards(nodes).length);

console.log('\n=== 2. ИДУЩАЯ ПАРТИЯ ПО-ПРЕЖНЕМУ ПУБЛИЧНА ===');

nodes = render({ ACT1: activeRoom() });
check('2.1 active-партия показывается', roomCards(nodes).length === 1);
check('2.2 постороннему доступна кнопка «Смотреть»',
    buttons(nodes, 'group-watch-btn').length === 1);
check('2.3 имена обоих игроков видны',
    renderedHtml.indexOf('Илья') !== -1 && renderedHtml.indexOf('Татьяна') !== -1);

global.myTelegramId = 'A';
nodes = render({ ACT1: activeRoom() });
check('2.4 участнику доступна кнопка «Продолжить»',
    buttons(nodes, 'group-resume-btn').length === 1);
check('2.5 и «Смотреть» ему при этом не предлагается',
    buttons(nodes, 'group-watch-btn').length === 0);
global.myTelegramId = 'ME';

console.log('\n=== 3. СМЕШАННЫЙ СПИСОК ===');

nodes = render({ INV1: waitingRoom('X'), INV2: waitingRoom('Y'), ACT1: activeRoom() });
check('3.1 из трёх комнат показана только одна active',
    buttons(nodes, 'group-watch-btn').length === 1 &&
    buttons(nodes, 'group-join-btn').length === 0);

nodes = render({ FIN: { status: 'finished', winner: 'light',
    players: { light: { id: 'A', name: 'A' }, dark: { id: 'B', name: 'B' } },
    presence: { light: { online: true, lastSeen: NOW }, dark: { online: true, lastSeen: NOW } } } });
check('3.2 завершённая партия по-прежнему не показывается',
    roomCards(nodes).length === 0);

console.log('\n=== 4. ВХОД ПО ССЫЛКЕ НЕ СЛОМАН ===');

check('4.1 createRoomAndShowWaiting на месте', /function createRoomAndShowWaiting/.test(SRC));
check('4.2 экран ожидания создателя сохранён', /showScreen\(waitingScreen\)/.test(SRC));
check('4.3 checkForInviteLink читает комнату САМ, минуя лобби',
    /function checkForInviteLink[\s\S]{0,1400}database\.ref\("rooms\/" \+ roomCode\)\.once\("value"\)/.test(SRC));
check('4.4 deep-link не зависит от joinGroupRoom',
    grab('checkForInviteLink').indexOf('joinGroupRoom') === -1);
check('4.5 joinGroupRoom НЕ удалён из кода', /function joinGroupRoom\(code\) \{/.test(SRC));
check('4.6 переход waiting -> active по-прежнему устанавливается при join',
    grab('joinGroupRoom').indexOf('claimDarkSeatAndActivate') !== -1 &&
    /status:\s*"active"/.test(grab('claimDarkSeatAndActivate')));

console.log('\n=== 5. НИЧЕГО ЛИШНЕГО НЕ ЗАТРОНУТО ===');

check('5.1 экранирование ключа комнаты из v182 сохранено',
    /const codeAttr = escapeHtml\(code\);/.test(grab('renderLobbyListFromCache')));
check('5.2 имена игроков по-прежнему экранируются',
    /lightName = escapeHtml\(lightName\);/.test(grab('renderLobbyListFromCache')) &&
    /darkName = escapeHtml\(darkName\);/.test(grab('renderLobbyListFromCache')));
// v184: ОЖИДАНИЕ ИЗМЕНЕНО ОСОЗНАННО. Проверка писалась в v183, чтобы
// доказать, что из отвергнутых кандидатов не перенесено ничего.
// isRoomAbandonedNow добавлен намеренно — это и есть правка both-offline.
check('5.3 из отвергнутых архитектур не перенесено ничего',
    SRC.indexOf('presenceSessions') === -1 &&
    SRC.indexOf('disconnectedAt') === -1 &&
    SRC.indexOf('presenceV2') === -1 &&
    SRC.indexOf('roomsV2') === -1);
check('5.3b добавлен ровно один новый предикат both-offline',
    (SRC.match(/function isRoomAbandonedNow/g) || []).length === 1);
check('5.4 cache-bust обоих ресурсов не отстаёт', (function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const js = /script\.js\?v=(\d+)/.exec(html);
    const css = /style\.css\?v=(\d+)/.exec(html);
    return !!js && Number(js[1]) >= 183 && !!css && Number(css[1]) >= 12;
})());
check('5.4b если style.css изменён, его версия обязана быть выше 12', (function () {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const css = /style\.css\?v=(\d+)/.exec(html);
    const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
    const changed = cssSrc.indexOf('--cell-size') !== -1;
    return !changed || (!!css && Number(css[1]) > 12);
})());

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

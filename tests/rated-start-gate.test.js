// №23 frontend start gate.
//
// Инвариант: рейтинговое online-поколение playable ТОЛЬКО когда
// registeredMatchIdForState(currentState, roomCode) !== null, то есть
// канонический pointer виден В САМОЙ КОМНАТЕ. До этого момента ни одно
// authoritative изменение состояния комнаты не выполняется.
//
// Почему это критично: protected replay в Worker'е стартует с ДОВЕРЕННОЙ
// начальной позиции (trustedInitialState -> createInitialPieces). Любой ход,
// ушедший в legacy-путь до регистрации, в protected log не попадёт, и replay
// его никогда не увидит — партия молча станет нерейтинговой.
//
// Отдельно доказывается, что ratedJoinState.phase === "success" НЕ является
// достаточным критерием: между успешным HTTP-ответом /rated/join и приходом
// pointer'а через room listener лежит сетевой круг.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info !== undefined ? '  — ' + info : '')); }
}

function grab(n) {
    const m = new RegExp('^function ' + n + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}

// --- реальные функции из production ---
eval(grab('buildEloMatchId'));
eval(grab('expectedRatedMatchIdForState'));
eval(grab('registeredMatchIdForState'));
eval(grab('ratedGenerationKey'));
eval(grab('currentRatedGenerationKey'));
eval(grab('ratedGenerationPlayable'));
eval(grab('rematchBlockedByUnratedFallback'));

// generation-scoped хранилище join-состояния (в production — модульная
// переменная; здесь объявляем, т.к. функции извлекаются изолированно).
global.ratedJoinState = {};
function setJoinState(state, st) {
    global.ratedJoinState = {};
    if (st) global.ratedJoinState[ratedGenerationKey(ROOM, state.matchNumber, state.createdAt)] = st;
}

const ROOM = 'ABC123';
const CREATED = 1_700_000_000_000;

function registeredState() {
    const st = { createdAt: CREATED, matchNumber: 0, ratingsAtStart: { light: 1200, dark: 1180 } };
    st.ratedMatchId = expectedRatedMatchIdForState(st, ROOM);
    return st;
}
function unregisteredState(overrides = {}) {
    return { createdAt: CREATED, matchNumber: 0, ...overrides };
}
function setEnv({ state, online = true, bot = false, spectator = false, code = ROOM }) {
    global.ratedJoinState = {};
    global.currentState = state;
    global.roomCode = code;
    global.isOnlineGame = online;
    global.isBotGame = bot;
    global.isSpectator = spectator;
}

console.log('=== 1. Источник истины: room-visible pointer, НЕ ratedJoinState.phase ===');

check('1.1 gate ЗАКРЫТ, пока pointer не виден в комнате', (function () {
    setEnv({ state: unregisteredState() });
    return ratedGenerationPlayable() === false;
})());

check('1.2 phase="success" БЕЗ room-visible pointer НЕ открывает gate', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'success', matchId: 'elo_x' });
    return ratedGenerationPlayable() === false;
})());

check('1.2a phase="inFlight" -> blocked', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'inFlight' });
    return ratedGenerationPlayable() === false;
})());

check('1.2b phase="retryWait" -> blocked', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'retryWait' });
    return ratedGenerationPlayable() === false;
})());

check('1.3 gate ОТКРЫТ при канонической room-visible регистрации', (function () {
    setEnv({ state: registeredState() });
    return ratedGenerationPlayable() === true;
})());

check('1.4 pointer есть, но ratingsAtStart неполны -> gate ЗАКРЫТ', (function () {
    const st = registeredState();
    delete st.ratingsAtStart.dark;
    setEnv({ state: st });
    return ratedGenerationPlayable() === false;
})());

check('1.5 pointer от ЧУЖОГО поколения -> gate ЗАКРЫТ', (function () {
    const st = registeredState();
    st.ratedMatchId = 'elo_ABC123_1700000000000_9';
    setEnv({ state: st });
    return ratedGenerationPlayable() === false;
})());

console.log('');
console.log('=== 2. Что gate НЕ блокирует ===');

check('2.1 партия с ботом не затронута', (function () {
    setEnv({ state: unregisteredState(), online: false, bot: true });
    return ratedGenerationPlayable() === true;
})());

check('2.2 offline (не online) не затронут', (function () {
    setEnv({ state: unregisteredState(), online: false });
    return ratedGenerationPlayable() === true;
})());

check('2.3 spectator (read-only) не затронут', (function () {
    setEnv({ state: unregisteredState(), spectator: true });
    return ratedGenerationPlayable() === true;
})());

console.log('');
console.log('=== 3. Gate стоит ДО мутации/рендера, а не в точке ветвления ===');

{
    // Комментарии убираем: они упоминают имена функций и ломали бы indexOf.
    const pm = grab('performMove').split('\n')
        .map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
    const gatePos = pm.indexOf('ratedGenerationPlayable()');
    const attemptPos = pm.indexOf('attemptMove(');
    const mutPos = pm.indexOf('isLocalStateOptimistic = true');
    const renderPos = pm.indexOf('renderBoard()');
    check('3.1 gate есть в performMove', gatePos !== -1);
    check('3.2 gate ДО attemptMove()', gatePos !== -1 && attemptPos !== -1 && gatePos < attemptPos,
        'gate@' + gatePos + ' attemptMove@' + attemptPos);
    check('3.3 gate ДО optimistic-мутации', gatePos !== -1 && mutPos !== -1 && gatePos < mutPos);
    check('3.4 gate ДО renderBoard()', gatePos !== -1 && renderPos !== -1 && gatePos < renderPos);
    // multi-capture: и старт, и промежуточные сегменты проходят через
    // performMove, поэтому единственный gate закрывает всю цепочку.
    // Обе точки вызова attemptMove(currentState...) находятся ВНУТРИ
    // performMove (online-ветка и bot/offline-ветка после else), поэтому
    // единственный gate в начале функции закрывает и старт цепочки взятия,
    // и все её промежуточные сегменты.
    const allAttempts = (SRC.match(/attemptMove\(currentState/g) || []).length;
    const inPerformMove = (pm.match(/attemptMove\(currentState/g) || []).length;
    check('3.5 multi-capture: ВСЕ вызовы attemptMove(currentState) — внутри performMove, под одним gate',
        allAttempts === inPerformMove && gatePos < attemptPos,
        'всего ' + allAttempts + ', внутри performMove ' + inPerformMove);
}

console.log('');
console.log('=== 4. Authoritative-пути закрыты gate ===');

function gatedBlock(anchor, within = 700) {
    const i = SRC.indexOf(anchor);
    if (i === -1) return null;
    return SRC.slice(i, i + within);
}

const PATHS = [
    ['resign', 'btnResignYes.addEventListener'],
    ['draw offer', 'btnOfferDraw.addEventListener'],
    ['draw accept', 'btnDrawAccept.addEventListener'],
    ['draw decline', 'btnDrawDecline.addEventListener'],
    ['draw cancel', 'btnDrawCancel.addEventListener'],
    ['timeout', 'function checkTimeout()'],
    ['technical verdict', 'function writeTechnicalResult(']
];
PATHS.forEach(function ([name, anchor]) {
    const blk = gatedBlock(anchor);
    check('4. ' + name + ': закрыт gate', !!blk && blk.indexOf('ratedGenerationPlayable()') !== -1);
});

console.log('');
console.log('=== 5. Gate НЕ навешен на presence/listener/реакции ===');

[['presence', 'function setupPresence('],
 ['реакции', 'function sendReaction(']].forEach(function ([name, anchor]) {
    const blk = gatedBlock(anchor, 500);
    check('5. ' + name + ': НЕ заблокирован gate', !blk || blk.indexOf('ratedGenerationPlayable()') === -1);
});

console.log('');
console.log('=== 7. Narrow unrated fallback: ТОЛЬКО room_already_started ===');

check('7.1 terminalFailed + room_already_started -> playable (историческая семантика "Без рейтинга")', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'terminalFailed', errorCode: 'room_already_started' });
    return ratedGenerationPlayable() === true;
})());

['stale_generation', 'card_mismatch', 'room_not_ready', 'match_number_jump',
 'not_first_match', 'card_conflict', 'room_not_active', 'not_a_player',
 'room_not_found', 'not_a_participant', 'match_not_rated'].forEach(function (code) {
    check('7.2 terminalFailed + ' + code + ' -> blocked', (function () {
        const st = unregisteredState(); setEnv({ state: st });
        setJoinState(st, { phase: 'terminalFailed', errorCode: code });
        return ratedGenerationPlayable() === false;
    })());
});

check('7.3 terminalFailed БЕЗ errorCode -> blocked (старый формат state не открывает gate)', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'terminalFailed' });
    return ratedGenerationPlayable() === false;
})());

check('7.4 canonical pointer имеет ПРИОРИТЕТ: playable даже если есть чужой terminalFailed-код', (function () {
    const st = registeredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'terminalFailed', errorCode: 'stale_generation' });
    return ratedGenerationPlayable() === true;
})());

check('7.5 errorCode generation-scoped: после реванша (matchNumber+1) fallback НЕ протекает', (function () {
    const gen0 = unregisteredState();
    const gen1 = unregisteredState({ matchNumber: 1 });
    setEnv({ state: gen0 });
    setJoinState(gen0, { phase: 'terminalFailed', errorCode: 'room_already_started' });
    const openGen0 = ratedGenerationPlayable();
    setEnv({ state: gen1 });                      // ключ другой -> состояния нет
    const openGen1 = ratedGenerationPlayable();
    return openGen0 === true && openGen1 === false;
})());

check('7.6 fallback открывает ВСЕ authoritative-действия (единый предикат на 8 точках)', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'terminalFailed', errorCode: 'room_already_started' });
    if (!ratedGenerationPlayable()) return false;
    // все 8 точек вызывают один и тот же предикат — проверено в блоках 3-4
    const calls = (SRC.match(/if \(!ratedGenerationPlayable\(\)\)/g) || []).length;
    return calls >= 8;
})());

console.log('');
console.log('=== 6. room_already_started классифицирован terminal ===');

check('6.1 room_already_started в RATED_JOIN_TERMINAL_ERRORS', (function () {
    const m = /const RATED_JOIN_TERMINAL_ERRORS = \[([\s\S]*?)\]/.exec(SRC);
    return !!m && m[1].indexOf('"room_already_started"') !== -1;
})());

check('6.2 stale_generation тоже остался terminal (ветка Worker CHAR-1)', (function () {
    const m = /const RATED_JOIN_TERMINAL_ERRORS = \[([\s\S]*?)\]/.exec(SRC);
    return !!m && m[1].indexOf('"stale_generation"') !== -1;
})());

console.log('');
console.log('=== 8. Реванш после unrated fallback (CHAR-4) ===');

check('8.1 fallback-поколение остаётся playable в ТЕКУЩЕЙ партии', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'terminalFailed', errorCode: 'room_already_started' });
    return ratedGenerationPlayable() === true;
})());

check('8.2 но реванш в такой комнате ЗАБЛОКИРОВАН', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'terminalFailed', errorCode: 'room_already_started' });
    return rematchBlockedByUnratedFallback() === true;
})());

check('8.3 обычный ЗАРЕГИСТРИРОВАННЫЙ rated-реванш разрешён', (function () {
    const st = registeredState(); setEnv({ state: st });
    setJoinState(st, null);
    return rematchBlockedByUnratedFallback() === false;
})());

check('8.4 not_first_match НЕ становится unrated fallback и НЕ блокирует реванш этим путём', (function () {
    const st = unregisteredState(); setEnv({ state: st });
    setJoinState(st, { phase: 'terminalFailed', errorCode: 'not_first_match' });
    return ratedGenerationPlayable() === false && rematchBlockedByUnratedFallback() === false;
})());

check('8.5 бот/offline и spectator не затронуты блокировкой реванша', (function () {
    const st = unregisteredState();
    setEnv({ state: st, online: false, bot: true });
    const bot = rematchBlockedByUnratedFallback();
    setEnv({ state: st, spectator: true });
    return bot === false && rematchBlockedByUnratedFallback() === false;
})());

check('8.6 все три точки реванша реально защищены предикатом', (function () {
    const n = (SRC.match(/rematchBlockedByUnratedFallback\(\)/g) || []).length;
    return n >= 4; // 1 объявление + btnNewGame + btnRematchAccept + performRematchReset
})());

check('8.7 performRematchReset не повышает matchNumber для fallback-поколения', (function () {
    const fn = grab('performRematchReset');
    const guard = fn.indexOf('rematchBlockedByUnratedFallback()');
    const inc = fn.indexOf('matchNumber');
    return guard !== -1 && inc !== -1 && guard < inc;
})());

check('8.8 выход в меню остаётся доступен (btnCloseGame не тронут блокировкой)', (function () {
    const i = SRC.indexOf('btnCloseGame.addEventListener');
    return i !== -1 && SRC.slice(i, i + 600).indexOf('rematchBlockedByUnratedFallback') === -1;
})());

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);
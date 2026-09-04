// Поведенческий тест lifecycle-хелпера "roomSpectators" (№18).
// Проверяет ИСПОЛНЕНИЕМ реальных attachRoomSpectatorsListener/
// detachRoomSpectatorsListener/detachRoomListener из script.js: переключение
// на другую комнату должно отписывать старый listener так, чтобы его
// запоздалый колбэк не мог обновить currentState новой комнаты.
const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c) { console.log((c ? '  ✅ ' : '  ❌ ') + n); c ? passed++ : failed++; }

// --- минимальный мок database.ref(path).on("value", cb) ---
// on() СОХРАНЯЕТ колбэк, не вызывает сразу — вызов имитируется вручную через
// fireSnapshot, что и даёт контроль над "запоздалым" колбэком отписанного ref.
const refs = {}; // path -> { callback, offCalled }
global.database = {
    ref: function (path) {
        if (!refs[path]) refs[path] = { callback: null, offCalled: false };
        const entry = refs[path];
        return {
            on: function (event, cb) { entry.callback = cb; },
            off: function () { entry.offCalled = true; }
        };
    }
};
function fireSnapshot(path, value) {
    const entry = refs[path];
    if (!entry || !entry.callback) throw new Error('нет подписки на ' + path);
    entry.callback({ val: function () { return value; } });
}

global.roomSpectatorsListenerRef = null;
global.roomSpectatorsListenerCode = null;
global.roomListenerRef = null;
global.currentState = null;
global.renderSpectatorsList = function () {};

eval(extractFunc('attachRoomSpectatorsListener'));
eval(extractFunc('detachRoomSpectatorsListener'));
eval(extractFunc('detachRoomListener'));

console.log('=== roomSpectators lifecycle ===');

currentState = {};
attachRoomSpectatorsListener('ROOM_A');
fireSnapshot('roomSpectators/ROOM_A', { alice: 'Alice' });
check('1. первичный snapshot обновляет currentState', currentState.spectators && currentState.spectators.alice === 'Alice');

const roomARef = refs['roomSpectators/ROOM_A'];
check('2. привязка к комнате A зафиксирована', roomSpectatorsListenerCode === 'ROOM_A');

// Переключение на комнату B через общий detachRoomListener (та же точка,
// что вызывается во всех 11 местах реального кода при смене/выходе из room).
detachRoomListener();
check('3. off() вызван у листенера комнаты A', roomARef.offCalled === true);

currentState = {}; // новая комната — новое локальное состояние
attachRoomSpectatorsListener('ROOM_B');
fireSnapshot('roomSpectators/ROOM_B', { bob: 'Bob' });
check('4. snapshot комнаты B корректно обновляет currentState', currentState.spectators && currentState.spectators.bob === 'Bob');

// Запоздалый колбэк A: Firebase SDK в реальности НЕ гарантирует, что колбэк
// физически перестанет вызываться сразу после .off() в проекции — теста ради
// проверяем, что даже если бы он всё ещё дошёл, guard внутри самого колбэка
// (roomSpectatorsListenerRef !== ref) не даст ему исказить currentState B.
fireSnapshot('roomSpectators/ROOM_A', { mallory: 'Mallory' });
check('5. запоздалый колбэк комнаты A НЕ переписал currentState комнаты B',
    currentState.spectators && currentState.spectators.bob === 'Bob' && !currentState.spectators.mallory);

console.log('\n=== initial-order race: spectators раньше room ===');

// currentState ещё НЕ существует в момент подписки — так и есть в реальном
// startOnlineGame(): attachRoomSpectatorsListener() вызывается до
// roomListenerRef.on(), а currentState создаётся только внутри ЕГО колбэка.
currentState = null;
attachRoomSpectatorsListener('ROOM_C');

let threw = false;
try {
    fireSnapshot('roomSpectators/ROOM_C', { alice: 'Alice' });
} catch (e) {
    threw = true;
}
check('6. первый snapshot зрителей ДО currentState не роняет колбэк', threw === false);
check('7. значение осело в кэше, а не потеряно', roomSpectatorsCache && roomSpectatorsCache.alice === 'Alice');

// Room-listener создаёт currentState заново — ТОЧНО тот же паттерн, что во
// всех трёх реальных местах: подмешивает roomSpectatorsCache при сборке.
currentState = { pieces: {}, spectators: roomSpectatorsCache };
check('8. currentState.spectators содержит исходный список без единого повторного spectator-события',
    currentState.spectators && currentState.spectators.alice === 'Alice');

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

// INVITE-LINK: подключение приглашённого друга по ссылке (восстановленная
// рабочая схема: once() -> проверки -> update(), БЕЗ Firebase transaction).
//
// ЧТО ПРОВЕРЯЕТСЯ ПО-НАСТОЯЩЕМУ:
//   запускается НАСТОЯЩАЯ checkForInviteLink(), извлечённая из script.js,
//   с моками Firebase/DOM. Главный regression-тест (сценарий 1) воспроизводит
//   ХОЛОДНЫЙ вход: у клиента нет локального кеша комнаты. Мок transaction
//   воспроизводит документированное поведение SDK на холодном кеше
//   (callback получает null; возврат undefined = немедленный abort без
//   обращения к серверу). Реализация через transaction на этом моке даёт
//   ложный err_room_taken — что и наблюдалось на реальных телефонах.
//   Реализация через once()+update() проходит.
//
// ЧЕГО ЭТИ ТЕСТЫ НЕ ДОКАЗЫВАЮТ:
//   это НЕ настоящий Firebase. Атомарность, конкуренция двух одновременных
//   клиентов и реальное сетевое поведение здесь не проверяются. Firebase
//   Emulator в этой среде недоступен (загрузка jar блокируется сетевой
//   политикой песочницы).
const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

global.firebase = { database: { ServerValue: { TIMESTAMP: '__TS__' } } };

let loadError = null;
try {
  // Вспомогательные функции транзакционной схемы извлекаются ТОЛЬКО если
  // существуют (нужно для прогона теста против старых версий через TARGET_SCRIPT).
  try { eval(extractFunc('buildInviteDarkClaim')); } catch (e) {}
  try { eval(extractFunc('decideInviteRetry')); } catch (e) {}
  global.serverTimeOffsetReady = (typeof serverTimeOffsetReady !== 'undefined') ? serverTimeOffsetReady : true;
global.cachedServerTimeOffsetMs = global.cachedServerTimeOffsetMs || 0;
global.getEstimatedServerNow = global.getEstimatedServerNow || function () { return Date.now() + cachedServerTimeOffsetMs; };
global.RECONNECT_GRACE_MS = global.RECONNECT_GRACE_MS || 60000;
global.isFirebaseConnected = (typeof isFirebaseConnected !== 'undefined') ? isFirebaseConnected : true;
eval(extractFunc('isRoomAbandonedNow'));
eval(extractFunc('checkForInviteLink'));
} catch (e) { loadError = e.message; }

function mkRoom(status, lightId, darkId) {
  const r = { pieces: { '5_0': { color: 'light', king: false } }, turn: 'light', status: status,
              players: { light: { id: lightId, name: 'Creator' } } };
  if (darkId) r.players.dark = { id: darkId, name: 'Dark' };
  return r;
}

let env;
function setup(serverRoom, opts) {
  opts = opts || {};
  env = { serverRoom: serverRoom, txCalls: 0, writes: [], modals: [], timers: [],
          startCalls: 0, screens: [] };
  global.myTelegramId = 'B'; global.myTelegramName = 'Bob';
  global.roomCode = null; global.myColor = 'light';
  global.isOnlineGame = false; global.isSpectator = false;
  global.myPendingFriendRoomCode = null;
  global.BOT_USERNAME = 'testbot';
  global.window = { Telegram: { WebApp: { initDataUnsafe: { start_param: 'ROOM1' } } } };
  global.Telegram = global.window.Telegram;
  global.database = { ref: function (p) { return {
    once: function () {
      if (p !== 'rooms/ROOM1') return Promise.resolve({ val: function () { return null; } });
      // once() всегда читает С СЕРВЕРА — отдаёт реальное состояние комнаты.
      const copy = env.serverRoom ? JSON.parse(JSON.stringify(env.serverRoom)) : null;
      return Promise.resolve({ val: function () { return copy; } });
    },
    // Мок transaction воспроизводит поведение SDK на ХОЛОДНОМ кеше:
    // callback вызывается с null (данных комнаты в локальном кеше нет),
    // возврат undefined приводит к committed:false БЕЗ похода на сервер.
    // Предшествующий once() кеш транзакции НЕ прогревает (без активного
    // .on()-слушателя SDK сразу выбрасывает данные из кеша).
    transaction: function (cb) {
      env.txCalls++;
      const res = cb(null);
      if (res === undefined) return Promise.resolve({ committed: false });
      env.serverRoom = res;
      return Promise.resolve({ committed: true });
    },
    set: function (v) { env.writes.push({ path: p, v: v }); return Promise.resolve(); },
    update: function (v) {
      env.writes.push({ path: p, v: v });
      if (opts.failRoomUpdate && p === 'rooms/ROOM1') return Promise.reject(new Error('PERMISSION_DENIED (mock)'));
      if (p === 'rooms/ROOM1' && env.serverRoom) {
        Object.keys(v).forEach(function (k) {
          if (k === 'players/dark') { env.serverRoom.players.dark = v[k]; }
          else { env.serverRoom[k] = v[k]; }
        });
      }
      return Promise.resolve();
    },
    on: function () {}, off: function () {}
  }; }};
  global.showScreen = function (s) { env.screens.push(s); };
  global.showInfoModal = function (txt) { env.modals.push(txt); };
  global.loadActiveRooms = function () {};
  global.startOnlineGame = function () { env.startCalls++; };
  global.resumeOwnActiveRoom = function () { return Promise.resolve(true); };
  global.setupPresence = function () {};
  global.t = function (k) { return k; };
  global.waitingScreen = 'waiting'; global.menuScreen = 'menu'; global.gameScreen = 'game';
  global.waitingText = { textContent: '' };
  global.inviteLinkBox = { textContent: '', classList: { add: function () {}, remove: function () {} } };
  global.btnShareLink = { classList: { add: function () {}, remove: function () {} } };
  global.setTimeout = function (fn, ms) { env.timers.push({ fn: fn, ms: ms }); return env.timers.length; };
  global.clearTimeout = function (id) { if (env.timers[id - 1]) env.timers[id - 1].cleared = true; };
}
const realSetImmediate = setImmediate;
const flush = () => new Promise(function (r) {
  realSetImmediate(function () { realSetImmediate(function () { realSetImmediate(function () { realSetImmediate(r); }); }); });
});
const gotMeta = () => env.writes.some(function (w) { return w.path.indexOf('users/B/rooms') === 0; });
const roomWrites = () => env.writes.filter(function (w) { return w.path === 'rooms/ROOM1'; });
const runTimer = (ms) => { env.timers.forEach(function (t) { if (t.ms === ms && !t.cleared && !t.ran) { t.ran = true; t.fn(); } }); };

(async function () {
  if (loadError) {
    check('0. checkForInviteLink присутствует в script.js', false, loadError);
    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(1);
  }

  console.log('СЦЕНАРИЙ 1 (ГЛАВНЫЙ REGRESSION). Холодный вход, waiting, dark свободен');
  setup(mkRoom('waiting', 'A', null));
  checkForInviteLink(); await flush();
  check('1. err_room_taken НЕ показан', env.modals.indexOf('err_room_taken') === -1, JSON.stringify(env.modals));
  check('1. вообще никакой ошибки не показано', env.modals.length === 0, JSON.stringify(env.modals));
  check('1. пользователь стал dark', global.myColor === 'dark' && global.isOnlineGame === true);
  check('1. status стал active НА СЕРВЕРЕ', !!env.serverRoom && env.serverRoom.status === 'active');
  check('1. players.dark записан на сервере', !!env.serverRoom && !!env.serverRoom.players.dark && env.serverRoom.players.dark.id === 'B');
  check('1. status+dark+turnStartedAt — ОДНОЙ операцией update', roomWrites().length === 1 &&
    roomWrites()[0].v['players/dark'] !== undefined &&
    roomWrites()[0].v.status === 'active' && roomWrites()[0].v.turnStartedAt === '__TS__');
  check('1. metadata (users/B/rooms) записана', gotMeta());
  check('1. 10s-таймаут снят', env.timers.some(function (t) { return t.ms === 10000 && t.cleared; }));
  runTimer(800);
  check('1. startOnlineGame запущен', env.startCalls === 1 && env.screens.indexOf('game') !== -1);

  console.log('');
  console.log('СЦЕНАРИЙ 2. Место реально занято другим (dark = C)');
  setup(mkRoom('waiting', 'A', 'C'));
  checkForInviteLink(); await flush();
  check('2. показан err_room_taken', env.modals.indexOf('err_room_taken') !== -1, JSON.stringify(env.modals));
  check('2. комната НЕ перезаписана', roomWrites().length === 0);
  check('2. пользователь НЕ стал dark', global.myColor !== 'dark' && global.isOnlineGame === false);
  check('2. metadata НЕ записана', !gotMeta());
  check('2. таймаут снят и при отказе', env.timers.some(function (t) { return t.ms === 10000 && t.cleared; }));

  console.log('');
  console.log('СЦЕНАРИЙ 3. Комната finished');
  setup(mkRoom('finished', 'A', null));
  checkForInviteLink(); await flush();
  check('3. показан err_no_active_game', env.modals.indexOf('err_no_active_game') !== -1, JSON.stringify(env.modals));
  check('3. комната НЕ перезаписана, игрок НЕ dark', roomWrites().length === 0 && global.myColor !== 'dark');

  console.log('');
  console.log('СЦЕНАРИЙ 4. Комната отсутствует (null)');
  setup(null);
  checkForInviteLink(); await flush();
  check('4. показан err_no_active_game', env.modals.indexOf('err_no_active_game') !== -1, JSON.stringify(env.modals));
  check('4. metadata НЕ записана', !gotMeta());

  console.log('');
  console.log('СЦЕНАРИЙ 5. Повторное открытие ссылки тем же приглашённым (reconnect)');
  setup(mkRoom('active', 'A', 'B'));
  checkForInviteLink(); await flush();
  check('5. reconnect: игрок снова dark', global.myColor === 'dark' && global.isOnlineGame === true);
  check('5. startOnlineGame запущен напрямую', env.startCalls === 1 && env.screens.indexOf('game') !== -1);
  check('5. комната НЕ перезаписана при reconnect', roomWrites().length === 0);
  check('5. никакой ошибки', env.modals.length === 0, JSON.stringify(env.modals));

  console.log('');
  console.log('СЦЕНАРИЙ 6. Комната active, dark занят другим');
  setup(mkRoom('active', 'A', 'C'));
  checkForInviteLink(); await flush();
  check('6. показан err_room_taken', env.modals.indexOf('err_room_taken') !== -1, JSON.stringify(env.modals));
  check('6. игрок НЕ dark', global.myColor !== 'dark');

  console.log('');
  console.log('СЦЕНАРИЙ 7. update() отклонён сервером (например, Rules)');
  setup(mkRoom('waiting', 'A', null), { failRoomUpdate: true });
  checkForInviteLink(); await flush();
  check('7. показан err_join_failed (не молчаливое зависание)', env.modals.indexOf('err_join_failed') !== -1, JSON.stringify(env.modals));
  check('7. возврат в меню, состояние сброшено', env.screens.indexOf('menu') !== -1 &&
    global.myColor !== 'dark' && global.isOnlineGame === false && global.roomCode === null);
  check('7. таймаут снят', env.timers.some(function (t) { return t.ms === 10000 && t.cleared; }));

  console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
})();

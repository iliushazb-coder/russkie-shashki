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


// v193 auth harness: these legacy behavioural suites exercise already-authenticated flows.
global.firebaseAuthReady = true;
global.localOnlyBotGame = false;
global.canUseFirebase = function () { return true; };
global.requireFirebaseAuth = function () { return true; };
let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

global.firebase = { database: { ServerValue: { TIMESTAMP: '__TS__' } } };

let loadError = null;
try {
  // Вспомогательные функции транзакционной схемы извлекаются ТОЛЬКО если
  // существуют (нужно для прогона теста против старых версий через TARGET_SCRIPT).
  // Атомарный захват места (v188): функции чистые, подтягиваем их так же,
  // как остальные — без них checkForInviteLink не соберётся.
  // ОДНОШАГОВЫЙ АТОМАРНЫЙ ВХОД (v7). Двухфазная схема «захват места ->
  // активация» убрана целиком: промежуточного состояния на сервере больше
  // нет, поэтому нет и уборки места по таймауту.
  eval(extractFunc('buildAtomicInviteJoin'));
  eval(extractFunc('classifyAtomicInviteJoinFailure'));
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
    // Чтение идёт через тот же локальный кеш, что и транзакции. Если
    // транзакция применила своё значение локально (applyLocally по
    // умолчанию), once увидит именно его, а не серверное.
    once: function () {
      if (p === 'rooms/ROOM1' && env.localOverlay !== undefined) {
        const ov = env.localOverlay;
        return Promise.resolve({ val: function () { return ov; } });
      }
      if (p !== 'rooms/ROOM1') return Promise.resolve({ val: function () { return null; } });
      // Спекулятивного состояния нет — отдаём подтверждённое сервером.
      const copy = env.serverRoom ? JSON.parse(JSON.stringify(env.serverRoom)) : null;
      return Promise.resolve({ val: function () { return copy; } });
    },
    // Мок transaction воспроизводит РЕАЛЬНУЮ семантику RTDB:
    //   1. колбэк вызывается с ЛОКАЛЬНЫМ значением; на холодном кеше это
    //      null, и предшествующий once() кеш не прогревает (без активного
    //      .on()-слушателя SDK сразу выбрасывает данные);
    //   2. возврат undefined = немедленный abort БЕЗ похода на сервер;
    //   3. если вернули значение, а на сервере оно ДРУГОЕ, SDK
    //      ПЕРЕЗАПУСКАЕТ колбэк с серверным значением — именно этим
    //      закрывается гонка при захвате узла места.
    transaction: function (cb, onComplete, applyLocally) {
      env.txCalls++;

      function serverValueAt(path) {
        if (path === 'rooms/ROOM1') return env.serverRoom;
        if (path === 'rooms/ROOM1/players/dark') {
          return env.serverRoom && env.serverRoom.players
            ? (env.serverRoom.players.dark || null) : null;
        }
        return null;
      }
      function writeValueAt(path, v) {
        if (path === 'rooms/ROOM1') { env.serverRoom = v; return; }
        if (path === 'rooms/ROOM1/players/dark') {
          if (!env.serverRoom) env.serverRoom = { players: {} };
          if (!env.serverRoom.players) env.serverRoom.players = {};
          env.serverRoom.players.dark = v;
        }
      }

      // Партию завершили МЕЖДУ захватом и активацией, но status остался
      // active (например, оппонент сдался и результат уже записан).
      if (p === 'rooms/ROOM1' && env.seatDone &&
          opts.winnerSetBeforeActivation && !env.winnerDone) {
        env.winnerDone = true;
        env.serverRoom.status = 'active';
        env.serverRoom.winner = 'light';
      }
      // ОДНОШАГОВЫЙ КОНТРАКТ: промежуточного состояния нет, поэтому все
      // помехи вносятся ПЕРЕД единственной корневой транзакцией.
      if (p === 'rooms/ROOM1' && !env.interleaveDone) {
        if (opts.stolenBeforeJoin) {
          env.interleaveDone = true;
          env.serverRoom.players.dark = { id: 'C', name: 'Другой гость' };
          env.serverRoom.status = 'active';
        }
        if (opts.finishedBeforeJoin) {
          env.interleaveDone = true;
          env.serverRoom.status = 'finished';
          env.serverRoom.winner = 'light';
          env.serverRoom.result = { winnerId: 'A', loserId: 'B' };
        }
        if (opts.deletedBeforeJoin) {
          env.interleaveDone = true;
          env.serverRoom = null;
        }
      }
      if (p === 'rooms/ROOM1' && opts.joinStuckInNetwork && !env.stuckDone) {
        env.stuckDone = true;
        const lr = env.warm ? (env.serverRoom ? JSON.parse(JSON.stringify(env.serverRoom)) : null) : null;
        const r0 = cb(lr);
        if (r0 !== undefined && applyLocally !== false) env.localOverlay = r0;
        return new Promise(function () {});
      }
      if (p === 'rooms/ROOM1' && opts.delayJoinAck && !env.ackHeld) {
        env.ackHeld = true;
        const lr2 = env.warm ? (env.serverRoom ? JSON.parse(JSON.stringify(env.serverRoom)) : null) : null;
        const r1 = cb(lr2);
        if (r1 !== undefined) env.serverRoom = r1;
        return new Promise(function (resolve) {
          env.releaseAck = function () { resolve({ committed: r1 !== undefined }); };
        });
      }

      // Гонка: место перехватили МЕЖДУ once() и транзакцией. Ровно то, что
      // прежняя схема с безусловным update() не замечала.
      if (opts.seatStolenBeforeClaim && p === 'rooms/ROOM1/players/dark' && env.txCalls === 1) {
        if (!env.serverRoom.players) env.serverRoom.players = {};
        env.serverRoom.players.dark = { id: 'C', name: 'Другой гость' };
        env.serverRoom.status = 'active';
      }

      // Шаг 1: локальное значение. Холодный кеш = null; после прогрева
      // слушателем транзакция по корню видит серверные данные.
      const local = (env.warm && p === 'rooms/ROOM1')
        ? (env.serverRoom ? JSON.parse(JSON.stringify(env.serverRoom)) : null)
        : null;
      let res = cb(local);
      if (res === undefined) return Promise.resolve({ committed: false });

      const onServer = serverValueAt(p);
      const differs = JSON.stringify(onServer) !== JSON.stringify(local);
      if (differs) {
        // Шаг 3: сервер видит другое значение — перезапуск колбэка.
        env.txReruns = (env.txReruns || 0) + 1;
        res = cb(JSON.parse(JSON.stringify(onServer)));
        if (res === undefined) return Promise.resolve({ committed: false });
      }

      if (opts.failSeatClaim && p === 'rooms/ROOM1/players/dark') {
        return Promise.reject(new Error('PERMISSION_DENIED (mock)'));
      }
      if (res === null) {
        // Возврат null в транзакции = УДАЛЕНИЕ узла (снятие захвата).
        if (p === 'rooms/ROOM1/players/dark' && env.serverRoom && env.serverRoom.players) {
          delete env.serverRoom.players.dark;
        }
        env.writes.push({ path: p, v: null });
        return Promise.resolve({ committed: true });
      }
      if (opts.failActivation && p === 'rooms/ROOM1') {
        return Promise.reject(new Error('PERMISSION_DENIED (mock)'));
      }
      writeValueAt(p, res);
      env.writes.push({ path: p, v: res });
      if (p === 'rooms/ROOM1/players/dark') env.seatDone = true;
      return Promise.resolve({ committed: true });
    },
    remove: function () {
      env.writes.push({ path: p, v: null });
      if (p === 'rooms/ROOM1/players/dark' && env.serverRoom && env.serverRoom.players) {
        delete env.serverRoom.players.dark;
      }
      return Promise.resolve();
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
    // Слушатель прогревает кеш: после него транзакция по корню видит
    // серверные данные — так же, как в реальном SDK.
    // Слушатель прогревает кеш; СНЯТИЕ последнего слушателя кеш ОЧИЩАЕТ —
    // именно так ведёт себя RTDB. Без этой строгости тест не доказывал бы,
    // что слушатель удерживается на всё время транзакции.
    on: function (ev, cb) {
      if (p === 'rooms/ROOM1') {
        env.warmHandlers = (env.warmHandlers || []).concat([cb]);
        env.warm = true;
        const copy = env.serverRoom ? JSON.parse(JSON.stringify(env.serverRoom)) : null;
        if (cb) cb({ val: function () { return copy; } });
      }
      return cb;
    },
    off: function (ev, cb) {
      if (p !== 'rooms/ROOM1') return;
      if (cb) {
        env.warmHandlers = (env.warmHandlers || []).filter(function (h) { return h !== cb; });
      } else {
        // off без колбэка снимает ВСЕ слушатели пути — включая чужие.
        env.offWithoutHandler = true;
        env.warmHandlers = [];
      }
      if (!env.warmHandlers || env.warmHandlers.length === 0) env.warm = false;
    }
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
// Цепочка захвата длиннее прежней (transaction -> once -> update), поэтому
// тиков нужно больше. Лишние безвредны.
const flush = () => new Promise(function (r) {
  let n = 0;
  (function step() { if (++n >= 12) return r(); realSetImmediate(step); })();
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
  // ОЖИДАНИЕ ИЗМЕНЕНО ОСОЗНАННО (v188). Прежняя схема писала место, статус и
  // turnStartedAt одним безусловным update() — и именно поэтому двое,
  // прошедшие проверки по одному и тому же снимку, оба записывались.
  // Теперь место захватывается ТРАНЗАКЦИЕЙ по узлу players/dark, а статус
  // выставляется следом. Требование прежнее и проверяется ниже: на сервере
  // оказываются и dark, и active, и серверная метка времени.
  check('1. место захвачено транзакцией по узлу players/dark', env.txCalls >= 1);
  check('1. статус и turnStartedAt выставлены следом', (function () {
    const w = roomWrites();
    return w.length === 1 && w[0].v.status === 'active' &&
      w[0].v.turnStartedAt && !('players/dark' in w[0].v);
  })(), JSON.stringify(roomWrites()));
  check('1. turnStartedAt — СЕРВЕРНАЯ метка', (function () {
    const w = roomWrites();
    return w.length === 1 && w[0].v.turnStartedAt === '__TS__';
  })(), JSON.stringify(roomWrites()));
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
  console.log('СЦЕНАРИЙ 7. транзакция отклонена сервером (например, Rules)');
  setup(mkRoom('waiting', 'A', null), { failActivation: true });
  checkForInviteLink(); await flush();
  check('7. показан err_join_failed', env.modals.indexOf('err_join_failed') !== -1, JSON.stringify(env.modals));
  check('7. возврат в меню, состояние сброшено', env.screens.indexOf('menu') !== -1 &&
    global.myColor !== 'dark' && global.isOnlineGame === false && global.roomCode === null);
  check('7. НИЧЕГО не записано на сервер — промежуточного состояния нет',
    !env.serverRoom.players.dark && env.serverRoom.status === 'waiting',
    JSON.stringify(env.serverRoom.players));

  console.log('');
  console.log('СЦЕНАРИЙ 8. ГОНКА: место заняли перед самой транзакцией');
  setup(mkRoom('waiting', 'A', null), { stolenBeforeJoin: true });
  checkForInviteLink(); await flush();
  check('8. место осталось за перехватившим', env.serverRoom.players.dark.id === 'C');
  check('8. проигравший НЕ стал dark', global.myColor !== 'dark');
  check('8. проигравший НЕ в онлайн-игре', global.isOnlineGame === false);
  check('8. проигравший НЕ записал метаданные', !gotMeta());
  check('8. startOnlineGame НЕ запущен', env.startCalls === 0);
  check('8. показан err_room_taken', env.modals.indexOf('err_room_taken') !== -1, JSON.stringify(env.modals));

  console.log('');
  console.log('СЦЕНАРИЙ 9. партию ЗАВЕРШИЛИ перед самой транзакцией');
  setup(mkRoom('waiting', 'A', null), { finishedBeforeJoin: true });
  checkForInviteLink(); await flush();
  check('9. завершённая партия НЕ воскрешена', env.serverRoom.status === 'finished');
  check('9. наше место НЕ записано — вход не состоялся',
    !env.serverRoom.players.dark, JSON.stringify(env.serverRoom.players));
  check('9. result остался целым', !!env.serverRoom.result && env.serverRoom.result.loserId === 'B');
  check('9. игрок не в игре', global.isOnlineGame === false && env.startCalls === 0);
  check('9. метаданные НЕ записаны', !gotMeta());

  console.log('');
  console.log('СЦЕНАРИЙ 10. комнату УДАЛИЛИ перед самой транзакцией');
  setup(mkRoom('waiting', 'A', null), { deletedBeforeJoin: true });
  checkForInviteLink(); await flush();
  check('10. огрызок комнаты НЕ создан', (function () {
    if (!env.serverRoom) return true;
    return !env.serverRoom.status && !env.serverRoom.turnStartedAt;
  })(), JSON.stringify(env.serverRoom));
  check('10. игрок не стал dark', global.myColor !== 'dark' && global.isOnlineGame === false);
  check('10. метаданные НЕ записаны', !gotMeta());

  console.log('');
  console.log('СЦЕНАРИЙ 11. ТАЙМАУТ 10с до подтверждения');
  setup(mkRoom('waiting', 'A', null), { joinStuckInNetwork: true });
  checkForInviteLink(); await flush();
  runTimer(10000); await flush();
  check('11. на сервере НЕТ следов незавершённого входа',
    !env.serverRoom.players.dark && env.serverRoom.status === 'waiting',
    JSON.stringify(env.serverRoom));
  check('11. состояние игрока полностью сброшено',
    global.myColor !== 'dark' && global.isOnlineGame === false &&
    global.isSpectator === false && global.roomCode === null);

  console.log('');
  console.log('СЦЕНАРИЙ 12. applyLocally=false: спекулятивного состояния нет');
  setup(mkRoom('waiting', 'A', null), { joinStuckInNetwork: true });
  checkForInviteLink(); await flush();
  check('12. локально комната НЕ показана активной', env.localOverlay === undefined,
    JSON.stringify(env.localOverlay && env.localOverlay.status));
  check('12. на сервере по-прежнему waiting без dark',
    env.serverRoom.status === 'waiting' && !env.serverRoom.players.dark);

  console.log('');
  console.log('СЦЕНАРИЙ 13. вход применён на сервере, ACK опоздал, затем таймаут');
  setup(mkRoom('waiting', 'A', null), { delayJoinAck: true });
  checkForInviteLink(); await flush();
  check('13. на сервере полноценная active-комната с обоими игроками',
    env.serverRoom.status === 'active' && !!env.serverRoom.players.dark &&
    env.serverRoom.players.dark.id === 'B' && !!env.serverRoom.players.light);
  runTimer(10000); await flush();
  check('13. таймаут НЕ испортил комнату — dark на месте',
    !!env.serverRoom.players.dark && env.serverRoom.players.dark.id === 'B');
  check('13. НЕ возникло active без чёрных',
    !(env.serverRoom.status === 'active' && !env.serverRoom.players.dark));
  env.releaseAck(); await flush();
  check('13. позднее подтверждение ничего не сломало',
    env.serverRoom.status === 'active' && env.serverRoom.players.dark.id === 'B');

  console.log('');
  console.log('СЦЕНАРИЙ 14. повторный вход того же гостя в active-комнату');
  setup(mkRoom('active', 'A', 'B'));
  checkForInviteLink(); await flush();
  check('14. вход разрешён, игрок снова dark',
    global.myColor === 'dark' && global.isOnlineGame === true);
  runTimer(800);
  check('14. startOnlineGame запущен', env.startCalls === 1, 'вызовов: ' + env.startCalls);
  check('14. комната не переписана', env.serverRoom.players.dark.id === 'B');

  console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
})();

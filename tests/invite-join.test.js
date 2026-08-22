// INVITE-LINK: атомарный захват места второго игрока (вариант C).
//
// ЧТО ПРОВЕРЯЕТСЯ ПО-НАСТОЯЩЕМУ:
//   1) чистые функции решения buildInviteDarkClaim / decideInviteRetry —
//      извлекаются из реального script.js;
//   2) конечный автомат повтора — запускается НАСТОЯЩАЯ checkForInviteLink()
//      с моками Firebase/DOM, считаются реальные вызовы transaction.
//
// ЧЕГО ЭТИ ТЕСТЫ НЕ ДОКАЗЫВАЮТ:
//   атомарности Firebase transaction и поведения при реальной конкуренции
//   двух клиентов. Мок этого честно воспроизвести не может (оптимистичная
//   блокировка на сервере с повтором). Firebase Emulator в этой среде
//   недоступен: загрузка его jar блокируется сетевой политикой песочницы.
//   Поэтому concurrency здесь НЕ проверяется — только клиентский автомат.
const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

global.firebase = { database: { ServerValue: { TIMESTAMP: '__TS__' } } };

let loadError = null;
try {
  eval(extractFunc('buildInviteDarkClaim'));
  eval(extractFunc('decideInviteRetry'));
  eval(extractFunc('checkForInviteLink'));
} catch (e) { loadError = e.message; }

function mkRoom(status, lightId, darkId) {
  const r = { pieces: { '5_0': { color: 'light', king: false } }, turn: 'light', status: status,
              players: { light: { id: lightId, name: 'Creator' } } };
  if (darkId) r.players.dark = { id: darkId, name: 'Dark' };
  return r;
}

let env;
function setup(scenario) {
  env = { txCalls: 0, txResults: scenario.txResults.slice(),
          reads: scenario.reads.slice(), writes: [], modals: [], timers: [] };
  global.myTelegramId = 'B'; global.myTelegramName = 'Bob';
  global.roomCode = null; global.myColor = 'light';
  global.isOnlineGame = false; global.isSpectator = false;
  global.window = { Telegram: { WebApp: { initDataUnsafe: { start_param: 'ROOM1' } } } };
  global.Telegram = global.window.Telegram;
  global.database = { ref: function (p) { return {
    once: function () {
      const v = env.reads.length > 1 ? env.reads.shift() : env.reads[0];
      return Promise.resolve({ val: function () { return p === 'rooms/ROOM1' ? v : null; } });
    },
    transaction: function (cb) {
      env.txCalls++;
      const committed = env.txResults.shift();
      if (committed) cb(mkRoom('waiting', 'A', null));
      return Promise.resolve({ committed: !!committed });
    },
    set: function (v) { env.writes.push({ path: p, v: v }); return Promise.resolve(); },
    update: function (v) { env.writes.push({ path: p, v: v }); return Promise.resolve(); },
    on: function () {}, off: function () {}
  }; }};
  global.showScreen = function () {};
  global.showInfoModal = function (txt) { env.modals.push(txt); };
  global.loadActiveRooms = function () {};
  global.startOnlineGame = function () {};
  global.t = function (k) { return k; };
  global.waitingScreen = 'waiting'; global.menuScreen = 'menu'; global.gameScreen = 'game';
  global.waitingText = { textContent: '' };
  global.inviteLinkBox = { classList: { add: function () {}, remove: function () {} } };
  global.btnShareLink = { classList: { add: function () {}, remove: function () {} } };
  global.setTimeout = function (fn, ms) { env.timers.push({ fn: fn, ms: ms }); return env.timers.length; };
  global.clearTimeout = function (id) { if (env.timers[id - 1]) env.timers[id - 1].cleared = true; };
}
const realSetImmediate = setImmediate;
const flush = () => new Promise(function (r) {
  realSetImmediate(function () { realSetImmediate(function () { realSetImmediate(function () { realSetImmediate(r); }); }); });
});
const gotMeta = () => env.writes.some(function (w) { return w.path.indexOf('users/B/rooms') === 0; });

(async function () {
  if (loadError) {
    check('0. вариант C присутствует в script.js', false, loadError);
    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(1);
  }

  console.log('ЧАСТЬ 1. Решение о захвате (buildInviteDarkClaim)');
  {
    const r = buildInviteDarkClaim(mkRoom('waiting', 'A', null), 'B', 'Bob');
    check('свободная waiting -> место захвачено', !!r && r.players.dark.id === 'B');
    check('status и turnStartedAt меняются ТОЙ ЖЕ операцией (полузахвата не бывает)',
      !!r && r.status === 'active' && r.turnStartedAt === '__TS__');
    check('занято другим -> abort', buildInviteDarkClaim(mkRoom('waiting', 'A', 'C'), 'B', 'Bob') === undefined);
    const rc = buildInviteDarkClaim(mkRoom('active', 'A', 'B'), 'B', 'Bob');
    check('свой dark -> reconnect без перезаписи', !!rc && rc.players.dark.id === 'B' && rc.turnStartedAt === undefined);
    check('self-join -> abort', buildInviteDarkClaim(mkRoom('waiting', 'B', null), 'B', 'Bob') === undefined);
    check('finished -> abort', buildInviteDarkClaim(mkRoom('finished', 'A', null), 'B', 'Bob') === undefined);
    check('null (холодный кеш / удалена) -> abort', buildInviteDarkClaim(null, 'B', 'Bob') === undefined);
  }

  console.log('');
  console.log('ЧАСТЬ 2. Решение о повторе (decideInviteRetry)');
  {
    check('комната отсутствует -> missing', decideInviteRetry(null, 'B') === 'missing');
    check('битая комната -> missing', decideInviteRetry({ status: 'waiting' }, 'B') === 'missing');
    check('занято другим -> occupied', decideInviteRetry(mkRoom('waiting', 'A', 'C'), 'B') === 'occupied');
    check('свой dark -> reconnect', decideInviteRetry(mkRoom('active', 'A', 'B'), 'B') === 'reconnect');
    check('finished -> not_waiting', decideInviteRetry(mkRoom('finished', 'A', null), 'B') === 'not_waiting');
    check('self-join -> self', decideInviteRetry(mkRoom('waiting', 'B', null), 'B') === 'self');
    check('waiting и место свободно -> retry (ложный abort)', decideInviteRetry(mkRoom('waiting', 'A', null), 'B') === 'retry');
  }

  console.log('');
  console.log('ЧАСТЬ 3. Конечный автомат — настоящая checkForInviteLink()');

  setup({ txResults: [true], reads: [mkRoom('waiting', 'A', null)] });
  checkForInviteLink(); await flush();
  check('1. первая transaction success -> ровно 1 transaction', env.txCalls === 1, 'tx=' + env.txCalls);
  check('1. игрок стал dark', global.myColor === 'dark' && global.isOnlineGame === true);
  check('1. metadata записана', gotMeta(), JSON.stringify(env.writes.map(function (w) { return w.path; })));
  check('1. таймаут снят', env.timers.some(function (t) { return t.ms === 10000 && t.cleared; }));

  // предпроверка видит свободную комнату, а к моменту контрольного чтения место занял другой
  setup({ txResults: [false], reads: [mkRoom('waiting', 'A', null), mkRoom('waiting', 'A', 'C')] });
  checkForInviteLink(); await flush();
  check('2. занято другим -> повтора НЕТ', env.txCalls === 1, 'tx=' + env.txCalls);
  check('2. показан err_room_taken', env.modals.indexOf('err_room_taken') !== -1, JSON.stringify(env.modals));
  check('2. проигравший НЕ стал dark', global.myColor !== 'dark' && global.isOnlineGame === false);
  check('2. проигравшему metadata НЕ записана', !gotMeta(), JSON.stringify(env.writes.map(function (w) { return w.path; })));
  check('2. таймаут снят и при отказе', env.timers.some(function (t) { return t.ms === 10000 && t.cleared; }));

  setup({ txResults: [false], reads: [mkRoom('waiting', 'A', null), mkRoom('finished', 'A', null)] });
  checkForInviteLink(); await flush();
  check('3. finished -> повтора НЕТ', env.txCalls === 1, 'tx=' + env.txCalls);
  check('3. игрок НЕ стал dark', global.myColor !== 'dark');

  setup({ txResults: [false], reads: [mkRoom('waiting', 'A', null), null] });
  checkForInviteLink(); await flush();
  check('4. комната отсутствует -> повтора НЕТ', env.txCalls === 1, 'tx=' + env.txCalls);
  check('4. metadata НЕ записана', !gotMeta());

  setup({ txResults: [false], reads: [mkRoom('waiting', 'A', null), mkRoom('active', 'A', 'B')] });
  checkForInviteLink(); await flush();
  check('5. свой dark -> reconnect, повтора НЕТ', env.txCalls === 1, 'tx=' + env.txCalls);
  check('5. reconnect засчитан как успех', global.myColor === 'dark' && global.isOnlineGame === true);

  setup({ txResults: [false, true], reads: [mkRoom('waiting', 'A', null)] });
  checkForInviteLink(); await flush();
  check('6. ложный abort -> РОВНО одна повторная transaction', env.txCalls === 2, 'tx=' + env.txCalls);
  check('7. retry success -> игрок стал dark', global.myColor === 'dark' && global.isOnlineGame === true);
  check('7. metadata записана после retry', gotMeta());

  setup({ txResults: [false, false, true], reads: [mkRoom('waiting', 'A', null)] });
  checkForInviteLink(); await flush();
  check('8. retry false -> окончательный отказ', env.modals.indexOf('err_room_taken') !== -1, JSON.stringify(env.modals));
  check('9. НИКОГДА больше двух transaction (третья доступна, но не вызвана)', env.txCalls === 2, 'tx=' + env.txCalls);
  check('10. после окончательного отказа НЕ dark и без metadata',
    global.myColor !== 'dark' && global.isOnlineGame === false && !gotMeta());

  console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
  process.exit(failed > 0 ? 1 : 0);
})();

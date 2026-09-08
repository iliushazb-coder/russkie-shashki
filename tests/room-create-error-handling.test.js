// №24 Step B: rooms/<code>.set(initialState) had no .catch() at all in
// createOnlineRoom / createRoomAndShowWaiting — on reject (network/
// permission), local state set synchronously BEFORE the write
// (roomCode/myColor/isOnlineGame/isSpectator/myPendingFriendRoomCode)
// stayed pointing at a room that was never created, with no feedback to
// the player. Extracts the REAL functions from script.js (not
// reimplemented copies), matching the extraction style used throughout
// this test suite.

const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

function domStub() { return { classList: { remove: function () {}, add: function () {} }, textContent: '' }; }

function resetGlobals() {
  global.canUseFirebase = function () { return true; };
  global.myPendingOnlineRoom = null;
  global.roomCode = null;
  global.myColor = null;
  global.isOnlineGame = false;
  global.isSpectator = false;
  global.myPendingFriendRoomCode = null;
  global.myWaitingRoomNoOpponent = false;
  global.pendingTimeControlSeconds = 0;
  global.GROUP_ID = 'g1';
  global.myTelegramId = 'tg_1';
  global.myTelegramName = 'Alice';
  global.BOT_USERNAME = 'bot';
  global.activeMatchRef = null;
  global.generateRoomCode = function () { return 'ABC123'; };
  global.createInitialPieces = function () { return {}; };
  global.getDrawPositionKey = function () { return 'key'; };
  global.firebase = { database: { ServerValue: { TIMESTAMP: '__TS__' } } };
  global.gameScreen = domStub();
  global.waitingScreen = domStub();
  global.inviteLinkBox = domStub();
  global.waitingText = domStub();
  global.btnShareLink = domStub();
  global.showInfoModalCalls = [];
  global.showInfoModal = function (msg, x) { global.showInfoModalCalls.push([msg, x]); };
  global.t = function (key) { return key; };
  global.showScreenCalls = [];
  global.showScreen = function (s) { global.showScreenCalls.push(s); };
  global.showGroupLobbyCalls = 0;
  global.showGroupLobby = function () { global.showGroupLobbyCalls++; };
  global.setupPresenceCalls = 0;
  global.setupPresence = function () { global.setupPresenceCalls++; };
  global.startOnlineGameCalls = 0;
  global.startOnlineGame = function () { global.startOnlineGameCalls++; };
  global.detachRoomListenerCalls = 0;
  global.detachRoomListener = function () { global.detachRoomListenerCalls++; };
  global.stopPresenceHeartbeatCalls = 0;
  global.stopPresenceHeartbeat = function () { global.stopPresenceHeartbeatCalls++; };
  global.workerErrorCode = function (e) { return e && e.message; };
}

function makeFakeDatabase(setBehavior) {
  const written = [];
  return {
    ref: function (path) {
      return {
        set: function (value) {
          written.push({ path: path, value: value });
          if (path.indexOf('rooms/') === 0) return setBehavior();
          return Promise.resolve();
        },
        remove: function () { return Promise.resolve(); },
        on: function () {},
        off: function () {}
      };
    },
    _written: written
  };
}

function makeFakeDatabaseFlipCanUseFirebase(rejectError) {
  return {
    ref: function (path) {
      return {
        set: function (value) {
          if (path.indexOf('rooms/') === 0) {
            // Симулирует сессию, сменившуюся ПОКА запись была в полёте:
            // canUseFirebase() было true на входе в функцию (иначе она
            // вышла бы в самой первой строке), но к моменту catch — уже
            // false.
            global.canUseFirebase = function () { return false; };
            return Promise.reject(rejectError);
          }
          return Promise.resolve();
        },
        remove: function () { return Promise.resolve(); },
        on: function () {},
        off: function () {}
      };
    }
  };
}

// №24 review fix (guarded transition): fake database поддерживающая ручное
// срабатывание слушателей "users/<uid>/activeMatch" и "rooms/<code>/status",
// плюс учёт .off()/.remove() для проверки exactly-once/detach-both.
// ВАЖНО: _fire() держит СВОЙ, никогда не очищаемый .off()'ом реестр
// колбэков — иначе .off(), вызванный ПЕРВЫМ срабатыванием, маскирует
// отсутствие explicit-guard'а внутри самого обработчика (второй _fire()
// просто не найдёт "снятый" листенер, и exactly-once-баг не проявится).
// Так моделируется реальная гонка: оба Firebase-события УЖЕ доставлены
// клиенту почти одновременно, ДО того как первый колбэк успел вызвать
// .off() — единственное, что тогда защищает от двойного перехода, это
// сам matchTransitionDone внутри guardedMatchTransition.
function makeGuardedTransitionDatabase() {
  const everRegistered = {}; // path -> callback, НЕ очищается через .off()
  const offCalls = [];
  let activeMatchRemoveCalls = 0;
  return {
    _fire: function (path, value) { if (everRegistered[path]) everRegistered[path]({ val: function () { return value; } }); },
    _offCalls: offCalls,
    _activeMatchRemoveCalls: function () { return activeMatchRemoveCalls; },
    ref: function (path) {
      return {
        set: function () { return Promise.resolve(); },
        remove: function () { if (path.indexOf('activeMatch') !== -1) activeMatchRemoveCalls++; return Promise.resolve(); },
        on: function (event, cb) { everRegistered[path] = cb; },
        off: function () { offCalls.push(path); }
      };
    }
  };
}

// №24 review fix (blocker: post-transition retry must reuse the SAME ref
// instance): controllable database где preflight-remove (1-й вызов на
// activeMatch) всегда resolve'ится сразу, а КАЖДАЯ post-transition попытка
// (2-й, 3-й... вызов) управляется через postTransitionOutcomes -- позволяет
// проверить, что retry реально повторяет .remove() на СОХРАНЁННОМ ref, а не
// падает на null.remove() после того как global activeMatchRef обнулился.
function makeRetryTrackingDatabase(postTransitionOutcomes) {
  const everRegistered = {};
  const offCalls = [];
  let activeMatchRemoveCalls = 0;
  return {
    _fire: function (path, value) { if (everRegistered[path]) everRegistered[path]({ val: function () { return value; } }); },
    _offCalls: offCalls,
    _activeMatchRemoveCalls: function () { return activeMatchRemoveCalls; },
    ref: function (path) {
      return {
        set: function () { return Promise.resolve(); },
        remove: function () {
          if (path.indexOf('activeMatch') === -1) return Promise.resolve();
          activeMatchRemoveCalls++;
          if (activeMatchRemoveCalls === 1) return Promise.resolve(); // preflight
          const outcome = postTransitionOutcomes[activeMatchRemoveCalls - 2]; // 0-indexed post-transition attempts
          return outcome ? outcome() : Promise.resolve();
        },
        on: function (event, cb) { everRegistered[path] = cb; },
        off: function () { offCalls.push(path); }
      };
    }
  };
}

// №24 review fix (preflight clear): fake database отслеживающая ПОРЯДОК
// операций (remove/set/on/off с путями) и позволяющая отдельно управлять
// поведением ИМЕННО preflight-remove (первый вызов .remove() на activeMatch)
// — независимо от post-transition remove (последующие вызовы).
function makePreflightTrackingDatabase(preflightRemoveBehavior) {
  const opLog = [];
  let activeMatchRemoveCallCount = 0;
  const listeners = {};
  return {
    _opLog: opLog,
    _fireExternalActiveMatch: function (value) {
      if (listeners['users/tg_1/activeMatch']) listeners['users/tg_1/activeMatch']({ val: function () { return value; } });
    },
    ref: function (path) {
      return {
        set: function (value) { opLog.push({ op: 'set', path: path }); return Promise.resolve(); },
        remove: function () {
          opLog.push({ op: 'remove', path: path });
          if (path.indexOf('activeMatch') !== -1) {
            activeMatchRemoveCallCount++;
            if (activeMatchRemoveCallCount === 1) return preflightRemoveBehavior();
            return Promise.resolve();
          }
          return Promise.resolve();
        },
        on: function (event, cb) { listeners[path] = cb; opLog.push({ op: 'on', path: path }); },
        off: function () { opLog.push({ op: 'off', path: path }); }
      };
    }
  };
}

let loadError = null;
try {
  eval([
    extractFunc('withBoundedRetry'),
    extractFunc('createOnlineRoom'),
    extractFunc('createRoomAndShowWaiting')
  ].join('\n\n'));


  Promise.resolve()
    .then(function () {
      console.log('=== 1. createOnlineRoom: rooms/<code>.set() REJECTS ===');
      resetGlobals();
      global.database = makeFakeDatabase(function () { return Promise.reject(new Error('permission_denied')); });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('1.1 USER ERROR shown via showInfoModal(err_room_create_failed)',
          global.showInfoModalCalls.length === 1 && global.showInfoModalCalls[0][0] === 'err_room_create_failed');
        check('1.2 roomCode rolled back to null', global.roomCode === null);
        check('1.3 myColor rolled back to null', global.myColor === null);
        check('1.4 isOnlineGame rolled back to false', global.isOnlineGame === false);
        check('1.5 isSpectator rolled back to false', global.isSpectator === false);
        check('1.6 showGroupLobby NOT called (success path skipped)', global.showGroupLobbyCalls === 0);
        check('1.7 setupPresence NOT called (never reached)', global.setupPresenceCalls === 0);
      });
    })
    .then(function () {
      console.log('=== 2. createOnlineRoom: rooms/<code>.set() SUCCEEDS (success path unchanged) ===');
      resetGlobals();
      global.database = makeFakeDatabase(function () { return Promise.resolve(); });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('2.1 no USER ERROR shown', global.showInfoModalCalls.length === 0);
        check('2.2 roomCode kept (== ABC123, not rolled back)', global.roomCode === 'ABC123');
        check('2.3 isOnlineGame stays true', global.isOnlineGame === true);
        check('2.4 showGroupLobby called once', global.showGroupLobbyCalls === 1);
        check('2.5 setupPresence called once', global.setupPresenceCalls === 1);
      });
    })
    .then(function () {
      console.log('=== 3. createRoomAndShowWaiting: rooms/<code>.set() REJECTS ===');
      resetGlobals();
      global.database = makeFakeDatabase(function () { return Promise.reject(new Error('permission_denied')); });
      createRoomAndShowWaiting();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('3.1 USER ERROR shown via showInfoModal(err_room_create_failed)',
          global.showInfoModalCalls.length === 1 && global.showInfoModalCalls[0][0] === 'err_room_create_failed');
        check('3.2 roomCode rolled back to null', global.roomCode === null);
        check('3.3 myPendingFriendRoomCode rolled back to null', global.myPendingFriendRoomCode === null);
        check('3.4 myColor rolled back to null', global.myColor === null);
        check('3.5 isOnlineGame rolled back to false', global.isOnlineGame === false);
        check('3.6 showScreen(waitingScreen) NOT called (success path skipped)', global.showScreenCalls.indexOf(global.waitingScreen) === -1);
      });
    })
    .then(function () {
      console.log('=== 4. createRoomAndShowWaiting: rooms/<code>.set() SUCCEEDS (success path unchanged) ===');
      resetGlobals();
      global.database = makeFakeDatabase(function () { return Promise.resolve(); });
      createRoomAndShowWaiting();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('4.1 no USER ERROR shown', global.showInfoModalCalls.length === 0);
        check('4.2 roomCode kept (== ABC123, not rolled back)', global.roomCode === 'ABC123');
        check('4.3 myPendingFriendRoomCode kept', global.myPendingFriendRoomCode === 'ABC123');
        check('4.4 showScreen(waitingScreen) called', global.showScreenCalls.indexOf(global.waitingScreen) !== -1);
        check('4.5 setupPresence called once', global.setupPresenceCalls === 1);
      });
    })
    .then(function () {
      console.log('=== 5. createOnlineRoom: rooms/<code>.set() REJECTS, canUseFirebase() flips to false IN FLIGHT (review blocker) ===');
      resetGlobals();
      // canUseFirebase() истинно на входе (иначе createOnlineRoom вышла бы
      // в первой строке); flip происходит ВНУТРИ set(), до reject —
      // симулирует смену сессии, пока запись была в полёте.
      global.database = makeFakeDatabaseFlipCanUseFirebase(new Error('permission_denied'));
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('5.1 rollback happens even though canUseFirebase() is false in catch', global.roomCode === null);
        check('5.2 myColor rolled back', global.myColor === null);
        check('5.3 isOnlineGame rolled back', global.isOnlineGame === false);
        check('5.4 isSpectator rolled back', global.isSpectator === false);
        check('5.5 USER ERROR NOT shown (canUseFirebase() false gates only the modal)', global.showInfoModalCalls.length === 0);
      });
    })
    .then(function () {
      console.log('=== 6. createRoomAndShowWaiting: rooms/<code>.set() REJECTS, canUseFirebase() flips to false IN FLIGHT (review blocker) ===');
      resetGlobals();
      global.database = makeFakeDatabaseFlipCanUseFirebase(new Error('permission_denied'));
      createRoomAndShowWaiting();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('6.1 rollback happens even though canUseFirebase() is false in catch', global.roomCode === null);
        check('6.2 myPendingFriendRoomCode rolled back', global.myPendingFriendRoomCode === null);
        check('6.3 myColor rolled back', global.myColor === null);
        check('6.4 isOnlineGame rolled back', global.isOnlineGame === false);
        check('6.5 USER ERROR NOT shown (canUseFirebase() false gates only the modal)', global.showInfoModalCalls.length === 0);
      });
    })
    .then(function () {
      console.log('=== 7. guarded transition: activeMatch never fires (set() reject on joiner side), status becomes active -> creator still enters ===');
      resetGlobals();
      global.database = makeGuardedTransitionDatabase();
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        global.database._fire('rooms/ABC123/status', 'active');
        check('7.1 startOnlineGame called exactly once', global.startOnlineGameCalls === 1);
        check('7.2 isOnlineGame true, roomCode set', global.isOnlineGame === true && global.roomCode === 'ABC123');
        check('7.3 both listeners detached', global.database._offCalls.sort().join(',') === 'rooms/ABC123/status,users/tg_1/activeMatch');
      });
    })
    .then(function () {
      console.log('=== 8. guarded transition: activeMatch fires FIRST -> exactly one transition, late status fire is a no-op ===');
      resetGlobals();
      global.database = makeGuardedTransitionDatabase();
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        global.database._fire('users/tg_1/activeMatch', 'ABC123');
        global.database._fire('rooms/ABC123/status', 'active'); // поздний, должен быть проигнорирован
        check('8.1 startOnlineGame called exactly once (not twice)', global.startOnlineGameCalls === 1);
        check('8.2 activeMatch.remove() called exactly twice (1 preflight in createOnlineRoom + 1 post-transition, review fix)', global.database._activeMatchRemoveCalls() === 2);
      });
    })
    .then(function () {
      console.log('=== 9. guarded transition: status fires FIRST -> exactly one transition, late activeMatch fire is a no-op ===');
      resetGlobals();
      global.database = makeGuardedTransitionDatabase();
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        global.database._fire('rooms/ABC123/status', 'active');
        global.database._fire('users/tg_1/activeMatch', 'ABC123'); // поздний, должен быть проигнорирован
        check('9.1 startOnlineGame called exactly once (not twice)', global.startOnlineGameCalls === 1);
      });
    })
    .then(function () {
      console.log('=== 10. guarded transition: both fire almost simultaneously -> exactly once ===');
      resetGlobals();
      global.database = makeGuardedTransitionDatabase();
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        global.database._fire('users/tg_1/activeMatch', 'ABC123');
        global.database._fire('rooms/ABC123/status', 'active');
        check('10.1 startOnlineGame called exactly once', global.startOnlineGameCalls === 1);
        check('10.2 both listeners detached exactly once each', global.database._offCalls.length === 2);
      });
    })
    .then(function () {
      console.log('=== 11. guarded transition: canUseFirebase() false when signal arrives -> no transition, listeners stay alive, transitionDone does not block retry (review blocker) ===');
      resetGlobals();
      global.database = makeGuardedTransitionDatabase();
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        global.canUseFirebase = function () { return false; };
        global.database._fire('rooms/ABC123/status', 'active');
        check('11.1 startOnlineGame NOT called', global.startOnlineGameCalls === 0);
        check('11.2 myPendingOnlineRoom NOT consumed (still ABC123, not nulled by a failed attempt)', global.myPendingOnlineRoom === 'ABC123');
        check('11.3 listeners NOT detached (no premature .off())', global.database._offCalls.length === 0);
        check('11.4 activeMatch.remove() called exactly once so far (1 preflight only -- post-transition one has not run, no transition happened yet)', global.database._activeMatchRemoveCalls() === 1);

        console.log('=== 12. ...then canUseFirebase() recovers and the same/next value event arrives -> enters exactly once ===');
        global.canUseFirebase = function () { return true; };
        global.database._fire('rooms/ABC123/status', 'active');
        check('12.1 startOnlineGame called exactly once', global.startOnlineGameCalls === 1);
        check('12.2 isOnlineGame true, roomCode set', global.isOnlineGame === true && global.roomCode === 'ABC123');

        console.log('=== 13. ...and both listeners are detached after the successful transition ===');
        check('13.1 both listeners detached', global.database._offCalls.sort().join(',') === 'rooms/ABC123/status,users/tg_1/activeMatch');

        console.log('=== 14. ...a further late fire on the OTHER listener is still a no-op (exactly-once holds across the retry too) ===');
        global.database._fire('users/tg_1/activeMatch', 'ABC123');
        check('14.1 startOnlineGame still called exactly once (not twice)', global.startOnlineGameCalls === 1);
      });
    })
    .then(function () {
      console.log('=== 15. preflight: stale activeMatch present -> preflight remove happens BEFORE rooms/<newCode>.set() ===');
      resetGlobals();
      global.database = makePreflightTrackingDatabase(function () { return Promise.resolve(); });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        const removeIdx = global.database._opLog.findIndex(function (e) { return e.op === 'remove' && e.path === 'users/tg_1/activeMatch'; });
        const setIdx = global.database._opLog.findIndex(function (e) { return e.op === 'set' && e.path === 'rooms/ABC123'; });
        check('15.1 preflight remove happened', removeIdx !== -1);
        check('15.2 rooms/<newCode>.set() happened', setIdx !== -1);
        check('15.3 preflight remove is strictly BEFORE rooms/<newCode>.set()', removeIdx < setIdx);
      });
    })
    .then(function () {
      console.log('=== 16. preflight: while remove is PENDING, room create does not begin ===');
      resetGlobals();
      let resolvePreflight;
      const preflightPromise = new Promise(function (r) { resolvePreflight = r; });
      global.database = makePreflightTrackingDatabase(function () { return preflightPromise; });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        const setBeforeResolve = global.database._opLog.some(function (e) { return e.op === 'set' && e.path === 'rooms/ABC123'; });
        check('16.1 rooms/<newCode>.set() has NOT happened yet while preflight is pending', setBeforeResolve === false);
        check('16.2 roomCode not yet reassigned to the new code while pending', global.roomCode === null);
        resolvePreflight();
        return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
          const setAfterResolve = global.database._opLog.some(function (e) { return e.op === 'set' && e.path === 'rooms/ABC123'; });
          check('16.3 rooms/<newCode>.set() happens once preflight resolves', setAfterResolve === true);
        });
      });
    })
    .then(function () {
      console.log('=== 17. preflight REJECTS -> room is not created, online-state untouched, USER ERROR shown ===');
      resetGlobals();
      global.database = makePreflightTrackingDatabase(function () { return Promise.reject(new Error('preflight_failed')); });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        const roomWasCreated = global.database._opLog.some(function (e) { return e.op === 'set' && e.path === 'rooms/ABC123'; });
        check('17.1 rooms/<newCode>.set() never happened', roomWasCreated === false);
        check('17.2 roomCode stays null (never touched)', global.roomCode === null);
        check('17.3 myColor stays null', global.myColor === null);
        check('17.4 isOnlineGame stays false', global.isOnlineGame === false);
        check('17.5 isSpectator stays false', global.isSpectator === false);
        check('17.6 USER ERROR shown via showInfoModal(err_room_create_failed)',
          global.showInfoModalCalls.length === 1 && global.showInfoModalCalls[0][0] === 'err_room_create_failed');
      });
    })
    .then(function () {
      console.log('=== 18. preflight RESOLVES -> ordinary successful create flow is unaffected ===');
      resetGlobals();
      global.database = makePreflightTrackingDatabase(function () { return Promise.resolve(); });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('18.1 no USER ERROR shown', global.showInfoModalCalls.length === 0);
        check('18.2 roomCode set to the new code', global.roomCode === 'ABC123');
        check('18.3 showGroupLobby called once', global.showGroupLobbyCalls === 1);
        check('18.4 setupPresence called once', global.setupPresenceCalls === 1);
      });
    })
    .then(function () {
      console.log('=== 19. a genuinely NEW activeMatch written by a real joiner AFTER room creation is not erased by the defensive preflight cleanup ===');
      resetGlobals();
      global.database = makePreflightTrackingDatabase(function () { return Promise.resolve(); });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        // Комната уже создана (preflight давно отработал) -- имитируем
        // РЕАЛЬНОГО joiner'а, записавшего валидный activeMatch именно
        // ПОСЛЕ создания комнаты.
        global.database._fireExternalActiveMatch('ABC123');
        check('19.1 the new signal is honored -- creator enters the game', global.startOnlineGameCalls === 1);
        check('19.2 no extra activeMatch remove happened between room creation and this signal besides preflight+post-transition',
          global.database._opLog.filter(function (e) { return e.op === 'remove' && e.path === 'users/tg_1/activeMatch'; }).length === 2);
      });
    })
    .then(function () {
      console.log('=== 20. post-transition cleanup REJECTS -> does not break the game that already started ===');
      resetGlobals();
      global.database = makeGuardedTransitionDatabase();
      const originalRef = global.database.ref.bind(global.database);
      global.database.ref = function (path) {
        const realRef = originalRef(path);
        if (path === 'users/tg_1/activeMatch') {
          let removeCallsOnThisRef = 0;
          const originalRemove = realRef.remove.bind(realRef);
          realRef.remove = function () {
            removeCallsOnThisRef++;
            if (removeCallsOnThisRef === 1) return originalRemove(); // preflight -- пропускаем как есть
            return Promise.reject(new Error('post_transition_cleanup_failed')); // post-transition -- отклоняем
          };
        }
        return realRef;
      };
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        global.database._fire('rooms/ABC123/status', 'active');
        check('20.1 startOnlineGame still called despite post-transition cleanup rejecting', global.startOnlineGameCalls === 1);
        check('20.2 isOnlineGame true, roomCode set -- game state unaffected', global.isOnlineGame === true && global.roomCode === 'ABC123');
      });
    })
    .then(function () {
      console.log('=== 21. preflight REJECTS with PRE-EXISTING non-default state (sentinel) -> state must stay EXACTLY unchanged, not reset to defaults (review blocker) ===');
      resetGlobals();
      // Sentinel: значения ДО вызова createOnlineRoom(), заведомо ОТЛИЧНЫЕ
      // от того, что резетнул бы обычный rollback (null/false) -- если
      // preflight-catch по ошибке безусловно обнуляет их вместо того чтобы
      // оставить как есть, тест это поймает, в отличие от resetGlobals()'а,
      // который сам ставит null/false и потому маскирует эту ошибку.
      global.roomCode = 'OLD';
      global.myColor = 'dark';
      global.isOnlineGame = true;
      global.isSpectator = true;
      global.database = makePreflightTrackingDatabase(function () { return Promise.reject(new Error('preflight_failed')); });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('21.1 roomCode stays EXACTLY the pre-existing sentinel value', global.roomCode === 'OLD');
        check('21.2 myColor stays EXACTLY the pre-existing sentinel value', global.myColor === 'dark');
        check('21.3 isOnlineGame stays EXACTLY the pre-existing sentinel value', global.isOnlineGame === true);
        check('21.4 isSpectator stays EXACTLY the pre-existing sentinel value', global.isSpectator === true);
        const roomWasCreated = global.database._opLog.some(function (e) { return e.op === 'set' && e.path.indexOf('rooms/') === 0; });
        check('21.5 rooms/<newCode>.set() never happened', roomWasCreated === false);
        check('21.6 USER ERROR shown via showInfoModal(err_room_create_failed)',
          global.showInfoModalCalls.length === 1 && global.showInfoModalCalls[0][0] === 'err_room_create_failed');
      });
    })
    .then(function () {
      console.log('=== 22. post-transition retry reuses the SAME saved ref -- first attempt rejects, second attempt genuinely retries (not null.remove()) (review blocker 1) ===');
      resetGlobals();
      let attempt1Failed = false;
      let attempt2CalledOnRealRef = false;
      global.database = makeRetryTrackingDatabase([
        function () { attempt1Failed = true; return Promise.reject(new Error('transient')); },
        function () { attempt2CalledOnRealRef = true; return Promise.resolve(); }
      ]);
      let uncaughtTypeError = null;
      process.once('unhandledRejection', function (e) { uncaughtTypeError = e; });
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        global.database._fire('rooms/ABC123/status', 'active');
        check('22.1 game already started, does not wait for cleanup', global.startOnlineGameCalls === 1);
        return new Promise(function (r) { setTimeout(r, 700); }).then(function () { // withBoundedRetry's 2nd delay is 500ms
          check('22.2 first post-transition attempt happened and failed', attempt1Failed === true);
          check('22.3 second attempt genuinely re-invoked remove() on the SAME saved ref (not a null.remove() crash)', attempt2CalledOnRealRef === true);
          check('22.4 no TypeError/unhandled rejection from calling remove() on null', uncaughtTypeError === null);
          check('22.5 game state still fine regardless of cleanup outcome', global.isOnlineGame === true && global.roomCode === 'ABC123');
        });
      });
    })
    .then(function () {
      console.log('=== 23. activeMatch listener ignores a stale/mismatched roomCode; only rooms/<own-code>/status remains authoritative for that case (review blocker 2) ===');
      resetGlobals();
      global.database = makeGuardedTransitionDatabase();
      createOnlineRoom();
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        // Поздняя, задержанная запись СТАРОГО activeMatch, долетевшая уже
        // ПОСЛЕ создания новой комнаты ABC123 -- ссылается на чужую/
        // устаревшую партию, не на myOwnRoomCode.
        global.database._fire('users/tg_1/activeMatch', 'OLD999');
        check('23.1 startOnlineGame NOT called for the mismatched stale code', global.startOnlineGameCalls === 0);
        check('23.2 roomCode stays ABC123 (not hijacked to OLD999)', global.roomCode === 'ABC123');
        check('23.3 both listeners remain active (not detached by the ignored signal)', global.database._offCalls.length === 0);

        console.log('=== 24. ...then the authoritative rooms/<own-code>/status fallback fires -> creator enters ABC123 exactly once ===');
        global.database._fire('rooms/ABC123/status', 'active');
        check('24.1 startOnlineGame called exactly once, for ABC123', global.startOnlineGameCalls === 1 && global.roomCode === 'ABC123');
      });
    })
    .then(function () {
      console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
      if (failed > 0) process.exit(1);
    })
    .catch(function (e) {
      check('x. гарнесс не должен падать сам по себе', false, e.stack || e.message);
      console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
      process.exit(1);
    });
} catch (e) {
  loadError = e;
  console.log('  ❌ не удалось загрузить функции из script.js — ' + e.message);
  console.log('\nИТОГ: 0/1');
  process.exit(1);
}

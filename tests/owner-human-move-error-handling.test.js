// №24 (final review): applyHumanMoveViaSession(...) had NO .catch() at all
// inside attemptOwnerHumanMove -- a genuine Firebase transaction rejection
// (not committed:false, which is handled separately inside .then()) became
// an unhandled promise rejection, and selectedFrom stayed stuck on the
// already-clicked square forever, with no way to recover except reloading.
// This is the human-move counterpart of the bot-move flow
// (triggerOwnerSyncedBotMove -> commitBotMove), which already had its own
// .catch(). Extracts the REAL attemptOwnerHumanMove from script.js, but
// mocks applyHumanMoveViaSession itself (not extracted) -- this test's
// concern is attemptOwnerHumanMove's OWN reject handling, not the
// underlying botSessions transaction machinery, which has its own coverage
// elsewhere.

const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

function resetGlobals() {
  global.selectedFrom = { row: 2, col: 1 }; // клетка, с которой был начат ход
  global.updateSelectionDomCalls = [];
  global.updateSelectionDom = function (oldSel, newSel) { global.updateSelectionDomCalls.push([oldSel, newSel]); };
  global.mirrorCommittedStateToSpectateRoomCalls = [];
  global.mirrorCommittedStateToSpectateRoom = function (code, session) { global.mirrorCommittedStateToSpectateRoomCalls.push([code, session]); };
  global.deserializeOwnerBotState = function (raw) { return raw; }; // pass-through, тело не важно для этого теста
  global.consoleErrorCalls = [];
  const realConsoleError = console.error;
  console.error = function () { global.consoleErrorCalls.push(Array.prototype.slice.call(arguments)); };
  global._restoreConsoleError = function () { console.error = realConsoleError; };
}

let loadError = null;
try {
  eval(extractFunc('attemptOwnerHumanMove'));

  Promise.resolve()
    .then(function () {
      console.log('=== 1. applyHumanMoveViaSession REJECTS -> no unhandled rejection, error logged, selectedFrom reset ===');
      resetGlobals();
      let unhandled = null;
      process.once('unhandledRejection', function (e) { unhandled = e; });
      global.applyHumanMoveViaSession = function () { return Promise.reject(new Error('transient_network_error')); };
      attemptOwnerHumanMove(2, 1, 3, 0);
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('1.1 no unhandled rejection', unhandled === null);
        check('1.2 error logged via console.error', global.consoleErrorCalls.length === 1 && /transient_network_error/.test(global.consoleErrorCalls[0][1].message));
        check('1.3 selectedFrom reset to null (not left stuck on the clicked square)', global.selectedFrom === null);
        check('1.4 updateSelectionDom called to clear the stale highlight', global.updateSelectionDomCalls.length === 1 && global.updateSelectionDomCalls[0][1] === null);
        check('1.5 mirrorCommittedStateToSpectateRoom NOT called (nothing committed)', global.mirrorCommittedStateToSpectateRoomCalls.length === 0);
        global._restoreConsoleError();
      });
    })
    .then(function () {
      console.log('=== 2. committed:false (abort, not a real error) -> handled separately, does NOT reach .catch() ===');
      resetGlobals();
      global.applyHumanMoveViaSession = function () { return Promise.resolve({ committed: false }); };
      attemptOwnerHumanMove(2, 1, 3, 0);
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('2.1 no console.error call (committed:false is not an error)', global.consoleErrorCalls.length === 0);
        check('2.2 selectedFrom left untouched (existing abort behavior unchanged)', global.selectedFrom && global.selectedFrom.row === 2 && global.selectedFrom.col === 1);
        check('2.3 updateSelectionDom NOT called for abort', global.updateSelectionDomCalls.length === 0);
        global._restoreConsoleError();
      });
    })
    .then(function () {
      console.log('=== 3. success path (committed:true) is unchanged ===');
      resetGlobals();
      global.applyHumanMoveViaSession = function () {
        return Promise.resolve({
          committed: true,
          snapshot: { val: function () { return { state: { mustContinueFrom: null }, spectateRoomCode: 'SPEC01', botColor: 'dark' }; } }
        });
      };
      attemptOwnerHumanMove(2, 1, 3, 0);
      return new Promise(function (r) { setTimeout(r, 10); }).then(function () {
        check('3.1 no console.error call', global.consoleErrorCalls.length === 0);
        check('3.2 selectedFrom updated to null (move complete, no further capture)', global.selectedFrom === null);
        check('3.3 updateSelectionDom called once for the successful commit', global.updateSelectionDomCalls.length === 1);
        check('3.4 mirrorCommittedStateToSpectateRoom called with the committed snapshot', global.mirrorCommittedStateToSpectateRoomCalls.length === 1 && global.mirrorCommittedStateToSpectateRoomCalls[0][0] === 'SPEC01');
        global._restoreConsoleError();
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

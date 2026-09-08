// №23: client-side tests for the durable-requestId + protected-first-ordering
// fixes found on independent review round 5 —
// (1) requestId must be STABLE across reload for a retry of the SAME
//     logical pending action (ambiguous failure), but FRESH for a genuinely
//     NEW logical action (after the previous one reached a definitive
//     outcome);
// (2) draw_offer moved to protected-first (matching draw_cancel) so a lost
//     HTTP response can never leave UI and protected log permanently
//     disagreeing.
//
// Extracts the REAL functions from script.js (not reimplemented copies) and
// drives them with a mocked localStorage/callWorker/database, matching the
// extraction style already used throughout this test suite.

const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

function makeFakeLocalStorage() {
  const store = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
    _dump: function () { return Object.assign({}, store); }
  };
}

let loadError = null;
try {
  global.localStorage = makeFakeLocalStorage();
  global.workerErrorCode = function (e) { return e && e.message; };
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  const constMatch = /const RATED_ACTION_DEFINITIVE_ERRORS = \[[\s\S]*?\];/.exec(SRC);
  if (!constMatch) throw new Error('RATED_ACTION_DEFINITIVE_ERRORS не найден в script.js');
  // Один общий eval — иначе const/function, объявленные в отдельных eval(),
  // не видят друг друга (lexical scoping eval'а), даже в одном try-блоке.
  eval([
    constMatch[0],
    extractFunc('ratedPendingActionKey'),
    extractFunc('getPendingRatedActionId'),
    extractFunc('setPendingRatedActionId'),
    extractFunc('clearPendingRatedActionId'),
    extractFunc('isDefinitiveRatedActionOutcome'),
    extractFunc('generateNonTurnRequestId'),
    extractFunc('withBoundedRetry'),
    extractFunc('removeDrawProposalWithRetry'),
    extractFunc('setDrawProposalWithRetry'),
    extractFunc('submitRatedDrawCancel'),
    extractFunc('submitRatedDrawOffer')
  ].join('\n'));
} catch (e) { loadError = e.message; }

check('0. все функции извлеклись без ошибок', loadError === null, loadError);

function run() {
  console.log('=== 1. Durable pending-action requestId: reload-retry vs genuinely-new action ===');
  {
    global.localStorage = makeFakeLocalStorage();
    const MATCH_ID = 'elo_ABC123_1700000000000_0';

    const idOffer1 = generateNonTurnRequestId('light', 'draw_offer', 5, MATCH_ID);
    const idOfferRetry = generateNonTurnRequestId('light', 'draw_offer', 5, MATCH_ID);
    check('1.1 retry ТОГО ЖЕ pending-действия после "reload" сохраняет тот же requestId',
      idOffer1 === idOfferRetry);

    clearPendingRatedActionId(MATCH_ID, 'draw_offer');

    const idCancel = generateNonTurnRequestId('light', 'draw_cancel', 5, MATCH_ID);
    check('1.2 draw_cancel получает СВОЙ отдельный requestId (не совпадает с draw_offer)',
      idCancel !== idOffer1);
    clearPendingRatedActionId(MATCH_ID, 'draw_cancel');

    const idFreshOffer = generateNonTurnRequestId('light', 'draw_offer', 5, MATCH_ID);
    check('1.3 fresh draw_offer после завершённого cancel получает НОВЫЙ requestId',
      idFreshOffer !== idOffer1);
  }

  console.log('');
  console.log('=== 2. definitive vs ambiguous outcome классификация ===');
  {
    check('2.1 match_already_terminal — definitive (marker можно снять)',
      isDefinitiveRatedActionOutcome(new Error('match_already_terminal')));
    check('2.2 self_accept_rejected — definitive',
      isDefinitiveRatedActionOutcome(new Error('self_accept_rejected')));
    check('2.3 сетевая/неизвестная ошибка — НЕ definitive (marker остаётся)',
      !isDefinitiveRatedActionOutcome(new Error('network_fail')));
    check('2.4 http_500-подобная ошибка — НЕ definitive',
      !isDefinitiveRatedActionOutcome(new Error('http_500')));
  }

  function makeCancelHarness(callWorkerImpl) {
    const removed = { count: 0 };
    global.localStorage = makeFakeLocalStorage();
    global.currentState = { ratedMatchId: 'elo_ABC123_1700000000000_0', moveCount: 3 };
    global.myColor = 'light';
    global.roomCode = 'ABC123';
    global.callWorker = callWorkerImpl;
    global.workerErrorCode = function (e) { return e && e.message; };
    global.showInfoModal = function () {};
    global.t = function (k) { return k; };
    global.database = { ref: function () { return { remove: function () { removed.count++; return Promise.resolve(); } }; } };
    return removed;
  }

  function makeOfferHarness(callWorkerImpl) {
    const setCalls = { count: 0 };
    global.localStorage = makeFakeLocalStorage();
    global.currentState = { ratedMatchId: 'elo_ABC123_1700000000000_0', moveCount: 7 };
    global.myColor = 'dark';
    global.myTelegramName = 'Bob';
    global.roomCode = 'ABC123';
    global.callWorker = callWorkerImpl;
    global.workerErrorCode = function (e) { return e && e.message; };
    global.showInfoModal = function () {};
    global.t = function (k) { return k; };
    global.database = { ref: function () { return { set: function () { setCalls.count++; return Promise.resolve(); } }; } };
    return setCalls;
  }

  console.log('');
  console.log('=== 3. cancel/decline: protected-first, UI-remove только после успеха ===');
  const removed = makeCancelHarness(function () { return Promise.resolve({ ok: true }); });
  return submitRatedDrawCancel().then(function () {
    check('3.1 успешный protected draw_cancel -> drawProposal.remove() вызван', removed.count === 1);
    check('3.2 успешный cancel снимает pending-marker',
      global.localStorage.getItem('ratedPendingAction:elo_ABC123_1700000000000_0:draw_cancel') === null);

    const removed2 = makeCancelHarness(function () { return Promise.reject(new Error('network_fail')); });
    return submitRatedDrawCancel().catch(function () {}).then(function () {
      check('3.3 упавший (ambiguous) protected draw_cancel -> drawProposal.remove() НЕ вызван',
        removed2.count === 0);
      check('3.4 ambiguous failure оставляет pending-marker (для retry)',
        global.localStorage.getItem('ratedPendingAction:elo_ABC123_1700000000000_0:draw_cancel') !== null);
    });
  }).then(function () {
    console.log('');
    console.log('=== 4. offer: protected-first, UI-set только после успеха (lost response не создаёт рассинхрон) ===');
    const s1 = makeOfferHarness(function () { return Promise.resolve({ ok: true }); });
    return submitRatedDrawOffer().then(function () {
      check('4.1 успешный protected draw_offer -> drawProposal.set() вызван (UI после подтверждения)', s1.count === 1);

      const s2 = makeOfferHarness(function () { return Promise.reject(new Error('network_fail')); });
      return submitRatedDrawOffer().catch(function () {}).then(function () {
        check('4.2 lost/failed response -> drawProposal.set() НЕ вызван (UI никогда не "успевает вперёд" protected log)', s2.count === 0);
        check('4.3 ambiguous failure на offer тоже оставляет pending-marker',
          global.localStorage.getItem('ratedPendingAction:elo_ABC123_1700000000000_0:draw_offer') !== null);
      });
    });
  }).then(function () {
    console.log('');
    console.log('=== 5. UI-write recovery: bounded retry-серия (не единственный retry) ===');
    // Protected-событие уже успешно, только САМА UI-запись падает первый раз.
    global.localStorage = makeFakeLocalStorage();
    global.currentState = { ratedMatchId: 'elo_ABC123_1700000000000_0', moveCount: 9 };
    global.myColor = 'light';
    global.roomCode = 'ABC123';
    global.callWorker = function () { return Promise.resolve({ ok: true }); };
    global.workerErrorCode = function (e) { return e && e.message; };
    global.showInfoModal = function () {};
    global.t = function (k) { return k; };
    let removeAttempts = 0;
    global.database = { ref: function () { return { remove: function () {
      removeAttempts++;
      if (removeAttempts === 1) return Promise.reject(new Error('transient_network_error'));
      return Promise.resolve();
    } }; } };
    return submitRatedDrawCancel().then(function () {
      check('5.1 первая .remove() падает, retry восстанавливает UI (2 попытки)', removeAttempts === 2);

      // Найдено на review IMPORTANT 1: единственного retry недостаточно --
      // проверяем, что серия действительно ИДЁТ ДАЛЬШЕ одного повтора.
      let removeAttempts2 = 0;
      global.database = { ref: function () { return { remove: function () {
        removeAttempts2++;
        if (removeAttempts2 <= 2) return Promise.reject(new Error('transient_network_error'));
        return Promise.resolve();
      } }; } };
      return submitRatedDrawCancel().then(function () {
        check('5.2 ДВЕ неудачи подряд -- bounded-серия всё равно доходит до 3-й попытки и успешна', removeAttempts2 === 3);

        // Найдено на review Point 1: раньше marker снимался СРАЗУ после
        // успеха Worker-вызова, ДО попытки UI-записи -- если ВСЕ 3 попытки
        // UI-записи проваливались, marker уже был снят, и UI навсегда
        // застревал (syncProjection никогда не пишет drawProposal, значит
        // это ЕДИНСТВЕННЫЙ путь восстановления). Теперь marker снимается
        // ТОЛЬКО после реального успеха UI-записи.
        let removeAttempts3 = 0;
        global.database = { ref: function () { return { remove: function () {
          removeAttempts3++;
          return Promise.reject(new Error('persistent_network_error')); // ВСЕ попытки падают
        } }; } };
        return submitRatedDrawCancel().then(function () {
          check('5.3 ВСЕ 3 попытки UI-записи провалились -> pending-marker НЕ снят (единственный путь когда-либо восстановить UI)',
            global.localStorage.getItem('ratedPendingAction:elo_ABC123_1700000000000_0:draw_cancel') !== null);
          check('5.3b все 3 попытки действительно были предприняты', removeAttempts3 === 3);
        });
      });
    });
  }).then(function () {
    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    if (failed > 0) process.exit(1);
  }).catch(function (e) {
    check('x. гарнесс не должен падать сам по себе', false, e.message);
    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(1);
  });
}

if (!loadError) {
  run();
} else {
  console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
  process.exit(1);
}

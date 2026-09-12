// №23 (TDD RED stage): registration barrier contract.
//
// Заменяет прежний ratedGenerationPlayable-based тест: тот gate был снят
// emergency rollback'ом после production freeze (единый gate на
// performMove/resign/draw/checkTimeout/writeTechnicalResult заморозил
// timeout/disconnect, когда регистрация не завершалась).
//
// Этот файл НЕ предполагает конкретную реализацию нового барьера. Он
// проверяет и STRUCTURAL PLACEMENT (где вызов должен стоять в исходнике),
// и RUNTIME SEMANTICS (что предикат реально возвращает для каждого
// состояния) будущего narrow-барьера, отдельного от старого
// ratedGenerationPlayable по имени и по scope.
//
// КРИТИЧЕСКИЙ КОНТРАКТ, который и является предметом этого файла:
// для USER GAMEPLAY MUTATIONS permission НЕ может зависеть от
// ratedJoinState.phase. Единственное основание разрешить mutation —
// room-visible canonical registration ЭТОГО generation:
// registeredMatchIdForState(currentState, roomCode) !== null, то есть
// ожидаемый ratedMatchId + ОБЕ numeric ratingsAtStart. Ни idle, ни
// inFlight, ни retryWait, ни phase="success" (сети предшествует round
// trip, поэтому "success" ответа HTTP не значит, что pointer уже виден
// в комнате), ни terminalFailed (в том числе room_already_started) сами
// по себе НЕ дают права на mutation. Причина: любое из этих состояний,
// разрешив resign/move/draw-offer/draw-accept ДО регистрации, может
// сделать комнату non-pristine и НАВСЕГДА уничтожить возможность
// canonical registration (roomIsPristine() в worker/index.mjs). И наоборот:
// если комната САМА доказывает регистрацию, phase из ratedJoinState не
// имеет права её ЗАБЛОКИРОВАТЬ -- регистрация приоритетнее любой локальной
// (потенциально устаревшей) записи о состоянии join'а.
//
// Классификация (проверено по фактическому legacy-пути каждого action'а,
// не по названию) -- см. §1 ниже, без изменений с прошлой ревизии:
//   move/resign/draw-offer/draw-accept -- легаси-путь пишет поле,
//     ломающее roomIsPristine => ДОЛЖНЫ ждать регистрации.
//   draw-decline/draw-cancel -- легаси-путь делает drawProposal.remove(),
//     что НЕ ломает roomIsPristine (undefined, не "плохое" значение) и
//     при необходимости ВОССТАНАВЛИВАЕТ pristine => НЕ требуют gate.
//   checkTimeout/writeTechnicalResult -- тоже пишут winner/status, но
//     ОБЯЗАНЫ остаться негейтированными: это тот самый regression
//     contract, нарушение которого дало production freeze.
//   presence/reactions/listeners/spectator -- не пишут ни одного поля
//     roomIsPristine вообще => структурно не связаны с барьером.
//
// Предлагаемое имя нового helper'а (НЕ реализован, production код не
// создавался): canMutateRatedGameplay(). Названо УЗКО и ОТДЕЛЬНО от
// старого ratedGenerationPlayable специально, чтобы реализацию нельзя
// было по инерции навесить на checkTimeout/writeTechnicalResult той же
// функцией -- именно так возникла прошлая заморозка.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  \u2705 ' + name); }
    else { failed++; console.log('  \u274c ' + name + (info !== undefined ? '  \u2014 ' + info : '')); }
}

// grabOrNull() НЕ бросает при отсутствии функции -- возвращает null. Это
// принципиально: тест должен давать читаемый FAIL по каждому assertion'у,
// а не падать целиком с "не найдена функция", если helper ещё не написан.
function grabOrNull(name) {
    const m = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    return m ? m[0] : null;
}

function blockAt(anchor, window) {
    const i = SRC.indexOf(anchor);
    if (i === -1) return null;
    return SRC.slice(i, i + (window || 900));
}

// blockBalanced() -- находит anchor, затем ПЕРВУЮ "{" после него и считает
// баланс скобок до настоящей закрывающей. Используется там, где фиксированное
// окно ненадёжно (проверено фактически: оба roomListenerRef.on(...) callback'а
// длиннее 1500 символов -- 8196 и 2391 -- фиксированное окно реально обрезало
// бы их и могло пропустить ссылку на gate дальше среза).
function blockBalanced(anchor, openFrom) {
    const i = SRC.indexOf(anchor);
    if (i === -1) return null;
    const openBrace = SRC.indexOf('{', i + (openFrom || 0));
    if (openBrace === -1) return null;
    let depth = 0, j = openBrace;
    while (j < SRC.length) {
        if (SRC[j] === '{') depth++;
        else if (SRC[j] === '}') { depth--; if (depth === 0) break; }
        j++;
    }
    return SRC.slice(i, j + 1);
}

const PROPOSED_GATE_NAME = 'canMutateRatedGameplay';

console.log('=== 0. Baseline из worker/index.mjs (не изменялся, воспроизводим для контекста) ===');
{
    const WORKER = fs.readFileSync(path.join(__dirname, '..', 'worker', 'index.mjs'), 'utf8');
    check('0.1 roomIsPristine отвергает drawProposal (не только moveCount/turn/pieces/winner/result)',
        /room\.drawProposal !== undefined && room\.drawProposal !== null/.test(WORKER));
    check('0.2 registrationComplete требует ratedMatchId ЭТОГО matchId + обе ratingsAtStart числами',
        /room\.ratedMatchId !== matchId/.test(WORKER) &&
        /typeof rs\.light === "number" && typeof rs\.dark === "number"/.test(WORKER));
}

console.log('');
console.log('=== 1. Классификация: 4 действия ЛОМАЮТ pristine через legacy-путь (текущее поведение, факт) ===');
{
    const move = blockAt('function performMove(fromRow, fromCol, toRow, toCol) {', 5200);
    check('1.1 performMove: legacy-ветка существует и пишет transaction на весь room', !!move && move.indexOf('.transaction(') !== -1);

    const resign = blockAt('btnResignYes.addEventListener', 2200);
    check('1.2 resign: legacy-ветка (без ratedMatchId) пишет transaction на весь room', !!resign && resign.indexOf('.transaction(') !== -1);

    const drawOffer = blockAt('btnOfferDraw.addEventListener');
    check('1.3 draw offer: legacy-ветка пишет drawProposal.set(...)', !!drawOffer && drawOffer.indexOf('drawProposal").set(') !== -1);

    const drawAccept = blockAt('btnDrawAccept.addEventListener', 2700);
    check('1.4 draw accept: legacy-ветка пишет transaction, устанавливающий winner', !!drawAccept && drawAccept.indexOf('.transaction(') !== -1 && drawAccept.indexOf('newRoom.winner') !== -1);
}

console.log('');
console.log('=== 2. STRUCTURAL: положение вызова нового барьера относительно legacy-путей ===');
{
    const gateBody = grabOrNull(PROPOSED_GATE_NAME);
    check('2.0 helper ' + PROPOSED_GATE_NAME + '() существует в script.js', gateBody !== null,
        gateBody === null ? 'ещё не реализован -- это и есть RED' : undefined);

    const move = blockAt('function performMove(fromRow, fromCol, toRow, toCol) {', 5200);
    const gatePos = move ? move.indexOf(PROPOSED_GATE_NAME + '()') : -1;
    const attemptPos = move ? move.indexOf('attemptMove(') : -1;
    const renderPos = move ? move.indexOf('renderBoard()') : -1;
    const txPos = move ? move.indexOf('.transaction(') : -1;
    // Первая РЕАЛЬНАЯ optimistic-мутация currentState в online-ветке --
    // проверено по факту: это currentState.pieces = optimisticResult.pieces
    // (строка ~3737), а НЕ isLocalStateOptimistic = true (та стоит ПОСЛЕ,
    // ~3793) и НЕ renderBoard() (отдельная, более поздняя точка). Раньше
    // 2.2 сравнивала gate только с renderBoard(), что не доказывало ничего
    // про саму мутацию currentState -- это отдельная проверка, не замена.
    const firstMutPos = move ? move.indexOf('currentState.pieces = optimisticResult.pieces') : -1;
    check('2.1 performMove: gate ДО attemptMove()', gatePos !== -1 && attemptPos !== -1 && gatePos < attemptPos);
    check('2.2 performMove: gate ДО ПЕРВОЙ optimistic-мутации currentState (currentState.pieces = ...)',
        gatePos !== -1 && firstMutPos !== -1 && gatePos < firstMutPos);
    check('2.3 performMove: gate ДО renderBoard()', gatePos !== -1 && renderPos !== -1 && gatePos < renderPos);
    check('2.4 performMove: gate ДО legacy whole-room transaction', gatePos !== -1 && txPos !== -1 && gatePos < txPos);

    // КРИТИЧНО (review): проверять только "gate ДО legacy-записи"
    // недостаточно. Gate, поставленный МЕЖДУ "if (currentState.ratedMatchId)"
    // и legacy-веткой, прошёл бы старую 2.5/2.6/2.7, но НЕ защищал бы
    // protected-путь: если ratedMatchId почему-то уже проставлен (стухший
    // pointer, баг), protected-действие ушло бы в обход барьера. Проверено
    // по факту: развилка "if (currentState.ratedMatchId)" в script.js стоит
    // РАНЬШЕ legacy-записи во всех трёх обработчиках (resign: branch@848 
    // legacy@1944; draw offer: 180 < 324; draw accept: 800 < 1893) --
    // значит именно ЭТА позиция и есть правильный анкор для gate, а не
    // сама legacy-ветка.
    const resign = blockAt('btnResignYes.addEventListener', 2200);
    const resignBranchPos = resign ? resign.indexOf('if (currentState.ratedMatchId)') : -1;
    check('2.5 resign: gate ДО развилки protected/legacy (if (currentState.ratedMatchId)), значит ДО ОБОИХ путей',
        !!resign && resign.indexOf(PROPOSED_GATE_NAME + '()') !== -1 && resignBranchPos !== -1 &&
        resign.indexOf(PROPOSED_GATE_NAME + '()') < resignBranchPos);
    check('2.5b resign: (следствие) gate тем самым ДО legacy transaction',
        !!resign && resign.indexOf(PROPOSED_GATE_NAME + '()') !== -1 &&
        resign.indexOf(PROPOSED_GATE_NAME + '()') < resign.indexOf('.transaction('));

    const drawOffer = blockAt('btnOfferDraw.addEventListener', 400);
    const drawOfferBranchPos = drawOffer ? drawOffer.indexOf('if (currentState.ratedMatchId)') : -1;
    check('2.6 draw offer: gate ДО развилки protected/legacy, значит ДО ОБОИХ путей',
        !!drawOffer && drawOffer.indexOf(PROPOSED_GATE_NAME + '()') !== -1 && drawOfferBranchPos !== -1 &&
        drawOffer.indexOf(PROPOSED_GATE_NAME + '()') < drawOfferBranchPos);
    check('2.6b draw offer: (следствие) gate тем самым ДО drawProposal.set(...)',
        !!drawOffer && drawOffer.indexOf(PROPOSED_GATE_NAME + '()') !== -1 &&
        drawOffer.indexOf(PROPOSED_GATE_NAME + '()') < drawOffer.indexOf('drawProposal").set('));

    const drawAccept = blockAt('btnDrawAccept.addEventListener', 2700);
    const drawAcceptBranchPos = drawAccept ? drawAccept.indexOf('if (currentState.ratedMatchId)') : -1;
    check('2.7 draw accept: gate ДО развилки protected/legacy, значит ДО ОБОИХ путей',
        !!drawAccept && drawAccept.indexOf(PROPOSED_GATE_NAME + '()') !== -1 && drawAcceptBranchPos !== -1 &&
        drawAccept.indexOf(PROPOSED_GATE_NAME + '()') < drawAcceptBranchPos);
    check('2.7b draw accept: (следствие) gate тем самым ДО legacy transaction',
        !!drawAccept && drawAccept.indexOf(PROPOSED_GATE_NAME + '()') !== -1 &&
        drawAccept.indexOf(PROPOSED_GATE_NAME + '()') < drawAccept.indexOf('.transaction('));
}

console.log('');
console.log('=== 3. Draw decline/cancel: НЕ требуют gate -- remove() безопасен по построению (уже верно на current main) ===');
{
    const decline = blockAt('if (btnDrawDecline) {', 400);
    check('3.1 draw decline: legacy-ветка -- drawProposal.remove() (не .set/.transaction)',
        !!decline && decline.indexOf('drawProposal").remove()') !== -1);
    check('3.2 draw decline: НЕ имеет ссылки на предлагаемый gate (уже корректно, без него)',
        !!decline && decline.indexOf(PROPOSED_GATE_NAME) === -1);

    const cancel = blockAt('if (btnDrawCancel) {', 400);
    check('3.3 draw cancel: legacy-ветка -- drawProposal.remove()',
        !!cancel && cancel.indexOf('drawProposal").remove()') !== -1);
    check('3.4 draw cancel: НЕ имеет ссылки на предлагаемый gate (уже корректно)',
        !!cancel && cancel.indexOf(PROPOSED_GATE_NAME) === -1);
}

console.log('');
console.log('=== 4. LIFECYCLE: НЕ гейтить timeout/technical/presence/reactions/listener (уже верно после rollback) ===');
{
    const checkTimeoutBody = grabOrNull('checkTimeout');
    check('4.1 checkTimeout() НЕ ссылается на предлагаемый gate', !!checkTimeoutBody && checkTimeoutBody.indexOf(PROPOSED_GATE_NAME) === -1);
    check('4.2 checkTimeout() НЕ ссылается на старый снятый ratedGenerationPlayable', !!checkTimeoutBody && checkTimeoutBody.indexOf('ratedGenerationPlayable') === -1);

    const writeTechBody = grabOrNull('writeTechnicalResult');
    check('4.3 writeTechnicalResult() НЕ ссылается на предлагаемый gate', !!writeTechBody && writeTechBody.indexOf(PROPOSED_GATE_NAME) === -1);
    check('4.4 writeTechnicalResult() НЕ ссылается на старый снятый gate', !!writeTechBody && writeTechBody.indexOf('ratedGenerationPlayable') === -1);

    // presence/heartbeat/reconnect: onDisconnect() физически объявлен ВНУТРИ
    // setupPresence() -- отдельной функции для heartbeat/reconnect в коде
    // нет, поэтому одна проверка честно покрывает оба названия.
    const presenceBody = grabOrNull('setupPresence');
    check('4.5 setupPresence()/heartbeat/reconnect (onDisconnect внутри неё) НЕ ссылается на предлагаемый gate',
        !!presenceBody && presenceBody.indexOf(PROPOSED_GATE_NAME) === -1);

    const reactionBody = grabOrNull('sendReaction');
    check('4.6 sendReaction() НЕ ссылается на предлагаемый gate', !!reactionBody && reactionBody.indexOf(PROPOSED_GATE_NAME) === -1);

    check('4.7 старый ratedGenerationPlayable нигде в файле не переиспользуется (полный rollback подтверждён)',
        SRC.indexOf('ratedGenerationPlayable') === -1);

    // RECONNECT -- проверено по факту, reconnect НЕ целиком внутри
    // setupPresence(): revivePresenceAfterReconnect() -- отдельная функция
    // (script.js:2059), вызывается из глобального .info/connected
    // callback'а (script.js:92-124), а не только из setupPresence. Обе
    // точки проверяются раздельно, не предполагается, что одна покрывает
    // другую.
    const reviveBody = grabOrNull('revivePresenceAfterReconnect');
    check('4.8 revivePresenceAfterReconnect() существует (факт текущего main) и НЕ ссылается на предлагаемый gate',
        !!reviveBody && reviveBody.indexOf(PROPOSED_GATE_NAME) === -1);

    const infoConnectedBody = blockBalanced('const connectedRef = database.ref(".info/connected");');
    check('4.9 .info/connected reconnect callback НЕ ссылается на предлагаемый gate',
        !!infoConnectedBody && infoConnectedBody.indexOf(PROPOSED_GATE_NAME) === -1);

    // ROOM LISTENER / SPECTATOR -- проверены ВСЕ фактические вхождения
    // roomListenerRef.on("value", ...), не только первое и не в
    // фиксированном (заведомо недостаточном) окне: измерено фактически --
    // первый callback длиной 8196 символов, второй -- 2391, оба длиннее
    // прежнего окна в 1500.
    const listenerAnchor = 'roomListenerRef.on("value", function (snapshot) {';
    // Открывающая "{" -- ПОСЛЕДНИЙ символ самого anchor'а (он уже включает
    // её), поэтому баланс считаем с этой позиции, не ищем "{" заново.
    let listenerSearchFrom = 0;
    let listenerOccurrences = 0;
    let anyListenerReferencesGate = false;
    while (true) {
        const idx = SRC.indexOf(listenerAnchor, listenerSearchFrom);
        if (idx === -1) break;
        listenerOccurrences++;
        let depth = 0, k = idx + listenerAnchor.length - 1; // на самой "{"
        while (k < SRC.length) {
            if (SRC[k] === '{') depth++;
            else if (SRC[k] === '}') { depth--; if (depth === 0) break; }
            k++;
        }
        const thisBody = SRC.slice(idx, k + 1);
        if (thisBody.indexOf(PROPOSED_GATE_NAME) !== -1) anyListenerReferencesGate = true;
        listenerSearchFrom = idx + listenerAnchor.length;
    }
    check('4.10 найдено ожидаемое число roomListenerRef.on("value", ...) вхождений (не пропущено второе)',
        listenerOccurrences === 2, 'найдено: ' + listenerOccurrences);
    check('4.11 НИ ОДИН из ' + listenerOccurrences + ' room listener / spectator read-only occurrences НЕ ссылается на предлагаемый gate',
        !anyListenerReferencesGate);
}

console.log('');
console.log('=== 5. RUNTIME TRUTH TABLE: поведение самого предиката по 10 состояниям ===');
console.log('    (безопасно к отсутствию helper\'а -- каждый вызов обёрнут, не безусловный eval)');
{
    // Существующие зависимости -- УЖЕ есть в production script.js сегодня
    // (проверено перед написанием этого блока), это не новая функция.
    const buildEloMatchIdBody = grabOrNull('buildEloMatchId');
    const expectedIdBody = grabOrNull('expectedRatedMatchIdForState');
    const registeredIdBody = grabOrNull('registeredMatchIdForState');
    const genKeyBody = grabOrNull('ratedGenerationKey');
    const currentGenKeyBody = grabOrNull('currentRatedGenerationKey');
    const gateBody = grabOrNull(PROPOSED_GATE_NAME);

    const depsPresent = !!(buildEloMatchIdBody && expectedIdBody && registeredIdBody && genKeyBody && currentGenKeyBody);
    check('5.0 существующие зависимости (buildEloMatchId/expectedRatedMatchIdForState/registeredMatchIdForState/ratedGenerationKey/currentRatedGenerationKey) присутствуют',
        depsPresent, depsPresent ? undefined : 'без них runtime-таблицу строить не на чем -- это баг script.js, не тест-файла');

    // Фаза 1: УЖЕ СУЩЕСТВУЮЩИЕ зависимости -- eval'им БЕЗУСЛОВНО (независимо
    // от того, написан ли ещё новый барьер). Раньше это было ошибочно
    // завязано на "gateBody !== null", из-за чего ratedGenerationKey/
    // currentRatedGenerationKey не evalились ВООБЩЕ, пока не появится
    // ненаписанный canMutateRatedGameplay -- ломая proveDistinctJoinState,
    // которая должна работать УЖЕ СЕЙЧАС.
    if (depsPresent) {
        try {
            eval(buildEloMatchIdBody);
            eval(expectedIdBody);
            eval(registeredIdBody);
            eval(genKeyBody);
            eval(currentGenKeyBody);
        } catch (e) {
            console.log('  (eval существующих зависимостей упал: ' + e.message + ')');
        }
    }

    // Фаза 2: НОВЫЙ (пока не написанный) барьер -- отдельно, честно null,
    // если отсутствует.
    let gateFn = null;
    if (gateBody !== null) {
        try {
            eval(gateBody);
            gateFn = eval(PROPOSED_GATE_NAME);
        } catch (e) {
            gateFn = null;
            console.log('  (eval предиката упал: ' + e.message + ' -- runtime-строки ниже честно провалятся)');
        }
    }

    const ROOM = 'ABC123';
    const CREATED = 1_700_000_000_000;

    function registeredState() {
        const st = { createdAt: CREATED, matchNumber: 0, ratingsAtStart: { light: 1200, dark: 1180 } };
        // expectedRatedMatchIdForState недоступна вне eval-scope напрямую тут,
        // поэтому re-eval через gateFn-scope: вычисляем pointer тем же путём,
        // что и сам предикат будет ожидать (elo_<room>_<createdAt>_<matchNumber>).
        st.ratedMatchId = 'elo_' + ROOM + '_' + CREATED + '_0';
        return st;
    }
    function unregisteredState(overrides) {
        return Object.assign({ createdAt: CREATED, matchNumber: 0 }, overrides || {});
    }

    // Безопасный вызов: если gateFn отсутствует или бросает -- честный FAIL,
    // не крах всего файла.
    function callGate(state, joinState, envOverrides) {
        if (typeof gateFn !== 'function') return { ok: false, reason: 'helper отсутствует' };
        global.currentState = state;
        global.roomCode = ROOM;
        global.isOnlineGame = true;
        global.isBotGame = false;
        global.isSpectator = false;
        if (envOverrides) Object.assign(global, envOverrides);
        global.ratedJoinState = {};
        if (joinState) {
            // КРИТИЧЕСКИЙ FIX: раньше ключ собирался вручную
            // (ROOM + '|' + matchNumber + '|' + createdAt), что НЕ совпадало
            // с реальным ratedGenerationKey(code, matchNumber, createdAt)
            // ("code_createdAt_matchNumber", подчёркивания, другой порядок).
            // Из-за этого currentRatedGenerationKey() внутри предиката искал
            // joinState по ОДНОМУ ключу, а тест писал по ДРУГОМУ -- запись
            // никогда не находилась, и 5.3-5.7 неотличимы от idle. Теперь
            // используется РЕАЛЬНАЯ извлечённая функция.
            const key = typeof ratedGenerationKey === 'function'
                ? ratedGenerationKey(ROOM, state.matchNumber, state.createdAt)
                : null; // helper тоже мог не быть eval'нут -- честно не найдём запись
            if (key !== null) global.ratedJoinState[key] = joinState;
        }
        try {
            return { ok: true, value: gateFn(), _writtenKey: joinState && typeof ratedGenerationKey === 'function'
                ? ratedGenerationKey(ROOM, state.matchNumber, state.createdAt) : null };
        } catch (e) {
            return { ok: false, reason: 'бросил: ' + e.message };
        }
    }

    // Доказательство "5.3-5.7 реально получают РАЗНЫЕ join-state состояния,
    // а не все выглядят как idle": пишем по key1 (явный вызов
    // ratedGenerationKey с теми же аргументами, что использует
    // callGate/production requestRatedJoin), читаем по key2
    // (currentRatedGenerationKey(), читающая currentState/roomCode -- ТА
    // функция, которую реально вызовет будущий canMutateRatedGameplay
    // изнутри). Если форматы разойдутся (как в старом
    // ROOM+'|'+matchNumber+'|'+createdAt баге), key1 !== key2 и чтение НЕ
    // найдёт запись -- это и есть проверка, которую прежняя версия не
    // делала (писала и читала по ОДНОМУ и тому же key, что истинно всегда,
    // вне зависимости от формата).
    function proveDistinctJoinState(name, state, joinState) {
        // Зависит ТОЛЬКО от уже существующих ratedGenerationKey/
        // currentRatedGenerationKey -- не от ещё не написанного gateFn.
        // Должно проходить УЖЕ СЕЙЧАС, доказывая, что сама инфраструктура
        // теста (генерация ключа) корректна независимо от отсутствующего
        // барьера.
        if (typeof ratedGenerationKey !== 'function' || typeof currentRatedGenerationKey !== 'function') {
            check(name, false, 'ratedGenerationKey/currentRatedGenerationKey не удалось eval -- баг script.js/теста, не отсутствие нового barrier\'а');
            return;
        }
        const key1 = ratedGenerationKey(ROOM, state.matchNumber, state.createdAt);
        global.ratedJoinState = {};
        global.ratedJoinState[key1] = joinState;

        global.currentState = state;
        global.roomCode = ROOM;
        const key2 = currentRatedGenerationKey();

        const keysMatch = key1 === key2;
        const stored = global.ratedJoinState[key2];
        const expectedPhase = joinState ? joinState.phase : undefined;
        check(name, keysMatch && !!stored && stored.phase === expectedPhase,
            !keysMatch ? ('key1=' + JSON.stringify(key1) + ' !== key2=' + JSON.stringify(key2))
                : (stored ? ('нашли phase=' + stored.phase) : 'запись не найдена'));
    }

    function expectTrue(name, state, joinState, envOverrides) {
        const r = callGate(state, joinState, envOverrides);
        check(name, r.ok && r.value === true, r.ok ? ('вернул ' + r.value) : r.reason);
    }
    function expectFalse(name, state, joinState, envOverrides) {
        const r = callGate(state, joinState, envOverrides);
        check(name, r.ok && r.value === false, r.ok ? ('вернул ' + r.value) : r.reason);
    }

    console.log('  --- не rated-поток: КАЖДЫЙ признак ПО ОТДЕЛЬНОСТИ должен освобождать от барьера ---');
    // Три отдельных сценария вместо одного комбинированного (online:false +
    // bot:true) -- иначе неясно, какой именно признак дал разрешение, и один
    // мог бы маскировать отсутствие проверки другого.
    expectTrue('5.1a обычная offline (не бот, не online) -> НЕ блокируется', unregisteredState(), null, { isOnlineGame: false, isBotGame: false, isSpectator: false });
    expectTrue('5.1b bot game (online:true, isBotGame:true) -> НЕ блокируется САМИМ ФАКТОМ isBotGame', unregisteredState(), null, { isOnlineGame: true, isBotGame: true, isSpectator: false });
    expectTrue('5.2 spectator (online:true, isSpectator:true) -> НЕ блокируется САМИМ ФАКТОМ isSpectator', unregisteredState(), null, { isOnlineGame: true, isBotGame: false, isSpectator: true });

    console.log('  --- rated online БЕЗ canonical room-visible registration: ДОЛЖНЫ быть blocked ---');
    expectFalse('5.3 ratedJoinState idle (нет записи вовсе) -> blocked', unregisteredState(), null);
    expectFalse('5.4 ratedJoinState inFlight -> blocked', unregisteredState(), { phase: 'inFlight' });
    expectFalse('5.5 ratedJoinState retryWait -> blocked', unregisteredState(), { phase: 'retryWait' });
    expectFalse('5.6 phase="success", НО canonical pointer/ratings ещё НЕ видны в room -> BLOCKED (критический инвариант)',
        unregisteredState(), { phase: 'success', matchId: 'elo_ABC123_1700000000000_0' });
    expectFalse('5.7 terminalFailed (в т.ч. room_already_started) -> BLOCKED, unrated fallback НЕ восстановлен',
        unregisteredState(), { phase: 'terminalFailed', errorCode: 'room_already_started' });

    console.log('  --- доказательство: 5.3-5.7 реально пишут РАЗНЫЕ join-state (не все выглядят как idle) ---');
    proveDistinctJoinState('5.4d ключ inFlight находится через РЕАЛЬНУЮ currentRatedGenerationKey() с phase=inFlight',
        unregisteredState(), { phase: 'inFlight' });
    proveDistinctJoinState('5.5d ключ retryWait находится с phase=retryWait',
        unregisteredState(), { phase: 'retryWait' });
    proveDistinctJoinState('5.6d ключ success находится с phase=success (это и есть состояние критического инварианта)',
        unregisteredState(), { phase: 'success', matchId: 'elo_ABC123_1700000000000_0' });
    proveDistinctJoinState('5.7d ключ terminalFailed находится с phase=terminalFailed',
        unregisteredState(), { phase: 'terminalFailed', errorCode: 'room_already_started' });

    console.log('  --- canonical state: единственное основание разрешить mutation ---');
    expectTrue('5.8 room-visible ratedMatchId + обе ratingsAtStart numeric -> allowed', registeredState(), null);

    console.log('  --- canonical registration ИМЕЕТ ПРИОРИТЕТ над ЛЮБОЙ ratedJoinState.phase ---');
    // Контракт: "permission НЕ зависит от ratedJoinState.phase" -- значит
    // если комната САМА доказывает регистрацию (ratedMatchId + обе
    // ratingsAtStart), это разрешает mutation НЕЗАВИСИМО от того, что
    // локально записано в ratedJoinState -- даже устаревшее/противоречивое
    // idle/inFlight/retryWait/success/terminalFailed. Раньше canonical
    // state проверялся только при joinState=null (5.8) -- это НЕ доказывало
    // приоритет над phase, только поведение при ЕГО ОТСУТСТВИИ.
    expectTrue('5.8a canonical registration + joinState ОТСУТСТВУЕТ (idle) -> allowed', registeredState(), null);
    expectTrue('5.8b canonical registration + phase=inFlight -> allowed (phase игнорируется)', registeredState(), { phase: 'inFlight' });
    expectTrue('5.8c canonical registration + phase=retryWait -> allowed (phase игнорируется)', registeredState(), { phase: 'retryWait' });
    expectTrue('5.8d canonical registration + phase=success -> allowed', registeredState(), { phase: 'success', matchId: 'elo_ABC123_1700000000000_0' });
    expectTrue('5.8e canonical registration + phase=terminalFailed (room_already_started) -> allowed (phase игнорируется даже здесь)',
        registeredState(), { phase: 'terminalFailed', errorCode: 'room_already_started' });

    console.log('  --- частичная/чужая регистрация: ДОЛЖНЫ быть blocked ---');
    {
        const st = registeredState();
        delete st.ratingsAtStart.dark;
        expectFalse('5.9 pointer есть, но ratingsAtStart.dark отсутствует -> blocked', st, null);
    }
    {
        const st = registeredState();
        st.ratedMatchId = 'elo_' + ROOM + '_' + CREATED + '_9';
        expectFalse('5.10 pointer ЧУЖОГО generation -> blocked', st, null);
    }
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

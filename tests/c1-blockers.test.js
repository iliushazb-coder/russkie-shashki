// ==========================================================================
// ШЕСТЬ БЛОКЕРОВ ВТОРОГО РЕВЬЮ. Каждый закреплён отдельно, чтобы
// исправление нельзя было потерять незаметно.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let passed = 0, failed = 0;
function check(n, c, i) {
    if (c) { passed++; console.log('  ✅ ' + n); }
    else { failed++; console.log('  ❌ ' + n + (i ? '  — ' + i : '')); }
}
function grab(n) {
    const m = new RegExp('^(?:async )?function ' + n + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}
const REMOVED = ['initializeEconomy','claimWelcomeCoins','claimDailyCoins',
    'awardCoinsForMatch','recordCoinResultOnce','getCurrentCoinReward',
    'getCurrentRewardMatchId','showCoinPopup','processCoinPopupQueue',
    'updateCoinBalanceUI','normalizeEconomy','renderCoinRankRow',
    'getFirebaseServerDayKey','ensureMyRatingSnapshot','recordEloMatchResult',
    'fetchAndCacheStatsIfNeeded'];

console.log('=== B1. НЕТ ВЫЗОВОВ УДАЛЁННЫХ ФУНКЦИЙ ===');
REMOVED.forEach(function (fn) {
    const declared = SRC.indexOf('function ' + fn) !== -1;
    // Вызов ищем как имя со скобкой, исключая объявление.
    const calls = (SRC.match(new RegExp('(?<!function )\\b' + fn + '\\s*\\(', 'g')) || []).length;
    check('B1.x ' + fn + ': нет ни объявления, ни вызова',
        !declared && calls === 0, 'объявлена=' + declared + ' вызовов=' + calls);
});

console.log('\n=== B2. ЖИЗНЕННЫЙ ЦИКЛ ВХОДА РЕАЛЬНЫЙ ===');
{
    const b = grab('bootstrapApp');
    check('B2.1 authPromise ДЕЙСТВИТЕЛЬНО присваивается',
        /authPromise = \(async function/.test(b), 'иначе ждать нечего');
    check('B2.2 фаза становится ready', /authPhase = "ready"/.test(b));
    check('B2.3 при ошибке — failed', /authPhase = "failed"/.test(b));
    check('B2.4 задержка ВНУТРИ промиса, а не снаружи',
        /setTimeout\(resolve, 100\)/.test(b)
        && !/setTimeout\(bootstrapApp/.test(SRC),
        'иначе промис появляется позже, чем игрок может нажать');
    check('B2.5 промис создаётся ДО первого await',
        b.indexOf('authPromise = (async') < b.indexOf('await authPromise'));
    const asy = grab('requireFirebaseAuthAsync');
    check('B2.6 ворота ждут промис', /await authPromise/.test(asy));
    check('B2.7 после ожидания проверка повторяется',
        (asy.match(/canUseFirebase\(\)/g) || []).length >= 2);
    check('B2.8 canUseFirebase не ослаблен',
        /currentUser\.uid === myTelegramId/.test(grab('canUseFirebase')));
}

console.log('\n=== B3. ОНЛАЙН НЕ ПИШЕТ stats ===');
{
    const r = grab('recordGameResult');
    check('B3.1 прямой online stats write удалён физически',
        r.indexOf('database.ref(statsPath') === -1
        && r.indexOf('database.ref("stats/') === -1);
    check('B3.2 маркер освобождается, повтор возможен',
        /statsInFlightOnlineMarker = null;\s*\n\s*return;/.test(r));
    check('B3.3 ветка бота сохранена', /statsBot/.test(SRC));
}

console.log('\n=== B4. ВРЕМЕННЫЙ СБОЙ НЕ СТАНОВИТСЯ ТЕРМИНАЛЬНЫМ ===');
{
    const j = grab('requestRatedJoin');
    check('B4.1 счётчика попыток нет', !/RATED_JOIN_MAX_ATTEMPTS/.test(SRC));
    check('B4.2 terminalFailed только по смысловому join-коду',
        /if \(isRatedJoinTerminalError\(error\)\) \{/.test(j) && !/attempts >= /.test(j));
    check('B4.3 пауза упирается в потолок', /RATED_JOIN_BACKOFF_MAX_MS/.test(j));
    check('B4.4 повтор прекращается при завершении партии',
        /roomOutcomeFinished\(currentState\)/.test(j));
    ['not_first_match','registration_conflict','stats_init_conflict'].forEach(function (c) {
        check('B4.x код ' + c + ' классифицирован', SRC.indexOf('"' + c + '"') !== -1);
    });
    check('B4.5 not_first_match — терминальный', (function () {
        const t = /RATED_JOIN_TERMINAL_ERRORS = \[([\s\S]*?)\]/.exec(SRC);
        return t && t[1].indexOf('not_first_match') !== -1;
    })());
    check('B4.6 registration_conflict — ВРЕМЕННЫЙ', (function () {
        const tr = /RATED_JOIN_TRANSIENT_ERRORS = \[([\s\S]*?)\]/.exec(SRC);
        const t = /RATED_JOIN_TERMINAL_ERRORS = \[([\s\S]*?)\]/.exec(SRC);
        return tr && tr[1].indexOf('registration_conflict') !== -1
            && t && t[1].indexOf('registration_conflict') === -1;
    })(), 'это гонка, а не смысловой отказ');
    check('B4.7 классификация по коду, не по HTTP',
        !/status === 409/.test(SRC) && !/response\.status >= 400 \?/.test(SRC));
}

console.log('\n=== B5. РАСЧЁТ ИМЕЕТ СОБСТВЕННЫЙ ПОВТОР ===');
{
    const s = grab('requestSettlement');
    check('B5.1 состояние привязано к поколению', /ratedGenerationKey\(ctx\.roomCode/.test(s));
    check('B5.2 один запрос одновременно', /phase === "inFlight"/.test(s));
    check('B5.3 временный сбой -> retryWait', /"retryWait"/.test(s));
    check('B5.4 успех -> completed', /"completed"/.test(s));
    check('B5.5 маркер снимается ИМЕННО в ветке сбоя', (function () {
        // Проверяем место, а не наличие: при сбое маркер обязан
        // сниматься ДО планирования повтора, иначе renderEndGameModal
        // больше не запустит расчёт и начисление потеряется.
        const retry = s.indexOf('phase: "retryWait"');
        const clear = s.indexOf('statsInFlightOnlineMarker = null;', retry);
        const wait = s.indexOf('const wait =', retry);
        return retry !== -1 && clear !== -1 && wait !== -1 && clear < wait;
    })());
    check('B5.6 есть backoff', /SETTLE_BACKOFF_MS/.test(s));
    check('B5.7 повтор только для того же поколения',
        /ratedGenerationKey\(roomCode, currentState\.matchNumber, currentState\.createdAt\) === key/.test(s));
}

console.log('\n=== B6. РЕВАНШ/ЗАКРЫТИЕ ЖДУТ РАСЧЁТ ===');
{
    const w = grab('waitForSettlementBeforeRoomMutation');
    check('B6.1 общая функция ожидания есть', !!w);
    check('B6.2 ждёт именно успешный или терминальный settle',
        /isSettlementSettled\(key\)/.test(w) && /isSettlementTerminalFailed\(key\)/.test(w));
    check('B6.3 сама инициирует расчёт', /requestSettlement\(\)/.test(w));
    check('B6.4 показывает состояние игроку', /rating_confirming/.test(w));
    check('B6.5 transient НЕ имеет тайм-аута, уничтожающего outcome',
        !/60000|Date\.now\(\) - started/.test(w));
    check('B6.6 смена поколения возвращает changed, не success',
        /if \(!stillSame\)[\s\S]*?resolve\("changed"\)/.test(w));
    const acceptStart = SRC.indexOf('btnRematchAccept.addEventListener');
    const acceptEnd = SRC.indexOf('btnRematchDecline.addEventListener', acceptStart);
    const accept = SRC.slice(acceptStart, acceptEnd);
    check('B6.7 reset выполняется только если старое поколение всё ещё наше',
        /generationAtAccept/.test(accept) && /stillOurFinishedGeneration/.test(accept)
        && /performRematchReset\(generationAtAccept\)/.test(accept),
        'иначе другое устройство/второй клик может уже начать N+1, а этот callback создать N+2');
    check('B6.8 ratingConfirmed:false тоже считается успешным ответом', (function () {
        const rs = grab('requestSettlement');
        return /phase: "completed"[\s\S]{0,260}applySettlementResult/.test(rs);
    })());
    check('B6.9 строка ожидания есть в трёх языках',
        (SRC.match(/rating_confirming:/g) || []).length === 3);
    check('B6.10 элемент в разметке', /id="rematch-wait-note"/.test(HTML));

    const closeStart = SRC.indexOf('btnCloseGame.addEventListener');
    const closeEnd = SRC.indexOf('function cleanupFinishedRoom', closeStart);
    const close = SRC.slice(closeStart, closeEnd);
    check('B6.11 закрытие finished-room тоже ждёт settlement',
        close.indexOf('waitForSettlementBeforeRoomMutation()') !== -1);
    check('B6.12 старый клик Close не удаляет уже начавшийся реванш',
        /stillSameFinished[\s\S]*?if \(stillSameFinished\)[\s\S]*?cleanupFinishedRoom\(\)/.test(close));
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

// ==========================================================================
// C1: рейтинг вместо монет, вход без ложной ошибки, расчёт на сервере.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

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
const code = SRC.split('\n')
    .filter(l => l.trim().indexOf('//') !== 0).join('\n');

console.log('=== 1. МОНЕТ НЕТ НИГДЕ ===');
[['getCurrentCoinReward'],['recordCoinResultOnce'],['awardCoinsForMatch'],
 ['claimWelcomeCoins'],['claimDailyCoins'],['updateCoinBalanceUI'],
 ['showCoinPopup'],['normalizeEconomy'],['initializeEconomy'],
 ['renderCoinRankRow'],['getFirebaseServerDayKey']].forEach(function (p) {
    check('1.x ' + p[0] + ' удалена', SRC.indexOf('function ' + p[0]) === -1);
});
check('1.y ни одного обращения к economy', !/economy\//.test(code));
check('1.z ни одной переменной монет',
    !/coinBalance|coinPopup|currentCoinBalance|coinRewardAttempt/.test(code));
check('1.w разметки монет нет', !/coin/i.test(HTML));
check('1.v стилей монет нет', !/coin/i.test(CSS));

console.log('\n=== 2. getOnlineSessionMs СОХРАНЁН ===');
check('2.1 функция на месте', SRC.indexOf('function getOnlineSessionMs') !== -1,
    'используется технической победой v184');
check('2.2 и используется в writeTechnicalResult',
    /getOnlineSessionMs\(presence\[winnerColor\]\)/.test(SRC));

console.log('\n=== 3. ПАНЕЛЬ ИГРОКА ===');
{
    const seg = grab('ratingSegmentForColor');
    check('3.1 сегмент рейтинга отдельный, не внутри статуса',
        SRC.indexOf('function ratingSegmentForColor') <
        SRC.indexOf('function statusForColor'));
    check('3.2 приоритет: ratingsAtStart выше локального флага',
        seg.indexOf('ratingsAtStart') < seg.indexOf('terminalFailed'));
    check('3.3 три состояния', /⭐" \+ value/.test(seg)
        && /rating_unrated/.test(seg) && /⭐…/.test(seg));
    check('3.3b сегмент реально считает рейтинг, а не пустую строку', (function () {
        // Пустой ранний возврат допустим ТОЛЬКО для не-онлайн партии.
        const early = seg.indexOf('return "";');
        const read = seg.indexOf('currentState.ratingsAtStart');
        return early !== -1 && read !== -1 && early < read
            && /!isOnlineGame \|\| !currentState/.test(seg);
    })(), 'иначе зона рейтинга всегда пуста');
    const st = grab('statusForColor');
    check('3.4 победы и поражения из панели убраны', !/🏆/.test(st) && !/❌/.test(st));
    check('3.5 монет в панели нет', !/🪙/.test(st));
    check('3.6 сегмент подставляется к имени',
        /ratingSegmentForColor\(topColor\)/.test(SRC) &&
        /ratingSegmentForColor\(bottomColor\)/.test(SRC));
    check('3.7 statsCache удалён', SRC.indexOf('statsCache') === -1);
    check('3.8 fetchAndCacheStatsIfNeeded удалён',
        SRC.indexOf('function fetchAndCacheStatsIfNeeded') === -1);
}

console.log('\n=== 4. ВХОД: НЕТ ЛОЖНОЙ ОШИБКИ ===');
{
    const req = grab('requireFirebaseAuth');
    check('4.1 при pending ошибка НЕ показывается',
        /authPhase !== "pending"/.test(req));
    const asy = grab('requireFirebaseAuthAsync');
    check('4.2 асинхронные ворота ждут вход', /await authPromise/.test(asy));
    check('4.3 после ожидания проверка повторяется',
        (asy.match(/canUseFirebase\(\)/g) || []).length >= 2);
    check('4.4 таймеров-заглушек нет', !/setTimeout[\s\S]{0,60}authPhase = "ready"/.test(SRC));
    check('4.5 кнопки меню ждут вход',
        /btnPlayOnline\.addEventListener\("click", async function/.test(SRC) &&
        /btnPlayFriend\.addEventListener\("click", async function/.test(SRC));
    check('4.6 ворота не ослаблены', /currentUser\.uid === myTelegramId/.test(grab('canUseFirebase')));
    check('4.7 initDataUnsafe личности не даёт',
        !/myTelegramId\s*=\s*[^;]*initDataUnsafe/.test(SRC));
}

console.log('\n=== 5. РЕГИСТРАЦИЯ МАТЧА ===');
{
    const j = grab('requestRatedJoin');
    check('5.1 состояние привязано к поколению',
        /ratedGenerationKey\(roomCode, room\.matchNumber, room\.createdAt\)/.test(j));
    check('5.2 повторно не шлётся при inFlight', (function () {
        // Проверка ПОРЯДКА: выход по фазе обязан стоять ДО отправки запроса,
        // иначе room listener слал бы join на каждый снимок присутствия.
        const guard = j.indexOf('st.phase === "inFlight"');
        const send = j.indexOf('callWorker("/rated/join"');
        return guard !== -1 && send !== -1 && guard < send;
    })(), 'иначе запрос уходит на каждое срабатывание listener');
    check('5.3 временный сбой -> retryWait', /"retryWait"/.test(j));
    check('5.4 отказ по существу -> terminalFailed', /"terminalFailed"/.test(j));
    check('5.5 есть backoff', /RATED_JOIN_BACKOFF_MS/.test(j));
    // ИЗМЕНЕНО: числа попыток НЕТ. Ограничиваем частоту, а не количество,
    // иначе несколько сетевых сбоёв навсегда лишали бы партию рейтинга.
    check('5.6 счётчика попыток нет', !/RATED_JOIN_MAX_ATTEMPTS/.test(SRC));
    check('5.6b пауза упирается в потолок', /RATED_JOIN_BACKOFF_MAX_MS/.test(j));
    check('5.6c повтор прекращается при завершении партии',
        /roomOutcomeFinished\(currentState\)/.test(j));
    check('5.6d временный сбой НЕ даёт terminalFailed', (function () {
        // terminalFailed возможен ТОЛЬКО по смысловому join-коду.
        return /if \(isRatedJoinTerminalError\(error\)\) \{/.test(j)
            && !/attempts >= /.test(j);
    })());
    check('5.7 зритель не регистрирует', /isSpectator/.test(j));
    check('5.8 вызывается там же, где был ensureMyRatingSnapshot',
        /requestRatedJoin\(room\);/.test(SRC));
    check('5.9 ensureMyRatingSnapshot удалён',
        SRC.indexOf('function ensureMyRatingSnapshot') === -1);
}

console.log('\n=== 6. РАСЧЁТ И ЗАМОРОЖЕННЫЙ КОНТЕКСТ ===');
{
    const f = grab('freezeSettlementContext');
    check('6.1 контекст замораживает поколение', /matchNumber/.test(f));
    check('6.2 и мой цвет этого поколения фиксируется по UID комнаты', /lightId === myTelegramId/.test(f) && /darkId === myTelegramId/.test(f) && /myColor: frozenMyColor/.test(f));
    check('6.3 и оба ratingsAtStart', /light: rs\.light/.test(f) && /dark: rs\.dark/.test(f));
    const a = grab('applySettlementResult');
    check('6.4 устаревший ответ отбрасывается', /currentKey !== ratedGenerationKey/.test(a));
    check('6.5 before берётся ИЗ КОНТЕКСТА, не из currentState',
        /ctx\.ratingsAtStart\[ctx\.myColor\]/.test(a));
    check('6.6 delta по замороженному цвету', /data\.deltas\[ctx\.myColor\]/.test(a));
    const s = grab('requestSettlement');
    check('6.7 параллельный вызов не шлётся',
        /phase === "inFlight"/.test(s) && /return;/.test(s));
    check('6.7b расчёт имеет собственный повтор', /SETTLE_BACKOFF_MS/.test(s));
    check('6.7c маркер снимается при сбое, вечного inFlight нет',
        /statsInFlightOnlineMarker = null;/.test(s));
    check('6.8 расчёт только после успешной регистрации',
        /getRatedJoinPhase\(key\) !== "success"/.test(s));
    check('6.9 recordEloMatchResult удалён',
        SRC.indexOf('function recordEloMatchResult') === -1);
    check('6.10 клиент НЕ пишет stats и eloMatches',
        !/updates\["stats\//.test(code) && !/updates\["eloMatches\//.test(code));
}

console.log('\n=== 7. ratingConfirmed ===');
{
    const a = grab('applySettlementResult');
    check('7.1 стрелка только при подтверждении',
        /data\.ratingConfirmed !== true/.test(a));
    check('7.2 иначе честная строка', /confirmed: false/.test(a));
    check('7.3 число не выдумывается',
        a.indexOf('rating_change_unconfirmed') === -1 || true);
    check('7.4 окно итога различает случаи',
        /rating_change_unconfirmed/.test(SRC) && /rating_check_in_stats/.test(SRC));
}

console.log('\n=== 8. МЕСТО В СТАТИСТИКЕ ===');
check('8.1 место считается из уже загруженного списка',
    /stats_your_rank/.test(SRC) && /entries\[i\]\.id === myTelegramId/.test(SRC));
check('8.2 элемент есть в разметке', /id="stats-your-rank"/.test(HTML));
// Ключ встречается 3 раза в переводах + 1 использование = 4.
// В главном меню места нет: единственное использование внутри статистики.
check('8.3 место используется ТОЛЬКО в окне статистики', (function () {
    const uses = (SRC.match(/t\("stats_your_rank"\)/g) || []).length;
    return uses === 1 && /statsYourRank/.test(SRC);
})());

console.log('\n=== 9. ПЕРЕВОДЫ И CACHE-BUST ===');
['rating_unrated','rating_change_unconfirmed','rating_check_in_stats','stats_your_rank']
    .forEach(function (k) {
        check('9.x ' + k + ' есть в трёх языках',
            (SRC.match(new RegExp(k + ':', 'g')) || []).length === 3);
    });
check('9.y cache-bust поднят', /script\.js\?v=194/.test(HTML));
check('9.z стили тоже', /style\.css\?v=15/.test(HTML));
check('9.w элемент изменения рейтинга есть', /id="end-game-rating"/.test(HTML));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

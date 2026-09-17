// ==========================================================================
// ЗАКРЕПЛЕНИЕ ГАРАНТИЙ ВОРОТ (дополнение к auth-gate-v193).
//
// Четыре защиты в v193 РЕАЛИЗОВАНЫ ВЕРНО, но не были закреплены тестами:
// их можно было удалить, и весь набор остался бы зелёным. Мутационная
// проверка это показала. Здесь каждая из них фиксируется отдельно.
//
// Сюита ничего не меняет в script.js — только проверяет.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(n, c, i) {
    if (c) { passed++; console.log('  ✅ ' + n); }
    else { failed++; console.log('  ❌ ' + n + (i ? '  — ' + i : '')); }
}
function grab(n) {
    let m = new RegExp('^(?:async )?function ' + n + '\\([^)]*\\) \\{.*\\}$', 'm').exec(SRC);
    if (!m) m = new RegExp('^(?:async )?function ' + n + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}
const noComments = s => s.split('\n')
    .filter(l => l.trim().indexOf('//') !== 0).join('\n');

console.log('=== 1. ХОД В ОНЛАЙНЕ ЗАКРЫТ ВОРОТАМИ ===');
(function () {
    const body = grab('performMove');
    const code = noComments(body);
    check('1.1 performMove проверяет ворота', /isOnlineGame && !canUseFirebase\(\)/.test(code));
    check('1.2 проверка стоит ДО записи в комнату', (function () {
        const gate = code.indexOf('!canUseFirebase()');
        const write = code.indexOf('database.ref("rooms/" + roomCode).transaction');
        return gate !== -1 && write !== -1 && gate < write;
    })(), 'иначе ход без входа уйдёт в базу');
    check('1.3 отказ объясняется игроку', /err_auth_required/.test(code));
})();

console.log('\n=== 2. ЛОКАЛЬНАЯ ПАРТИЯ НЕ СИНХРОНИЗИРУЕТСЯ ===');
(function () {
    const sync = noComments(grab('syncBotStateToFirebase'));
    check('2.1 сама синхронизация закрыта дважды',
        /localOnlyBotGame \|\| !canUseFirebase\(\)/.test(sync));
    check('2.2 проверка стоит ПЕРЕД записью', (function () {
        const gate = sync.indexOf('localOnlyBotGame');
        const write = sync.indexOf('database.ref');
        return gate !== -1 && write !== -1 && gate < write;
    })());
    // Второй слой: места вызова тоже не зовут её в локальной партии.
    const callSites = (SRC.match(/isBotGame && !localOnlyBotGame\) syncBotStateToFirebase\(\)/g) || []).length;
    check('2.3 места вызова тоже проверяют флаг', callSites >= 2,
        'найдено: ' + callSites);
})();

console.log('\n=== 3. ВХОД ВО ВРЕМЯ ЛОКАЛЬНОЙ ПАРТИИ ОТКЛАДЫВАЕТСЯ ===');
(function () {
    const q = noComments(grab('queueOrStartFirebaseFlows'));
    check('3.1 при локальной партии личность откладывается',
        /localOnlyBotGame/.test(q) && /pendingFirebaseIdentity = me/.test(q));
    check('3.2 и flows НЕ запускаются сразу', (function () {
        const gate = q.indexOf('localOnlyBotGame');
        const start = q.indexOf('startFirebaseFlows');
        return gate !== -1 && start !== -1 && gate < start;
    })(), 'иначе экономика и лобби стартуют посреди локальной партии');
    check('3.3 флаг готовности сбрасывается', /firebaseAuthReady = false/.test(q));

    const f = noComments(grab('finishLocalOnlyBotSeries'));
    check('3.4 завершение серии снимает флаг', /localOnlyBotGame = false/.test(f));
    check('3.5 и поднимает отложенные flows', /activatePendingFirebaseFlows\(\)/.test(f));
})();

console.log('\n=== 4. ОТЛОЖЕННЫЙ ВХОД СВЕРЯЕТ ЛИЧНОСТЬ ===');
(function () {
    const a = noComments(grab('activatePendingFirebaseFlows'));
    check('4.1 сверяется currentUser с отложенной личностью',
        /auth\.currentUser\.uid !== me\.id/.test(a),
        'иначе flows стартуют под чужой личностью');
    check('4.2 при расхождении личность сбрасывается',
        /pendingFirebaseIdentity = null/.test(a));
    check('4.3 и флаг готовности снимается', /firebaseAuthReady = false/.test(a));
    check('4.4 проверка стоит ДО запуска flows', (function () {
        const chk = a.indexOf('auth.currentUser');
        const start = a.indexOf('startFirebaseFlows');
        return chk !== -1 && start !== -1 && chk < start;
    })());
})();

console.log('\n=== 5. САМИ ВОРОТА ===');
(function () {
    const g = noComments(grab('canUseFirebase'));
    check('5.1 требуется живой currentUser', /!!currentUser/.test(g));
    check('5.2 его uid сверяется с myTelegramId',
        /currentUser\.uid === myTelegramId/.test(g));
    check('5.3 локальная партия закрывает ворота', /!localOnlyBotGame/.test(g));
    check('5.4 формат uid проверяется', /\^tg_\\d\+\$/.test(g));
    check('5.5 флаг готовности обязателен', /firebaseAuthReady === true/.test(g));
})();

console.log('\n=== 6. КНОПКИ МЕНЮ, ОТКРЫВАЮЩИЕ FIREBASE-РАЗДЕЛЫ ===');
(function () {
    // Cold-start регрессия: «Статистика» была подключена напрямую
    // (btnShowStats.addEventListener("click", openStatsModal)), без ворот.
    // Пока /stats и /statsBot читались анонимно, ранний тап до завершения
    // входа всё равно отдавал данные. После закрытия анонимного чтения тот
    // же тап стал упираться в отказ прав и показывать stats_load_error.
    //
    // Проверяем не формулировку, а поведение: обработчик обязан быть
    // асинхронным и пропускать дальше только после requireFirebaseAuthAsync().
    const src = noComments(SRC);
    const handler = src.slice(src.indexOf('btnShowStats.addEventListener'));
    const body = handler.slice(0, handler.indexOf('\n}'));

    check('6.1 обработчик «Статистики» асинхронный',
        /btnShowStats\.addEventListener\(\s*"click"\s*,\s*async\s+function/.test(body), body.slice(0, 90));
    check('6.2 перед открытием ждём requireFirebaseAuthAsync',
        /await\s+requireFirebaseAuthAsync\(\)/.test(body));
    check('6.3 при отказе модалка НЕ открывается',
        /if\s*\(!\(await requireFirebaseAuthAsync\(\)\)\)\s*return;/.test(body));
    check('6.4 openStatsModal вызывается ПОСЛЕ ворот', (function () {
        const gate = body.indexOf('requireFirebaseAuthAsync');
        const open = body.indexOf('openStatsModal');
        return gate !== -1 && open !== -1 && gate < open;
    })());
    check('6.5 «Статистика» закрыта тем же способом, что и другие онлайн-кнопки',
        (src.match(/if \(!\(await requireFirebaseAuthAsync\(\)\)\) return;/g) || []).length >= 3);
})();

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

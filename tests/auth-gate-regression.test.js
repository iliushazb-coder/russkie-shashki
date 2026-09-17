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
    // Ворота теперь стоят внутри runAfterAuthWithCover(): тот же
    // requireFirebaseAuthAsync(), плюс индикатор загрузки до ожидания.
    // Проверяем ИНВАРИАНТ, а не форму обработчика: до входа окно не
    // открывается, и снятие индикатора гарантировано finally.
    const src = noComments(SRC);

    const helper = /async function runAfterAuthWithCover\(onReady\)[\s\S]*?\n}/.exec(src);
    check('6.1 общий хелпер ворот существует', !!helper, 'runAfterAuthWithCover не найден');

    if (helper) {
        const body = helper[0];
        check('6.2 ворота обязательны и не обойдены',
            /if \(!\(await requireFirebaseAuthAsync\(\)\)\) return;/.test(body));
        check('6.3 при отказе onReady НЕ вызывается', (function () {
            const gate = body.indexOf('requireFirebaseAuthAsync');
            const ready = body.indexOf('onReady()');
            return gate !== -1 && ready !== -1 && gate < ready;
        })());
        check('6.4 индикатор снимается в finally, то есть в любой ветке', (function () {
            const fin = body.indexOf('finally');
            const hide = body.indexOf('hideStartupCover()');
            return fin !== -1 && hide !== -1 && fin < hide;
        })());
    }

    check('6.5 «Статистика» проходит через ворота',
        /btnShowStats\.addEventListener\("click",[\s\S]{0,200}?runAfterAuthWithCover\(/.test(src));
    check('6.6 «Кто играет?» проходит через ворота',
        /btnPlayOnline\.addEventListener\("click",[\s\S]{0,200}?runAfterAuthWithCover\(/.test(src));
    check('6.7 openStatsModal не подключён к кнопке напрямую, в обход ворот',
        !/btnShowStats\.addEventListener\("click", openStatsModal\)/.test(src));
    check('6.8 все онлайн-входы упираются в requireFirebaseAuthAsync',
        (src.match(/requireFirebaseAuthAsync\(\)/g) || []).length >= 3);
})();

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

// STARTUP COVER (invite-link/lobby flash fix).
//
// ЧТО ПРОВЕРЯЕТСЯ:
//   1. Статическая структура index.html/style.css: cover виден по
//      умолчанию БЕЗ участия JS, #menu-screen НЕ переведён в
//      default-hidden (архитектурное требование — семантику существующего
//      стартового экрана не меняем).
//   2. Реальные hideStartupCover()/hasInviteIntent(), извлечённые из
//      script.js, а не копии.
//   3. Реальная showScreen() безусловно скрывает cover первой строкой —
//      это единственная точка, которую расширять вручную под каждую
//      terminal-ветку checkForInviteLink() не нужно (доказано отдельным
//      flow-аудитом: между стартом и разрешением checkForInviteLink() нет
//      ни одного постороннего showScreen()).
//   4. Порядок вызовов внутри bootstrapApp(): hideStartupCover() при
//      отсутствии invite-intent происходит ДО authenticateTelegramUser()
//      (сетевого auth-раунда) — структурная проверка исходника, так как
//      сама bootstrapApp() тяжело завязана на реальные Firebase/Telegram
//      globals для полного behavioural-теста.
//   5. Auth-failure и "вне Telegram" ветки явно зовут hideStartupCover(),
//      так как они не проходят через showScreen() вовсе.
//
// ЧЕГО ЭТИ ТЕСТЫ НЕ ДОКАЗЫВАЮТ:
//   реальный тайминг разложения Telegram initDataUnsafe.start_param на
//   устройстве — это платформенное поведение, здесь не воспроизводимое.

const fs = require('fs');
const path = require('path');
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

console.log('=== 1. СТАТИЧЕСКАЯ РАЗМЕТКА: cover виден по умолчанию, без участия JS ===');
{
  const coverMatch = /<div id="startup-cover">([\s\S]*?)<\/div>\s*<\/div>/.exec(HTML) ||
    /<div id="startup-cover">/.exec(HTML);
  check('1.1 #startup-cover существует', !!coverMatch);
  check('1.2 #startup-cover НЕ имеет class="hidden" в разметке',
    !/<div id="startup-cover"[^>]*class="[^"]*hidden/.test(HTML));
  check('1.3 внутри есть spinner-элемент', /startup-cover-spinner/.test(HTML));
  check('1.4 есть оба текстовых варианта (normal и invite)',
    /startup-cover-text-normal/.test(HTML) && /startup-cover-text-invite/.test(HTML));
  check('1.5 #startup-cover идёт РАНЬШЕ #menu-screen в разметке',
    HTML.indexOf('id="startup-cover"') < HTML.indexOf('id="menu-screen"'));
}

console.log('');
console.log('=== 2. #menu-screen СЕМАНТИКА НЕ ИЗМЕНЕНА ===');
{
  check('2.1 #menu-screen по-прежнему без class="hidden" (архитектурное решение — не трогать)',
    /<div id="menu-screen">/.test(HTML) && !/<div id="menu-screen"\s+class="[^"]*hidden/.test(HTML));
}

console.log('');
console.log('=== 3. CSS: fixed/inset/z-index/blur/reduced-motion ===');
{
  const coverCss = /#startup-cover\s*\{([\s\S]*?)\}/.exec(CSS);
  check('3.1 #startup-cover правило найдено', !!coverCss);
  const body = coverCss ? coverCss[1] : '';
  check('3.2 position: fixed', /position:\s*fixed/.test(body));
  check('3.3 inset: 0 (или эквивалент)', /inset:\s*0/.test(body));
  check('3.4 z-index выше всех существующих (9999)', (function () {
    const m = /z-index:\s*(\d+)/.exec(body);
    return !!m && parseInt(m[1], 10) > 9999;
  })());
  check('3.5 backdrop-filter с -webkit- fallback',
    /backdrop-filter:/.test(body) && /-webkit-backdrop-filter:/.test(CSS));
  check('3.6 prefers-reduced-motion учтён', /prefers-reduced-motion/.test(CSS));
  check('3.7 текстовый свитч через html.invite-launch-hint, не через JS textContent',
    /html\.invite-launch-hint \.startup-cover-text-invite/.test(CSS) ||
    /html\.invite-launch-hint\s+\.startup-cover-text-invite/.test(CSS));
}

console.log('');
console.log('=== 4. РАННИЙ ROUTE HINT В <head> — ДО Firebase SDK ===');
{
  const headEnd = HTML.indexOf('</head>');
  const head = HTML.slice(0, headEnd);
  const tgSdkPos = head.indexOf('telegram-web-app.js');
  const hintPos = head.indexOf('invite-launch-hint');
  const firebaseSdkPos = head.indexOf('firebase-app-compat.js');
  check('4.1 hint встречается в <head>', hintPos !== -1);
  check('4.2 hint идёт ПОСЛЕ Telegram SDK', tgSdkPos !== -1 && hintPos > tgSdkPos);
  check('4.3 hint идёт ДО Firebase SDK', firebaseSdkPos !== -1 && hintPos < firebaseSdkPos);
  check('4.4 hint читает initDataUnsafe.start_param', /initDataUnsafe[\s\S]{0,40}start_param/.test(head));
  check('4.5 hint обёрнут в try/catch (не должен ронять страницу)',
    /try\s*\{[\s\S]*?start_param[\s\S]*?\}\s*catch/.test(head));
}

console.log('');
console.log('=== 4b. JS CACHE-BUST ПОДНЯТ ВМЕСТЕ С COVER (publication blocker, найден на независимой проверке) ===');
{
  // Причина: #startup-cover видим по умолчанию БЕЗ участия JS. Если браузер/
  // Telegram WebView получит НОВЫЙ index.html (cover в разметке) вместе со
  // СТАРЫМ закэшированным script.js (без hideStartupCover()/hasInviteIntent()/
  // markStartupCoverAsInvite()) — cover показывается, но никогда не
  // снимается: вечный fullscreen loader. index.html и script.js должны
  // деплоиться атомарно с этим фиксом, поэтому js cache-bust обязан
  // подняться в ТОМ ЖЕ patch, а не полагаться на то, что версия уже
  // когда-то менялась.
  check('4b.1 script.js НЕ ссылается на старую версию v=198 (ту, что была до этого fix)',
    !/script\.js\?v=198/.test(HTML));
  check('4b.2 script.js версия поднята относительно v=198 (текущая — v=200 после №22, механическая правка)',
    /script\.js\?v=(19[9]|2\d\d)\b/.test(HTML));
}

console.log('');
console.log('=== 5. hasInviteIntent() / hideStartupCover() — извлечённые функции ===');
let loadError = null;
try {
  global.document = {
    _cover: { classList: { _classes: new Set(), add: function (c) { this._classes.add(c); }, contains: function (c) { return this._classes.has(c); } } },
    documentElement: { classList: { _classes: new Set(), add: function (c) { this._classes.add(c); }, contains: function (c) { return this._classes.has(c); } } },
    getElementById: function (id) { return id === 'startup-cover' ? global.document._cover : null; }
  };
  eval(extractFunc('hideStartupCover'));
  eval(extractFunc('hasInviteIntent'));
  eval(extractFunc('markStartupCoverAsInvite'));
} catch (e) { loadError = e.message; }

check('5.0 все три функции извлеклись без ошибок', loadError === null, loadError);

if (!loadError) {
  check('5.1 hasInviteIntent() === false вне Telegram (window.Telegram отсутствует)', (function () {
    global.window = {};
    global.Telegram = undefined;
    return hasInviteIntent() === false;
  })());

  check('5.2 hasInviteIntent() === false при Telegram без start_param', (function () {
    global.window = { Telegram: { WebApp: { initDataUnsafe: {} } } };
    global.Telegram = global.window.Telegram;
    return hasInviteIntent() === false;
  })());

  check('5.3 hasInviteIntent() === true при заполненном start_param', (function () {
    global.window = { Telegram: { WebApp: { initDataUnsafe: { start_param: 'ROOM01' } } } };
    global.Telegram = global.window.Telegram;
    return hasInviteIntent() === true;
  })());

  check('5.4 hideStartupCover() добавляет class hidden на #startup-cover', (function () {
    global.document._cover.classList._classes.clear();
    hideStartupCover();
    return global.document._cover.classList.contains('hidden');
  })());

  check('5.5 hideStartupCover() безопасен, если элемент отсутствует (не должен падать)', (function () {
    const savedGetById = global.document.getElementById;
    global.document.getElementById = function () { return null; };
    let threw = false;
    try { hideStartupCover(); } catch (e) { threw = true; }
    global.document.getElementById = savedGetById;
    return !threw;
  })());

  check('5.6 markStartupCoverAsInvite() добавляет invite-launch-hint на documentElement (LATE-DETECTED INVITE FIX)', (function () {
    global.document.documentElement.classList._classes.clear();
    markStartupCoverAsInvite();
    return global.document.documentElement.classList.contains('invite-launch-hint');
  })());
}

console.log('');
console.log('=== 6. showScreen() безусловно скрывает cover первой строкой ===');
{
  const src = extractFunc('showScreen');
  check('6.1 hideStartupCover() вызывается', /hideStartupCover\(\)/.test(src));
  check('6.2 вызов идёт РАНЬШЕ первого screen.classList.add("hidden")', (function () {
    const hideCoverPos = src.indexOf('hideStartupCover()');
    const firstScreenHide = src.indexOf('.classList.add("hidden")');
    return hideCoverPos !== -1 && firstScreenHide !== -1 && hideCoverPos < firstScreenHide;
  })());
  check('6.3 вызов БЕЗУСЛОВНЫЙ — не внутри if/условия своей же строки',
    /function showScreen\(screen\) \{\s*\n\s*hideStartupCover\(\);/.test(src));
}

console.log('');
console.log('=== 7. Отсутствие постороннего showScreen() в invite-pending окне ===');
{
  // Явное доказательство (не просто утверждение): между вызовом startApp()
  // внутри bootstrapApp() и разрешением checkForInviteLink() единственные
  // showScreen()-вызовы происходят ВНУТРИ самой checkForInviteLink() (уже
  // покрыто существующими invite-join.test.js/invite-privacy.test.js).
  // Проверяем это здесь структурно: ни startApp(), ни authenticateTelegramUser(),
  // ни queueOrStartFirebaseFlows()/startFirebaseFlows() (до вызова
  // checkForInviteLink() внутри неё) не содержат собственных showScreen().
  const startAppSrc = extractFunc('startApp');
  const authSrc = extractFunc('authenticateTelegramUser');
  const queueSrc = extractFunc('queueOrStartFirebaseFlows');
  const startFlowsSrc = extractFunc('startFirebaseFlows');
  const beforeInviteCheck = startFlowsSrc.slice(0, startFlowsSrc.indexOf('checkForInviteLink()'));

  check('7.1 startApp() не вызывает showScreen()', !/showScreen\(/.test(startAppSrc));
  check('7.2 authenticateTelegramUser() не вызывает showScreen()', !/showScreen\(/.test(authSrc));
  check('7.3 queueOrStartFirebaseFlows() не вызывает showScreen() напрямую',
    !/showScreen\(/.test(queueSrc.replace(/startFirebaseFlows\([^)]*\)/g, '')));
  check('7.4 startFirebaseFlows() до вызова checkForInviteLink() не содержит showScreen()',
    !/showScreen\(/.test(beforeInviteCheck));
}

console.log('');
console.log('=== 8. bootstrapApp(): late-detected invite переключает текст, auth-failure явно скрывает cover ===');
{
  const src = extractFunc('bootstrapApp');
  const hideCallPos = src.indexOf('hideStartupCover()');
  const markCallPos = src.indexOf('markStartupCoverAsInvite()');
  const authCallPos = src.indexOf('authenticateTelegramUser()');
  const setTimeoutPos = src.indexOf('setTimeout(resolve, 100)');
  const catchPos = src.indexOf('catch (error)');
  const hideInCatch = catchPos !== -1 ? src.indexOf('hideStartupCover()', catchPos) : -1;

  check('8.1 и hide, и mark присутствуют внутри authPromise (до catch)',
    hideCallPos !== -1 && markCallPos !== -1 &&
    hideCallPos < (catchPos === -1 ? src.length : catchPos) &&
    markCallPos < (catchPos === -1 ? src.length : catchPos));
  check('8.2 оба идут ПОСЛЕ 100мс-паузы (та же защита, что уже есть у initData)',
    setTimeoutPos !== -1 && hideCallPos > setTimeoutPos && markCallPos > setTimeoutPos);
  check('8.3 оба идут ДО authenticateTelegramUser() — не ждут сетевой auth-раунд',
    authCallPos !== -1 && hideCallPos < authCallPos && markCallPos < authCallPos);
  check('8.4 решение — if/else по hasInviteIntent(): true → markStartupCoverAsInvite(), false → hideStartupCover() (LATE-DETECTED INVITE FIX)',
    /if \(hasInviteIntent\(\)\) \{\s*\n\s*markStartupCoverAsInvite\(\);\s*\n\s*\} else \{\s*\n\s*hideStartupCover\(\);\s*\n\s*\}/.test(src));
  check('8.5 catch-ветка (auth failure) явно вызывает hideStartupCover()',
    hideInCatch !== -1);
  check('8.6 hide в catch идёт ДО showInfoModal (модалка не должна открываться под cover)', (function () {
    if (hideInCatch === -1) return false;
    const modalPos = src.indexOf('showInfoModal', catchPos);
    return modalPos !== -1 && hideInCatch < modalPos;
  })());
}

console.log('');
console.log('=== 9. Ветка "вне Telegram" тоже явно скрывает cover ===');
{
  const tail = SRC.slice(SRC.indexOf('bootstrapApp(); // задержка перенесена ВНУТРЬ authPromise'));
  const elsePos = tail.indexOf('} else {');
  const elseBody = elsePos !== -1 ? tail.slice(elsePos) : '';
  check('9.1 "else" (вне Telegram) ветка найдена', elsePos !== -1);
  check('9.2 hideStartupCover() вызывается в этой ветке', /hideStartupCover\(\)/.test(elseBody));
  check('9.3 hide идёт ДО showInfoModal', (function () {
    const h = elseBody.indexOf('hideStartupCover()');
    const m = elseBody.indexOf('showInfoModal');
    return h !== -1 && m !== -1 && h < m;
  })());
}

console.log('');
console.log('=== 10. Обычные menu flows не задеты ===');
{
  check('10.1 btn-play-online по-прежнему вызывает showGroupLobby()',
    /btnPlayOnline\.addEventListener\("click",[\s\S]{0,150}showGroupLobby\(\)/.test(SRC));
  check('10.2 checkForInviteLink() decision-логика не тронута (early-return на !startParam не изменился)',
    /if \(!startParam\) return false;/.test(extractFunc('checkForInviteLink')));
}

console.log('\nИТОГ:', passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

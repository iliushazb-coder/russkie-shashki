// №43 slice 5 (frozen plan): постепенная модульность script.js.
// hideStartupCover/hasInviteIntent/markStartupCoverAsInvite, вынесенные из
// script.js в shared/startup-cover-utils.js, по тому же паттерну, что и
// четыре предыдущих shared-модуля.
//
// Note: подробное behavioral-покрытие (все Telegram-комбинации, DOM
// present/absent, showScreen/bootstrapApp integration) уже есть в
// tests/startup-cover.test.js (обновлён этим же кандидатом -- секция 5
// берёт функции через require() вместо eval-извлечения из script.js).
// Здесь -- только structural/export/load-order/cache-bust/no-side-effect
// guards, не дублирующие ту секцию.
//
// Что доказывается:
//   A. Нет declaration ни одной из 3 функций в script.js.
//   B. shared/startup-cover-utils.js экспортирует ровно эти 3 функции.
//   C. index.html: startup-cover-utils.js грузится РАНЬШЕ script.js,
//      ПОСЛЕ captured-stack-utils.js, без async/defer/module.
//   D. script.js реально получает binding через fail-loud проверку;
//      6 реальных call sites мигрированы.
//   E. Нет side effect'ов при загрузке модуля (ни одна из функций не
//      вызывается на верхнем уровне).
//   F. Нет второй production-копии тел.
//   G. Cache-bust.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info !== undefined ? '  — ' + info : '')); }
}

const ROOT = path.join(__dirname, '..');
const SCRIPT_SRC = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHARED_PATH = path.join(ROOT, 'shared', 'startup-cover-utils.js');
const SHARED_SRC = fs.readFileSync(SHARED_PATH, 'utf8');
let sharedApi = null;
try { sharedApi = require(SHARED_PATH); } catch (e) { /* checked below */ }

const CLUSTER_FUNCS = ['hideStartupCover', 'hasInviteIntent', 'markStartupCoverAsInvite'];

console.log('=== A. Нет declaration ни одной из 3 функций в script.js ===');
CLUSTER_FUNCS.forEach(function (fn) {
    check('A. script.js: нет declaration ' + fn, !new RegExp('^function ' + fn + '\\(', 'm').test(SCRIPT_SRC));
});

console.log('');
console.log('=== B. shared/startup-cover-utils.js экспортирует ровно 3 функции ===');
check('B.1 shared/startup-cover-utils.js реально require\'ится', !!sharedApi);
if (sharedApi) {
    CLUSTER_FUNCS.forEach(function (fn) {
        check('B.2 экспортирует ' + fn, typeof sharedApi[fn] === 'function');
    });
    check('B.3 ровно 4 ключа в экспорте (не больше)', Object.keys(sharedApi).length === 4,
        JSON.stringify(Object.keys(sharedApi)));
}
check('B.4 IIFE + "use strict"', /^\(function \(global\) \{\s*\n\s*"use strict";/.test(SHARED_SRC));
check('B.5 экспорт через global.RussianCheckersStartupCoverUtils = api;',
    /global\.RussianCheckersStartupCoverUtils\s*=\s*api;/.test(SHARED_SRC));
check('B.6 module.exports для Node tests',
    /if \(typeof module === "object" && module\.exports\) \{\s*\n\s*module\.exports = api;/.test(SHARED_SRC));

console.log('');
console.log('=== C. index.html: порядок и способ загрузки script tags ===');
{
    const stackIdx = HTML.indexOf('shared/captured-stack-utils.js?v=1');
    const startupVerMatch = /shared\/startup-cover-utils\.js\?v=\d+/.exec(HTML);
    const startupIdx = startupVerMatch ? startupVerMatch.index : -1;
    const scriptVerMatch = /script\.js\?v=(\d+)/.exec(HTML);
    const scriptIdx = scriptVerMatch ? scriptVerMatch.index : -1;
    check('C.1 shared/startup-cover-utils.js подключён с числовой версией', startupIdx !== -1);
    check('C.2 порядок: captured-stack-utils.js < startup-cover-utils.js < script.js',
        stackIdx !== -1 && stackIdx < startupIdx && startupIdx < scriptIdx,
        'stack@' + stackIdx + ' startup@' + startupIdx + ' script@' + scriptIdx);
    const tagMatch = /<script src="shared\/startup-cover-utils\.js\?v=\d+"[^>]*><\/script>/.exec(HTML);
    check('C.3 тег без async/defer/type="module"', !!tagMatch, tagMatch ? tagMatch[0] : 'не найден');
}

console.log('');
console.log('=== D. script.js реально получает функции из RussianCheckersStartupCoverUtils ===');
{
    check('D.1 fail-loud проверка на RussianCheckersStartupCoverUtils.hasInviteIntent присутствует',
        /if \(!window\.RussianCheckersStartupCoverUtils \|\| typeof window\.RussianCheckersStartupCoverUtils\.hasInviteIntent !== "function"\) \{\s*\n\s*throw new Error\("RussianCheckersStartupCoverUtils failed to load"\);/.test(SCRIPT_SRC));
    check('D.2 destructuring всех четырёх присутствует',
        SCRIPT_SRC.indexOf('const { hideStartupCover, showStartupCover, hasInviteIntent, markStartupCoverAsInvite } = window.RussianCheckersStartupCoverUtils;') !== -1);
    check('D.3 fail-loud проверка идёт РАНЬШЕ destructuring', (function () {
        const guardPos = SCRIPT_SRC.indexOf('RussianCheckersStartupCoverUtils.hasInviteIntent !== "function"');
        const destrPos = SCRIPT_SRC.indexOf('const { hideStartupCover, showStartupCover, hasInviteIntent, markStartupCoverAsInvite }');
        return guardPos !== -1 && destrPos !== -1 && guardPos < destrPos;
    })());
    check('D.4 нет client-side fallback-копии',
        !/=\s*window\.RussianCheckersStartupCoverUtils\s*\|\|/.test(SCRIPT_SRC));
    // hideStartupCover: 4 прежних стартовых вызова + 1 в finally у
    // runAfterAuthWithCover(). showStartupCover: ровно один -- в нём же.
    check('D.5 все production call sites на месте (5×hideStartupCover + 1×showStartupCover + 1×hasInviteIntent + 1×markStartupCoverAsInvite)',
        (SCRIPT_SRC.match(/hideStartupCover\(\)/g) || []).length === 5 &&
        (SCRIPT_SRC.match(/showStartupCover\(\)/g) || []).length === 1 &&
        (SCRIPT_SRC.match(/hasInviteIntent\(\)/g) || []).length === 1 &&
        (SCRIPT_SRC.match(/markStartupCoverAsInvite\(\)/g) || []).length === 1);
}

console.log('');
console.log('=== E. Нет side effect\'ов при загрузке модуля ===');
{
    // Убираем построчные //-комментарии ПЕРЕД анализом -- иначе упоминание
    // имени функции в пояснительном комментарии (например "hasInviteIntent()
    // уже надёжен") ложно засчитывается как реальный вызов.
    const withoutLineComments = SHARED_SRC.split('\n')
        .map(function (line) { return line.replace(/\/\/.*$/, ''); })
        .join('\n');
    // Ни один из экспортируемых вызовов не должен происходить после
    // объявления api (никакого self-invoke) и вне тел самих
    // function-деклараций (module-level side effect) -- в отличие,
    // например, от audio-effects.js, где document.addEventListener
    // НАМЕРЕННО остался в script.js именно по этой причине.
    const beforeApiDecl = withoutLineComments.slice(0, withoutLineComments.indexOf('const api = {'));
    const outsideFunctionBodies = beforeApiDecl.replace(/function \w+\(\) \{[\s\S]*?\n    \}/g, '');
    check('E.1 ни один экспортируемый вызов не происходит вне тел самих function-деклараций (module-level side effect, включая после api)',
        !/hideStartupCover\(\)|hasInviteIntent\(\)|markStartupCoverAsInvite\(\)/.test(outsideFunctionBodies) &&
        !/hideStartupCover\(\)|hasInviteIntent\(\)|markStartupCoverAsInvite\(\)/.test(withoutLineComments.slice(withoutLineComments.indexOf('const api = {'))));
}

console.log('');
console.log('=== F. Нет второй production-копии тел ===');
CLUSTER_FUNCS.forEach(function (fn) {
    check('F. script.js: нет declaration ' + fn, !new RegExp('^function ' + fn + '\\(', 'm').test(SCRIPT_SRC));
});

console.log('');
console.log('=== G. Cache-bust ===');
// Числовая граница, а не точное равенство: файл получил showStartupCover(),
// поэтому его cache-bust штатно поднимается и будет расти дальше.
check('G.1 HTML содержит shared/startup-cover-utils.js с версией >= 2', (function () {
    const m = /shared\/startup-cover-utils\.js\?v=(\d+)/.exec(HTML);
    return !!m && parseInt(m[1], 10) >= 2;
})());
check('G.2 HTML содержит script.js с версией >= 205 (поднят: script.js получил новую fail-loud зависимость от RussianCheckersStartupCoverUtils; конкретное число не фиксируем -- оно продолжит расти с будущими bump)',
    (function () {
        const m = /script\.js\?v=(\d+)/.exec(HTML);
        return !!m && parseInt(m[1], 10) >= 205;
    })());
check('G.3 HTML НЕ содержит старую script.js?v=204', !/script\.js\?v=204/.test(HTML));

console.log('');
console.log('=== H. ПОВЕДЕНИЕ showStartupCover / hideStartupCover ===');
// Здесь проверяется не текст, а РАБОТА функций: поднимаем минимальный
// стаб DOM и смотрим на фактическое состояние классов.
{
    function makeEl(initialClasses) {
        const set = new Set(initialClasses || []);
        return {
            classList: {
                add: (c) => set.add(c),
                remove: (c) => set.delete(c),
                contains: (c) => set.has(c)
            },
            _has: (c) => set.has(c)
        };
    }

    const savedDocument = global.document;
    function withDom(coverClasses, rootClasses, fn) {
        const cover = makeEl(coverClasses);
        const root = makeEl(rootClasses);
        global.document = {
            getElementById: (id) => (id === 'startup-cover' ? cover : null),
            documentElement: root
        };
        try { fn(cover, root); }
        finally { global.document = savedDocument; }
    }

    withDom(['hidden'], [], function (cover) {
        sharedApi.showStartupCover();
        check('H.1 showStartupCover снимает класс hidden', !cover._has('hidden'));
    });

    withDom([], [], function (cover) {
        sharedApi.hideStartupCover();
        check('H.2 hideStartupCover возвращает класс hidden', cover._has('hidden'));
    });

    withDom(['hidden'], [], function (cover) {
        sharedApi.showStartupCover();
        sharedApi.hideStartupCover();
        check('H.3 функции парны: show -> hide возвращает исходное состояние',
            cover._has('hidden'));
    });

    // Для кнопок меню нужен нейтральный «Загрузка…», а не
    // «Подключение к столу…» от invite-запуска.
    withDom(['hidden'], ['invite-launch-hint'], function (cover, root) {
        sharedApi.showStartupCover();
        check('H.4 показ снимает invite-launch-hint (нейтральный текст)',
            !root._has('invite-launch-hint'));
        check('H.5 при этом cover действительно показан', !cover._has('hidden'));
    });

    // Отсутствие элемента не должно ронять приложение.
    (function () {
        const saved = global.document;
        global.document = { getElementById: () => null, documentElement: null };
        let threw = false;
        try { sharedApi.showStartupCover(); } catch (e) { threw = true; }
        global.document = saved;
        check('H.6 showStartupCover не падает, если элемента нет', !threw);
    })();
}

console.log('');
console.log('=== I. script.js: cover вокруг ожидания auth ===');
{
    const m = /async function runAfterAuthWithCover\(onReady\)[\s\S]*?\n}/.exec(SCRIPT_SRC);
    check('I.1 хелпер runAfterAuthWithCover существует', !!m);
    if (m) {
        const body = m[0];
        const showPos = body.indexOf('showStartupCover()');
        const awaitPos = body.indexOf('await requireFirebaseAuthAsync()');
        const finallyPos = body.indexOf('finally');
        const hidePos = body.indexOf('hideStartupCover()');

        check('I.2 cover показывается ДО ожидания auth',
            showPos !== -1 && awaitPos !== -1 && showPos < awaitPos);
        // Ключевое: ждём не только вход, но и результат onReady(). Иначе
        // кружок исчезал бы раньше данных.
        check('I.2b хелпер ждёт результат onReady, а не просто вызывает его',
            /await onReady\(\);/.test(body));
        check('I.3 ворота auth остаются обязательными',
            /if \(!\(await requireFirebaseAuthAsync\(\)\)\) return;/.test(body));
        check('I.4 скрытие стоит в finally, то есть и при отказе, и при исключении',
            finallyPos !== -1 && hidePos !== -1 && finallyPos < hidePos);
        check('I.5 скрытие НЕ вызывается до finally (нет раннего hide)',
            body.indexOf('hideStartupCover()') === body.lastIndexOf('hideStartupCover()'));
    }

    // Обе кнопки обязаны идти через хелпер, а не мимо него.
    check('I.6 «Кто играет?» использует хелпер',
        /btnPlayOnline\.addEventListener\("click",[\s\S]{0,600}?runAfterAuthWithCover\(/.test(SCRIPT_SRC));
    check('I.7 «Статистика» использует хелпер',
        /btnShowStats\.addEventListener\("click",[\s\S]{0,300}?runAfterAuthWithCover\(/.test(SCRIPT_SRC));
}

console.log('');
console.log('=== J. COVER ЖДЁТ ПЕРВИЧНУЮ ЗАГРУЗКУ ДАННЫХ ===');
{
    // «Статистика»: openStatsModal() обязана быть awaitable, иначе cover
    // снимется до прихода данных и пользователь увидит пустое окно.
    const m = /function openStatsModal\(\)[\s\S]*?\n}/.exec(SCRIPT_SRC);
    check('J.1 openStatsModal найдена', !!m);
    if (m) {
        const body = m[0];
        check('J.2 промис онлайн-таблицы захвачен',
            /const onlineStatsLoaded = Promise\.all\(/.test(body));
        check('J.3 промис таблицы бота захвачен',
            /botStatsLoaded = database\.ref\("statsBot"\)/.test(body));
        check('J.4 бот-промис инициализирован, даже если вкладки нет',
            /let botStatsLoaded = Promise\.resolve\(\)/.test(body));
        check('J.5 функция возвращает ОБА промиса',
            /return Promise\.all\(\[onlineStatsLoaded, botStatsLoaded\]\)/.test(body));
        // Ошибки гасятся внутри, значит cover снимется и при отказе чтения,
        // а не подвиснет.
        check('J.6 обе ветки гасят ошибку своим catch (обещание не отвергается)',
            /statsLeaderboard\.textContent = t\("stats_load_error"\)/.test(body) &&
            /statsLeaderboardBot\.textContent = t\("stats_load_error"\)/.test(body));
    }
    check('J.7 обработчик «Статистики» возвращает промис openStatsModal',
        /return runAfterAuthWithCover\(function \(\) \{\s*\n\s*return openStatsModal\(\);/.test(SCRIPT_SRC));

    // «Кто играет?»: сознательно ждём ТОЛЬКО вход. Тест закрепляет это
    // решение, чтобы следующий читатель не счёл его упущением.
    const lobby = /btnPlayOnline\.addEventListener\("click"[\s\S]*?\n\}\);/.exec(SCRIPT_SRC);
    check('J.8 обработчик лобби найден', !!lobby);
    if (lobby) {
        check('J.9 лобби НЕ возвращает промис из onReady (ждём только вход)',
            /showGroupLobby\(\);\s*\n\s*\}\);/.test(lobby[0]) &&
            !/return showGroupLobby\(\)/.test(lobby[0]));
    }
    // Запрет на обходные приёмы, которые мы намеренно не стали применять.
    const lobbyFn = /function showGroupLobby\(\)[\s\S]*?\n}/.exec(SCRIPT_SRC);
    if (lobbyFn) {
        check('J.10 в лобби не добавлен лишний once("value") ради ожидания',
            !/once\("value"\)/.test(lobbyFn[0]));
        check('J.11 схема child_added/changed/removed сохранена',
            /on\("child_added"/.test(lobbyFn[0]) &&
            /on\("child_changed"/.test(lobbyFn[0]) &&
            /on\("child_removed"/.test(lobbyFn[0]));
        check('J.12 у лобби есть собственный индикатор загрузки',
            /t\("loading"\)/.test(lobbyFn[0]));
    }
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

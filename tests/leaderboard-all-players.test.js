// ==========================================================================
// ТАБЛИЦА СТАТИСТИКИ — ВСЕ ИГРОКИ В ОБЕИХ ВКЛАДКАХ.
//
// Было ЧЕТЫРЕ ограничения количества, все в openStatsModal:
//   «Онлайн»  : limitToLast(50) x2  +  entries.slice(0, 10)
//   «С ботом» : limitToLast(50)     +  entries.slice(0, 10)
// Игрок с 11-го места не видел в таблице никого, включая себя.
//
// Проверки поведенческие: прогоняется настоящий openStatsModal на
// подставных данных Firebase, считаются реально отрисованные строки.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}
function grab(n) {
    const m = new RegExp('^function ' + n + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}
function codeOf(n) {
    return grab(n).split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');
}

// --- подставной DOM ---
function makeNode() {
    const node = {
        children: [], _html: '', _text: '', className: '',
        classList: { add: function () {}, remove: function () {}, contains: function () { return false; } },
        appendChild: function (c) { this.children.push(c); return c; },
        addEventListener: function () {},
        set innerHTML(v) { this._html = v; if (v === '') this.children = []; },
        get innerHTML() { return this._html; },
        set textContent(v) { this._text = v; },
        get textContent() { return this._text; }
    };
    return node;
}
const onlineList = makeNode();
const botList = makeNode();
global.statsLeaderboard = onlineList;
global.statsModal = { classList: { remove: function () {}, add: function () {} } };
global.document = {
    getElementById: function (id) { return id === 'stats-leaderboard-bot' ? botList : null; },
    createElement: function () { return makeNode(); }
};
global.t = function (k) { return k; };
global.normalizeEloRating = function (r) { return typeof r === 'number' ? r : 1000; };
global.openBotDetailsModal = function () {};

// --- подставной Firebase ---
let statsData = null, statsBotData = null;
let requestedPaths = [];
let usedQueryLimit = false;
function makeRef(pathName) {
    const ref = {
        orderByChild: function () { usedQueryLimit = true; return ref; },
        limitToLast: function () { usedQueryLimit = true; return ref; },
        limitToFirst: function () { usedQueryLimit = true; return ref; },
        once: function () {
            requestedPaths.push(pathName);
            const v = pathName === 'stats' ? statsData : statsBotData;
            return Promise.resolve({ val: function () { return v; } });
        }
    };
    return ref;
}
global.database = { ref: function (p) { return makeRef(p); } };

eval(grab('compareLeaderboardEntries'));
eval(grab('renderRankAndName'));
eval(grab('renderOnlineStatsRow'));
eval(grab('renderBotStatsRow'));
eval(grab('openStatsModal'));

// Игроки со строго убывающим рейтингом: ожидаемый порядок известен заранее.
function makeOnline(n) {
    const out = {};
    for (let i = 1; i <= n; i++) {
        out['U' + i] = { name: 'Игрок ' + i, wins: n - i + 1, losses: i,
                         draws: 0, rating: 3000 - i };
    }
    return out;
}
function makeBot(n) {
    const out = {};
    for (let i = 1; i <= n; i++) {
        out['B' + i] = { name: 'Бот-игрок ' + i, wins: n - i + 1, losses: i,
                         byLevel: { medium: { wins: 1, losses: 1 }, hard: { wins: 0, losses: 0 } } };
    }
    return out;
}
// Достаём подписи мест и имена из отрисованных строк
function ranksAndNames(list) {
    const out = [];
    list.children.forEach(function (row) {
        const flat = JSON.stringify(row);
        const rank = /"_text":"(🥇|🥈|🥉|\d+\.)"/.exec(flat);
        const name = /"_text":"(Игрок \d+|Бот-игрок \d+)"/.exec(flat);
        out.push({ rank: rank ? rank[1] : null, name: name ? name[1] : null });
    });
    return out;
}

async function open(online, bot) {
    statsData = online; statsBotData = bot;
    requestedPaths = []; usedQueryLimit = false;
    onlineList.children = []; botList.children = [];
    onlineList._text = ''; botList._text = '';
    openStatsModal();
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

(async function () {
    console.log('=== 1. ВКЛАДКА «ОНЛАЙН» — ВСЕ ИГРОКИ ===');

    await open(makeOnline(15), null);
    check('1.1 15 игроков -> отрисовано 15 строк',
        onlineList.children.length === 15, 'отрисовано ' + onlineList.children.length);

    await open(makeOnline(75), null);
    check('1.2 75 игроков -> отрисовано 75 строк',
        onlineList.children.length === 75, 'отрисовано ' + onlineList.children.length);

    await open(makeOnline(11), null);
    check('1.3 11 игроков -> одиннадцатый больше НЕ теряется',
        onlineList.children.length === 11, 'отрисовано ' + onlineList.children.length);

    await open(makeOnline(200), null);
    check('1.4 200 игроков -> отрисовано 200 (лимита 50 нет)',
        onlineList.children.length === 200, 'отрисовано ' + onlineList.children.length);

    console.log('\n=== 2. ВКЛАДКА «С БОТОМ» — ВСЕ ИГРОКИ ===');

    await open(null, makeBot(15));
    check('2.1 15 игроков -> отрисовано 15 строк',
        botList.children.length === 15, 'отрисовано ' + botList.children.length);

    await open(null, makeBot(75));
    check('2.2 75 игроков -> отрисовано 75 строк',
        botList.children.length === 75, 'отрисовано ' + botList.children.length);

    await open(null, makeBot(11));
    check('2.3 одиннадцатый не теряется', botList.children.length === 11);

    await open(null, makeBot(200));
    check('2.4 200 игроков -> отрисовано 200', botList.children.length === 200);

    console.log('\n=== 3. ОБЕ ВКЛАДКИ ОДНОВРЕМЕННО ===');

    await open(makeOnline(75), makeBot(75));
    check('3.1 онлайн 75 и бот 75 одновременно',
        onlineList.children.length === 75 && botList.children.length === 75,
        onlineList.children.length + ' / ' + botList.children.length);

    console.log('\n=== 4. СОРТИРОВКА СОХРАНЕНА ===');

    await open(makeOnline(75), null);
    const rows = ranksAndNames(onlineList);
    check('4.1 первым идёт игрок с наибольшим рейтингом',
        rows[0].name === 'Игрок 1', rows[0].name);
    check('4.2 последним — с наименьшим',
        rows[74].name === 'Игрок 75', rows[74].name);
    check('4.3 порядок строго по убыванию рейтинга', (function () {
        for (let i = 0; i < 75; i++) {
            if (rows[i].name !== 'Игрок ' + (i + 1)) return false;
        }
        return true;
    })());
    check('4.4 сортировка по-прежнему через compareLeaderboardEntries',
        /entries\.sort\(compareLeaderboardEntries\)/.test(SRC));

    // ВАЖНО: подавать данные УЖЕ отсортированными нельзя — тогда результат
    // совпадает и без сортировки, и тест ничего не доказывает. Подаём в
    // перемешанном порядке.
    function shuffledOnline(n) {
        const out = {};
        const order = [];
        for (let i = 1; i <= n; i++) order.push(i);
        for (let i = order.length - 1; i > 0; i--) {
            const j = (i * 7 + 3) % (i + 1);   // детерминированная перестановка
            const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        order.forEach(function (i) {
            out['U' + i] = { name: 'Игрок ' + i, wins: n - i + 1, losses: i,
                             draws: 0, rating: 3000 - i };
        });
        return out;
    }
    await open(shuffledOnline(40), null);
    const shuffled = ranksAndNames(onlineList);
    check('4.5 перемешанный ввод -> вывод строго по убыванию рейтинга', (function () {
        for (let i = 0; i < 40; i++) {
            if (shuffled[i].name !== 'Игрок ' + (i + 1)) return false;
        }
        return true;
    })(), shuffled.slice(0, 5).map(function (r) { return r.name; }).join(', '));
    check('4.6 и ввод действительно был перемешан', (function () {
        const keys = Object.keys(shuffledOnline(40));
        return keys[0] !== 'U1';
    })());

    await open(null, (function () {
        const b = makeBot(40); const out = {};
        Object.keys(b).reverse().forEach(function (k) { out[k] = b[k]; });
        return out;
    })());
    check('4.7 во вкладке «С ботом» перемешанный ввод тоже сортируется', (function () {
        const r = ranksAndNames(botList);
        for (let i = 0; i < 40; i++) {
            if (r[i].name !== 'Бот-игрок ' + (i + 1)) return false;
        }
        return true;
    })());

    console.log('\n=== 5. НУМЕРАЦИЯ И МЕДАЛИ ===');

    check('5.1 медали у первых трёх',
        rows[0].rank === '🥇' && rows[1].rank === '🥈' && rows[2].rank === '🥉',
        rows[0].rank + ' ' + rows[1].rank + ' ' + rows[2].rank);
    check('5.2 с четвёртого идут номера', rows[3].rank === '4.', rows[3].rank);
    check('5.3 нумерация непрерывна до последнего', (function () {
        for (let i = 3; i < 75; i++) {
            if (rows[i].rank !== (i + 1) + '.') return false;
        }
        return true;
    })());
    check('5.4 последнее место — 75', rows[74].rank === '75.', rows[74].rank);

    await open(null, makeBot(75));
    const botRows = ranksAndNames(botList);
    check('5.5 во вкладке «С ботом» медали и нумерация те же',
        botRows[0].rank === '🥇' && botRows[3].rank === '4.' && botRows[74].rank === '75.');

    console.log('\n=== 6. НИКТО НЕ ПРОПАЛ И НЕ ПРОДУБЛИРОВАЛСЯ ===');

    await open(makeOnline(75), null);
    const names = ranksAndNames(onlineList).map(function (r) { return r.name; });
    check('6.1 ровно 75 имён', names.length === 75);
    check('6.2 все имена уникальны', new Set(names).size === 75,
        'уникальных ' + new Set(names).size);
    check('6.3 присутствуют все от 1 до 75', (function () {
        const set = new Set(names);
        for (let i = 1; i <= 75; i++) if (!set.has('Игрок ' + i)) return false;
        return true;
    })());

    await open(null, makeBot(75));
    const botNames = ranksAndNames(botList).map(function (r) { return r.name; });
    check('6.4 во вкладке «С ботом» тоже 75 уникальных',
        botNames.length === 75 && new Set(botNames).size === 75);

    console.log('\n=== 7. ЗАПРОСЫ БЕЗ ОГРАНИЧЕНИЙ ===');

    await open(makeOnline(5), makeBot(5));
    check('7.1 ни orderByChild, ни limitToLast не применяются',
        usedQueryLimit === false);
    check('7.2 запрошены обе ветки',
        requestedPaths.indexOf('stats') !== -1 && requestedPaths.indexOf('statsBot') !== -1,
        requestedPaths.join(','));
    check('7.3 к stats теперь ОДИН запрос вместо двух',
        requestedPaths.filter(function (p) { return p === 'stats'; }).length === 1,
        'запросов: ' + requestedPaths.filter(function (p) { return p === 'stats'; }).length);

    console.log('\n=== 8. ПУСТЫЕ ДАННЫЕ И ГРАНИЦЫ ===');

    await open(null, null);
    check('8.1 нет онлайн-игроков -> строк нет, показан текст',
        onlineList.children.length === 0 && onlineList.textContent === 'stats_no_online_games');
    check('8.2 нет игроков с ботом -> то же',
        botList.children.length === 0 && botList.textContent === 'stats_no_bot_games');

    await open(makeOnline(1), makeBot(1));
    check('8.3 один игрок -> одна строка с золотой медалью', (function () {
        const r = ranksAndNames(onlineList);
        return onlineList.children.length === 1 && r[0].rank === '🥇';
    })());

    await open(makeOnline(3), null);
    check('8.4 ровно три игрока -> три медали, без номеров', (function () {
        const r = ranksAndNames(onlineList);
        return r.length === 3 && r[0].rank === '🥇' && r[1].rank === '🥈' && r[2].rank === '🥉';
    })());

    console.log('\n=== 9. КОД: ограничений количества не осталось ===');

    check('9.1 slice(0, 10) в таблицах отсутствует', (function () {
        const bad = SRC.split('\n').filter(function (l) {
            return l.indexOf('slice(0, 10)') !== -1 &&
                l.indexOf('toISOString') === -1 && l.trim().indexOf('//') !== 0;
        });
        return bad.length === 0;
    })());
    check('9.2 limitToLast / limitToFirst в коде отсутствуют', (function () {
        const code = SRC.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');
        return code.indexOf('limitToLast') === -1 && code.indexOf('limitToFirst') === -1;
    })());
    check('9.3 обе вкладки читают ветку целиком', (function () {
        const c = codeOf('openStatsModal');
        return /database\.ref\("stats"\)\.once\("value"\)/.test(c) &&
            /database\.ref\("statsBot"\)\.once\("value"\)/.test(c);
    })());
    check('9.4 economy из таблицы по-прежнему НЕ читается',
        codeOf('openStatsModal').indexOf('economy') === -1);
    check('9.5 третьей таблицы не появилось', (function () {
        const c = codeOf('openStatsModal');
        const refs = (c.match(/database\.ref\("[a-zA-Z]+"\)/g) || []);
        const uniq = new Set(refs);
        return uniq.size === 2;
    })(), 'разных веток: ' + new Set((codeOf('openStatsModal').match(/database\.ref\("[a-zA-Z]+"\)/g) || [])).size);

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

// ==========================================================================
// S-1 (v182): ЭКРАНИРОВАНИЕ КЛЮЧА КОМНАТЫ В РАЗМЕТКЕ ЛОББИ
//
// Проверяется НЕ наличие вызова escapeHtml regex-ом, а фактический результат
// рендера: враждебный ключ не должен порождать ни одного лишнего элемента и
// ни одного обработчика события, а обычный код комнаты обязан вернуться из
// getAttribute("data-code") ровно таким же, каким был.
//
// HTML разбирается собственным минимальным парсером (без внешних
// зависимостей) — он реализует ту же модель, что и браузер: атрибут в
// двойных кавычках заканчивается на первой закрывающей кавычке, всё, что
// после, разбирается как разметка.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}

// --- настоящий escapeHtml из production ---
const escapeSrc = /^function escapeHtml[\s\S]*?\n\}/m.exec(SRC);
if (!escapeSrc) { console.log('  ❌ 0. escapeHtml не найдена в script.js'); process.exit(1); }
eval(escapeSrc[0]);

// --- настоящие шаблоны кнопок из production ---
const lobbySrc = /function renderLobbyListFromCache[\s\S]*?\n\}/.exec(SRC);
if (!lobbySrc) { console.log('  ❌ 0. renderLobbyListFromCache не найдена'); process.exit(1); }
const LOBBY = lobbySrc[0];
const templates = LOBBY.match(/<button class="group-(?:join|resume|watch)-btn" data-code="\$\{[A-Za-z]+\}">[^<]*<\/button>/g) || [];

// --- минимальный HTML-парсер: теги, атрибуты, значения ---
function parseHtml(html) {
    const nodes = [];
    const tagRe = /<\s*([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*\/?>/g;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const attrs = {};
        const attrRe = /([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+)))?/g;
        let a;
        while ((a = attrRe.exec(m[2])) !== null) {
            if (!a[1]) continue;
            attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
        }
        nodes.push({ tag: m[1].toLowerCase(), attrs: attrs });
    }
    return nodes;
}
// getAttribute() отдаёт РАСКОДИРОВАННОЕ значение — как в браузере
function decodeEntities(s) {
    return String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&');
}
function render(tpl, code) { return tpl.replace(/\$\{[A-Za-z]+\}/, escapeHtml(code)); }
function eventHandlers(nodes) {
    const out = [];
    nodes.forEach(n => Object.keys(n.attrs).forEach(k => { if (/^on/.test(k)) out.push(n.tag + '[' + k + ']'); }));
    return out;
}

console.log('=== S-1. ЭКРАНИРОВАНИЕ КЛЮЧА КОМНАТЫ В ЛОББИ ===');

// --- 0. сам парсер должен ловить инъекцию, иначе тест бесполезен ---
(function () {
    const unsafeTpl = '<button class="group-join-btn" data-code="${code}">Играть</button>';
    const raw = unsafeTpl.replace('${code}', 'AB"><img src=x onerror="pwn()">');
    const nodes = parseHtml(raw);
    check('0.1 контроль: парсер ВИДИТ инъекцию в неэкранированном шаблоне',
        nodes.length === 2 && nodes.some(n => n.tag === 'img') && eventHandlers(nodes).length === 1,
        'узлов ' + nodes.length);
    const raw2 = unsafeTpl.replace('${code}', 'AB" onmouseover="pwn()');
    check('0.2 контроль: парсер ВИДИТ разорванный атрибут',
        eventHandlers(parseHtml(raw2)).length === 1);
})();

// --- 1. production действительно использует экранированное значение ---
check('1.1 найдены все три кнопки лобби (join/resume/watch)', templates.length === 3,
    'найдено ' + templates.length);
check('1.2 ни одна кнопка не подставляет сырой ${code}',
    !/data-code="\$\{code\}"/.test(LOBBY));
check('1.3 экранированное значение готовится через существующий escapeHtml',
    /const codeAttr = escapeHtml\(code\);/.test(LOBBY));

// --- 2. обычные коды комнат работают идентично прежнему ---
const NORMAL = ['K7X2QF', 'ABCDEF', '000000', 'Z9Y8X7', 'aB3dE9'];
templates.forEach(function (tpl, ti) {
    const kind = /join/.test(tpl) ? 'join' : (/resume/.test(tpl) ? 'resume' : 'watch');
    NORMAL.forEach(function (code) {
        const nodes = parseHtml(render(tpl, code));
        const btn = nodes.find(n => n.tag === 'button');
        check('2.' + (ti + 1) + ' [' + kind + '] обычный код "' + code + '" не изменился',
            nodes.length === 1 && btn && decodeEntities(btn.attrs['data-code']) === code,
            btn ? JSON.stringify(btn.attrs['data-code']) : 'кнопка не найдена');
    });
});

// --- 3. враждебные ключи не создают ни элементов, ни обработчиков ---
const HOSTILE = [
    ['кавычка + onmouseover', 'AB" onmouseover="pwn()'],
    ['закрытие тега + img',   'AB"><img src=x onerror="pwn()">'],
    ['закрытие тега + svg',   'AB"><svg onload="pwn()">'],
    ['одинарные кавычки',     "AB' onclick='pwn()"],
    ['угловые скобки',        '<script>pwn()</script>'],
    ['амперсанд-сущность',    'AB&quot; onfocus=&quot;pwn()'],
    ['все спецсимволы',       '<>"&\'']
];
templates.forEach(function (tpl, ti) {
    const kind = /join/.test(tpl) ? 'join' : (/resume/.test(tpl) ? 'resume' : 'watch');
    HOSTILE.forEach(function (h) {
        const nodes = parseHtml(render(tpl, h[1]));
        const handlers = eventHandlers(nodes);
        const extra = nodes.filter(n => n.tag !== 'button').map(n => n.tag);
        const btn = nodes.find(n => n.tag === 'button');
        check('3.' + (ti + 1) + ' [' + kind + '] ' + h[0] + ': нет лишних элементов и обработчиков',
            nodes.length === 1 && extra.length === 0 && handlers.length === 0 && !!btn,
            'узлы=[' + nodes.map(n => n.tag).join(',') + '] обработчики=[' + handlers.join(',') + ']');
        check('3.' + (ti + 1) + ' [' + kind + '] ' + h[0] + ': data-code читается целиком и без потерь',
            btn && decodeEntities(btn.attrs['data-code']) === h[1],
            btn ? JSON.stringify(decodeEntities(btn.attrs['data-code'])) : 'нет кнопки');
    });
});

// --- 4. escapeHtml покрывает весь опасный набор ---
check('4.1 экранируются < > " \' &',
    escapeHtml('<>"\'&') === '&lt;&gt;&quot;&#039;&amp;', escapeHtml('<>"\'&'));
check('4.2 обычные символы кода комнаты не трогаются',
    escapeHtml('K7X2QF') === 'K7X2QF');
check('4.3 круговой путь: экранирование -> разбор -> getAttribute даёт исходное',
    decodeEntities(escapeHtml('A&B<C>"D\'E')) === 'A&B<C>"D\'E');

// --- 5. обработчики кнопок не изменены ---
check('5.1 join по-прежнему читает getAttribute("data-code")',
    /joinGroupRoom\(this\.getAttribute\('data-code'\)\)/.test(SRC));
check('5.2 watch по-прежнему читает getAttribute("data-code")',
    /watchGroupRoom\(this\.getAttribute\('data-code'\)\)/.test(SRC));
check('5.3 resume по-прежнему читает getAttribute("data-code")',
    /const code = this\.getAttribute\('data-code'\);/.test(SRC));
check('5.4 формат генерации кода комнаты не изменён',
    /function generateRoomCode/.test(SRC));
// Имена игроков рендерятся тем же innerHTML. Поведенчески это не вызвать без
// DOM, поэтому здесь проверяется исходник — единственная такая проверка в
// файле, и она нужна, чтобы снятие escapeHtml с имён не прошло незамеченным.
check('5.5 имена обоих игроков по-прежнему экранируются',
    /lightName = escapeHtml\(lightName\);/.test(LOBBY) &&
    /darkName = escapeHtml\(darkName\);/.test(LOBBY));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

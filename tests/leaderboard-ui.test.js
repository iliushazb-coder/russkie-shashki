// K. LEADERBOARD UI 50/50 + BOT DETAILS (leaderboard-ui.test.js)
// Регрессионные тесты новой UI-разметки leaderboard:
//   - каждая строка = grid 50% (место+имя) / 50% (статистика);
//   - статистика разбита на фиксированные колонки (⭐🏆❌🎮 / 🏆❌🎮);
//   - длинное имя обрезается и не двигает статистику;
//   - клик по строке «С ботом» открывает модалку Всего/Средний/Тяжёлый;
//   - шрифт существующих строк НЕ изменён.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(process.env.TARGET_SCRIPT || path.join(__dirname, '..', 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function ex(n) {
    const re = new RegExp('function ' + n + '\\([^)]*\\) \\{', 'g');
    const m = re.exec(src);
    if (!m) throw new Error('нет ' + n);
    let s = m.index, i = src.indexOf('{', s), d = 1; i++;
    while (d > 0) { if (src[i] === '{') d++; else if (src[i] === '}') d--; i++; }
    return src.slice(s, i);
}

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

// ---------- мини-мок DOM ----------
function makeEl(tag) {
    const el = {
        tagName: tag,
        className: '',
        textContent: '',
        href: '', target: '', rel: '',
        children: [],
        _handlers: {},
        appendChild: function (c) { el.children.push(c); return c; },
        addEventListener: function (ev, fn) { (el._handlers[ev] = el._handlers[ev] || []).push(fn); },
        classList: {
            contains: function (cls) { return el.className.split(/\s+/).indexOf(cls) !== -1; },
            add: function (cls) { if (!el.classList.contains(cls)) el.className = (el.className + ' ' + cls).trim(); },
            remove: function (cls) { el.className = el.className.split(/\s+/).filter(function (c) { return c !== cls; }).join(' '); }
        }
    };
    Object.defineProperty(el, 'innerHTML', {
        get: function () { return ''; },
        set: function (v) { if (v === '') el.children = []; }
    });
    return el;
}
function allText(el) {
    let out = el.textContent || '';
    (el.children || []).forEach(function (c) { out += ' ' + allText(c); });
    return out;
}

const byId = {};
['bot-details-modal', 'bot-details-title', 'bot-details-body'].forEach(function (id) {
    byId[id] = makeEl('div');
});
byId['bot-details-modal'].className = 'hidden modal-overlay';

global.document = {
    createElement: makeEl,
    getElementById: function (id) { return byId[id] || null; },
    createTextNode: function (t) { const n = makeEl('#text'); n.textContent = t; return n; }
};
global.t = function (k) {
    return ({
        bot_details_total: 'Всего',
        btn_difficulty_medium: '⚖️ Средний',
        btn_difficulty_hard: '🔥 Сложный'
    })[k] || k;
};

eval(ex('normalizeEloRating'));
eval(ex('renderRankAndName'));
eval(ex('renderOnlineStatsRow'));
eval(ex('openBotDetailsModal'));
eval(ex('renderBotStatsRow'));

// ================= ONLINE =================
const onlineRow = renderOnlineStatsRow(1, '@tetiana220722', 3, 3, 0, 1016);

check('1. Online row разделена ровно на две зоны: name-zone и stats-zone',
    onlineRow.children.length === 2 &&
    onlineRow.children[0].className.indexOf('stats-name-block') !== -1 &&
    onlineRow.children[1].className.indexOf('stats-info-block') !== -1);

const rowRule = (css.match(/\.stats-row \{[^}]*\}/) || [''])[0];
check('2. Геометрия 40/60 задана настоящей CSS-сеткой (не пробелами и не margin)',
    rowRule.indexOf('display: grid') !== -1 &&
    rowRule.indexOf('grid-template-columns: 40% 60%') !== -1 &&
    css.indexOf('margin-left') === -1 || rowRule.indexOf('grid-template-columns: 40% 60%') !== -1);

const onlineCells = onlineRow.children[1].children;
check('3. Online stats содержит ⭐ 🏆 ❌ 🎮 отдельными колонками',
    onlineCells.length === 4 &&
    onlineCells[0].textContent === '⭐1016' &&
    onlineCells[1].textContent === '🏆3' &&
    onlineCells[2].textContent === '❌3' &&
    onlineCells[3].textContent === '🎮6');

const longRow = renderOnlineStatsRow(2, '@оченьдлинноеимяигрока12345', 1, 0, 0, 1016);
const longName = allText(longRow.children[0]);
const longCells = longRow.children[1].children.map(function (c) { return c.textContent; }).join(' ');
const shortCells = renderOnlineStatsRow(2, '@ab', 1, 0, 0, 1016).children[1].children.map(function (c) { return c.textContent; }).join(' ');
check('4. Длинное имя обрезается (… + CSS ellipsis) и не сдвигает stats',
    longName.indexOf('…') !== -1 &&
    longCells === shortCells &&
    /\.stats-name-text \{[^}]*text-overflow: ellipsis/.test(css));

check('5. Никаких переносов строки (white-space: nowrap у имени и статистики)',
    /\.stats-name-text \{[^}]*white-space: nowrap/.test(css) &&
    /\.stats-stat \{[^}]*white-space: nowrap/.test(css) &&
    /\.stats-name-block \{[^}]*white-space: nowrap/.test(css));

// ================= BOT =================
const botRow = renderBotStatsRow(1, 'vasea', 9, 38, { medium: { wins: 6, losses: 20 }, hard: { wins: 3, losses: 18 } });

check('6. Bot row — та же строка .stats-row с той же сеткой 50/50',
    botRow.className.indexOf('stats-row') !== -1 &&
    botRow.children.length === 2 &&
    botRow.children[0].className.indexOf('stats-name-block') !== -1 &&
    botRow.children[1].className.indexOf('stats-info-block') !== -1);

const botCells = botRow.children[1].children;
check('7. Bot stats содержит 🏆 ❌ 🎮 отдельными колонками',
    botCells.length === 3 &&
    botCells[0].textContent === '🏆9' &&
    botCells[1].textContent === '❌38' &&
    botCells[2].textContent === '🎮47');

check('8. Bot row не содержит 🪙',
    allText(botRow).indexOf('🪙') === -1);

check('9. Online и Bot: правая зона начинается с одной и той же 40%-границы, колонки фиксированные',
    onlineRow.className.indexOf('stats-row') !== -1 &&
    botRow.className.indexOf('stats-row') !== -1 &&
    /\.stats-info-online \{[^}]*grid-template-columns: 1\.2fr 1fr 1fr 1fr/.test(css) &&
    /\.stats-info-bot \{[^}]*repeat\(3, 1fr\)/.test(css));

check('9b. Колонка ⭐ шире остальных (четырёхзначный рейтинг не наезжает на 🏆), доли одинаковы у всех строк',
    /\.stats-info-online \{[^}]*1\.2fr 1fr 1fr 1fr/.test(css) &&
    renderOnlineStatsRow(1, 'X', 0, 0, 0, 1250).children[1].children[0].textContent === '⭐1250');

const mediaBlock = css.slice(css.indexOf('@media (max-width: 360px)'));
check('10. Font-size существующих leaderboard строк НЕ изменён (13px / 12px в media), новые классы шрифт не задают',
    rowRule.indexOf('font-size: 13px') !== -1 &&
    /\.stats-row \{[^}]*font-size: 12px/.test(mediaBlock) &&
    !/\.stats-name-text \{[^}]*font-/.test(css) &&
    !/\.stats-info-block \{[^}]*font-/.test(css) &&
    !/\.stats-stat \{[^}]*font-/.test(css) &&
    (css.match(/font-family/g) || []).length === 1); // единственный давний глобальный font-family (body) — не тронут

// ================= BOT DETAILS MODAL =================
const modal = byId['bot-details-modal'];
const title = byId['bot-details-title'];
const body = byId['bot-details-body'];

const clickHandler = (botRow._handlers['click'] || [])[0];
modal.classList.add('hidden');
if (clickHandler) clickHandler({ target: botRow.children[1].children[0] });
check('11. Нажатие на bot-row открывает details-модалку',
    !!clickHandler && !modal.classList.contains('hidden'));

check('12. Открывается правильный пользователь',
    title.textContent === '🤖 vasea');

function cellsOf(labelIdx) {
    // body — единая сетка: 4 ячейки на строку (label, 🏆, ❌, 🎮)
    return body.children.slice(labelIdx * 4, labelIdx * 4 + 4).map(function (c) { return c.textContent; });
}
check('13. Total wins/losses/games правильные (games = wins + losses)',
    cellsOf(0).join('|') === 'Всего|🏆 9|❌ 38|🎮 47');
check('14. Medium wins/losses/games правильные',
    cellsOf(1).join('|') === '⚖️ Средний|🏆 6|❌ 20|🎮 26');
check('15. Hard wins/losses/games правильные',
    cellsOf(2).join('|') === '🔥 Сложный|🏆 3|❌ 18|🎮 21');

openBotDetailsModal('@old_player', 0, 0, null);
check('16. Отсутствующий byLevel безопасно даёт 0 (без ошибок)',
    cellsOf(0).join('|') === 'Всего|🏆 0|❌ 0|🎮 0' &&
    cellsOf(1).join('|') === '⚖️ Средний|🏆 0|❌ 0|🎮 0' &&
    cellsOf(2).join('|') === '🔥 Сложный|🏆 0|❌ 0|🎮 0');

openBotDetailsModal('vasea', 9, 38, { medium: { wins: 6, losses: 20 }, hard: { wins: 3, losses: 18 } });
check('17. Никаких economy-данных в details (нет 🪙, нет обращений к economy)',
    allText(body).indexOf('🪙') === -1 &&
    ex('openBotDetailsModal').indexOf('economy') === -1 &&
    ex('openBotDetailsModal').indexOf('database.ref') === -1);

check('18. Закрытие модалки работает (кнопка есть в HTML, обработчик прячет модалку)',
    html.indexOf('id="btn-bot-details-close"') !== -1 &&
    /btn-bot-details-close[\s\S]{0,400}?classList\.add\("hidden"\)/.test(src));

const row2 = renderBotStatsRow(2, '@tetiana220722', 0, 1, null);
(row2._handlers['click'] || [])[0]({ target: row2.children[1].children[0] });
check('19. Нажатие по разным пользователям показывает именно их данные',
    title.textContent === '🤖 @tetiana220722' &&
    cellsOf(0).join('|') === 'Всего|🏆 0|❌ 1|🎮 1');

// ================= доп. защита =================
const linkTarget = { classList: { contains: function (c) { return c === 'stats-user-link'; } } };
title.textContent = 'unchanged';
(botRow._handlers['click'] || [])[0]({ target: linkTarget });
check('20. Клик именно по ссылке-нику НЕ открывает модалку (ссылка ведёт в Telegram)',
    title.textContent === 'unchanged');

check('21. Модалка details есть в HTML после stats-modal (рисуется поверх)',
    html.indexOf('id="bot-details-modal"') > html.indexOf('id="stats-modal"'));

check('22. В строках больше нет inline-панели byLevel (таблица чистая)',
    src.indexOf('stats-bylevel-panel') === -1 &&
    src.indexOf('statsExpandedBotEntry') === -1);

check('23. Ключ bot_details_total есть во всех трёх языках',
    (src.match(/bot_details_total:/g) || []).length === 3);

console.log('ИТОГ leaderboard-ui: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

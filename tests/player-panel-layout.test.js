// ==========================================================================
// BUG 2: ширина игровых панелей и порядок сокращения.
//
// Проверяется и разметка, и расчёт ширины: панель обязана равняться доске,
// а сокращаться разрешено ТОЛЬКО имени.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let passed = 0, failed = 0;
function check(n, c, i) {
    if (c) { passed++; console.log('  ✅ ' + n); }
    else { failed++; console.log('  ❌ ' + n + (i ? '  — ' + i : '')); }
}
// Возвращает тело правила по селектору.
function rule(sel) {
    const re = new RegExp('(^|\\n)' + sel.replace(/[.#*]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
    const m = re.exec(CSS);
    return m ? m[2] : null;
}
function has(sel, prop, value) {
    const b = rule(sel);
    if (!b) return false;
    const re = new RegExp(prop + '\\s*:\\s*' + (value || '[^;]+'));
    return re.test(b);
}

console.log('=== 1. ШИРИНА ПАНЕЛИ ПРИВЯЗАНА К ДОСКЕ ===');
check('1.1 переменная ширины доски объявлена', /--board-total\s*:/.test(CSS));
check('1.2 считается из тех же переменных, что и доска', (function () {
    const m = /--board-total\s*:\s*([^;]+);/.exec(CSS);
    return m && /--coord-size/.test(m[1]) && /--cell-size/.test(m[1]);
})(), 'иначе панель разойдётся с доской');
check('1.3 учтены padding и рамка обёртки', (function () {
    const m = /--board-total\s*:\s*([^;]+);/.exec(CSS);
    // 12px padding * 2 + 2px рамка * 2 = 28px
    return m && /28px/.test(m[1]);
})());
check('1.4 панель занимает всю доступную ширину', has('.player-panel', 'width', '100%'));
check('1.5 но не шире доски', has('.player-panel', 'max-width', 'var\\(--board-total\\)'));
check('1.6 панель центрирована', has('.player-panel', 'align-self', 'center'));
check('1.7 обе панели используют ОДИН класс', (function () {
    const top = /id="player-top"[^>]*class="[^"]*player-panel/.test(HTML)
        || /class="player-panel"[^>]*id="player-top"/.test(HTML);
    const bot = /id="player-bottom"[^>]*class="[^"]*player-panel/.test(HTML)
        || /class="player-panel"[^>]*id="player-bottom"/.test(HTML);
    return top && bot;
})(), 'иначе одинаковость не гарантирована');

console.log('\n=== 2. СОКРАЩАЕТСЯ ТОЛЬКО ИМЯ ===');
check('2.1 у имени есть многоточие', has('.player-name-text', 'text-overflow', 'ellipsis'));
check('2.2 и запрет переноса', has('.player-name-text', 'white-space', 'nowrap'));
check('2.3 и min-width: 0', has('.player-name-text', 'min-width', '0'),
    'без него ellipsis не сработает во flex');
check('2.4 имя ограничено долей ширины, а не пикселями', (function () {
    const b = rule('.player-name-text');
    return b && /max-width\s*:\s*\d+%/.test(b);
})());
check('2.5 РЕЙТИНГ не сжимается', has('.player-rating', 'flex', '0 0 auto'));
check('2.6 и не переносится', has('.player-rating', 'white-space', 'nowrap'));
check('2.7 у рейтинга НЕТ многоточия', !/text-overflow/.test(rule('.player-rating') || ''));
check('2.8 СТАТУС не сжимается', has('.player-status', 'flex', '0 0 auto'));
check('2.9 и не переносится', has('.player-status', 'white-space', 'nowrap'));
check('2.10 у статуса НЕТ многоточия', !/text-overflow/.test(rule('.player-status') || ''));
check('2.11 контейнер имени имеет min-width: 0', has('.player-name', 'min-width', '0'));

console.log('\n=== 3. РАЗДЕЛЕНИЕ ИМЕНИ И РЕЙТИНГА ===');
check('3.1 рейтинг больше НЕ склеен с именем одной строкой',
    !/playerTopName\.textContent\s*=\s*\(/.test(SRC),
    'иначе многоточие съело бы Elo');
check('3.2 есть отдельная функция отрисовки', /function renderPlayerNameCell\(/.test(SRC));
check('3.3 используется для обеих панелей', (function () {
    return /renderPlayerNameCell\(playerTopName/.test(SRC)
        && /renderPlayerNameCell\(playerBottomName/.test(SRC);
})());
check('3.4 имя вставляется через textContent, НЕ innerHTML', (function () {
    const m = /function renderPlayerNameCell\([\s\S]*?\n\}/.exec(SRC);
    return m && /textContent/.test(m[0]) && !/innerHTML/.test(m[0]);
})(), 'имя приходит из Telegram — это внешние данные');
check('3.5 узлы переиспользуются, а не пересоздаются каждый ход', (function () {
    const m = /function renderPlayerNameCell\([\s\S]*?\n\}/.exec(SRC);
    return m && /querySelector\("\.player-name-text"\)/.test(m[0]);
})());

console.log('\n=== 4. СЪЕДЕННЫЕ ШАШКИ НЕ ЛОМАЮТ СТРОКУ ===');
check('4.1 ширина адаптивная, а не фиксированные пиксели', (function () {
    const b = rule('.captured-icons');
    return b && /max-width\s*:\s*min\(/.test(b);
})(), 'на экране 320px жёсткие 130px выдавили бы статус');
check('4.2 могут сжиматься', has('.captured-icons', 'flex', '0 1 auto'));
check('4.3 перенос строк сохранён', has('.captured-icons', 'flex-wrap', 'wrap'));
check('4.4 не выходят за край', has('.captured-icons', 'overflow', 'hidden'));

console.log('\n=== 5. МЕСТО В РЕЙТИНГЕ В ПАНЕЛЬ НЕ ПОПАЛО ===');
check('5.1 в отрисовке панели нет номера места', (function () {
    const m = /function renderPlayerNameCell\([\s\S]*?\n\}/.exec(SRC);
    return m && !/stats_your_rank|№/.test(m[0]);
})());
check('5.2 место осталось только в статистике', (function () {
    return (SRC.match(/t\("stats_your_rank"\)/g) || []).length === 1;
})());
check('5.3 в разметке панели нет элемента места',
    !/id="player-(top|bottom)-rank"/.test(HTML));

console.log('\n=== 6. НИЧЕГО ЛИШНЕГО НЕ ЗАТРОНУТО ===');
check('6.1 доска не тронута', (function () {
    const b = rule('#board');
    return b && /grid-template-columns\s*:\s*repeat\(8, var\(--cell-size\)\)/.test(b);
})());
check('6.2 обёртка доски не тронута', (function () {
    const b = rule('#board-wrapper');
    return b && /padding\s*:\s*12px/.test(b);
})());
check('6.3 разметка панелей прежняя', (function () {
    return /id="player-top-name"/.test(HTML) && /id="player-top-status"/.test(HTML)
        && /id="player-top-captured"/.test(HTML);
})(), 'лишних узлов в index.html не добавлялось');

console.log('\n=== 7. CACHE-BUST ===');
// Меняются и style.css, и script.js. Без подъёма версий в ссылках
// Telegram WebView и CDN продолжат отдавать старые файлы, и правка
// у части игроков просто не применится.
check('7.1 стили подняты до v=16', /style\.css\?v=16/.test(HTML));
check('7.2 скрипт поднят до v=195', /script\.js\?v=195/.test(HTML));
check('7.3 старых ссылок не осталось',
    !/style\.css\?v=15\b/.test(HTML) && !/script\.js\?v=194\b/.test(HTML));
check('7.4 версии не совпадают со старыми нигде в файле',
    (HTML.match(/style\.css\?v=/g) || []).length === 1 &&
    (HTML.match(/script\.js\?v=/g) || []).length === 1);

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

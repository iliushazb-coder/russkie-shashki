// ==========================================================================
// ПАНЕЛЬ ИГРОКА: ФИКСИРОВАННАЯ СЕТКА И СТОПКА ВЗЯТЫХ ШАШЕК.
//
// Главное требование: вертикали одинаковы у верхней и нижней панели и не
// зависят ни от длины имени, ни от рейтинга, ни от статуса, ни от числа
// съеденных шашек. Поэтому проверяется именно СЕТКА, а не поток.
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
// Экранируем ВСЕ спецсимволы регулярки: селекторы содержат + и :nth-last-child(n+5),
// и без этого правило просто не находилось, хотя в CSS оно есть.
function rule(sel) {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('(^|\\n)' + esc + '\\s*\\{([^}]*)\\}').exec(CSS);
    return m ? m[2] : null;
}
function has(sel, prop, value) {
    const b = rule(sel);
    if (!b) return false;
    return new RegExp(prop + '\\s*:\\s*' + (value || '[^;]+')).test(b);
}

console.log('=== 1. ПАНЕЛЬ — СЕТКА, А НЕ ПОТОК ===');
check('1.1 display: grid', has('.player-panel', 'display', 'grid'),
    'при flex короткое имя утаскивало рейтинг влево');
check('1.4 ширина по-прежнему по доске', (function () {
    const b = rule('.player-panel') || '';
    return b.indexOf('max-width: var(--board-total)') !== -1;
})());
check('1.5 обе панели используют один класс',
    /id="player-top"/.test(HTML) && /id="player-bottom"/.test(HTML)
    && (HTML.match(/class="player-panel"/g) || []).length === 2);

console.log('\n=== 2. ЧЕТЫРЕ ЯЧЕЙКИ В РАЗМЕТКЕ ===');
['top', 'bottom'].forEach(function (side) {
    check('2.x ' + side + ': имя, рейтинг, статус, шашки', (function () {
        return new RegExp('id="player-' + side + '-name"').test(HTML)
            && new RegExp('id="player-' + side + '-rating"').test(HTML)
            && new RegExp('id="player-' + side + '-status"').test(HTML)
            && new RegExp('id="player-' + side + '-captured"').test(HTML);
    })());
});
check('2.y порядок ячеек одинаков у обеих панелей', (function () {
    const order = s => ['name', 'rating', 'status', 'captured']
        .map(k => HTML.indexOf('id="player-' + s + '-' + k + '"'));
    const t = order('top'), b = order('bottom');
    const asc = a => a.every((v, i) => i === 0 || (v > a[i - 1] && v !== -1));
    return asc(t) && asc(b);
})());

console.log('\n=== 3. ЧТО СОКРАЩАЕТСЯ ===');
// Многоточие переехало на .player-name-label: кружок цвета стал
// отдельным элементом и сокращаться не должен.
check('3.1 имя сокращается многоточием', has('.player-name-label', 'text-overflow', 'ellipsis'));
check('3.1b кружок цвета отдельным элементом', /\.player-color-dot\s*\{/.test(CSS));
check('3.1c кружок не сжимается', has('.player-color-dot', 'flex-shrink', '0'));
check('3.1e эмодзи в тексте имени не осталось', (function () {
    const fn = /function renderPlayerNameCell\([\s\S]*?\n\}/.exec(SRC);
    if (!fn) return false;
    // «⚪ » и «⚫ » съедали треть колонки на узком экране
    return !/[⚪⚫]/.test(fn[0]) && /label\.textContent = name;/.test(fn[0]);
})(), 'кружок должен быть элементом, а не знаками');
check('3.1f цвет передаётся кружку, а не тексту', (function () {
    const fn = /function renderPlayerNameCell\([\s\S]*?\n\}/.exec(SRC);
    return fn && /dot\.className[\s\S]{0,80}light-dot/.test(fn[0]);
})());
check('3.1d у кружка два цвета',
    /\.player-color-dot\.light-dot\s*\{/.test(CSS) && /\.player-color-dot\.dark-dot\s*\{/.test(CSS));
check('3.2 и не переносится', has('.player-name-label', 'white-space', 'nowrap'));
check('3.3 min-width: 0 у имени', has('.player-name', 'min-width', '0'),
    'без него колонка не сожмётся и многоточия не будет');
// Многоточие переехало на вложенный элемент: на контейнере overflow
// срезал свечение точки, и кружок выглядел подрезанным.
check('3.4 текст статуса может сократиться',
    has('.player-status-text', 'text-overflow', 'ellipsis'));
check('3.4b контейнер статуса НЕ обрезает содержимое', (function () {
    const b = rule('.player-status') || '';
    return !/overflow\s*:\s*hidden/.test(b);
})(), 'иначе точка статуса клипается');
check('3.4c точка не сжимается', has('.player-status::before', 'flex-shrink', '0'));
check('3.4d текст пишется ТОЛЬКО во вложенный элемент', (function () {
    const fn = /function applyStatusToElement\([\s\S]*?\n\}/.exec(SRC);
    if (!fn) return false;
    // el.textContent = "" допустим при создании узла, но присваивать
    // туда сам текст нельзя: это стёрло бы вложенный span
    return /textEl\.textContent = statusInfo\.text/.test(fn[0])
        && !/el\.textContent = statusInfo\.text/.test(fn[0]);
})(), 'иначе вложенный элемент стирается на каждом ходу');
check('3.5 РЕЙТИНГ не сокращается', !/text-overflow/.test(rule('.player-rating') || ''));
check('3.6 и не переносится', has('.player-rating', 'white-space', 'nowrap'));

console.log('\n=== 4. СТОПКА ВЗЯТЫХ ШАШЕК ===');
check('4.1 переноса строк нет', has('.captured-icons', 'flex-wrap', 'nowrap'),
    'перенос делал панели разной высоты');
check('4.2 шашки накладываются', (function () {
    const b = rule('.captured-icons .captured-icon + .captured-icon');
    return b && /margin-left\s*:\s*-\d+px/.test(b);
})());
check('4.3 наложение заметное, но шашки различимы', (function () {
    const b = rule('.captured-icons .captured-icon + .captured-icon') || '';
    const m = /margin-left\s*:\s*-(\d+)px/.exec(b);
    if (!m) return false;
    const overlap = parseInt(m[1], 10);
    // иконка 15px: сдвиг от 8 до 12 оставляет видимой полоску
    return overlap >= 8 && overlap <= 12;
})());
check('4.7 значок с числом есть', /\.captured-count\s*\{/.test(CSS));
// Значок больше не висит абсолютом над строкой — он выглядел
// подпрыгнувшим. Теперь обычный элемент ряда, по центру стопки.
check('4.8 значок стоит в ряду, а не над ним', (function () {
    const b = rule('.captured-count') || '';
    return !/position\s*:\s*absolute/.test(b) && /align-self\s*:\s*center/.test(b);
})());
check('4.8b значок не сжимается', has('.captured-count', 'flex-shrink', '0'));
check('4.8c стопка выравнивает содержимое по центру',
    has('.captured-icons', 'align-items', 'center'));
check('4.9 стопка — точка отсчёта для значка', has('.captured-icons', 'position', 'relative'));

console.log('\n=== 5. ОТРИСОВКА СТОПКИ ===');
{
    const fn = /function renderCapturedStack\([\s\S]*?\n\}/.exec(SRC);
    check('5.1 функция есть', !!fn);
    const body = fn ? fn[0] : '';
    check('5.2 число шашек в стопке ограничено', /CAPTURED_STACK_MAX/.test(body));
    check('5.3 значок показывает ПОЛНОЕ число, а не показанное',
        /badge\.textContent = String\(total\)/.test(body),
        'иначе при 12 съеденных значок соврёт');
    check('5.4 при нуле стопка пустая', /if \(total === 0\) return;/.test(body));
    check('5.5 цвет шашки сохраняется', /iconClass/.test(body));
    check('5.6 используется для обеих панелей',
        /renderCapturedStack\(playerTopCaptured/.test(SRC)
        && /renderCapturedStack\(playerBottomCaptured/.test(SRC));
    check('5.7 старая функция удалена', !/function renderCapturedIcons\(/.test(SRC));
}

console.log('\n=== 6. ИМЯ И РЕЙТИНГ — РАЗНЫЕ ЯЧЕЙКИ ===');
{
    const fn = /function renderPlayerNameCell\([\s\S]*?\n\}/.exec(SRC);
    const body = fn ? fn[0] : '';
    check('6.1 рейтинг пишется в свою ячейку', (function () {
        // Проверяем именно ЗАПИСЬ, а не упоминание параметра: без неё
        // ячейка рейтинга осталась бы пустой навсегда.
        return /ratingCell\.textContent\s*=/.test(body);
    })(), 'в одной ячейке многоточие съело бы рейтинг');
    check('6.1b и вызывается с этой ячейкой',
        /renderPlayerNameCell\([\s\S]{0,160}playerTopRating\)/.test(SRC)
        && /renderPlayerNameCell\([\s\S]{0,160}playerBottomRating\)/.test(SRC));
    check('6.2 только textContent, без innerHTML',
        /textContent/.test(body) && !/innerHTML/.test(body));
    check('6.3 вложенных span больше нет', !/player-name-text/.test(SRC));
}

console.log('\n=== 7. СТАТУС ===');
check('7.1 отсчёт сокращён до «Оффлайн Nс»',
    !/status_left"\) \+ " " \+ remaining/.test(SRC)
    && /t\("status_offline"\) \+ " " \+ remaining/.test(SRC));
check('7.2 у отсчёта отдельный класс', /cls: "status-countdown"/.test(SRC));
check('7.3 и отдельный цвет', /\.player-status\.status-countdown\s*\{/.test(CSS));
check('7.4 прежние состояния сохранены',
    /status-online/.test(CSS) && /status-neutral/.test(CSS) && /status-left/.test(CSS));

console.log('\n=== 7b. НИЧЕГО НЕ СХЛОПЫВАЕТСЯ И НЕ РАСПУХАЕТ ===');
check('7b.2 колонка стопки постоянной ширины', (function () {
    const m = /grid-template-columns\s*:\s*([^;]+);/.exec(rule('.player-panel') || '');
    return m && /var\(--stack-width\)/.test(m[1]);
})());
check('7b.3 иконки не сжимаются', has('.captured-icon', 'flex-shrink', '0'));

console.log('\n=== 7c. ЗАТУХАНИЕ ПАНЕЛИ ПРИ УХОДЕ СОПЕРНИКА ===');
check('7c.1 отсчёт тоже гасит панель', (function () {
    const fn = /function applyStatusToElement\([\s\S]*?\n\}/.exec(SRC);
    return fn && /status-countdown/.test(fn[0]);
})(), 'после разделения классов затухание пропало бы');
check('7c.2 прежний случай сохранён', (function () {
    const fn = /function applyStatusToElement\([\s\S]*?\n\}/.exec(SRC);
    return fn && /status-left/.test(fn[0]);
})());
check('7c.3 в остальных состояниях панель не гаснет', (function () {
    const fn = /function applyStatusToElement\([\s\S]*?\n\}/.exec(SRC);
    return fn && /classList\.remove\("player-faded"\)/.test(fn[0]);
})());
check('7c.4 мёртвый ratingPrefix удалён', !/ratingPrefix/.test(SRC),
    'после переноса рейтинга в свою ячейку он всегда был пустой строкой');

console.log('\n=== 7e. КОЛОНКИ ЗАДАНЫ СОДЕРЖИМЫМ ===');
// Ширины больше не считаются в ch: эта единица в grid-template-columns
// берётся от шрифта панели, а не дочерних элементов, и давала
// переполнение. Фактические размеры проверяет panel-browser-layout.
// auto подстраивался под содержимое КАЖДОЙ панели, поэтому у соперников
// с разными рейтингами вертикали расходились. Колонки снова фиксированы,
// но в em от ЯВНО заданного шрифта панели, а не в ch.
check('7e.1 колонки рейтинга и статуса фиксированы', (function () {
    const m = /grid-template-columns\s*:\s*([^;]+);/.exec(rule('.player-panel') || '');
    return m && /var\(--rating-width\)\s+var\(--status-width\)/.test(m[1]);
})());
check('7e.2 auto в колонках не осталось', (function () {
    const m = /grid-template-columns\s*:\s*([^;]+);/.exec(rule('.player-panel') || '');
    return m && !/\bauto\b/.test(m[1]);
})(), 'auto зависит от содержимого и разводит панели');
check('7e.2b ширины заданы в em', (function () {
    const b = rule('.player-panel') || '';
    return /--rating-width:\s*[\d.]+em/.test(b) && /--status-width:\s*[\d.]+em/.test(b);
})());
check('7e.2c панели задан явный шрифт для этих em', (function () {
    const b = rule('.player-panel') || '';
    return /font-size:\s*clamp\(/.test(b);
})(), 'без него em считался бы от 16px и колонки не масштабировались');
check('7e.3 имя забирает остаток', (function () {
    const m = /grid-template-columns\s*:\s*([^;]+);/.exec(rule('.player-panel') || '');
    return m && /^minmax\(0, *1fr\)/.test(m[1].trim());
})());

console.log('\n=== 7f. СТОПКА РАСТЁТ ВЛЕВО ОТ ЦИФРЫ ===');
check('7f.1 содержимое прижато вправо',
    has('.captured-icons', 'justify-content', 'flex-end'),
    'иначе цифра поедет при изменении числа шашек');
check('7f.2 значок стоит последним в ряду', (function () {
    const fn = /function renderCapturedStack\([\s\S]*?\n\}/.exec(SRC);
    if (!fn) return false;
    // значок добавляется ПОСЛЕ цикла с иконками
    return fn[0].indexOf('appendChild(badge)') > fn[0].indexOf('appendChild(icon)');
})());
check('7f.3 порядок узлов не переворачивался',
    !/flex-direction\s*:\s*row-reverse/.test(rule('.captured-icons') || ''),
    'переворот сломал бы отсчёт глубины');

console.log('\n=== 7d. МИНИ-ШАШКИ ПОХОЖИ НА ДОСКУ ===');
// Раньше мини-шашки были золотисто-обведённые и на доску не походили.
// Сравниваем с настоящими фигурами: градиент и цвет рамки должны
// совпадать, иначе панель снова разъедется с доской по стилю.
['dark', 'light'].forEach(function (side) {
    const mini = rule('.captured-icon.' + side + '-icon') || '';
    const real = rule('.piece-' + side) || '';
    check('7d.x ' + side + ': градиент как у шашки на доске', (function () {
        const g = /background:\s*radial-gradient\(([^;]+)\);/;
        const a = g.exec(mini), b = g.exec(real);
        return a && b && a[1].trim() === b[1].trim();
    })());
    check('7d.y ' + side + ': цвет рамки как у шашки на доске', (function () {
        const c = /border:\s*\d+px solid (#[0-9a-fA-F]+)/;
        const a = c.exec(mini), b = c.exec(real);
        return a && b && a[1].toLowerCase() === b[1].toLowerCase();
    })());
    check('7d.z ' + side + ': объём сохранён', /inset/.test(mini));
});
check('7d.v есть блик, как у фигуры на доске', (function () {
    const mini = rule('.captured-icon::before') || '';
    const real = rule('.piece::before') || '';
    const g = /top:\s*(\d+)%[\s\S]*?left:\s*(\d+)%[\s\S]*?width:\s*(\d+)%/;
    const a = g.exec(mini), b = g.exec(real);
    return a && b && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
})(), 'та же геометрия блика, что у настоящей шашки');
check('7d.u есть кольца', (function () {
    const b = rule('.captured-icon::after') || '';
    return (b.match(/radial-gradient/g) || []).length >= 2;
})());
check('7d.t иконке задан position для блика и колец',
    has('.captured-icon', 'position', 'relative'));
check('7d.w золотистой обводки больше нет',
    !/\.captured-icon\.(dark|light)-icon\s*\{[^}]*#b3925a|#d4b978/.test(CSS));

console.log('\n=== 7g. ЧУЖИЕ ЭКРАНЫ НЕ ЗАТРОНУТЫ ===');
// Промежутки панели правились заменой по всему файлу и дважды задели
// посторонние правила. Фиксируем их значения поимённо.
{
    const vals = {};
    const re = /([^{}]+)\{([^}]*)\}/g; let m;
    while ((m = re.exec(CSS))) {
        const sel = m[1].trim().split('\n').pop().trim();
        const g = /gap:\s*(\d+)px/.exec(m[2]);
        if (g) vals[sel] = parseInt(g[1], 10);
    }
    check('7g.1 промежуток панели уменьшен', vals['.player-panel'] === 4);
    [['#active-rooms-section', 8], ['#active-rooms-list', 8],
     ['.room-item-row', 8], ['.stats-tabs', 6]].forEach(function (p) {
        check('7g.x ' + p[0] + ' не тронут', vals[p[0]] === p[1],
            'ожидалось ' + p[1] + 'px, стало ' + vals[p[0]] + 'px');
    });
    check('7g.2 поля панели уменьшены', (function () {
        const b = rule('.player-panel') || '';
        return /padding:\s*6px 10px/.test(b);
    })());
}

console.log('\n=== 8. МЕСТО В РЕЙТИНГЕ И CACHE-BUST ===');
check('8.1 места в панели нет', !/id="player-(top|bottom)-rank"/.test(HTML));
check('8.2 место только в статистике',
    (SRC.match(/t\("stats_your_rank"\)/g) || []).length === 1);
check('8.3 скрипт поднят', /script\.js\?v=198/.test(HTML));
check('8.4 стили подняты', /style\.css\?v=19/.test(HTML));
check('8.5 старых ссылок нет',
    !/script\.js\?v=195/.test(HTML) && !/style\.css\?v=16/.test(HTML));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

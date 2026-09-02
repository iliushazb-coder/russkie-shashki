// ==========================================================================
// СТОПКА ВЗЯТЫХ ШАШЕК: ПРОВЕРКА ПОСТРОЕННОГО DOM, А НЕ СТРОК CSS.
//
// Прежние проверки смотрели на текст стилей и пропустили два дефекта:
// значок с числом забирал nth-last-child(1) себе, и колонка стопки
// меняла ширину от количества шашек. Здесь строится настоящее дерево
// узлов и считаются фактические значения.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
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

// --- минимальный DOM ---
function makeEl(tag) {
    return {
        tagName: tag, children: [],
        // Значок задаётся через className, иконки — через classList.
        // Макет обязан поддерживать оба способа, иначе тест ищет узлы,
        // которых для него как бы нет.
        set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); },
        get className() { return this.classList.toString(); },
        classList: {
            _s: new Set(),
            add: function () { for (const c of arguments) if (c) this._s.add(c); },
            contains: function (c) { return this._s.has(c); },
            toString: function () { return [...this._s].join(' '); }
        },
        style: { _p: {}, setProperty: function (k, v) { this._p[k] = v; } },
        set textContent(v) { if (v === '') this.children = []; this._t = v; },
        get textContent() { return this._t; },
        appendChild: function (c) { this.children.push(c); return c; }
    };
}
global.document = { createElement: makeEl };

// ЭТАЛОН задан здесь, а не берётся из script.js: иначе тест проверял бы
// сам себя и пропустил бы изменение самих значений глубины.
const EXPECTED_DEPTH = [1, 0.82, 0.66, 0.52, 0.45];

eval(grab('capturedDepthOpacity'));
eval(grab('renderCapturedStack'));
global.CAPTURED_STACK_MAX = 6;
global.CAPTURED_DEPTH_OPACITY = (function () {
    const m = /const CAPTURED_DEPTH_OPACITY = (\[[^\]]*\]);/.exec(SRC);
    return m ? JSON.parse(m[1]) : [];
})();

function build(total) {
    const c = makeEl('div');
    renderCapturedStack(c, total, 'dark-icon');
    const icons = c.children.filter(x => x.classList.contains('captured-icon'));
    const badges = c.children.filter(x => x.classList.contains('captured-count'));
    return { c, icons, badges };
}

console.log('=== 1. ЗНАЧОК НЕ УЧАСТВУЕТ В ГЛУБИНЕ ===');
[1, 2, 3, 5, 6, 12].forEach(function (total) {
    const { icons, badges } = build(total);
    const front = icons[icons.length - 1];
    check('1.x при ' + total + ' взятых передняя шашка непрозрачна',
        !!front && front.style._p['--depth-opacity'] === '1',
        front ? front.style._p['--depth-opacity'] : 'шашек нет');
    check('1.y при ' + total + ' значок идёт ПОСЛЕ шашек и не шашка',
        badges.length === 1 && !badges[0].classList.contains('captured-icon'));
});

console.log('\n=== 1b. ЗНАЧЕНИЯ ГЛУБИНЫ СОВПАДАЮТ С ЭТАЛОНОМ ===');
check('1b.1 ряд прозрачности не менялся',
    JSON.stringify(global.CAPTURED_DEPTH_OPACITY) === JSON.stringify(EXPECTED_DEPTH),
    JSON.stringify(global.CAPTURED_DEPTH_OPACITY));
check('1b.2 передняя ровно 1', global.CAPTURED_DEPTH_OPACITY[0] === 1);
check('1b.3 предел стопки шесть', /CAPTURED_STACK_MAX = 6;/.test(SRC));

console.log('\n=== 2. ПОСЛЕДОВАТЕЛЬНОСТЬ ГЛУБИНЫ ===');
{
    const { icons } = build(5);
    const seq = icons.map(i => parseFloat(i.style._p['--depth-opacity']));
    check('2.1 глубина убывает вглубь стопки',
        seq[4] === EXPECTED_DEPTH[0] && seq[3] === EXPECTED_DEPTH[1]
        && seq[2] === EXPECTED_DEPTH[2] && seq[1] === EXPECTED_DEPTH[3],
        JSON.stringify(seq));
    check('2.2 дальние не бледнее 0.45', Math.min.apply(null, seq) >= 0.45);
    const six = build(6).icons.map(i => parseFloat(i.style._p['--depth-opacity']));
    check('2.3 пятая и дальше держат ровный уровень',
        six[0] === 0.45 && six[1] === 0.45, JSON.stringify(six));
    check('2.4 порядок наложения растёт к передней', (function () {
        const z = icons.map(i => parseInt(i.style._p['--depth-order'], 10));
        return z.every((v, k) => k === 0 || v > z[k - 1]);
    })());
}

console.log('\n=== 3. КОЛИЧЕСТВО УЗЛОВ ===');
[[0, 0, 0], [1, 1, 1], [3, 3, 1], [6, 6, 1], [12, 6, 1]].forEach(function (t) {
    const { icons, badges } = build(t[0]);
    check('3.x при ' + t[0] + ' взятых: ' + t[1] + ' шашек, ' + t[2] + ' значок',
        icons.length === t[1] && badges.length === t[2],
        icons.length + '/' + badges.length);
});
check('3.y значок показывает ПОЛНОЕ число, а не показанное', (function () {
    const { badges } = build(12);
    return badges[0].textContent === '12';
})(), 'иначе при 12 съеденных значок соврёт');
check('3.z при нуле контейнер пуст', build(0).c.children.length === 0);

console.log('\n=== 4. ШИРИНА КОЛОНКИ ПОСТОЯННА ===');
{
    // Колонка задана переменной, а не auto: содержимое на неё не влияет.
    const panel = /\.player-panel\s*\{([^}]*)\}/.exec(CSS);
    const cols = panel && /grid-template-columns\s*:\s*([^;]+);/.exec(panel[1]);
    check('4.1 последняя колонка НЕ auto',
        !!cols && !/\bauto\s*;?\s*$/.test(cols[1].trim()),
        cols ? cols[1] : 'не найдено');
    check('4.2 последняя колонка — переменная фиксированной ширины',
        !!cols && /var\(--stack-width\)\s*$/.test(cols[1].trim()), cols ? cols[1] : '');
    check('4.3 переменная объявлена в px', /--stack-width\s*:\s*\d+px/.test(CSS));
    check('4.4 её хватает на полную стопку', (function () {
        const m = /--stack-width\s*:\s*(\d+)px/.exec(CSS);
        const ov = /\.captured-icon \+ \.captured-icon\s*\{[^}]*margin-left\s*:\s*-(\d+)px/.exec(CSS);
        const sz = /\.captured-icon\s*\{[^}]*width\s*:\s*(\d+)px/.exec(CSS);
        if (!m || !ov || !sz) return false;
        // шесть иконок: первая целиком, остальные по (размер - наложение)
        const need = parseInt(sz[1], 10) + 5 * (parseInt(sz[1], 10) - parseInt(ov[1], 10));
        return parseInt(m[1], 10) >= need;
    })(), 'иначе шестая шашка обрежется');
    check('4.5 ширина стопки не зависит от содержимого', (function () {
        // ни одного правила, где ширина стопки задавалась бы содержимым
        const b = /\.captured-icons\s*\{([^}]*)\}/.exec(CSS);
        return b && !/width\s*:\s*(auto|fit-content|max-content)/.test(b[1]);
    })());
}

console.log('\n=== 5. ГЛУБИНА ЗАДАЁТСЯ ШАШКОЙ, А НЕ ПОЗИЦИЕЙ ===');
check('5.1 позиционных селекторов глубины больше нет',
    !/captured-icon:nth-last-child/.test(CSS),
    'значок ломал их: он становился последним ребёнком');
check('5.2 прозрачность берётся из переменной',
    /\.captured-icons \.captured-icon\s*\{[^}]*opacity\s*:\s*var\(--depth-opacity/.test(CSS));
check('5.3 порядок наложения тоже',
    /\.captured-icons \.captured-icon\s*\{[^}]*z-index\s*:\s*var\(--depth-order/.test(CSS));
check('5.4 переменные выставляются при отрисовке',
    /setProperty\("--depth-opacity"/.test(SRC) && /setProperty\("--depth-order"/.test(SRC));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

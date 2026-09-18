// ==========================================================================
// ЦЕНТРИРОВАНИЕ ФИШЕК И ДАМОК.
//
// На Android Telegram и в Desktop-клиенте фигуры визуально сидели не по
// центру клетки. Причина: четыре финальных PNG-правила
// (.piece-dark, .piece-light, .piece-dark.king, .piece-light.king)
// использовали background-size: contain без background-position, а
// умолчание для background-position -- 0% 0% (левый верхний угол), не
// центр. Сами PNG проверены отдельно и симметричны; promotion-overlay
// (king-promotion-flip-king) уже центрировался правильно -- рассинхрон
// был только у статичных фигур.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS_CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}

// Некоторые селекторы (.piece-dark, .piece-light) встречаются в файле
// ДВАЖДЫ: старое gradient-правило раньше по файлу, финальное
// PNG-правило -- позже и перебивает первое через !important. Нам нужен
// именно финальный блок, поэтому берём ПОСЛЕДНЕЕ совпадение, а не первое.
// Selectors here appear in several unrelated blocks: an old gradient rule
// with the same selector, a shared "box-shadow: none" reset that lists
// all four selectors together, and -- for ".piece-dark" / ".piece-light"
// -- as a substring of the longer ".king-promotion-flip-king.piece-dark".
// The block that matters for this test is specifically the one carrying
// background-image, so match on that rather than on selector position.
// Generic lookup: last block whose selector list contains this exact
// selector. Fine for selectors that occur once (.square, .king,
// .move-ghost-piece); for ones that occur several times see below.
function rule(selector) {
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m, last = null;
    while ((m = re.exec(CSS_CLEAN)) !== null) {
        const selectors = m[1].split(',').map(function (s) { return s.trim(); });
        if (selectors.indexOf(selector) !== -1) last = m[2];
    }
    return last;
}

// .piece-dark / .piece-light / their .king combos appear in three places:
// an old gradient rule, the PNG rule this test is actually about, and a
// shared "box-shadow: none" reset listing all four together. Only the
// PNG one carries background-image, so filter on that instead of position.
function pngRule(selector) {
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m, found = null;
    while ((m = re.exec(CSS_CLEAN)) !== null) {
        const selectors = m[1].split(',').map(function (s) { return s.trim(); });
        if (selectors.indexOf(selector) !== -1 && /background-image:/.test(m[2])) {
            found = m[2];
        }
    }
    return found;
}

console.log('=== 1. ЧЕТЫРЕ ФИНАЛЬНЫХ ПРАВИЛА ЦЕНТРИРУЮТ ФОН ===');

const SELECTORS = ['.piece-dark', '.piece-light', '.piece-dark.king', '.piece-light.king'];
SELECTORS.forEach(function (sel, i) {
    const body = pngRule(sel);
    check((i + 1) + '.1 ' + sel + ' правило найдено', !!body);
    check((i + 1) + '.2 ' + sel + ' центрирует фон',
        !!body && /background-position:\s*center\s*!important/.test(body));
    check((i + 1) + '.3 ' + sel + ' сохраняет background-size: contain',
        !!body && /background-size:\s*contain\s*!important/.test(body));
    check((i + 1) + '.4 ' + sel + ' сохраняет background-repeat: no-repeat',
        !!body && /background-repeat:\s*no-repeat\s*!important/.test(body));
});

console.log('\n=== 2. PROMOTION OVERLAY НЕ ЗАДЕТ ===');
{
    // Overlay уже центрировался правильно до этой правки -- проверяем,
    // что он остался как был, а не получил лишних изменений.
    const king = pngRule('.king-promotion-flip-king.piece-dark');
    const light = pngRule('.king-promotion-flip-king.piece-light');
    check('2.1 overlay для тёмной дамки центрирован',
        !!king && /background-position:\s*center/.test(king));
    check('2.2 overlay для светлой дамки центрирован',
        !!light && /background-position:\s*center/.test(light));
}

console.log('\n=== 3. НИЧЕГО ЛИШНЕГО НЕ ЗАТРОНУТО ===');
{
    // .square центрирует .piece внутри клетки через flexbox -- эта правка
    // его не касается и не должна.
    const square = rule('.square');
    check('3.1 .square по-прежнему центрирует через flexbox',
        !!square && /justify-content:\s*center/.test(square) && /align-items:\s*center/.test(square));

    // .king масштабируется из центра по умолчанию (transform-origin не
    // задавался нигде и не должен появиться из-за этой правки).
    check('3.2 transform-origin не добавлялся нигде в файле',
        !/transform-origin/.test(CSS_CLEAN));

    const king = rule('.king');
    check('3.3 .king transform: scale(1.1) не тронут',
        !!king && /transform:\s*scale\(1\.1\)\s*!important/.test(king));

    // move-ghost-piece не имеет собственного background-image -- он
    // получает классы фигуры через JS, значит наследует правку
    // автоматически, без отдельного правила.
    const ghost = rule('.move-ghost-piece');
    check('3.4 у move-ghost-piece нет своего background-image',
        !!ghost && !/background-image/.test(ghost));

    check('3.5 .selected не менялся',
        /\.selected \{\s*\n\s*transform: scale\(1\.1\);/.test(CSS_CLEAN));
}

console.log('\n=== 4. АССЕТЫ И ДВИЖОК НЕ ЗАТРОНУТЫ ===');
{
    check('4.1 версии PNG-ассетов не менялись (v2)',
        (CSS_CLEAN.match(/(?:piece|king)_(?:dark|light)\.png\?v=2/g) || []).length >= 6);
    check('4.2 style.css cache-bust поднят (>= 34)', (function () {
        const m = /style\.css\?v=(\d+)/.exec(HTML);
        return !!m && parseInt(m[1], 10) >= 34;
    })(), (/style\.css\?v=(\d+)/.exec(HTML) || [])[1]);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

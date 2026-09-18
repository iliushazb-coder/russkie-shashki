// ==========================================================================
// ГЕОМЕТРИЯ ДОСКИ -- CSS-ЧАСТЬ ФИКСА.
//
// Реальное визуальное подтверждение (border/outline geometry, точность
// board.png) живёт в tests/board-geometry.test.js -- ему нужны браузерные
// движки, и он не входит в этот прогон. Здесь -- быстрые проверки
// исходников, которые не требуют браузера: что фикс СДЕЛАН (border ->
// outline) и что предыдущий ложный fix (background-position на фишках)
// убран, а не остался как misleading no-op.
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

function rule(selector) {
    const re = /([^{}]+)\{([^}]*)\}/g;
    let m, last = null;
    while ((m = re.exec(CSS_CLEAN)) !== null) {
        const selectors = m[1].split(',').map(function (s) { return s.trim(); });
        if (selectors.indexOf(selector) !== -1) last = m[2];
    }
    return last;
}

console.log('=== 1. #board: border -> outline ===');
{
    // #board встречается в файле ДВАЖДЫ: блок с сеткой/рамкой (этот нам
    // нужен) и отдельный блок только с background-image (та же ситуация,
    // что у .piece-dark -- несколько правил с одним селектором). Ищем
    // именно блок с grid-template, а не последний по позиции.
    function boardGridRule() {
        const re = /([^{}]+)\{([^}]*)\}/g;
        let m, found = null;
        while ((m = re.exec(CSS_CLEAN)) !== null) {
            const sels = m[1].split(',').map(function (s) { return s.trim(); });
            if (sels.indexOf('#board') !== -1 && /grid-template-columns/.test(m[2])) found = m[2];
        }
        return found;
    }
    const board = boardGridRule();
    check('1.1 #board правило найдено', !!board);
    check('1.2 больше НЕ использует border для рамки',
        !!board && !/\bborder:\s*1px solid/.test(board));
    check('1.3 использует outline вместо border',
        !!board && /outline:\s*1px solid #d4a94f/.test(board));
    check('1.4 outline-offset: -1px (рамка на прежнем месте, не поверх соседей)',
        !!board && /outline-offset:\s*-1px/.test(board));
    check('1.5 overflow: hidden сохранён (клип последнего трека, если он есть)',
        !!board && /overflow:\s*hidden/.test(board));
    check('1.6 grid-tracks по 8 клеток на cell-size не менялись',
        !!board && /grid-template-columns:\s*repeat\(8, var\(--cell-size\)\)/.test(board) &&
        /grid-template-rows:\s*repeat\(8, var\(--cell-size\)\)/.test(board));
}

console.log('\n=== 2. ЛОЖНЫЙ FIX УБРАН ===');
{
    // background-position:center на .piece-dark/.piece-light/их .king был
    // доказан no-op (квадрат в квадрате, contain, свободного места нет).
    // Оставлять его как «исправление центровки» -- вводящий в заблуждение
    // комментарий/тест, поэтому убран целиком, а не просто перестал
    // проверяться.
    const selectors = ['.piece-dark', '.piece-light', '.piece-dark.king', '.piece-light.king'];
    function pngRule(selector) {
        const re = /([^{}]+)\{([^}]*)\}/g;
        let m, found = null;
        while ((m = re.exec(CSS_CLEAN)) !== null) {
            const sels = m[1].split(',').map(function (s) { return s.trim(); });
            if (sels.indexOf(selector) !== -1 && /background-image:/.test(m[2])) found = m[2];
        }
        return found;
    }
    selectors.forEach(function (sel, i) {
        const body = pngRule(sel);
        check((i + 1) + '.1 ' + sel + ' не содержит background-position: center',
            !!body && !/background-position:\s*center/.test(body));
        check((i + 1) + '.2 ' + sel + ' сохраняет background-size: contain',
            !!body && /background-size:\s*contain\s*!important/.test(body));
    });
    check('2.5 нигде в style.css не осталось "background-position: center !important"',
        !/background-position:\s*center\s*!important/.test(CSS_CLEAN));

    // promotion overlay использовал center ДО этого PR по другой причине
    // (у него нет !important-конфликта с .king) -- его не трогаем.
    const overlay = rule('.king-promotion-flip-king.piece-dark');
    check('2.6 promotion overlay не затронут этим PR',
        !!overlay && /background-position:\s*center/.test(overlay));
}

console.log('\n=== 3. АССЕТ ===');
{
    // board.png подключается из style.css (background-image), а не из
    // index.html -- в отличие от script.js/style.css, у него не было
    // никакого номера версии вообще. Раз содержимое файла изменилось,
    // версия обязана появиться -- иначе браузеры и CDN могут отдать
    // закэшированный старый (геометрически неточный) вариант.
    check('3.1 board.png подключается с номером версии (?v=N)',
        /assets\/board\.png\?v=\d+/.test(CSS_CLEAN));
    check('3.2 ссылка на board.png единственная (нет расхождения путей)',
        (CSS_CLEAN.match(/assets\/board\.png/g) || []).length === 1);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

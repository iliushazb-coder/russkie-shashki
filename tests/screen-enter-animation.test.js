// ==========================================================================
// ПОЯВЛЕНИЕ ЭКРАНОВ (#3A).
//
// Главное свойство этой правки -- она ЧИСТО CSS. showScreen() не должен
// получить ни таймеров, ни animationend, ни служебных классов: экран
// обязан становиться видимым синхронно, а анимация -- быть побочным
// эффектом снятия .hidden, а не отдельным жизненным циклом.
//
// Поэтому тесты защищают не только наличие анимации, но и ОТСУТСТВИЕ
// логики в JS: именно она и была бы источником гонок при быстрых
// переходах waiting -> game, reconnect и входе по invite-ссылке.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}

function noComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function funcBody(src, name) {
    const i = src.indexOf('function ' + name + '(');
    if (i === -1) return null;
    const from = src.indexOf('{', i);
    if (from === -1) return null;
    let depth = 0;
    for (let k = from; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    return null;
}

const CLEAN = noComments(SRC);
const CSS_CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const SCREENS = ['menu-screen', 'time-control-screen', 'group-lobby-screen',
                 'waiting-screen', 'game-screen'];

console.log('=== 1. ВСЕ ПЯТЬ ЭКРАНОВ ПОКРЫТЫ ===');

const enterRule = /((?:#[a-z-]+:not\(\.hidden\),\s*\n)*#[a-z-]+:not\(\.hidden\))\s*\{\s*animation: screenEnter[^}]*\}/.exec(CSS_CLEAN);
check('1.1 правило появления найдено', !!enterRule);

SCREENS.forEach(function (id, i) {
    check('1.' + (i + 2) + ' #' + id + ' покрыт',
        !!enterRule && enterRule[1].indexOf('#' + id + ':not(.hidden)') !== -1);
});

check('1.7 экраны существуют в разметке',
    SCREENS.every(function (id) { return HTML.indexOf('id="' + id + '"') !== -1; }));
check('1.8 keyframes screenEnter объявлены', /@keyframes screenEnter \{/.test(CSS_CLEAN));

console.log('\n=== 2. showScreen ОСТАЁТСЯ СИНХРОННЫМ ===');
{
    // Если бы переход получил жизненный цикл в JS, при быстрых
    // переключениях (waiting -> game, reconnect, invite-ссылка) на экране
    // могли бы остаться два видимых экрана или устаревший служебный класс.
    const body = funcBody(CLEAN, 'showScreen');
    check('2.1 showScreen найдена', !!body);
    if (body) {
        check('2.2 нет setTimeout', !/setTimeout/.test(body));
        check('2.3 нет requestAnimationFrame', !/requestAnimationFrame/.test(body));
        check('2.4 нет animationend/transitionend', !/animationend|transitionend/.test(body));
        check('2.5 нет addEventListener', !/addEventListener/.test(body));
        check('2.6 нет служебных классов перехода',
            !/screen-enter|screen-leave|screen-anim|is-entering/.test(body));
        check('2.7 нет promise/async', !/async |await |\.then\(/.test(body));
        // Снятие hidden обязано быть последним действием и синхронным.
        check('2.8 hidden снимается синхронно, без обёрток',
            /screen\.classList\.remove\("hidden"\);/.test(body));
        check('2.9 старые экраны прячутся тем же classList.add("hidden")',
            (body.match(/\.classList\.add\("hidden"\)/g) || []).length >= 4);
    }
    // Ни один служебный класс перехода не должен появиться во всём файле.
    check('2.10 в script.js нет классов анимации экранов',
        !/screen-enter|screen-leave/.test(CLEAN));
}

console.log('\n=== 3. hidden НЕ ИЗМЕНЁН ===');
check('3.1 .hidden остаётся display: none !important',
    /\.hidden \{\s*display: none !important;\s*\}/.test(CSS_CLEAN));
check('3.2 у .hidden не появилось анимаций или переходов', (function () {
    const m = /\.hidden \{([^}]*)\}/.exec(CSS_CLEAN);
    return !!m && !/animation|transition|opacity/.test(m[1]);
})());

console.log('\n=== 4. PREFERS-REDUCED-MOTION ===');
{
    const blocks = CSS_CLEAN.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    const rm = blocks.find(function (b) { return /screen:not\(\.hidden\)/.test(b); });
    check('4.1 блок reduced-motion покрывает экраны', !!rm);
    SCREENS.forEach(function (id, i) {
        check('4.' + (i + 2) + ' #' + id + ' отключён при reduced-motion',
            !!rm && rm.indexOf('#' + id + ':not(.hidden)') !== -1);
    });
    check('4.7 анимация именно отключается', !!rm && /animation: none/.test(rm));
}

console.log('\n=== 5. ИГРОВОЙ ЭКРАН НЕ ПОЛУЧИЛ ОСОБОЙ ЛОГИКИ ===');
{
    // game-screen обязан вести себя ровно так же, как остальные четыре:
    // никакой отдельной ветки, которая могла бы задержать партию.
    const body = funcBody(CLEAN, 'showScreen');
    check('5.1 в showScreen нет ветки специально под gameScreen с анимацией', (function () {
        if (!body) return false;
        // Единственное упоминание gameScreen кроме скрытия и показа --
        // отмена звука превращения, она к анимации отношения не имеет.
        const lines = body.split('\n').filter(function (l) { return /gameScreen/.test(l); });
        return lines.every(function (l) {
            return /classList\.add\("hidden"\)/.test(l) || /cancelKingSound/.test(l);
        });
    })());
    check('5.2 у #game-screen нет собственной, отличной от других анимации', (function () {
        // Правило появления одно и общее; отдельного animation у
        // game-screen быть не должно.
        const own = /#game-screen \{([^}]*)\}/.exec(CSS_CLEAN);
        return !own || !/animation/.test(own[1]);
    })());
    check('5.3 длительность одинакова для всех экранов', (function () {
        const all = CSS_CLEAN.match(/animation: screenEnter (\d+)ms/g) || [];
        if (all.length === 0) return false;
        return all.every(function (a) { return a === all[0]; });
    })());
}

console.log('\n=== 6. ХАРАКТЕР АНИМАЦИИ ===');
{
    const m = /animation: screenEnter (\d+)ms ([^;]+);/.exec(CSS_CLEAN);
    check('6.1 длительность объявлена', !!m);
    check('6.2 длительность в диапазоне 150-200 мс', (function () {
        if (!m) return false;
        const ms = parseInt(m[1], 10);
        return ms >= 150 && ms <= 200;
    })(), m ? m[1] + 'ms' : '?');

    const kf = /@keyframes screenEnter \{[\s\S]*?\n\}/.exec(CSS_CLEAN);
    check('6.3 анимируется прозрачность', !!kf && /opacity: 0/.test(kf[0]));
    check('6.4 есть небольшой подъём', !!kf && /translateY\(\d+px\)/.test(kf[0]));
    check('6.5 подъём не больше 10px', (function () {
        if (!kf) return false;
        const t = /translateY\((\d+)px\)/.exec(kf[0]);
        return !!t && parseInt(t[1], 10) <= 10;
    })());
    // Тяжёлых эффектов быть не должно: доска -- самый горячий путь рендера.
    check('6.6 нет масштаба, размытия и теней', !!kf && !/scale\(|blur\(|box-shadow/.test(kf[0]));
    check('6.7 easing без отскока (спокойное появление)', (function () {
        if (!m) return false;
        const cb = /cubic-bezier\(([^)]+)\)/.exec(m[2]);
        if (!cb) return true;
        // Отскок = значение y вне [0,1]; для спокойной кривой такого нет.
        const v = cb[1].split(',').map(function (x) { return parseFloat(x); });
        return v.length === 4 && v[1] >= 0 && v[1] <= 1 && v[3] >= 0 && v[3] <= 1;
    })());
}

console.log('\n=== 7. CACHE-BUST ===');
check('7.1 style.css поднят (>= 28)', (function () {
    const m = /style\.css\?v=(\d+)/.exec(HTML);
    return !!m && parseInt(m[1], 10) >= 28;
})(), (/style\.css\?v=(\d+)/.exec(HTML) || [])[1]);

console.log('\n=== 8. МОДАЛКИ НЕ ТРОНУТЫ (это #3B) ===');
check('8.1 closeModal по-прежнему ставит hidden первой строкой', (function () {
    const body = funcBody(CLEAN, 'closeModal');
    if (!body) return false;
    const i = body.indexOf('modal.classList.add("hidden")');
    const j = body.indexOf('modalFocusState.get(modal)');
    return i !== -1 && j !== -1 && i < j;
})());
check('8.2 у .modal-overlay не появилось классов закрытия',
    !/modal-closing/.test(CSS_CLEAN) && !/modal-closing/.test(CLEAN));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

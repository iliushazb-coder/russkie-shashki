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
    // 280 мс вместо прежних 200: переход должен читаться как мягкое
    // открытие, а не как мгновенная подмена. Задержки при этом нет --
    // экран становится видимым в том же синхронном вызове showScreen().
    check('6.2 длительность ровно 280 мс', !!m && parseInt(m[1], 10) === 280,
        m ? m[1] + 'ms' : '?');

    const kf = /@keyframes screenEnter \{[\s\S]*?\n\}/.exec(CSS_CLEAN);
    check('6.3 анимируется прозрачность', !!kf && /opacity: 0/.test(kf[0]));
    check('6.4 есть небольшой подъём', !!kf && /translateY\(\d+px\)/.test(kf[0]));
    // При 6px движение почти не читалось, поэтому подъём увеличен.
    check('6.5 подъём ровно 10px', (function () {
        if (!kf) return false;
        const t = /translateY\((\d+)px\)/.exec(kf[0]);
        return !!t && parseInt(t[1], 10) === 10;
    })(), kf ? (/translateY\((\d+)px\)/.exec(kf[0]) || [])[1] : '?');
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
check('7.1 style.css поднят (>= 29)', (function () {
    const m = /style\.css\?v=(\d+)/.exec(HTML);
    return !!m && parseInt(m[1], 10) >= 29;
})(), (/style\.css\?v=(\d+)/.exec(HTML) || [])[1]);

console.log('\n=== 8. №3B НЕ ЛОМАЕТ #3A: MODAL CLOSE ОТДЕЛЁН ОТ SCREEN ENTER ===');
// Раньше этот раздел был временным scope-guard'ом "модалки не тронуты".
// №3B теперь намеренно реализован, поэтому проверяем обратное: его lifecycle
// существует только внутри modal helper/CSS и НЕ протёк в showScreen().
check('8.1 closeModal теперь имеет отдельный modal-closing lifecycle', (function () {
    const body = funcBody(CLEAN, 'closeModal');
    return !!body && /modal-closing/.test(body) && /finishModalClose/.test(body);
})());
check('8.2 CSS содержит modal-closing, но screenEnter rule не использует его',
    /\.modal-overlay\.modal-closing/.test(CSS_CLEAN) &&
    !!enterRule && !/modal-closing/.test(enterRule[0]));
check('8.3 showScreen по-прежнему не знает о modal-closing',
    (function () {
        const body = funcBody(CLEAN, 'showScreen');
        return !!body && !/modal-closing|finishModalClose|modalCloseState/.test(body);
    })());

console.log('\n=== 9. НАЖАТИЕ КНОПКИ: СТЕКЛЯННЫЙ FEEDBACK ===');
{
    const activeRule = /\.menu-button:active \{([^}]*)\}/.exec(CSS_CLEAN);
    const afterRule = /\.menu-button::after \{([^}]*)\}/.exec(CSS_CLEAN);
    const afterActive = /\.menu-button:active::after \{([^}]*)\}/.exec(CSS_CLEAN);

    check('9.1 правило нажатия найдено', !!activeRule);
    check('9.2 декоративный слой ::after объявлен', !!afterRule);
    check('9.3 слой зажигается именно при нажатии', !!afterActive && /opacity:\s*1/.test(afterActive[1]));

    // Декоративный слой не должен перехватывать клики -- иначе обработчик
    // кнопки перестал бы срабатывать.
    check('9.4 слой не перехватывает события', !!afterRule && /pointer-events:\s*none/.test(afterRule[1]));
    check('9.5 радиус слоя совпадает с кнопкой', !!afterRule && /border-radius:\s*inherit/.test(afterRule[1]));
    check('9.6 слой покрывает кнопку целиком', !!afterRule && /inset:\s*0/.test(afterRule[1]));
    check('9.7 в покое слой невидим', !!afterRule && /opacity:\s*0/.test(afterRule[1]));

    // Физическое утопление: одного масштаба мало, нужен и сдвиг вниз.
    check('9.8 кнопка утапливается (масштаб + сдвиг)',
        !!activeRule && /transform:\s*scale\([\d.]+\)\s*translateY\(\d+px\)/.test(activeRule[1]));
    check('9.9 рамка при нажатии ярче', !!activeRule && /border-color:/.test(activeRule[1]));
    check('9.10 есть выраженный внутренний блик',
        !!activeRule && /inset 0 2px 0 rgba/.test(activeRule[1]));
    check('9.11 есть внутренняя тень снизу (ощущение вдавленности)',
        !!activeRule && /inset 0 -3px/.test(activeRule[1]));

    // Не казино: никаких неоновых приёмов.
    check('9.12 без неона и тяжёлых фильтров', (function () {
        if (!activeRule || !afterRule) return false;
        const both = activeRule[1] + afterRule[1];
        return !/filter:|blur\(|drop-shadow\(/.test(both);
    })());

    // Опасная кнопка обязана остаться красной: у .menu-button:active
    // специфичность выше, чем у .danger-button, и без своего правила
    // рамка перекрасилась бы в золотистую.
    check('9.13 danger-button сохраняет красный характер при нажатии', (function () {
        const dr = /\.danger-button:active \{([^}]*)\}/.exec(CSS_CLEAN);
        return !!dr && /border-color:/.test(dr[1]);
    })());
    check('9.14 у danger-button свой оттенок блика',
        /\.danger-button::after \{[^}]*background:/.test(CSS_CLEAN));

    // room-item-button переиспользует класс menu-button -- эффект
    // распространяется на него автоматически, отдельной логики не нужно.
    check('9.15 room-item-button не переопределяет нажатие',
        !/\.room-item-button:active/.test(CSS_CLEAN));

    // Системная подсветка тапа смазала бы собственный эффект.
    check('9.16 системная подсветка тапа отключена у кнопки', (function () {
        const base = /\.menu-button \{([^}]*)\}/.exec(CSS_CLEAN);
        return !!base && /-webkit-tap-highlight-color:\s*transparent/.test(base[1]);
    })());
    check('9.17 переход по border-color объявлен', (function () {
        const base = /\.menu-button \{([^}]*)\}/.exec(CSS_CLEAN);
        return !!base && /transition:[^;]*border-color/.test(base[1]);
    })());

    // Никакого JS: эффект чисто визуальный и не может задержать обработчик.
    check('9.18 нажатие не требует JS', !/menu-button[^\n]*addEventListener\("(touchstart|pointerdown|mousedown)"/.test(CLEAN));
}

console.log('\n=== 10. REDUCED-MOTION ДЛЯ КНОПКИ ===');
{
    const blocks = CSS_CLEAN.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    const rm = blocks.find(function (b) { return /menu-button/.test(b); });
    check('10.1 блок покрывает кнопку', !!rm);
    check('10.2 движение при нажатии отключено',
        !!rm && /\.menu-button:active \{\s*transform: none;/.test(rm));
    check('10.3 плавные переходы отключены',
        !!rm && /\.menu-button \{\s*transition: none;/.test(rm));
    // Проверять надо ИМЕННО правило кнопки: в том же media-блоке лежат
    // наложения превращения, у которых opacity: 0 !important законен.
    check('10.4 световой отклик СОХРАНЁН (он статичен, движением не является)', (function () {
        if (!rm) return false;
        const btnAfter = /\.menu-button::after \{([^}]*)\}/.exec(rm);
        // У слоя отключается только переход; гасить сам блик нельзя,
        // иначе нажатие перестанет читаться вовсе.
        return !!btnAfter && /transition:\s*none/.test(btnAfter[1]) && !/opacity/.test(btnAfter[1]);
    })());
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

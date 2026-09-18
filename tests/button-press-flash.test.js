// ==========================================================================
// ВСПЫШКА НАЖАТИЯ КНОПКИ.
//
// :active показывает отклик только пока палец на кнопке -- при быстром
// тапе это несколько десятков миллисекунд, и глаз его не видит. Класс
// button-press-flash вешается на pointerdown и держится 300 мс.
//
// Ключевое, что здесь защищается: эффект ЧИСТО ВИЗУАЛЬНЫЙ. Таймер
// существует только чтобы снять класс; ни click, ни showScreen, ни вход в
// комнату, ни Firebase ничего не ждут. И никаких overlay поверх
// интерфейса -- слой принадлежит самой кнопке, поэтому при смене экрана
// исчезает вместе с ней.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}

function noComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const CLEAN = noComments(SRC);
const CSS_CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

// Тело делегированного обработчика.
function handlerSource() {
    const i = CLEAN.indexOf('document.addEventListener("pointerdown"');
    if (i === -1) return null;
    const end = CLEAN.indexOf('}, true);', i);
    return end === -1 ? null : CLEAN.slice(i, end + 9);
}

console.log('=== 1. ДЕЛЕГИРОВАННЫЙ ОБРАБОТЧИК ===');
const handlerSrc = handlerSource();
check('1.1 слушатель pointerdown зарегистрирован', !!handlerSrc);
check('1.2 делегирование на document, а не на каждую кнопку',
    !!handlerSrc && /^document\.addEventListener\("pointerdown"/.test(handlerSrc));
// Часть обработчиков останавливает всплытие -- на всплытии вспышка не дошла бы.
check('1.3 слушатель в фазе захвата', !!handlerSrc && /\}, true\);$/.test(handlerSrc));
check('1.4 ищется ближайшая button', !!handlerSrc && /closest\("button"\)/.test(handlerSrc));
check('1.5 disabled-кнопка пропускается', !!handlerSrc && /button\.disabled/.test(handlerSrc));

console.log('\n=== 2. ЭТО ТОЛЬКО ВИЗУАЛ ===');
{
    // Таймер допустим ИСКЛЮЧИТЕЛЬНО для снятия класса. Если бы в него
    // попало что-то ещё, действие кнопки начало бы опаздывать на 300 мс.
    check('2.1 в обработчике нет click/действий кнопки',
        !!handlerSrc && !/\.click\(\)|showScreen|database\.|firebase/.test(handlerSrc));
    check('2.2 нет preventDefault -- нажатие не перехватывается',
        !!handlerSrc && !/preventDefault/.test(handlerSrc));
    check('2.3 нет stopPropagation -- чужие обработчики не ломаются',
        !!handlerSrc && !/stopPropagation/.test(handlerSrc));
    check('2.4 в таймере только снятие класса и очистка записи', (function () {
        if (!handlerSrc) return false;
        const m = /setTimeout\(function \(\) \{([\s\S]*?)\}, BUTTON_PRESS_FLASH_MS\)/.exec(handlerSrc);
        if (!m) return false;
        const body = m[1];
        return /classList\.remove/.test(body) && /buttonPressFlashTimers\.delete/.test(body)
            && !/click|showScreen|database|fetch|play/.test(body);
    })());
    check('2.5 showScreen не изменён этой правкой',
        /function showScreen\(screen\) \{\s*\n\s*hideStartupCover\(\);/.test(CLEAN));
}

console.log('\n=== 3. ПОВТОРНОЕ НАЖАТИЕ БЕЗ ГОНКИ ===');
{
    check('3.1 прежний таймер снимается', !!handlerSrc && /clearTimeout\(pending\)/.test(handlerSrc));
    check('3.2 запись удаляется перед новой', !!handlerSrc && /buttonPressFlashTimers\.delete\(button\)/.test(handlerSrc));
    // Без снятия класса и пересчёта браузер счёл бы анимацию той же самой
    // и второй вспышки просто не было бы.
    check('3.3 анимация перезапускается принудительно', (function () {
        if (!handlerSrc) return false;
        const rm = handlerSrc.indexOf('button.classList.remove(BUTTON_PRESS_FLASH_CLASS);');
        const reflow = handlerSrc.indexOf('void button.offsetWidth;');
        const add = handlerSrc.indexOf('button.classList.add(BUTTON_PRESS_FLASH_CLASS);');
        return rm !== -1 && reflow !== -1 && add !== -1 && rm < reflow && reflow < add;
    })());
    // WeakMap: кнопки лобби пересоздаются, запись должна уходить с узлом.
    check('3.4 хранилище таймеров не удерживает удалённые кнопки',
        /new WeakMap\(\)/.test(CLEAN) && /buttonPressFlashTimers = new WeakMap/.test(CLEAN));
}

console.log('\n=== 4. ПОВЕДЕНИЕ ИСПОЛНЕНИЕМ ===');
{
    // Регулярки не поймают гонку таймеров -- обработчик реально запускается.
    let handler = null, capture = null;
    const timers = [];
    let nextId = 1;
    const cleared = [];

    const savedDoc = global.document;
    const savedST = global.setTimeout;
    const savedCT = global.clearTimeout;

    global.document = {
        addEventListener: function (type, fn, cap) {
            if (type === 'pointerdown') { handler = fn; capture = cap; }
        }
    };
    global.setTimeout = function (fn, ms) { const id = nextId++; timers.push({ id: id, fn: fn, ms: ms }); return id; };
    global.clearTimeout = function (id) { cleared.push(id); };

    // eslint-disable-next-line no-eval
    eval(handlerSrc ? CLEAN.slice(CLEAN.indexOf('const BUTTON_PRESS_FLASH_MS'), CLEAN.indexOf('}, true);', CLEAN.indexOf('document.addEventListener("pointerdown"')) + 9) : '');

    function makeButton(disabled) {
        const cls = new Set();
        const btn = {
            disabled: !!disabled,
            offsetWidth: 1,
            classList: {
                add: function (c) { cls.add(c); },
                remove: function (c) { cls.delete(c); },
                contains: function (c) { return cls.has(c); }
            },
            _cls: cls
        };
        btn.closest = function () { return btn; };
        return btn;
    }

    check('4.1 обработчик зарегистрирован в capture', capture === true);

    const btn = makeButton(false);
    handler({ target: btn });
    check('4.2 быстрый тап сразу зажигает вспышку', btn._cls.has('button-press-flash'));
    check('4.3 снятие запланировано на 300 мс',
        timers.length === 1 && timers[0].ms === 300, timers.length ? String(timers[0].ms) : 'нет');

    const clearedBefore = cleared.length;
    handler({ target: btn });
    check('4.4 повторный тап снимает прежний таймер', cleared.length === clearedBefore + 1);
    check('4.5 повторный тап снова зажигает вспышку', btn._cls.has('button-press-flash'));
    check('4.6 таймеров ровно два за два нажатия', timers.length === 2);

    timers[timers.length - 1].fn();
    check('4.7 по истечении вспышка гаснет', !btn._cls.has('button-press-flash'));

    const disabled = makeButton(true);
    const before = timers.length;
    handler({ target: disabled });
    check('4.8 disabled-кнопка эффекта не получает',
        !disabled._cls.has('button-press-flash') && timers.length === before);

    let threw = false;
    try { handler({ target: { closest: function () { return null; } } }); } catch (e) { threw = true; }
    check('4.9 нажатие мимо кнопки не падает', !threw);

    // Кнопку могли убрать из DOM до срабатывания таймера.
    const gone = makeButton(false);
    handler({ target: gone });
    let threwGone = false;
    try { timers[timers.length - 1].fn(); } catch (e) { threwGone = true; }
    check('4.10 снятие класса с удалённой кнопки не падает', !threwGone);

    global.document = savedDoc;
    global.setTimeout = savedST;
    global.clearTimeout = savedCT;
}

console.log('\n=== 5. CSS: ВСПЫШКА НА САМОЙ КНОПКЕ ===');
{
    const rule = /button\.button-press-flash::after \{([^}]*)\}/.exec(CSS_CLEAN);
    check('5.1 правило вспышки найдено', !!rule);
    check('5.2 слой не перехватывает события', !!rule && /pointer-events:\s*none/.test(rule[1]));
    // Форма: круглые кнопки (.lang-btn, .reaction-btn) должны остаться круглыми.
    check('5.3 форма наследуется -- круглые остаются круглыми',
        !!rule && /border-radius:\s*inherit/.test(rule[1]));
    check('5.4 слой покрывает кнопку целиком', !!rule && /inset:\s*0/.test(rule[1]));
    check('5.5 длительность 300 мс', !!rule && /animation: buttonPressFlash 300ms/.test(rule[1]));
    check('5.6 есть яркая рамка и свечение',
        !!rule && /inset 0 0 0 1px/.test(rule[1]) && /0 0 \d+px/.test(rule[1]));

    // Никакого overlay поверх интерфейса: слой абсолютный внутри кнопки.
    check('5.7 слой позиционируется внутри кнопки, а не фиксированно',
        !!rule && /position:\s*absolute/.test(rule[1]) && !/position:\s*fixed/.test(rule[1]));
    check('5.8 в CSS нет фиксированного ghost-слоя для нажатия',
        !/press-ghost|press-overlay|flash-overlay/.test(CSS_CLEAN));
    check('5.9 в JS нет создания элементов для вспышки',
        !!handlerSrc && !/createElement|appendChild/.test(handlerSrc));

    const kf = /@keyframes buttonPressFlash \{[\s\S]*?\n\}/.exec(CSS_CLEAN);
    check('5.10 keyframes объявлены', !!kf);
    check('5.11 резкий приход и спокойный уход',
        !!kf && /0%\s*\{\s*opacity: 0/.test(kf[0]) && /100%\s*\{\s*opacity: 0/.test(kf[0]));
    // Ни масштаба, ни сдвига, ни размытия -- только свет.
    check('5.12 без движения и тяжёлых эффектов',
        !!kf && !/scale\(|translate|blur\(|filter/.test(kf[0]));

    check('5.13 опасная кнопка сохраняет красный характер', (function () {
        const dr = /button\.danger-button\.button-press-flash::after \{([^}]*)\}/.exec(CSS_CLEAN);
        return !!dr && /background:/.test(dr[1]);
    })());
    check('5.14 позиционирование кнопки задано для слоя',
        /button\.button-press-flash \{[^}]*position:\s*relative/.test(CSS_CLEAN));
}

console.log('\n=== 6. ВСЕ ТИПЫ КНОПОК ПОКРЫТЫ ===');
{
    // Селектор по тегу button, поэтому перечислять классы не нужно --
    // проверяем, что он именно такой и ни один тип не исключён.
    check('6.1 селектор по тегу button, а не по списку классов',
        /button\.button-press-flash::after/.test(CSS_CLEAN));
    ['menu-button', 'danger-button', 'room-item-button', 'lang-btn',
     'reaction-btn', 'stats-tab-btn', 'room-item-remove'].forEach(function (cls, i) {
        // Ни у одного типа не должно быть правила, отключающего вспышку.
        check('6.' + (i + 2) + ' .' + cls + ' не отключает вспышку',
            !new RegExp('\\.' + cls + '\\.button-press-flash::after \\{[^}]*(display:\\s*none|content:\\s*none)').test(CSS_CLEAN));
    });
}

console.log('\n=== 7. REDUCED-MOTION ===');
{
    const blocks = CSS_CLEAN.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    const rm = blocks.find(function (b) { return /button-press-flash/.test(b); });
    check('7.1 блок упоминает вспышку', !!rm);
    check('7.2 у вспышки нет движения', !!rm && /button\.button-press-flash::after \{\s*transform: none;/.test(rm));
    // Световой отклик сохраняется: без него быстрый тап снова перестанет читаться.
    check('7.3 сама вспышка не гасится', (function () {
        if (!rm) return false;
        const r = /button\.button-press-flash::after \{([^}]*)\}/.exec(rm);
        return !!r && !/display:\s*none/.test(r[1]) && !/opacity:\s*0/.test(r[1]);
    })());
    check('7.4 движение кнопки по-прежнему отключено',
        !!rm && /\.menu-button:active \{\s*transform: none;/.test(rm));
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

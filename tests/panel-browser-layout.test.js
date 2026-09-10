// ==========================================================================
// РАСКЛАДКА ПАНЕЛИ В НАСТОЯЩЕМ БРАУЗЕРЕ.
//
// Прежняя сюита считала ширины формулой с коэффициентом 0.55em и
// пропустила переполнение: единица ch в grid-template-columns считается
// от шрифта САМОЙ ПАНЕЛИ, а не дочерних элементов с их clamp. Минимум
// колонок выходил 347px при панели 292px.
//
// Здесь ничего не считается — Chromium меряет сам.
//
// СЮИТА НЕ ВХОДИТ В ОБЩИЙ ПРОГОН tests/run.js: ей нужны браузерные движки,
// которые ставятся отдельно и весят сотни мегабайт. Основной прогон
// намеренно остаётся лёгким, поэтому у сюиты свой workflow
// (.github/workflows/browser.yml) и своя команда.
//
// Локально:
//
//     npm ci
//     npx playwright install --with-deps chromium webkit
//     npm run test:browser
//
// Проверяются ОБА движка: Chromium и WebKit. WebKit здесь -- ближайшее
// автоматизируемое приближение к Safari/iOS, но это НЕ Telegram WKWebView
// на реальном iPhone; ручной smoke он не заменяет.
//
// Делать это стоит после любой правки раскладки панели: ширин колонок,
// размеров стопки, шрифтов и полей.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// №39: движки импортируются ЖЁСТКО. Прежний вариант заворачивал require в
// try/catch и при отсутствии playwright печатал «ИТОГ: 0/0» с кодом 0 --
// то есть отсутствие проверки выглядело как успешная проверка. Пока сюита
// запускалась только вручную, это было терпимо; как только browser
// coverage становится частью CI, такой silent-skip даёт ложный зелёный
// результат. Теперь отсутствие пакета или движка -- это ошибка окружения,
// и она должна быть видна немедленно.
const { chromium, webkit } = require('playwright');

// Оба движка запускаются с параметрами по умолчанию. В прежней версии у
// Chromium стоял --no-sandbox; он достался по наследству и проверку не
// прошёл: Chromium запускается без этого флага даже под root. Флаг
// ослабляет песочницу браузера, поэтому вносить его без доказанной
// необходимости не стоит. Если на каком-то раннере запуск всё же
// упадёт -- это будет видно сразу (сюита fail-closed), и флаг можно
// будет добавить точечно, уже с конкретной причиной.
const ENGINES = [
    { name: 'chromium', type: chromium, launchOptions: {} },
    { name: 'webkit', type: webkit, launchOptions: {} }
];

let passed = 0, failed = 0;
function check(n, c, i) {
    if (c) { passed++; console.log('  ✅ ' + n); }
    else { failed++; console.log('  ❌ ' + n + (i ? '  — ' + i : '')); }
}

const LONG_NAME = '@tetiana220722';
const RATINGS = ['⭐876', '⭐1156', '⭐9999', '⭐10000', '⭐99999'];
const STATUSES = ['В игре', 'Подключение…', 'Оффлайн 45с', 'Подтверждение…'];
const CAPTURED = [0, 1, 2, 3, 5, 6, 12];
const WIDTHS = [320, 360, 390, 430];

function html(rating, status, caps) {
    const icons = '<div class="captured-icon dark-icon"></div>'.repeat(Math.min(caps, 6));
    const badge = caps ? '<span class="captured-count">' + caps + '</span>' : '';
    return '<!doctype html><html><head><style>' + CSS + '</style></head><body>'
        + '<div id="game-screen"><div id="board-wrapper"><div id="board"></div></div>'
        + '<div class="player-panel" id="p">'
        + '<div class="player-name"><span class="player-color-dot dark-dot"></span>'
        + '<span class="player-name-label">' + LONG_NAME + '</span></div>'
        + '<div class="player-rating">' + rating + '</div>'
        + '<div class="player-status"><span class="player-status-text">' + status + '</span></div>'
        + '<div class="captured-icons">' + icons + badge + '</div>'
        + '</div></div></body></html>';
}

const MEASURE = function () {
    const p = document.getElementById('p');
    const bw = document.getElementById('board-wrapper');
    const q = s => p.querySelector(s);
    const cut = e => e && e.scrollWidth > e.getBoundingClientRect().width + 1;
    const name = q('.player-name-label');
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:'
        + getComputedStyle(name).font;
    document.body.appendChild(probe);
    let shown = 0;
    const full = name.textContent;
    for (let i = 1; i <= full.length; i++) {
        probe.textContent = full.slice(0, i);
        if (probe.getBoundingClientRect().width <= name.getBoundingClientRect().width) shown = i;
        else break;
    }
    probe.remove();
    const cap = q('.captured-icons');
    const badge = q('.captured-count');
    // №40: геометрия наложения шашек в стопке -- ТОЛЬКО измеренные
    // bounding box'ы, никаких чисел из CSS (17px/12px и т.п.). Раньше это
    // был regex-тест по значению margin-left с диапазоном 8..12,
    // обоснованным шириной иконки 15px -- иконка с тех пор выросла до
    // 17px, обоснование устарело, а верхняя граница диапазона стояла
    // ровно на пределе. Теперь порог относительный к измеренной ширине,
    // поэтому рост/уменьшение иконки не требует синхронной правки теста.
    const icons = Array.from(p.querySelectorAll('.captured-icon'));
    const iconRects = icons.map(el => el.getBoundingClientRect());
    const iconSteps = iconRects.slice(1).map((r, i) => r.left - iconRects[i].left);
    return {
        overflow: document.documentElement.scrollWidth > document.body.clientWidth,
        widerThanBoard: p.getBoundingClientRect().width > bw.getBoundingClientRect().width + 1,
        ratingCut: cut(q('.player-rating')),
        statusCut: cut(q('.player-status-text')),
        nameShown: shown,
        capRight: Math.round(cap.getBoundingClientRect().right),
        badgeRight: badge ? Math.round(badge.getBoundingClientRect().right) : null,
        iconWidth: icons.length ? iconRects[0].width : null,
        iconSteps: iconSteps
    };
};

// ===== ДИАГНОСТИКА (№39) =====
//
// Ничего не проверяет и ничего не смягчает -- только печатает числа.
// Существующие assertions ниже остаются как есть и обязаны падать там же,
// где падали: цель этого блока -- дать данные для ВЫБОРА правки, а не
// сделать прогон зелёным.
//
// Зачем: --rating-width/--status-width заданы константами в em, и
// комментарий у них честно говорит, что значения «измерены в Chromium».
// В Chromium запас до срабатывания cut() -- доли пикселя, поэтому любой
// движок с чуть более широкими метриками обязан отвалиться. Чтобы
// подобрать значения по данным, а не на глаз, нужны фактические ширины
// контента и треков в КАЖДОМ движке.
const PROBE_STRINGS = { rating: '⭐99999', status: 'Оффлайн 45с', nameSix: '@tetia' };

// Косвенная проба шрифта. Достоверного КРОССБРАУЗЕРНОГО API, который
// сообщил бы фактически выбранный физический шрифт элемента, нет:
// getComputedStyle().fontFamily возвращает CSS-СПИСОК, а не результат
// подбора, а CSS.getPlatformFontsForNode существует только в CDP, то есть
// только для Chromium -- несимметрично, сравнивать движки по нему нельзя.
// Поэтому меряем одну и ту же строку под стеком приложения и под
// несколькими явно названными шрифтами: совпадение ширины -- это УЛИКА,
// какой шрифт скорее всего подставился, но НЕ доказательство.
const FONT_SUSPECTS = ['DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'FreeSans', 'Arial', 'sans-serif'];

async function dumpDiagnostics(browser, engineName, out) {
    const console = { log: m => out.push(m) };
    console.log('\n--- ДИАГНОСТИКА ' + engineName.toUpperCase() + ' (данные, не проверки) ---');
    for (const vw of WIDTHS) {
        const pg = await browser.newPage({ viewport: { width: vw, height: 700 } });
        await pg.setContent(html('⭐99999', 'Оффлайн 45с', 12));
        const d = await pg.evaluate(({ probes, suspects }) => {
            const q = s => document.querySelector(s);
            const panel = q('.player-panel');
            const cs = getComputedStyle(panel);
            const root = getComputedStyle(document.documentElement);
            const num = v => Math.round(parseFloat(v) * 100) / 100;
            const geo = el => {
                if (!el) return null;
                const s = getComputedStyle(el);
                return {
                    client: el.clientWidth, scroll: el.scrollWidth,
                    rect: num(el.getBoundingClientRect().width),
                    delta: el.scrollWidth - el.clientWidth,
                    fontSize: s.fontSize, letterSpacing: s.letterSpacing,
                    whiteSpace: s.whiteSpace, overflow: s.overflow,
                    textOverflow: s.textOverflow,
                    minWidth: s.minWidth, maxWidth: s.maxWidth, width: s.width
                };
            };
            // Ширина строки в ТОМ ЖЕ вычисленном шрифте, что у элемента.
            const probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
            document.body.appendChild(probe);
            const measure = (text, fontShorthand) => {
                probe.style.font = fontShorthand;
                probe.textContent = text;
                return num(probe.getBoundingClientRect().width);
            };
            const ratingFont = getComputedStyle(q('.player-rating')).font;
            const statusFont = getComputedStyle(q('.player-status-text')).font;
            const nameFont = getComputedStyle(q('.player-name-label')).font;

            // canvas.measureText для тех же shorthand'ов. Условия отрисовки
            // у canvas и DOM не идентичны (нет CSS-контекста, letter-spacing
            // и т.п.), поэтому это справочное число, не истина.
            const ctx = document.createElement('canvas').getContext('2d');
            const canvasW = (text, f) => { ctx.font = f; return Math.round(ctx.measureText(text).width * 100) / 100; };

            // Косвенная проба шрифта: та же строка под явными шрифтами.
            const fontClues = {};
            for (const fam of suspects) {
                fontClues[fam] = measure(probes.rating, '12px "' + fam + '"');
            }
            const appStackAt12 = measure(probes.rating, '12px ' + cs.fontFamily);
            // ВАЖНО: измеряем ДО probe.remove() -- иначе все ширины нулевые.
            const domWidths = {
                rating: measure(probes.rating, ratingFont),
                status: measure(probes.status, statusFont),
                nameSix: measure(probes.nameSix, nameFont)
            };
            probe.remove();

            return {
                panel: {
                    client: panel.clientWidth, scroll: panel.scrollWidth,
                    rect: num(panel.getBoundingClientRect().width),
                    padding: cs.padding, gap: cs.gap, fontSize: cs.fontSize,
                    gridTemplateColumns: cs.gridTemplateColumns,
                    fontFamilyStack: cs.fontFamily
                },
                vars: {
                    ratingWidth: cs.getPropertyValue('--rating-width').trim(),
                    statusWidth: cs.getPropertyValue('--status-width').trim(),
                    stackWidth: cs.getPropertyValue('--stack-width').trim() || root.getPropertyValue('--stack-width').trim(),
                    boardTotal: root.getPropertyValue('--board-total').trim()
                },
                name: geo(q('.player-name-label')),
                rating: geo(q('.player-rating')),
                status: geo(q('.player-status-text')),
                stack: geo(q('.captured-icons')),
                domWidths: domWidths,
                canvasWidths: {
                    rating: canvasW(probes.rating, ratingFont),
                    status: canvasW(probes.status, statusFont),
                    nameSix: canvasW(probes.nameSix, nameFont)
                },
                fontClues: fontClues,
                appStackAt12: appStackAt12
            };
        }, { probes: PROBE_STRINGS, suspects: FONT_SUSPECTS });

        console.log('  [' + vw + 'px] panel client=' + d.panel.client + ' scroll=' + d.panel.scroll
            + ' rect=' + d.panel.rect + ' padding=' + d.panel.padding + ' gap=' + d.panel.gap
            + ' font-size=' + d.panel.fontSize);
        console.log('           columns: ' + d.panel.gridTemplateColumns);
        console.log('           vars: --rating-width=' + d.vars.ratingWidth + ' --status-width=' + d.vars.statusWidth
            + ' --stack-width=' + d.vars.stackWidth + ' --board-total=' + d.vars.boardTotal);
        for (const key of ['name', 'rating', 'status', 'stack']) {
            const g = d[key];
            if (!g) { console.log('           ' + key + ': (нет элемента)'); continue; }
            console.log('           ' + key.padEnd(6) + ' client=' + g.client + ' scroll=' + g.scroll
                + ' rect=' + g.rect + ' scroll-client=' + g.delta
                + ' font=' + g.fontSize + ' ls=' + g.letterSpacing + ' ws=' + g.whiteSpace
                + ' ovf=' + g.overflow + '/' + g.textOverflow
                + ' min=' + g.minWidth + ' max=' + g.maxWidth + ' w=' + g.width);
        }
        console.log('           DOM-ширина контента:    ' + JSON.stringify(d.domWidths));
        console.log('           canvas.measureText:     ' + JSON.stringify(d.canvasWidths)
            + '  (справочно: условия canvas и DOM не идентичны)');
        if (vw === WIDTHS[0]) {
            console.log('           стек шрифтов: ' + d.panel.fontFamilyStack);
            console.log('           «⭐99999» под стеком приложения @12px: ' + d.appStackAt12);
            console.log('           та же строка под явными шрифтами: ' + JSON.stringify(d.fontClues));
            console.log('           ^ совпадение ширины -- лишь улика о подставленном шрифте, НЕ доказательство');
        }
        await pg.close();
    }
    console.log('--- КОНЕЦ ДИАГНОСТИКИ ' + engineName.toUpperCase() + ' ---\n');
}

// №42-B1: fixture для focus-management четырёх ЛОКАЛЬНЫХ confirm-модалок.
// Helper (openModal/closeModal/getFocusableInModal) и разметка модалок --
// РЕАЛЬНЫЕ, извлечённые из script.js/index.html, не копии текста. Клик-
// привязка на каждой кнопке в fixture -- ПРЕДСТАВИТЕЛЬНАЯ (closeModal(modal)
// как первая строка обработчика, тот же паттерн, что и во всех 19 реальных
// call-site'ов; это отдельно проверяется source-guard'ом в
// modal-dialog-focus.test.js, секция 7). Здесь цель -- ТОЛЬКО механика
// фокуса/клавиатуры, которую вне настоящего браузера не проверить.
// Побочные эффекты конкретных обработчиков (например, сброс
// pendingReplaceExistingSession у bot-difficulty "Назад") проверяются
// отдельно, на реальном извлечённом теле, в modal-dialog-focus.test.js.
function buildModalFixture() {
    const helperStart = SRC.indexOf('const modalFocusState = new WeakMap();');
    const heMarker = 'function closeModal(modal) {';
    const heStart = SRC.indexOf(heMarker, helperStart);
    let depth = 0, i = SRC.indexOf('{', heStart), end = -1;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const helperSrc = SRC.slice(helperStart, end + 1);

    const modalIds = ['resign-confirm-modal', 'back-confirm-modal', 'bot-difficulty-modal', 'continue-or-new-modal'];
    const modalsHtml = modalIds.map(function (id) {
        const start = HTML.indexOf('<div id="' + id + '"');
        const m = /\n    <\/div>/.exec(HTML.slice(start));
        return HTML.slice(start, start + m.index + m[0].length);
    }).join('\n');

    return '<!doctype html><html><head><style>.hidden{display:none !important}</style></head><body>'
        + '<button id="ext-trigger">внешний триггер</button>' + modalsHtml
        + '<script>' + helperSrc + '\n'
        // Представительная привязка: closeModal(modal) первой строкой --
        // ровно паттерн всех 19 реальных call-site'ов.
        + 'document.querySelectorAll(".modal-overlay").forEach(function(modal){'
        + '  modal.querySelectorAll("button").forEach(function(btn){'
        + '    btn.addEventListener("click", function(){ closeModal(modal); });'
        + '  });'
        + '});'
        + '</script></body></html>';
}

async function runModalFocusChecks(page, engineName) {
    async function reset() {
        await page.evaluate(function () {
            document.querySelectorAll('.modal-overlay').forEach(function (m) { m.classList.add('hidden'); });
            document.getElementById('ext-trigger').focus();
        });
    }

    await reset();
    await page.evaluate(function () { openModal(document.getElementById('resign-confirm-modal')); });
    let active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B1: resign-confirm initial focus -> btn-resign-no (не первая btn-resign-yes)',
        active === 'btn-resign-no', active);

    await page.keyboard.press('Tab');
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B1: Tab со второй (последней) кнопки уходит на первую (wrap)',
        active === 'btn-resign-yes', active);

    await page.keyboard.press('Shift+Tab');
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B1: Shift+Tab с первой уходит на последнюю (wrap)',
        active === 'btn-resign-no', active);

    await page.keyboard.press('Escape');
    let stillOpen = await page.evaluate(function () { return !document.getElementById('resign-confirm-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B1: Escape вызывает click на data-modal-escape и закрывает модалку', !stillOpen);
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B1: return focus на исходный триггер после закрытия', active === 'ext-trigger', active);

    // review fix: повторный openModal() того же диалога БЕЗ closeModal()
    // между вызовами (например, дважды сработавшая асинхронная проверка
    // перед показом) не должен потерять НАСТОЯЩИЙ внешний триггер --
    // раньше второй openModal() перезаписывал его текущим activeElement
    // (уже внутренней кнопкой диалога), и после close фокус улетал в
    // никуда вместо ext-trigger.
    await reset();
    await page.evaluate(function () { document.getElementById('ext-trigger').focus(); openModal(document.getElementById('resign-confirm-modal')); });
    await page.evaluate(function () { openModal(document.getElementById('resign-confirm-modal')); }); // повторно, БЕЗ closeModal
    await page.evaluate(function () { closeModal(document.getElementById('resign-confirm-modal')); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B1 review fix: повторный openModal() без close между вызовами НЕ теряет исходный внешний триггер',
        active === 'ext-trigger', active);

    // continue-or-new: initial-focus и escape-target -- РАЗНЫЕ кнопки.
    await reset();
    await page.evaluate(function () { openModal(document.getElementById('continue-or-new-modal')); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B1: continue-or-new initial focus -> Продолжить текущую (не Назад)',
        active === 'btn-continue-existing-session', active);
    await page.keyboard.press('Escape');
    stillOpen = await page.evaluate(function () { return !document.getElementById('continue-or-new-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B1: continue-or-new Escape закрывает через btn-continue-or-new-back (Назад), не Продолжить', !stillOpen);

    // bot-difficulty: initial focus и полный Tab-цикл по всем 4 кнопкам.
    await reset();
    await page.evaluate(function () { openModal(document.getElementById('bot-difficulty-modal')); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B1: bot-difficulty initial focus -> Назад (не первая Лёгкий)',
        active === 'btn-difficulty-back', active);
    const order = [active];
    for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        order.push(await page.evaluate(function () { return document.activeElement.id; }));
    }
    check(engineName + ' 42-B1: 4 Tab по кругу через все кнопки возвращают на initial (' + order.join(' -> ') + ')',
        order[0] === order[4]);
}

async function runEngine(engine) {
    console.log('\n################  ДВИЖОК: ' + engine.name.toUpperCase() + '  ################');
    const browser = await engine.type.launch(engine.launchOptions);

    // №39: диагностика собирается ВСЕГДА, но печатается только если у
    // движка есть провалы. Пока всё зелено, полный дамп в каждом прогоне
    // CI -- лишний шум; как только что-то падает, числа под рукой.
    const diagLines = [];
    await dumpDiagnostics(browser, engine.name, diagLines);
    const failedBefore = failed;

    console.log('=== 1. КРАЙНИЙ СЛУЧАЙ НА КАЖДОЙ ШИРИНЕ ===');
    console.log('    длинное имя + ⭐99999 + «Оффлайн 45с» + 12 взятых');
    for (const vw of WIDTHS) {
        const pg = await browser.newPage({ viewport: { width: vw, height: 700 } });
        await pg.setContent(html('⭐99999', 'Оффлайн 45с', 12));
        const r = await pg.evaluate(MEASURE);
        await pg.close();
        check(vw + 'px: нет переполнения страницы', !r.overflow);
        check(vw + 'px: панель не шире доски', !r.widerThanBoard);
        check(vw + 'px: рейтинг целиком', !r.ratingCut);
        check(vw + 'px: статус целиком', !r.statusCut);
        // Порог шесть: кружок цвета вынесен из текста, поэтому это шесть
        // настоящих букв имени, а не знаков вместе с эмодзи.
        check(vw + 'px: имени видно не меньше шести букв (' + r.nameShown + ')',
            r.nameShown >= 6);

        // №40: наложение шашек в стопке -- по факту отрисовки, относительно
        // измеренной ширины иконки, без хардкода 15/17/8..12 из CSS.
        if (r.iconSteps.length) {
            const w = r.iconWidth;
            r.iconSteps.forEach(function (step, i) {
                check(vw + 'px: шаг ' + i + ' различим и накладывается (' + step.toFixed(1) + 'px из ' + w.toFixed(1) + 'px)',
                    step >= w * 0.15 && step < w);
            });
            const maxStep = Math.max(...r.iconSteps), minStep = Math.min(...r.iconSteps);
            check(vw + 'px: шаг между шашками одинаков (' + minStep.toFixed(2) + '..' + maxStep.toFixed(2) + ')',
                maxStep - minStep <= 0.5);
        }
    }

    console.log('\n=== 2. ЗНАЧОК НЕ ДВИГАЕТСЯ ОТ СОДЕРЖИМОГО ===');
    for (const vw of [320, 360, 390]) {
        const rights = new Set();
        let broke = null;
        for (const rating of RATINGS) {
            for (const status of STATUSES) {
                for (const caps of CAPTURED) {
                    const pg = await browser.newPage({ viewport: { width: vw, height: 600 } });
                    await pg.setContent(html(rating, status, caps));
                    const r = await pg.evaluate(MEASURE);
                    await pg.close();
                    if (r.overflow && !broke) broke = vw + 'px ' + rating + ' «' + status + '» ' + caps;
                    rights.add(r.capRight);
                    if (r.badgeRight !== null) rights.add(r.badgeRight);
                }
            }
        }
        check(vw + 'px: правый край стопки одинаков во всех 140 сочетаниях',
            rights.size === 1, JSON.stringify([...rights]));
        check(vw + 'px: ни одно сочетание не переполняет', !broke, broke);
    }

    console.log('\n=== 3. ДВЕ ПАНЕЛИ С РАЗНЫМ СОДЕРЖИМЫМ ===');
    console.log('    сверху длинное имя ⭐99999 «Оффлайн 45с» 12 взятых');
    console.log('    снизу короткое имя ⭐876 «В игре» 0 взятых');
    for (const vw of WIDTHS) {
        const pg = await browser.newPage({ viewport: { width: vw, height: 900 } });
        const top = html('⭐99999', 'Оффлайн 45с', 12)
            .replace(/<\/body>[\s\S]*$/, '');
        await pg.setContent('<!doctype html><html><head><style>' + CSS + '</style></head><body>'
            + '<div id="game-screen"><div id="board-wrapper"><div id="board"></div></div>'
            + '<div class="player-panel" id="a">'
            + '<div class="player-name"><span class="player-color-dot dark-dot"></span>'
            + '<span class="player-name-label">@tetiana220722</span></div>'
            + '<div class="player-rating">⭐99999</div>'
            + '<div class="player-status"><span class="player-status-text">Оффлайн 45с</span></div>'
            + '<div class="captured-icons">'
            + '<div class="captured-icon dark-icon"></div>'.repeat(6)
            + '<span class="captured-count">12</span></div></div>'
            + '<div class="player-panel" id="b">'
            + '<div class="player-name"><span class="player-color-dot light-dot"></span>'
            + '<span class="player-name-label">@yl</span></div>'
            + '<div class="player-rating">⭐876</div>'
            + '<div class="player-status"><span class="player-status-text">В игре</span></div>'
            + '<div class="captured-icons"></div></div>'
            + '</div></body></html>');
        const r = await pg.evaluate(function () {
            const ps = [document.getElementById('a'), document.getElementById('b')];
            const L = (p, s) => { const e = p.querySelector(s);
                return e ? Math.round(e.getBoundingClientRect().left) : null; };
            const R = (p, s) => { const e = p.querySelector(s);
                return e ? Math.round(e.getBoundingClientRect().right) : null; };
            return { ratingL: ps.map(p => L(p, '.player-rating')),
                statusL: ps.map(p => L(p, '.player-status')),
                capL: ps.map(p => L(p, '.captured-icons')),
                capR: ps.map(p => R(p, '.captured-icons')),
                over: document.documentElement.scrollWidth > document.body.clientWidth };
        });
        await pg.close();
        const same = a => a[0] === a[1];
        check(vw + 'px: ⭐ на одной вертикали', same(r.ratingL), JSON.stringify(r.ratingL));
        check(vw + 'px: статус на одной вертикали', same(r.statusL), JSON.stringify(r.statusL));
        check(vw + 'px: стопка на одной вертикали', same(r.capL) && same(r.capR),
            JSON.stringify([r.capL, r.capR]));
        check(vw + 'px: без переполнения', !r.over);
    }

    if (failed > failedBefore) {
        console.log('\n(есть провалы -- печатаю диагностику этого движка)');
        diagLines.forEach(l => console.log(l));
    }

    console.log('\n=== №42-B1: dialog focus management (4 локальные confirm-модалки) ===');
    {
        const modalPage = await browser.newPage();
        await modalPage.setContent(buildModalFixture());
        await runModalFocusChecks(modalPage, engine.name);
        await modalPage.close();
    }

    await browser.close();
}

(async function () {
    for (const engine of ENGINES) {
        // Никакого перехвата: если движок не установлен, launch бросит, и
        // прогон упадёт с ненулевым кодом -- ровно то поведение, которое
        // нужно CI. Установка движков -- задача workflow
        // (npx playwright install --with-deps chromium webkit).
        await runEngine(engine);
    }
    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

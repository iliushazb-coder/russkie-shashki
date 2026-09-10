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

// №42-B2a: fixture для 4 АСИНХРОННЫХ диалогов. В отличие от B1, они
// открываются программно (функцией, имитирующей реальный паттерн
// checkDrawProposal()/checkRematchProposal()/renderEndGameModal()/
// checkSpectatorGameInterrupted() -- guard "openModal только если
// classList.contains('hidden')"), а не кликом. Клик-привязка кнопок --
// та же представительная closeModal(modal), что и в B1-fixture; реальное
// соответствие call-site'ов этому паттерну отдельно проверяется
// source-guard'ами в modal-dialog-focus-b2a.test.js.
function buildAsyncModalFixture() {
    const helperStart = SRC.indexOf('const modalFocusState = new WeakMap();');
    const heMarker = 'function closeModal(modal) {';
    const heStart = SRC.indexOf(heMarker, helperStart);
    let depth = 0, i = SRC.indexOf('{', heStart), end = -1;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const helperSrc = SRC.slice(helperStart, end + 1);

    // review fix: строки-guard'ы извлечены ИЗ SRC, а не переписаны вручную --
    // первая попытка hand-написала эти же условия внутри simulate*-функций,
    // и мутация реальной строки в script.js (убрать guard) не ловилась
    // тестом, потому что тест проверял СВОЙ отдельный текст, не реальный.
    function extractLine(marker) {
        const idx = SRC.indexOf(marker);
        if (idx === -1) throw new Error('line not found for extraction: ' + marker);
        return SRC.slice(idx, SRC.indexOf(';', idx) + 1);
    }
    const drawGuardLine = extractLine('if (drawOfferModal.classList.contains("hidden"))');
    const rematchGuardLine = extractLine('if (rematchRequestModal.classList.contains("hidden"))');
    const endGameGuardLine = extractLine('if (endGameModal.classList.contains("hidden"))');

    const modalIds = ['draw-offer-modal', 'rematch-request-modal', 'end-game-modal', 'spectator-interrupted-modal'];
    const modalsHtml = modalIds.map(function (id) {
        const start = HTML.indexOf('<div id="' + id + '"');
        const m = /\n    <\/div>/.exec(HTML.slice(start));
        return HTML.slice(start, start + m.index + m[0].length);
    }).join('\n');

    return '<!doctype html><html><head><style>.hidden{display:none !important}</style></head><body>'
        + '<button id="ext-trigger">внешний триггер</button>' + modalsHtml
        + '<script>' + helperSrc + '\n'
        + 'document.querySelectorAll(".modal-overlay").forEach(function(modal){'
        + '  modal.querySelectorAll("button").forEach(function(btn){'
        + '    btn.addEventListener("click", function(){ closeModal(modal); });'
        + '  });'
        + '});'
        // Представительные функции; сама guard-строка внутри каждой --
        // РЕАЛЬНАЯ, извлечённая выше из script.js, не переписанная вручную.
        + 'function simulateDrawOfferShown(){'
        + '  var drawOfferModal=document.getElementById("draw-offer-modal");'
        + '  ' + drawGuardLine
        + '}'
        + 'function simulateDrawOfferCleared(){ closeModal(document.getElementById("draw-offer-modal")); }'
        + 'function simulateRematchOfferCleared(){ closeModal(document.getElementById("rematch-request-modal")); }'
        + 'function simulateRematchOfferShown(){'
        + '  var rematchRequestModal=document.getElementById("rematch-request-modal");'
        + '  ' + rematchGuardLine
        + '}'
        + 'function simulateEndGameShown(){'
        + '  var endGameModal=document.getElementById("end-game-modal");'
        + '  ' + endGameGuardLine
        + '}'
        + 'function simulateSpectatorInterrupted(){'
        + '  openModal(document.getElementById("spectator-interrupted-modal"), { returnFocus: false });'
        + '}'
        + '</script></body></html>';
}

// №42-B2b: nested stats-modal/bot-details-modal fixture. openModal/
// closeModal -- те же извлечённые helper'ы. openBotDetailsModal() и оба
// tab-switch handler'а (Online/Bot) -- РЕАЛЬНЫЕ тела функций, извлечённые
// из script.js, а не переписанные вручную: именно на этом мы уже дважды
// ловили несловленные мутации (B1's click-wiring, B2a's redundant-guard).
// "bot-row" в fixture -- синтетическая (реальные строки рендерятся JS
// динамически, статической разметки для них нет), но её click вызывает
// РЕАЛЬНУЮ extracted openBotDetailsModal(...), не имитацию.
function buildNestedModalFixture() {
    const helperStart = SRC.indexOf('const modalFocusState = new WeakMap();');
    const heMarker = 'function closeModal(modal) {';
    const heStart = SRC.indexOf(heMarker, helperStart);
    let depth = 0, i = SRC.indexOf('{', heStart), end = -1;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const helperSrc = SRC.slice(helperStart, end + 1);

    function extractFn(marker) {
        const s = SRC.indexOf(marker);
        if (s === -1) throw new Error('function not found for extraction: ' + marker);
        let d = 0, j = SRC.indexOf('{', s), e = -1;
        for (; j < SRC.length; j++) {
            if (SRC[j] === '{') d++;
            else if (SRC[j] === '}') { d--; if (d === 0) { e = j; break; } }
        }
        return SRC.slice(s, e + 1);
    }
    const openBotDetailsSrc = extractFn('function openBotDetailsModal(name, wins, losses, byLevel) {');

    function extractHandler(marker) {
        const s = SRC.indexOf(marker);
        if (s === -1) throw new Error('handler not found for extraction: ' + marker);
        const e = SRC.indexOf('});', s);
        return SRC.slice(s, e + 3);
    }
    const onlineTabHandlerSrc = extractHandler('statsTabOnline.addEventListener("click", function () {');
    const botTabHandlerSrc = extractHandler('statsTabBot.addEventListener("click", function () {');

    const statsHtmlStart = HTML.indexOf('<div id="stats-modal"');
    const statsHtmlEnd = HTML.indexOf('<div id="bot-details-modal"');
    const statsHtml = HTML.slice(statsHtmlStart, statsHtmlEnd);
    const detailsHtmlStart = statsHtmlEnd;
    const detailsM = /\n    <\/div>/.exec(HTML.slice(detailsHtmlStart));
    const detailsHtml = HTML.slice(detailsHtmlStart, detailsHtmlStart + detailsM.index + detailsM[0].length);

    return '<!doctype html><html><head><style>.hidden{display:none !important}</style></head><body>'
        + '<button id="ext-trigger">внешний триггер</button>'
        + statsHtml + detailsHtml
        + '<button id="bot-row" class="stats-row">bot-row</button>'
        + '<script>' + helperSrc + '\n'
        // Реальные close-кнопки: представительная привязка closeModal(modal)
        // -- тот же паттерн, что реальный код (проверено source-guard'ом в
        // modal-dialog-focus-b2b.test.js, секция 7).
        + 'document.getElementById("btn-stats-close").addEventListener("click", function(){ closeModal(document.getElementById("stats-modal")); });'
        // Реальный, извлечённый openBotDetailsModal -- мутация в нём (например,
        // удаление openModal(modal) внутри) действительно ломает этот тест.
        + 'function t(k){ return ({bot_details_total:"Всего",btn_difficulty_medium:"Средний",btn_difficulty_hard:"Сложный"})[k] || k; }'
        + openBotDetailsSrc + '\n'
        + 'document.getElementById("btn-bot-details-close").addEventListener("click", function(){'
        + '  var modal=document.getElementById("bot-details-modal"); if(modal) closeModal(modal);'
        + '});'
        + 'var statsTabOnline=document.getElementById("stats-tab-online");'
        + 'var statsTabBot=document.getElementById("stats-tab-bot");'
        + 'var statsViewOnline=document.getElementById("stats-view-online");'
        + 'var statsViewBot=document.getElementById("stats-view-bot");'
        + 'var statsTitleOnline=document.getElementById("stats-title-online");'
        + 'var statsTitleBot=document.getElementById("stats-title-bot");'
        + 'var statsModal=document.getElementById("stats-modal");'
        + 'if (statsTabOnline && statsTabBot && statsViewOnline && statsViewBot) {'
        + onlineTabHandlerSrc
        + botTabHandlerSrc
        + '}'
        + 'document.getElementById("bot-row").addEventListener("click", function(){'
        + '  openBotDetailsModal("тест-бот", 9, 38, { medium: { wins: 6, losses: 20 }, hard: { wins: 3, losses: 18 } });'
        + '});'
        + '</script></body></html>';
}

async function runNestedModalFocusChecks(page, engineName) {
    async function reset() {
        await page.evaluate(function () {
            document.querySelectorAll('.modal-overlay').forEach(function (m) { m.classList.add('hidden'); });
            document.getElementById('ext-trigger').focus();
        });
    }

    // --- Полный жизненный цикл ровно из задания ---
    await reset();
    await page.evaluate(function () { openModal(document.getElementById('stats-modal')); });
    let active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2b: stats initial focus -> btn-stats-close (не вкладка -- та может быть не Online при переоткрытии)',
        active === 'btn-stats-close', active);

    await page.evaluate(function () { document.getElementById('bot-row').focus(); document.getElementById('bot-row').click(); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2b: клик по bot-row открывает bot-details-modal (реальный extracted openBotDetailsModal), фокус -> btn-bot-details-close',
        active === 'btn-bot-details-close', active);

    await page.keyboard.press('Tab');
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2b: Tab внутри details не уходит наружу в stats (единственная кнопка, wrap на себя)',
        active === 'btn-bot-details-close', active);
    await page.keyboard.press('Shift+Tab');
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2b: Shift+Tab тоже не уходит наружу', active === 'btn-bot-details-close', active);

    await page.keyboard.press('Escape');
    let stillOpen = await page.evaluate(function () { return !document.getElementById('bot-details-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2b: Escape закрывает bot-details-modal через btn-bot-details-close', !stillOpen);
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2b: после закрытия child фокус ВЕРНУЛСЯ ИМЕННО в bot-row (не в ext-trigger, не потерян)',
        active === 'bot-row', active);
    stillOpen = await page.evaluate(function () { return !document.getElementById('stats-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2b: stats-modal остаётся открытым после закрытия child', stillOpen);

    // Tab-trap stats продолжает работать после возврата фокуса от child.
    await page.keyboard.press('Tab');
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2b: Tab внутри stats после возврата от child всё ещё работает (уходит на следующую кнопку)',
        active !== 'bot-row', active);

    await page.evaluate(function () { document.getElementById('btn-stats-close').click(); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2b: закрытие stats после этого возвращает фокус во внешний ext-trigger',
        active === 'ext-trigger', active);

    // --- Dynamic aria-labelledby: реальные tab-switch handler'ы ---
    await reset();
    await page.evaluate(function () { openModal(document.getElementById('stats-modal')); });
    let labelledby = await page.evaluate(function () { return document.getElementById('stats-modal').getAttribute('aria-labelledby'); });
    check(engineName + ' 42-B2b: начальный aria-labelledby = stats-title-online (дефолтная активная вкладка)',
        labelledby === 'stats-title-online', labelledby);
    await page.evaluate(function () { document.getElementById('stats-tab-bot').click(); });
    labelledby = await page.evaluate(function () { return document.getElementById('stats-modal').getAttribute('aria-labelledby'); });
    check(engineName + ' 42-B2b: после клика на вкладку "С ботом" aria-labelledby реально переключился на stats-title-bot (реальный extracted handler)',
        labelledby === 'stats-title-bot', labelledby);
    await page.evaluate(function () { document.getElementById('stats-tab-online').click(); });
    labelledby = await page.evaluate(function () { return document.getElementById('stats-modal').getAttribute('aria-labelledby'); });
    check(engineName + ' 42-B2b: обратный клик на "Онлайн" возвращает aria-labelledby на stats-title-online',
        labelledby === 'stats-title-online', labelledby);
}

// №42-B2c: fixture для info-modal. openModal/closeModal/showInfoModal --
// РЕАЛЬНЫЕ, извлечённые из script.js. showInfoModal() внутри вызывает
// openModal(infoModal, { returnFocus: !(infoModalShouldNavigate ||
// offerNewGame) }) -- мутация этой формулы должна ломать тест, поэтому
// извлекаем showInfoModal целиком, а не переписываем условие вручную.
function buildInfoModalFixture() {
    const helperStart = SRC.indexOf('const modalFocusState = new WeakMap();');
    const heMarker = 'function closeModal(modal) {';
    const heStart = SRC.indexOf(heMarker, helperStart);
    let depth = 0, i = SRC.indexOf('{', heStart), end = -1;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const helperSrc = SRC.slice(helperStart, end + 1);

    function extractFn(marker) {
        const s = SRC.indexOf(marker);
        if (s === -1) throw new Error('function not found for extraction: ' + marker);
        let d = 0, j = SRC.indexOf('{', s), e = -1;
        for (; j < SRC.length; j++) {
            if (SRC[j] === '{') d++;
            else if (SRC[j] === '}') { d--; if (d === 0) { e = j; break; } }
        }
        return SRC.slice(s, e + 1);
    }
    const showInfoModalSrc = extractFn('function showInfoModal(text, offerNewGame, navigateToMenu) {');

    const infoStart = HTML.indexOf('<div id="info-modal"');
    const infoM = /\n    <\/div>/.exec(HTML.slice(infoStart));
    const infoHtml = HTML.slice(infoStart, infoStart + infoM.index + infoM[0].length);

    return '<!doctype html><html><head><style>.hidden{display:none !important}</style></head><body>'
        + '<button id="ext-trigger">внешний триггер</button>' + infoHtml
        + '<script>' + helperSrc + '\n'
        + 'function t(k){ return k; }'
        + 'var infoModal=document.getElementById("info-modal");'
        + 'var infoModalText=document.getElementById("info-modal-text");'
        + 'var btnInfoNewGame=document.getElementById("btn-info-new-game");'
        + 'var btnInfoClose=document.getElementById("btn-info-close");'
        + 'var infoModalShouldNavigate=true;'
        + 'var menuScreen={}, timeControlScreen={}, showScreenCalls=[];'
        + 'function showScreen(s){ showScreenCalls.push(s); }'
        + 'function detachRoomListener(){} function stopPresenceHeartbeat(){} function loadActiveRooms(){}'
        + 'var roomCode=null, currentState=null, isOnlineGame=false;'
        // Реальные close-кнопки; wiring представительный (совпадает с
        // реальным паттерном, отдельно проверено source-guard'ом).
        + 'btnInfoNewGame.addEventListener("click", function(){'
        + '  closeModal(infoModal); showScreen(timeControlScreen);'
        + '});'
        + 'btnInfoClose.addEventListener("click", function(){'
        + '  closeModal(infoModal); if (infoModalShouldNavigate) showScreen(menuScreen);'
        + '});'
        + showInfoModalSrc
        + '</script></body></html>';
}

async function runInfoModalFocusChecks(page, engineName) {
    async function reset() {
        await page.evaluate(function () {
            document.getElementById('info-modal').classList.add('hidden');
            document.getElementById('btn-info-new-game').classList.add('hidden');
            document.getElementById('ext-trigger').focus();
            window.__showScreenCallsAtReset = showScreenCalls.length;
        });
    }

    // --- Комбинация 1: offerNewGame=false, navigateToMenu=true (default) -- реальный, единственный используемый сегодня режим ---
    await reset();
    await page.evaluate(function () { showInfoModal('err_test', false); });
    let active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: обычный navigating-режим, initial focus -> btn-info-close', active === 'btn-info-close', active);

    await page.keyboard.press('Tab');
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: Tab внутри единственной видимой кнопки остаётся на ней (New Game скрыта)', active === 'btn-info-close', active);

    await page.keyboard.press('Escape');
    let stillOpen = await page.evaluate(function () { return !document.getElementById('info-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2c: Escape закрывает через btn-info-close', !stillOpen);
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: navigating-режим -- НЕТ stale return-focus на ext-trigger (экран сменился)',
        active !== 'ext-trigger', active);

    // --- Комбинация 2: offerNewGame=false, navigateToMenu=false -- non-navigating, return-focus ДОЛЖЕН сработать ---
    await reset();
    await page.evaluate(function () { showInfoModal('err_no_nav', false, false); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: non-navigating режим, initial focus -> btn-info-close', active === 'btn-info-close', active);
    await page.evaluate(function () { document.getElementById('btn-info-close').click(); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: non-navigating режим -- return-focus РЕАЛЬНО вернулся на ext-trigger',
        active === 'ext-trigger', active);

    // --- Комбинация 3: offerNewGame=true, navigateToMenu=true -- dormant двухкнопочный режим, оба exit навигируют ---
    await reset();
    await page.evaluate(function () { showInfoModal('err_two_btn', true); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: dormant двухкнопочный режим, initial focus -> btn-info-close (не btn-info-new-game)',
        active === 'btn-info-close', active);

    const order = [active];
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(function () { return document.activeElement.id; }));
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(function () { return document.activeElement.id; }));
    check(engineName + ' 42-B2c: Tab между двумя кнопками циклически замкнут (' + order.join(' -> ') + ')',
        order[0] === order[2] && order[0] !== order[1]);

    await page.keyboard.press('Escape');
    active = await page.evaluate(function () { return document.activeElement.id; });
    const escapeWentToNewGame = await page.evaluate(function () { return showScreenCalls[showScreenCalls.length - 1] === timeControlScreen; });
    check(engineName + ' 42-B2c: Escape НИКОГДА не запускает btn-info-new-game (New Game screen не вызван Escape\'ом)', !escapeWentToNewGame);

    // --- New Game exit явным кликом: навигация безусловна ---
    await reset();
    await page.evaluate(function () { showInfoModal('err_two_btn2', true); });
    await page.evaluate(function () { document.getElementById('btn-info-new-game').click(); });
    const newGameScreenCalled = await page.evaluate(function () { return showScreenCalls[showScreenCalls.length - 1] === timeControlScreen; });
    check(engineName + ' 42-B2c: явный клик на btn-info-new-game реально переводит на timeControlScreen', newGameScreenCalled);

    // --- Комбинация 4: offerNewGame=true, navigateToMenu=false -- New Game видима, но её handler ИГНОРИРУЕТ navigateToMenu ---
    await reset();
    await page.evaluate(function () { showInfoModal('err_mixed', true, false); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: смешанная комбинация (New Game видима, navigateToMenu=false), initial focus -> btn-info-close',
        active === 'btn-info-close', active);
    await page.evaluate(function () { document.getElementById('btn-info-close').click(); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2c: смешанная комбинация -- НЕТ return-focus (New Game видима => returnFocus:false по формуле)',
        active !== 'ext-trigger', active);

    // --- Repeated showInfoModal() до close: новое сообщение осмысленно переустанавливает фокус на initial ---
    await reset();
    await page.evaluate(function () { showInfoModal('err_first', false); });
    await page.keyboard.press('Tab'); // пользователь остаётся на единственной кнопке
    await page.evaluate(function () { showInfoModal('err_second', false); }); // второй, замещающий вызов
    active = await page.evaluate(function () { return document.activeElement.id; });
    const text = await page.evaluate(function () { return document.getElementById('info-modal-text').textContent; });
    check(engineName + ' 42-B2c: повторный showInfoModal() реально заменяет текст (' + text + ') и сохраняет фокус на btn-info-close',
        text === 'err_second' && active === 'btn-info-close');

    // --- Реальный текущий call-site: showInfoModal(t("err_..."), false) -- ровно 2 аргумента, как все 45 в проде ---
    await reset();
    await page.evaluate(function () { showInfoModal(t('err_auth_required'), false); });
    stillOpen = await page.evaluate(function () { return !document.getElementById('info-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2c: реальная форма вызова (2 аргумента, как в 45 продакшен call-sites) открывает модалку корректно', stillOpen);
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

async function runAsyncModalFocusChecks(page, engineName) {
    async function reset() {
        await page.evaluate(function () {
            document.querySelectorAll('.modal-overlay').forEach(function (m) { m.classList.add('hidden'); });
            document.getElementById('ext-trigger').focus();
        });
    }

    // --- 1. Программное async-открытие БЕЗ клика; return-focus (draw-offer: экран не меняется) ---
    await reset();
    await page.evaluate(function () { simulateDrawOfferShown(); });
    let active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a: draw-offer программно открылся БЕЗ клика, initial focus -> btn-draw-decline',
        active === 'btn-draw-decline', active);

    // --- 2. Нет Escape у draw-offer (нет безопасного нейтрального действия) ---
    await page.keyboard.press('Escape');
    let stillOpen = await page.evaluate(function () { return !document.getElementById('draw-offer-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2a: draw-offer НЕ закрывается по Escape (нет data-modal-escape)', stillOpen);

    // --- 3. Программное внешнее закрытие (соперник отменил предложение) идёт через closeModal ---
    await page.evaluate(function () { simulateDrawOfferCleared(); });
    stillOpen = await page.evaluate(function () { return !document.getElementById('draw-offer-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2a: draw-offer programmatic external close (simulateDrawOfferCleared) реально закрывает', !stillOpen);
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a: draw-offer return-focus после внешнего закрытия -> ext-trigger (экран не менялся)',
        active === 'ext-trigger', active);

    // --- 4. Repeated async open (redundant re-render) НЕ крадёт фокус пользователя ---
    await reset();
    await page.evaluate(function () { simulateDrawOfferShown(); });
    await page.keyboard.press('Tab'); // пользователь уходит с initial на следующую кнопку
    const afterTab = await page.evaluate(function () { return document.activeElement.id; });
    await page.evaluate(function () { simulateDrawOfferShown(); }); // redundant re-render, proposal тот же
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a: redundant re-render (тот же проposal) НЕ возвращает фокус на initial (' + afterTab + ' -> ' + active + ')',
        active === afterTab, active);

    // --- 5. rematch-request: тоже нет Escape ---
    await reset();
    await page.evaluate(function () { simulateRematchOfferShown(); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a: rematch-request initial focus -> btn-rematch-decline', active === 'btn-rematch-decline', active);
    await page.keyboard.press('Escape');
    stillOpen = await page.evaluate(function () { return !document.getElementById('rematch-request-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2a: rematch-request НЕ закрывается по Escape', stillOpen);

    // --- 6. end-game-modal: Escape РАБОТАЕТ (делегирует Закрыть), returnFocus:false ---
    await reset();
    await page.evaluate(function () { simulateEndGameShown(); });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a: end-game initial focus -> btn-close-game (не btn-new-game)', active === 'btn-close-game', active);
    await page.keyboard.press('Escape');
    stillOpen = await page.evaluate(function () { return !document.getElementById('end-game-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2a: end-game Escape закрывает через btn-close-game', !stillOpen);
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a: end-game returnFocus:false -- НЕ возвращается на ext-trigger (' + active + ')',
        active !== 'ext-trigger');

    // --- 7. spectator-interrupted: Escape работает, returnFocus:false, повторный async-open (listener teardown) ---
    await reset();
    await page.evaluate(function () { simulateSpectatorInterrupted(); });
    await page.evaluate(function () { simulateSpectatorInterrupted(); }); // повторный async open без close между ними
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a: spectator-interrupted повторный async-open не ломается (keydown listener не задвоен), фокус на btn-spectator-interrupted-ok',
        active === 'btn-spectator-interrupted-ok', active);
    await page.keyboard.press('Escape');
    stillOpen = await page.evaluate(function () { return !document.getElementById('spectator-interrupted-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2a: spectator-interrupted Escape закрывает через btn-spectator-interrupted-ok', !stillOpen);

    // --- 8. review fix: РЕАЛЬНЫЙ порядок renderBoard() -- renderEndGameModal()
    // открывается ПЕРВЫМ, checkRematchProposal()/checkDrawProposal() (закрытие
    // устаревшего draw/rematch при currentState.winner) идут ПОСЛЕ, в том же
    // синхронном проходе. Обратный порядок ("сначала закрыли draw, потом
    // открыли end-game") не воспроизводит найденный баг: closeModal(draw)
    // late-запущенный ПОСЛЕ того как end-game уже получил фокус, крал его
    // обратно на старый game-screen trigger, хотя end-game оставался открыт.
    await reset();
    await page.evaluate(function () { simulateDrawOfferShown(); });
    await page.evaluate(function () {
        simulateEndGameShown();   // 1: renderEndGameModal() -- открывается первым
        simulateDrawOfferCleared(); // 2: checkDrawProposal() -- закрывается позже, в том же проходе
    });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a review fix: draw-offer -> end-game в РЕАЛЬНОМ порядке renderBoard -- late closeModal(draw) НЕ крадёт фокус у уже открытого end-game',
        active === 'btn-close-game', active);
    stillOpen = await page.evaluate(function () { return !document.getElementById('end-game-modal').classList.contains('hidden'); });
    check(engineName + ' 42-B2a review fix: end-game остаётся открытым после late close(draw)', stillOpen);

    await reset();
    await page.evaluate(function () { simulateRematchOfferShown(); });
    await page.evaluate(function () {
        simulateEndGameShown();
        simulateRematchOfferCleared();
    });
    active = await page.evaluate(function () { return document.activeElement.id; });
    check(engineName + ' 42-B2a review fix: rematch-request -> end-game в РЕАЛЬНОМ порядке -- то же самое для rematch',
        active === 'btn-close-game', active);
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

    console.log('\n=== №42-B2a: async dialog focus management (draw-offer/rematch/end-game/spectator-interrupted) ===');
    {
        const asyncModalPage = await browser.newPage();
        await asyncModalPage.setContent(buildAsyncModalFixture());
        await runAsyncModalFocusChecks(asyncModalPage, engine.name);
        await asyncModalPage.close();
    }

    console.log('\n=== №42-B2b: nested stats-modal / bot-details-modal focus management ===');
    {
        const nestedModalPage = await browser.newPage();
        await nestedModalPage.setContent(buildNestedModalFixture());
        await runNestedModalFocusChecks(nestedModalPage, engine.name);
        await nestedModalPage.close();
    }

    console.log('\n=== №42-B2c: info-modal focus management (4 combinations) ===');
    {
        const infoModalPage = await browser.newPage();
        await infoModalPage.setContent(buildInfoModalFixture());
        await runInfoModalFocusChecks(infoModalPage, engine.name);
        await infoModalPage.close();
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

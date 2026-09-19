// ==========================================================================
// ДВА ДЕФЕКТА АНИМАЦИИ ПРЕВРАЩЕНИЯ У БОТА.
//
// A. Повторный рендер того же хода убивал уже идущую анимацию.
//    Ход бота коммитится транзакцией, а транзакция RTDB применяет
//    результат локально и поднимает value сразу, затем ВТОРОЙ раз при
//    подтверждении сервером. Один коммит -- две доставки одного revision,
//    и renderBoard вызывается на обеих. Поскольку
//    cancelActiveGhostAnimations() стояла ДО проверки isGenuinelyNewMove,
//    вторая доставка снимала эффект и выходила, не запустив его заново.
//    Наложение невидимо первые MOVE_GHOST_DURATION_MS, а подтверждение
//    приходит за 50-300 мс -- поэтому анимации не было видно вообще.
//
// B. Превращение ВНУТРИ обязательной серии взятий срезалось следующим
//    автоматическим прыжком бота через 150 мс -- ровно в момент, когда
//    наложение должно было зажечься.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

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
function constOf(name) {
    const m = new RegExp('const ' + name + ' = (\\d+)').exec(noComments(SRC));
    return m ? parseInt(m[1], 10) : null;
}

const CLEAN = noComments(SRC);

// --- Исполняемая песочница для playMoveGhostAnimation -------------------
//
// Клетки и фигура подставляются НАСТОЯЩИЕ (в виде минимальных заглушек),
// а не пустыми объектами. Иначе genuine new move упирался бы в защитный
// выход `if (!fromSquareEl || !toSquareEl || !realPieceEl) return;` ДО
// вызова playKingPromotionEffect(), и главный регрессионный сценарий --
// "первая доставка реально запускает превращение" -- остался бы
// непроверенным.
//
// Заглушки ровно те, что нужны функции дальше по коду:
// getBoundingClientRect для двух клеток, classList и appendChild, плюс
// document.createElement и activeGhostCancelFns. Браузерным тестом это не
// становится.
function makeSquare() {
    const children = [];
    return {
        getBoundingClientRect: function () { return { left: 0, top: 0, width: 40, height: 40 }; },
        appendChild: function (el) { children.push(el); el.parentNode = this; },
        _children: children
    };
}
function makeElement() {
    const cls = new Set();
    return {
        className: '',
        parentNode: null,
        style: { transform: '', setProperty: function () {} },
        classList: {
            add: function (c) { cls.add(c); },
            remove: function (c) { cls.delete(c); },
            contains: function (c) { return cls.has(c); }
        },
        addEventListener: function () {},
        remove: function () { this.parentNode = null; },
        _cls: cls
    };
}

function runGhost(state, lastAnimated) {
    const calls = { cancels: 0, promotions: 0 };
    const saved = {};
    ['cancelActiveGhostAnimations', 'playKingPromotionEffect', 'squareElements',
     'pieceElements', 'currentState', 'lastAnimatedMoveCount', 'activeGhostCancelFns',
     'document', 'setTimeout', 'requestAnimationFrame', 'prefersReducedScreenMotion',
     'MOVE_GHOST_DURATION_MS'].forEach(function (k) {
        saved[k] = global[k];
    });
    global.cancelActiveGhostAnimations = function () { calls.cancels++; };
    global.playKingPromotionEffect = function () { calls.promotions++; };
    global.activeGhostCancelFns = [];
    global.document = { createElement: function () { return makeElement(); } };
    global.setTimeout = function () { return 0; };
    // Ghost стартует внутри rAF. Не исполняем колбэк: нас интересуют
    // ветвления до него, а реальный полёт в Node всё равно не измерить.
    global.requestAnimationFrame = function () { return 0; };
    global.prefersReducedScreenMotion = function () { return false; };
    global.MOVE_GHOST_DURATION_MS = constOf('MOVE_GHOST_DURATION_MS') || 150;

    global.squareElements = {};
    global.pieceElements = {};
    if (state && state.lastMove) {
        const fromKey = state.lastMove.from.row + '_' + state.lastMove.from.col;
        const toKey = state.lastMove.to.row + '_' + state.lastMove.to.col;
        global.squareElements[fromKey] = makeSquare();
        global.squareElements[toKey] = makeSquare();
        global.pieceElements[toKey] = makeElement();
    }
    global.currentState = state;
    global.lastAnimatedMoveCount = lastAnimated;

    // eslint-disable-next-line no-eval
    eval(funcBody(CLEAN, 'playMoveGhostAnimation'));
    playMoveGhostAnimation([]);

    calls.lastAnimated = global.lastAnimatedMoveCount;
    Object.keys(saved).forEach(function (k) {
        if (saved[k] === undefined) delete global[k]; else global[k] = saved[k];
    });
    return calls;
}

function moveState(moveCount, extra) {
    return Object.assign({
        moveCount: moveCount,
        moveType: 'king',
        lastMove: { from: { row: 1, col: 1 }, to: { row: 0, col: 2 } },
        // Фигура на клетке назначения обязательна: без неё функция выходит
        // на `if (!pieceData) return;` до вызова эффекта.
        pieces: { '0_2': { color: 'light', king: true } }
    }, extra || {});
}

console.log('=== A. ПОВТОРНЫЙ РЕНДЕР ТОГО ЖЕ ХОДА ===');
{
    const body = funcBody(CLEAN, 'playMoveGhostAnimation');
    check('A.1 функция найдена', !!body);

    // Порядок: отмена больше не может стоять до вычисления guard'ов.
    check('A.2 отмена НЕ первой строкой функции',
        !!body && !/function playMoveGhostAnimation\([^)]*\) \{\s*\n\s*cancelActiveGhostAnimations\(\);/.test(body));
    check('A.3 guard вычисляется до основной отмены', (function () {
        if (!body) return false;
        const guard = body.indexOf('const isGenuinelyNewMove');
        const lastCancel = body.lastIndexOf('cancelActiveGhostAnimations();');
        return guard !== -1 && lastCancel !== -1 && guard < lastCancel;
    })());

    // Сначала убеждаемся, что harness вообще доводит до эффекта: иначе
    // все проверки ниже были бы бессмысленны -- функция выходила бы на
    // защитном выходе по отсутствию клеток и ничего бы не вызывала.
    const genuine = runGhost(moveState(6), 5);
    check('A.0 genuine new king move РЕАЛЬНО запускает превращение',
        genuine.promotions === 1, 'promotions: ' + genuine.promotions);
    check('A.0b и при этом снимает предыдущие наложения',
        genuine.cancels === 1, 'отмен: ' + genuine.cancels);

    // Главная проверка дефекта -- ИСПОЛНЕНИЕМ.
    const repeat = runGhost(moveState(7), 7);
    check('A.4 повторная доставка НЕ вызывает cancelActiveGhostAnimations',
        repeat.cancels === 0, 'отмен: ' + repeat.cancels);
    check('A.5 повторная доставка не перезапускает эффект',
        repeat.promotions === 0, 'promotions: ' + repeat.promotions);

    const fresh = runGhost(moveState(8), 7);
    check('A.6 настоящий новый ход очищает предыдущие ghosts',
        fresh.cancels === 1, 'отмен: ' + fresh.cancels);
    check('A.7 новый ход обновляет lastAnimatedMoveCount', fresh.lastAnimated === 8);

    const firstRender = runGhost(moveState(5), null);
    check('A.8 первый рендер после attach очищает старые анимации',
        firstRender.cancels === 1, 'отмен: ' + firstRender.cancels);
    check('A.9 первый рендер НЕ проигрывает чужой прошлый ход',
        firstRender.promotions === 0, 'promotions: ' + firstRender.promotions);
    check('A.10 первый рендер запоминает moveCount', firstRender.lastAnimated === 5);

    const noMove = runGhost({ moveCount: 5, lastMove: null }, 3);
    check('A.11 отсутствие lastMove очищает наложения',
        noMove.cancels === 1, 'отмен: ' + noMove.cancels);
    check('A.12 отсутствие lastMove обновляет счётчик', noMove.lastAnimated === 5);

    const noState = runGhost(null, 3);
    check('A.13 отсутствие состояния очищает и сбрасывает счётчик',
        noState.cancels === 1 && noState.lastAnimated === null);

    // Уборка превращения ОСТАЁТСЯ в общем списке: она нужна и новому ходу,
    // и обработчикам resize/orientation.
    check('A.14 уборка превращения по-прежнему регистрируется', (function () {
        const eff = funcBody(CLEAN, 'playKingPromotionEffect');
        return !!eff && /activeGhostCancelFns\.push\(cleanup\)/.test(eff);
    })());
    check('A.15 resize и orientation по-прежнему очищают напрямую',
        /window\.addEventListener\("resize", cancelActiveGhostAnimations\)/.test(CLEAN) &&
        /window\.addEventListener\("orientationchange", cancelActiveGhostAnimations\)/.test(CLEAN));
}

console.log('\n=== A2. СЦЕНАРИЙ ДВОЙНОЙ ДОСТАВКИ OWNER-SYNCED ===');
{
    // Транзакция даёт локальную и серверную доставку одного revision.
    check('A2.1 ход бота коммитится транзакцией',
        /database\.ref\("botSessions\/" \+ myTelegramId\)\.transaction\(/.test(CLEAN));
    check('A2.2 слушатель сессии обычный on("value")',
        /ref\.on\("value", function \(snapshot\) \{ onUpdate\(snapshot\.val\(\)\); \}\)/.test(CLEAN));
    check('A2.3 renderBoard в onOwnerSessionUpdate вызывается безусловно', (function () {
        const b = funcBody(CLEAN, 'onOwnerSessionUpdate');
        if (!b) return false;
        // renderBoard НЕ должен быть спрятан под проверку revision --
        // именно поэтому защищать анимацию обязана сама ghost-функция.
        return /\n    renderBoard\(\);/.test(b);
    })());

    // Проигрываем обе доставки подряд, ровно как это делает транзакция
    // RTDB: локальное применение, затем подтверждение сервером.
    const first = runGhost(moveState(9), 8);
    check('A2.4 первая доставка ЗАПУСКАЕТ превращение ровно один раз',
        first.promotions === 1, 'promotions: ' + first.promotions);
    check('A2.5 первая доставка снимает предыдущие наложения',
        first.cancels === 1, 'отмен: ' + first.cancels);
    check('A2.6 первая доставка запоминает moveCount', first.lastAnimated === 9);

    const second = runGhost(moveState(9), 9);
    check('A2.7 вторая доставка того же moveCount НИЧЕГО не отменяет',
        second.cancels === 0, 'отмен: ' + second.cancels);
    check('A2.8 вторая доставка НЕ запускает превращение повторно',
        second.promotions === 0, 'promotions: ' + second.promotions);

    // Полная последовательность одного коммита в одном прогоне: сначала
    // локальная доставка, следом серверная. Именно она воспроизводит
    // исходный дефект -- раньше вторая убивала эффект первой.
    (function () {
        const stateAtRevision = moveState(9);
        const local = runGhost(stateAtRevision, 8);
        const confirmed = runGhost(stateAtRevision, local.lastAnimated);
        check('A2.9 за один коммит превращение запускается один раз и не отменяется',
            local.promotions === 1 && confirmed.promotions === 0 && confirmed.cancels === 0,
            'local: p=' + local.promotions + ' c=' + local.cancels +
            ', confirmed: p=' + confirmed.promotions + ' c=' + confirmed.cancels);
    })();
}

console.log('\n=== B. В ИГРАХ С БОТОМ ВИЗУАЛА НЕТ ===');
{
    // Продуктовое решение владельца после ручного теста: в играх с ботом
    // превращение происходит без анимации вовсе. Критерий -- isBotGame, а
    // не цвет и не владелец хода.
    const eff = funcBody(CLEAN, 'playKingPromotionEffect');
    check('B.1 эффект найден', !!eff);
    check('B.2 ранний выход по isBotGame', !!eff && /if \(isBotGame\) return;/.test(eff));
    check('B.3 критерий именно isBotGame, а не цвет или владелец хода',
        !!eff && !/botColor|myColor|currentState\.turn/.test(eff));

    // Проверяем ИСПОЛНЕНИЕМ: в бот-игре не создаётся ни одного наложения,
    // в игре человек против человека -- создаются.
    function overlaysCreated(isBot) {
        let made = 0;
        const saved = {};
        ['squareElements', 'pieceElements', 'document', 'activeGhostCancelFns',
         'setTimeout', 'currentState', 'isBotGame', 'MOVE_GHOST_DURATION_MS',
         'KING_PROMOTION_DURATION_MS'].forEach(function (k) { saved[k] = global[k]; });
        global.squareElements = { '0_2': { appendChild: function () { made++; } } };
        global.pieceElements = { '0_2': { classList: { add: function () {}, remove: function () {} } } };
        global.document = { createElement: function () {
            return { className: '', parentNode: null, style: { setProperty: function () {} },
                     addEventListener: function () {} };
        } };
        global.activeGhostCancelFns = [];
        global.setTimeout = function () { return 0; };
        global.MOVE_GHOST_DURATION_MS = constOf('MOVE_GHOST_DURATION_MS');
        global.KING_PROMOTION_DURATION_MS = constOf('KING_PROMOTION_DURATION_MS');
        global.isBotGame = isBot;
        global.currentState = { moveType: 'king', lastMove: { to: { row: 0, col: 2 } },
                                pieces: { '0_2': { color: 'light', king: true } } };
        // eslint-disable-next-line no-eval
        eval(funcBody(CLEAN, 'playKingPromotionEffect'));
        playKingPromotionEffect();
        Object.keys(saved).forEach(function (k) {
            if (saved[k] === undefined) delete global[k]; else global[k] = saved[k];
        });
        return made;
    }

    check('B.4 бот-игра: превращение НЕ создаёт наложений',
        overlaysCreated(true) === 0, 'наложений: ' + overlaysCreated(true));
    check('B.5 человек против человека: наложения создаются',
        overlaysCreated(false) > 0, 'наложений: ' + overlaysCreated(false));

    // Правило распространяется на все случаи бот-игры: превращение бота,
    // превращение человека против бота, обычное и внутри серии.
    check('B.6 выход по isBotGame стоит до любой работы с DOM', (function () {
        if (!eff) return false;
        const bot = eff.indexOf('if (isBotGame) return;');
        const dom = eff.indexOf('document.createElement');
        return bot !== -1 && dom !== -1 && bot < dom;
    })());
}

console.log('\n=== B2. ЗВУК В БОТ-ИГРЕ СОХРАНЁН ===');
{
    // Звук живёт отдельно от визуала и всегда жил: ни одна из точек
    // вызова не проходит через playKingPromotionEffect.
    const eff = funcBody(CLEAN, 'playKingPromotionEffect');
    check('B2.1 звук НЕ вызывается из эффекта',
        !!eff && !/playKingSound|playSoundForMoveType/.test(eff));
    check('B2.2 звук вызывается из своих точек',
        (CLEAN.match(/playSoundForMoveType\(/g) || []).length >= 4);

    // Задержка звука существует ради попадания ноты в момент появления
    // дамки. В бот-игре появления нет -- ждать нечего.
    const delayFn = funcBody(CLEAN, 'kingPromotionSoundDelayMs');
    check('B2.3 функция задержки найдена', !!delayFn);
    check('B2.4 в бот-игре задержки нет', !!delayFn && /if \(isBotGame\) return 0;/.test(delayFn));

    function delayFor(isBot, reduced) {
        const saved = { b: global.isBotGame, w: global.window, k: global.KING_PROMOTION_SOUND_DELAY_MS };
        global.isBotGame = isBot;
        global.window = { matchMedia: function () { return { matches: !!reduced }; } };
        // Значение берём из тех же констант, что и код, а не числом:
        // после смены длительности превращения оно пересчитывается.
        global.KING_PROMOTION_SOUND_DELAY_MS = Math.max(0, Math.round(
            constOf('MOVE_GHOST_DURATION_MS')
            + constOf('KING_PROMOTION_DURATION_MS') * parseFloat(
                /const KING_PROMOTION_REVEAL_FRACTION = ([\d.]+)/.exec(CLEAN)[1])
            - constOf('KING_SOUND_RESOLVE_OFFSET_MS')));
        // eslint-disable-next-line no-eval
        eval(funcBody(CLEAN, 'kingPromotionSoundDelayMs'));
        const v = kingPromotionSoundDelayMs();
        global.isBotGame = saved.b; global.window = saved.w;
        global.KING_PROMOTION_SOUND_DELAY_MS = saved.k;
        return v;
    }
    check('B2.5 бот-игра -> звук без задержки', delayFor(true, false) === 0, String(delayFor(true, false)));
    check('B2.6 человек против человека -> задержка из формулы (455 мс)',
        delayFor(false, false) === 455, String(delayFor(false, false)));
    check('B2.7 reduced-motion по-прежнему снимает задержку', delayFor(false, true) === 0);
}

console.log('\n=== B3. СТАРАЯ ПАУЗА БОТА УДАЛЕНА ===');
{
    // Пауза добавлялась ради досмотра анимации превращения бота. Визуала
    // больше нет -- ветка и константа удалены, а не оставлены мёртвыми.
    check('B3.1 константа запаса удалена', !/BOT_PROMOTION_EXTRA_PAUSE_MS/.test(CLEAN));
    check('B3.2 ветка mid-capture удалена', !/isBotPromotionMidCapture/.test(CLEAN));
    check('B3.3 вычисляемой задержки бота больше нет', !/nextBotMoveDelayMs/.test(CLEAN));
    check('B3.4 обычная пауза бота сохранена', constOf('BOT_MOVE_DELAY_MS') === 150);

    const render = funcBody(CLEAN, 'renderBoard');
    check('B3.5 таймер использует только BOT_MOVE_DELAY_MS',
        !!render && /\}, BOT_MOVE_DELAY_MS\);/.test(render));
    check('B3.6 защита от второго таймера сохранена', !!render && /if \(!botMoveTimer\) \{/.test(render));
    check('B3.7 планирование только когда ход бота',
        !!render && /currentState\.turn === botColor/.test(render));
    check('B3.8 после паузы вызывается тот же triggerBotMove',
        !!render && /botMoveTimer = null;\s*\n\s*triggerBotMove\(\);/.test(render));
}

console.log('\n=== C. НИЧЕГО ЛИШНЕГО НЕ ЗАТРОНУТО ===');
{
    const engine = fs.readFileSync(path.join(__dirname, '..', 'shared', 'game-engine.js'), 'utf8');
    check('C.1 движок не менялся: becameKing на месте',
        /moveType = becameKing \? "king" : "move"/.test(engine) &&
        /moveType = becameKing \? "king" : "capture"/.test(engine));
    check('C.2 транзакции Firebase не менялись',
        /\.transaction\(function \(session\)/.test(CLEAN));
    check('C.3 звук превращения и его задержка не менялись',
        /function kingPromotionSoundDelayMs\(\)/.test(CLEAN) &&
        /KING_PROMOTION_SOUND_DELAY_MS = Math\.max\(0, Math\.round\(/.test(CLEAN));
    check('C.4 ход человека не получил новых задержек', (function () {
        const b = funcBody(CLEAN, 'performMove');
        return !!b && !/BOT_PROMOTION_EXTRA_PAUSE_MS|nextBotMoveDelayMs/.test(b);
    })());
    check('C.5 эффект превращения по-прежнему вызывается из ghost-функции', (function () {
        const b = funcBody(CLEAN, 'playMoveGhostAnimation');
        return !!b && /playKingPromotionEffect\(\);/.test(b);
    })());
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

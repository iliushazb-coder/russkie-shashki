// ==========================================================================
// ОДНОРАЗОВЫЙ ЭФФЕКТ ПРЕВРАЩЕНИЯ В ДАМКУ.
//
// Главное требование: эффект принадлежит СОБЫТИЮ, а не состоянию доски.
// Он обязан срабатывать ровно тогда, когда обычная шашка впервые стала
// дамкой, и не срабатывать ни при перерисовке, ни при reconnect, ни при
// входе зрителя в партию, где дамка уже стоит.
//
// Поэтому проверяется не «есть ли анимация в CSS», а то, откуда она
// запускается и что её запуск защищён теми же guard'ами, что уже
// отсеивают повторы для ghost-анимации хода.
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

// Общий блок трёх наложений. Ищем по тексту, а не регуляркой: селектор
// многострочный, и экранирование в шаблоне легко испортить незаметно.
function baseOverlayRule() {
    const head = '.king-promotion-flip,\n.king-promotion-flip-back,\n.king-promotion-flip-king {';
    const i = CSS.indexOf(head);
    if (i === -1) return null;
    const end = CSS.indexOf('\n}', i);
    return end === -1 ? null : [CSS.slice(i, end + 2)];
}

// Базовое opacity из общего селектора трёх наложений. Всё, что keyframes
// не переопределяют, остаётся этим значением.
function baseOpacity() {
    const rule = baseOverlayRule();
    if (!rule) return 1;
    const m = /opacity:\s*([\d.]+)/.exec(rule[0]);
    return m ? parseFloat(m[1]) : 1;
}


console.log('=== 1. ТРИГГЕР ТОЛЬКО ПО СОБЫТИЮ ===');

const effect = funcBody(CLEAN, 'playKingPromotionEffect');
check('1.1 функция эффекта существует', !!effect);

if (effect) {
    check('1.2 запускается только при moveType === "king"',
        /currentState\.moveType !== "king"/.test(effect));
    check('1.3 адресуется по lastMove.to, а не по всей доске',
        /lastMove\.to\.row/.test(effect) && /lastMove\.to\.col/.test(effect));
    check('1.4 не ищет фигуры по классу .king',
        !/querySelector[\s\S]{0,40}\.king/.test(effect) &&
        !/classList\.contains\("king"\)/.test(effect));
    check('1.5 защитный выход, если клетки или фигуры нет',
        /if \(!squareEl \|\| !pieceData\) return;/.test(effect));
}

console.log('\n=== 2. НЕ ПОВТОРЯЕТСЯ ПРИ RECONNECT / RE-RENDER / SPECTATOR ===');

// Эффект вызывается из playMoveGhostAnimation ПОСЛЕ её guard'а.
// Именно этот guard отсеивает первый рендер после подключения
// (reconnect, reload, вход зрителя) и повторные рендеры того же хода.
const ghost = funcBody(CLEAN, 'playMoveGhostAnimation');
check('2.1 ghost-функция найдена', !!ghost);

if (ghost) {
    const guardPos = ghost.indexOf('if (!isGenuinelyNewMove) return;');
    const callPos = ghost.indexOf('playKingPromotionEffect()');
    check('2.2 эффект вызывается из защищённого от повторов пути', callPos !== -1);
    check('2.3 вызов стоит ПОСЛЕ guard\'а isGenuinelyNewMove',
        guardPos !== -1 && callPos !== -1 && guardPos < callPos,
        'guard@' + guardPos + ' call@' + callPos);
    // Вызов переехал ниже проверок клеток: эффект не должен запускаться
    // там, где сам полёт невозможен.
    check('2.3b вызов стоит ПОСЛЕ проверок клеток и реальной фигуры', (function () {
        const squares = ghost.indexOf('!fromSquareEl || !toSquareEl || !realPieceEl');
        return squares !== -1 && callPos !== -1 && squares < callPos;
    })());
    check('2.3c вызов стоит ПОСЛЕ проверки pieceData', (function () {
        const pd = ghost.indexOf('if (!pieceData) return;');
        return pd !== -1 && callPos !== -1 && pd < callPos;
    })());
    check('2.4 guard отсеивает первый рендер после подключения',
        /isFirstRenderSinceAttach = \(lastAnimatedMoveCount === null\)/.test(ghost));
    check('2.5 guard сравнивает moveCount, а не только наличие хода',
        /currentState\.moveCount !== lastAnimatedMoveCount/.test(ghost));
}

// Единственная точка вызова: если эффект дёргать откуда-то ещё, гарантия
// «только по событию» перестанет действовать.
check('2.6 у эффекта ровно одна точка вызова во всём script.js',
    (CLEAN.match(/playKingPromotionEffect\(\)/g) || []).length === 2,
    'определение + один вызов');

check('2.7 эффект не вызывается из renderBoard/updateBoardPieces', (function () {
    const rb = funcBody(CLEAN, 'renderBoard');
    const up = funcBody(CLEAN, 'updateBoardPieces');
    return (!rb || rb.indexOf('playKingPromotionEffect') === -1) &&
           (!up || up.indexOf('playKingPromotionEffect') === -1);
})());

console.log('\n=== 3. MULTI-CAPTURE: РОВНО ОДИН РАЗ ===');

// moveCount инкрементируется на КАЖДОМ прыжке цепочки, а moveType
// становится "king" только на том прыжке, где движок выставил becameKing.
// Значит по совокупности двух условий эффект сработает один раз.
const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'shared', 'game-engine.js'), 'utf8');
check('3.1 движок выставляет moveType "king" из becameKing',
    /moveType = becameKing \? "king" : "move"/.test(ENGINE) &&
    /moveType = becameKing \? "king" : "capture"/.test(ENGINE));
check('3.2 becameKing выставляется и в ветке взятия',
    (ENGINE.match(/becameKing = true/g) || []).length === 4);
check('3.3 эффект зависит от moveType, поэтому не сработает на прыжках без превращения',
    !!effect && /moveType !== "king"/.test(effect));

console.log('\n=== 4. КОНФЛИКТ С .king transform !important ===');

// В .king стоит transform: scale(1.1) !important. По каскаду CSS
// !important приоритетнее анимации, а !important внутри @keyframes
// игнорируется. Поэтому анимировать transform у элемента с .king нельзя --
// наложение намеренно этот класс не несёт.
check('4.1 конфликтующее правило действительно существует',
    /\.king\s*\{[^}]*transform:\s*scale\(1\.1\)\s*!important/.test(CSS));
check('4.2 наложение НЕ получает класс king', (function () {
    if (!effect) return false;
    const m = /className = "piece " \+ colorClass \+ " king-promotion-flip"/.exec(effect);
    return !!m;
})());
check('4.3 наложение переиспользует существующие классы фигуры',
    !!effect && /"piece " \+ colorClass/.test(effect));

console.log('\n=== 5. CSS: ДЛИТЕЛЬНОСТЬ, СМЕНА ТЕКСТУРЫ, СВЕЧЕНИЕ ===');

check('5.1 keyframes переворота существуют', /@keyframes kingPromotionFlip/.test(CSS));
check('5.2 keyframes свечения существуют', /@keyframes kingPromotionGlow/.test(CSS));
// Длительность больше не пишется числом в CSS -- она приходит переменной,
// а значение живёт в KING_PROMOTION_DURATION_MS (диапазон см. 13.5d).
check('5.3 длительность задана переменной, а не числом',
    /animation: kingPromotionFlip var\(--king-promotion-duration/.test(CSS));
check('5.4 есть подъём (translateY) и поворот (rotateX)',
    /kingPromotionFlip[\s\S]*?translateY\(-\d+%\)/.test(CSS) &&
    /kingPromotionFlip[\s\S]*?rotateX\(\d+deg\)/.test(CSS));
// Смена текстуры больше не делается исчезновением наложения: это
// двусторонний переворот, сторона меняется при проходе через ребро
// (90 градусов). Проверяем, что момент реально наступает внутри
// анимации, а не в самом её конце.
check('5.5 смена стороны происходит в первой половине эффекта', (function () {
    const block = /@keyframes kingPromotionFlip \{[\s\S]*?\n\}/.exec(CSS);
    if (!block) return false;
    const kf = [...block[0].matchAll(/(\d+)%\s*\{[^}]*rotateX\((\d+)deg\)/g)]
        .map(function (m) { return [parseInt(m[1], 10), parseInt(m[2], 10)]; });
    for (let i = 1; i < kf.length; i++) {
        if (kf[i - 1][1] < 90 && kf[i][1] >= 90) {
            const x = (90 - kf[i - 1][1]) / (kf[i][1] - kf[i - 1][1]);
            const pct = kf[i - 1][0] + (kf[i][0] - kf[i - 1][0]) * x;
            return pct > 5 && pct < 50;
        }
    }
    return false;
})());
check('5.6 свечение отдельным слоем, не через filter настоящей фигуры',
    /\.king-promotion-glow\s*\{[\s\S]*?radial-gradient/.test(CSS));
check('5.7 ни одно наложение не перехватывает клики', (function () {
    const base = baseOverlayRule();
    return !!base && /pointer-events: none/.test(base[0]);
})());

console.log('\n=== 6. PREFERS-REDUCED-MOTION ===');

check('6.1 блок reduced-motion покрывает переворот', (function () {
    const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    return blocks.some(function (b) { return /\.king-promotion-flip/.test(b) && /animation: none/.test(b); });
})());
check('6.2 блок reduced-motion покрывает свечение', (function () {
    const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    return blocks.some(function (b) { return /\.king-promotion-glow/.test(b) && /animation: none/.test(b); });
})());
check('6.3 при reduced-motion наложение не показывается вовсе', (function () {
    const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    return blocks.some(function (b) { return /\.king-promotion-flip[\s\S]*?opacity: 0/.test(b); });
})());

console.log('\n=== 7. УБОРКА ЗА СОБОЙ ===');

if (effect) {
    check('7.1 элементы удаляются по animationend',
        /addEventListener\("animationend", cleanup\)/.test(effect));
    check('7.2 есть страховка по таймауту, если animationend не придёт',
        /setTimeout\(cleanup/.test(effect));
    check('7.3 cleanup идемпотентен (защита от двойного удаления)',
        /if \(done\) return;/.test(effect));
    check('7.4 эффект отменяется вместе с остальными ghost-анимациями',
        /activeGhostCancelFns\.push\(cleanup\)/.test(effect));
}

console.log('\n=== 8. НИЧЕГО ЛИШНЕГО НЕ ЗАТРОНУТО ===');

const AUDIO = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-effects.js'), 'utf8');
check('8.1 playKingCaptureSound не тронут (это НЕ превращение со взятием)',
    /function playKingCaptureSound\(\) \{\s*\n\s*playWoodKnock\(0\.18, 0\.6, 600\);/.test(AUDIO));
// Диспетчер получил третий параметр -- задержку запуска звука
// превращения. Проверяем ИНВАРИАНТ: тип "king" по-прежнему уходит именно
// в playKingSound, а не куда-то ещё.
check('8.2 диспетчер по-прежнему направляет "king" в playKingSound',
    /if \(type === "king"\) \{\s*\n\s*playKingSound\(/.test(AUDIO));
check('8.3 мёртвый CSS короны пока не удалён (вне scope этого PR)',
    /\.king::before \{\s*\n\s*display: none !important;/.test(CSS));
check('8.4 эффект не трогает currentState и не пишет в Firebase',
    !!effect && !/currentState\.\w+\s*=/.test(effect) && !/database\./.test(effect));

console.log('\n=== 9. CACHE-BUST ===');

check('9.1 script.js поднят (>= 213)', (function () {
    const m = /script\.js\?v=(\d+)/.exec(HTML);
    return !!m && parseInt(m[1], 10) >= 213;
})());
check('9.2 style.css поднят (>= 22)', (function () {
    const m = /style\.css\?v=(\d+)/.exec(HTML);
    return !!m && parseInt(m[1], 10) >= 22;
})());
check('9.3 shared/audio-effects.js поднят (>= 2)', (function () {
    const m = /shared\/audio-effects\.js\?v=(\d+)/.exec(HTML);
    return !!m && parseInt(m[1], 10) >= 2;
})());

console.log('\n=== 10. ПОВЕДЕНИЕ: КАКОЙ moveType ЗАПУСКАЕТ ЭФФЕКТ ===');
{
    // Здесь функция реально ИСПОЛНЯЕТСЯ против подставных состояний, а не
    // проверяется регуляркой: только так видно, что обычный ход, взятие и
    // ход уже готовой дамки эффект НЕ запускают.
    let created = [];
    const fakeSquare = {
        appendChild: function (el) { created.push(el.className); }
    };
    global.squareElements = { "0_1": fakeSquare, "7_2": fakeSquare };
    // Настоящая фигура на клетке: эффект прячет её на время превращения.
    const realClasses = new Set();
    const fakeReal = { classList: { add: function (c) { realClasses.add(c); },
                                    remove: function (c) { realClasses.delete(c); } } };
    global.pieceElements = { "0_1": fakeReal, "7_2": fakeReal };
    global._realClasses = realClasses;
    global.document = {
        createElement: function () {
            return {
                className: "",
                parentNode: null,
                addEventListener: function () {},
                classList: { add: function () {}, remove: function () {} }
            };
        }
    };
    global.activeGhostCancelFns = [];
    global.isBotGame = false; // человек против человека -- визуал включён
    const savedTimeout = global.setTimeout;
    global.setTimeout = function () { return 0; };

    // Константу длительности берём ИЗ ИСХОДНИКА, а не хардкодим: если её
    // значение изменят, тест продолжит проверять реальное поведение.
    const durMatch = /const KING_PROMOTION_DURATION_MS = (\d+);/.exec(CLEAN);
    global.KING_PROMOTION_DURATION_MS = durMatch ? parseInt(durMatch[1], 10) : 340;
    const ghostMatch = /const MOVE_GHOST_DURATION_MS = (\d+);/.exec(CLEAN);
    global.MOVE_GHOST_DURATION_MS = ghostMatch ? parseInt(ghostMatch[1], 10) : 150;
    // Наложение теперь выставляет CSS-переменную, поэтому стабу нужен style.
    const savedCreate = global.document.createElement;
    global.document.createElement = function () {
        return {
            className: "", parentNode: null,
            style: { setProperty: function () {} },
            addEventListener: function () {},
            classList: { add: function () {}, remove: function () {} }
        };
    };

    // eslint-disable-next-line no-eval
    eval(funcBody(CLEAN, 'playKingPromotionEffect'));

    function run(state) {
        created = [];
        global.activeGhostCancelFns = [];
        global.isBotGame = false; // человек против человека -- визуал включён
        global.currentState = state;
        playKingPromotionEffect();
        return created.length;
    }
    const at = { to: { row: 0, col: 1 } };
    const pieces = { "0_1": { color: "light", king: true } };

    check('10.1 обычный ход (moveType "move") НЕ запускает эффект',
        run({ moveType: "move", lastMove: at, pieces: pieces }) === 0);
    check('10.2 взятие без превращения (moveType "capture") НЕ запускает',
        run({ moveType: "capture", lastMove: at, pieces: pieces }) === 0);
    check('10.3 ход уже готовой дамки НЕ запускает (moveType всё равно "move")',
        run({ moveType: "move", lastMove: at, pieces: pieces }) === 0);
    check('10.4 превращение (moveType "king") запускает ровно один раз',
        run({ moveType: "king", lastMove: at, pieces: pieces }) === 4,
        'создано элементов: glow + две обычные стороны + дамка');
    check('10.5 превращение ЧЕРЕЗ ВЗЯТИЕ тоже даёт "king" и запускает один раз',
        run({ moveType: "king", lastMove: { to: { row: 7, col: 2 } }, pieces: { "7_2": { color: "dark", king: true } } }) === 4);
    check('10.6 нет lastMove -> тишина',
        run({ moveType: "king", lastMove: null, pieces: pieces }) === 0);
    check('10.7 клетки нет в DOM -> защитный выход без исключения',
        run({ moveType: "king", lastMove: { to: { row: 3, col: 3 } }, pieces: {} }) === 0);

    // Настоящая дамка обязана быть скрыта на время эффекта, иначе в
    // рёберных фазах она проглянет сквозь наложения раньше времени.
    (function () {
        global._realClasses.clear();
        global.activeGhostCancelFns = [];
        global.isBotGame = false; // человек против человека -- визуал включён
        global.currentState = { moveType: "king", lastMove: at, pieces: pieces };
        playKingPromotionEffect();
        check('10.8 настоящая дамка скрыта на время превращения',
            global._realClasses.has('piece-hidden-for-promotion'));
        if (global.activeGhostCancelFns.length) global.activeGhostCancelFns[0]();
        check('10.9 после уборки настоящая дамка снова видна',
            !global._realClasses.has('piece-hidden-for-promotion'));
    })();

    global.setTimeout = savedTimeout;
}

console.log('\n=== 11. ПУНКТ №1 НЕ ЗАДЕТ ===');
{
    const AUDIO2 = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-effects.js'), 'utf8');
    check('11.1 playVictorySound сохранён', /function playVictorySound\(\)/.test(AUDIO2));
    check('11.2 playDefeatSound сохранён', /function playDefeatSound\(\)/.test(AUDIO2));
    check('11.3 playDrawSound сохранён', /function playDrawSound\(\)/.test(AUDIO2));
    check('11.4 все три по-прежнему экспортированы',
        /playVictorySound,/.test(AUDIO2) && /playDefeatSound,/.test(AUDIO2) && /playDrawSound,/.test(AUDIO2));
    check('11.5 playEndGameOutcomeSound на месте и вызывается из финала',
        /function playEndGameOutcomeSound\(\)/.test(SRC) &&
        /if \(endGameShownForRoom !== marker\) \{[\s\S]{0,300}?playEndGameOutcomeSound\(\);/.test(SRC));
}

console.log('\n=== 12. ЗВУК ПРЕВРАЩЕНИЯ -- ЛОКАЛЬНЫЙ WAV ===');
{
    const AUDIO3 = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-effects.js'), 'utf8');
    const king = funcBody(AUDIO3, 'playKingSound');
    check('12.1 playKingSound найдена', !!king);

    // Владельцу не подошёл ни один синтезированный вариант, поэтому звук
    // теперь -- выбранный им файл. Проверяем, что играет именно он.
    check('12.2 путь к ассету объявлен', /KING_SOUND_URL = "assets\/king-promotion\.wav/.test(AUDIO3));
    check('12.3 файл существует в репозитории',
        fs.existsSync(path.join(__dirname, '..', 'assets', 'king-promotion.wav')));
    if (king) {
        check('12.4 воспроизводится буфер, а не осцилляторы',
            /createBufferSource\(\)/.test(king) && !/createOscillator\(/.test(king));
        check('12.5 синтезированного мотива в playKingSound не осталось',
            !/playTone\(/.test(king) && !/playWoodKnock\(/.test(king));
        check('12.6 используется тот же audioContext (unlock работает как прежде)',
            /audioContext\.createBufferSource/.test(king) && /audioContext\.destination/.test(king));
        check('12.7 при недекодированном буфере молчит, а не падает',
            /if \(!kingSoundBuffer\)/.test(king) && /return;/.test(king));
    }
    // Предзагрузка нужна, чтобы первый звук не опоздал.
    check('12.8 есть предзагрузка', /function preloadKingSound\(\)/.test(AUDIO3));
    check('12.9 предзагрузка запускается при загрузке модуля',
        /\n    preloadKingSound\(\);/.test(AUDIO3));
    check('12.10 предзагрузка не выполняется вне браузера (Node-тесты)',
        /typeof global\.document === "undefined"/.test(AUDIO3));
    check('12.11 ассет локальный, без сторонних сервисов',
        !/https?:\/\//.test(/KING_SOUND_URL = "[^"]*"/.exec(AUDIO3)[0]));

    // Остальные звуки не задеты.
    check('12.12 playKingCaptureSound не изменён',
        /function playKingCaptureSound\(\) \{\s*\n\s*playWoodKnock\(0\.18, 0\.6, 600\);/.test(AUDIO3));
    check('12.13 звуки исхода партии не изменены',
        /function playVictorySound\(\)/.test(AUDIO3) &&
        /function playDefeatSound\(\)/.test(AUDIO3) &&
        /function playDrawSound\(\)/.test(AUDIO3));
    check('12.14 звуки хода и взятия не изменены',
        /function playMoveSound\(\) \{ playWoodKnock\(0\.09, 0\.32, 1700\); \}/.test(AUDIO3));
}

console.log('\n=== 13. ЭФФЕКТ НЕ ОПЕРЕЖАЕТ ПОЛЁТ ШАШКИ ===');
{
    // Move-ghost вешается на ТУ ЖЕ конечную клетку и летит к ней от
    // исходной, а настоящая дамка на это время скрыта. Если наложение
    // показать сразу, первые MOVE_GHOST_DURATION_MS были бы видны ДВЕ
    // обычные шашки. Проверяем, что этого не происходит.
    const eff = funcBody(CLEAN, 'playKingPromotionEffect');
    check('13.1 функция найдена', !!eff);

    check('13.2 базовый opacity всех наложений = 0 (до старта невидимо)', (function () {
        const base = baseOverlayRule();
        return !!base && /opacity: 0;/.test(base[0]);
    })());

    check('13.3 задержка берётся из CSS-переменной, а не числом',
        /animation: kingPromotionFlip [^;]*var\(--king-promotion-delay/.test(CSS));
    check('13.4 свечение имеет ТУ ЖЕ задержку',
        /animation: kingPromotionGlow [^;]*var\(--king-promotion-delay/.test(CSS));
    check('13.4b длительность тоже переменной у обоих',
        /animation: kingPromotionFlip var\(--king-promotion-duration\)/.test(CSS) &&
        /animation: kingPromotionGlow var\(--king-promotion-duration\)/.test(CSS));
    // Запрет строгий: числа длительности в CSS быть не должно ВООБЩЕ --
    // ни в самой анимации, ни как запасное значение переменной. Иначе
    // рядом с KING_PROMOTION_DURATION_MS появляется второй источник истины.
    check('13.4c число длительности не дублируется в CSS нигде', (function () {
        const m = /const KING_PROMOTION_DURATION_MS = (\d+);/.exec(CLEAN);
        if (!m) return false;
        const promo = CSS.match(/animation: kingPromotion[\s\S]*?;/g) || [];
        const inAnim = promo.some(function (b) { return b.indexOf(m[1] + 'ms') !== -1; });
        const asFallback = CSS.indexOf('--king-promotion-duration,') !== -1;
        return !inAnim && !asFallback;
    })());
    // Длительность менялась по запросу владельца: 340 -> 680 -> 1500.
    // Точное значение закреплено в 17.1, здесь только разумные границы,
    // чтобы случайная правка не сделала эффект мгновенным или бесконечным.
    check('13.4d длительность в разумных границах', (function () {
        const m = /const KING_PROMOTION_DURATION_MS = (\d+);/.exec(CLEAN);
        if (!m) return false;
        const v = parseInt(m[1], 10);
        return v >= 300 && v <= 2000;
    })());
    check('13.4e MOVE_GHOST_DURATION_MS не менялся', (function () {
        const m = /const MOVE_GHOST_DURATION_MS = (\d+);/.exec(CLEAN);
        return !!m && parseInt(m[1], 10) === 150;
    })());
    check('13.4f длительность передаётся переменной всем четырём элементам', (function () {
        const eff2 = funcBody(CLEAN, 'playKingPromotionEffect');
        return !!eff2 && (eff2.match(/setProperty\("--king-promotion-duration"/g) || []).length === 4;
    })());
    check('13.5 promotion CSS не хардкодит 150ms задержку полёта', (function () {
        const start = CSS.indexOf('.king-promotion-flip,');
        const end = CSS.indexOf('@keyframes kingPromotionFlip', start);
        if (start === -1 || end === -1 || end <= start) return false;
        const promotionCss = CSS.slice(start, end);
        return !/150ms/.test(promotionCss) && /--king-promotion-delay/.test(promotionCss);
    })());

    if (eff) {
        check('13.6 задержка связана с MOVE_GHOST_DURATION_MS, а не с magic number',
            /const startDelayMs = MOVE_GHOST_DURATION_MS;/.test(eff));
        check('13.7 переменная задержки выставляется всем четырём элементам',
            (eff.match(/setProperty\("--king-promotion-delay"/g) || []).length === 4);
        check('13.8 fallback timeout учитывает И задержку, И длительность эффекта',
            /setTimeout\(cleanup, startDelayMs \+ KING_PROMOTION_DURATION_MS \+ \d+\)/.test(eff));
        check('13.9 cleanup удаляет себя из activeGhostCancelFns (симметрично соседям)',
            /activeGhostCancelFns = activeGhostCancelFns\.filter\(function \(fn\) \{ return fn !== cleanup; \}\)/.test(eff));
    }

    // Исполняем и смотрим на фактические значения, а не на текст.
    (function () {
        const props = {};
        const timeouts = [];
        const saved = { st: global.setTimeout, doc: global.document, sq: global.squareElements, fns: global.activeGhostCancelFns, cs: global.currentState };
        global.MOVE_GHOST_DURATION_MS = 150;
        global.KING_PROMOTION_DURATION_MS = 340;
        global.activeGhostCancelFns = [];
        global.isBotGame = false; // человек против человека -- визуал включён
        global.document = {
            createElement: function () {
                return {
                    className: '', parentNode: null,
                    style: { setProperty: function (k, v) { props[k] = v; } },
                    addEventListener: function () {}
                };
            }
        };
        global.squareElements = { '0_1': { appendChild: function () {} } };
        global.setTimeout = function (fn, ms) { timeouts.push(ms); return 0; };
        global.currentState = { moveType: 'king', lastMove: { to: { row: 0, col: 1 } }, pieces: { '0_1': { color: 'light', king: true } } };

        // eslint-disable-next-line no-eval
        eval(funcBody(CLEAN, 'playKingPromotionEffect'));
        playKingPromotionEffect();

        check('13.10 переменная задержки равна длительности полёта',
            props['--king-promotion-delay'] === global.MOVE_GHOST_DURATION_MS + 'ms',
            String(props['--king-promotion-delay']));
        check('13.11 fallback timeout не короче задержки + анимации',
            timeouts.length > 0 && timeouts[0] >= global.MOVE_GHOST_DURATION_MS + global.KING_PROMOTION_DURATION_MS,
            'timeout=' + timeouts[0] + ' нужно >= ' + (global.MOVE_GHOST_DURATION_MS + global.KING_PROMOTION_DURATION_MS));
        check('13.12 cleanup зарегистрирован ровно один раз',
            global.activeGhostCancelFns.length === 1);
        if (global.activeGhostCancelFns.length === 1) {
            global.activeGhostCancelFns[0]();
            check('13.13 после вызова cleanup сам себя удалил из списка',
                global.activeGhostCancelFns.length === 0);
        }

        global.setTimeout = saved.st; global.document = saved.doc;
        global.squareElements = saved.sq; global.activeGhostCancelFns = saved.fns;
        global.currentState = saved.cs;
    })();
}

console.log('\n=== 14. ДВУСТОРОННИЙ ПЕРЕВОРОТ НА 360 ГРАДУСОВ ===');
{
    function kfAngles(name) {
        const b = new RegExp('@keyframes ' + name + ' \\{[\\s\\S]*?\\n\\}').exec(CSS);
        if (!b) return null;
        return [...b[0].matchAll(/(\d+)%\s*\{[^}]*rotateX\((\d+)deg\)/g)]
            .map(function (m) { return [parseInt(m[1], 10), parseInt(m[2], 10)]; });
    }
    const man = kfAngles('kingPromotionFlip');
    const king = kfAngles('kingPromotionFlipKing');
    const back = kfAngles('kingPromotionFlipBack');

    check('14.1 keyframes обеих сторон существуют', !!man && !!king);
// Один полный оборот = ДВА прохода ребром, то есть два переворота.
    // Прежние 540 давали три.
    check('14.2 обычная сторона проходит ровно 360 градусов',
        !!man && man[0][1] === 0 && man[man.length - 1][1] === 360);
    check('14.2b это ровно два прохода ребром', (function () {
        if (!man) return false;
        let edges = 0;
        for (let i = 1; i < man.length; i++) {
            [90, 270].forEach(function (e) {
                if (man[i - 1][1] < e && man[i][1] >= e) edges++;
            });
        }
        return edges === 2;
    })());
    check('14.3 сторона дамки проходит те же 360',
        !!king && (king[king.length - 1][1] - king[0][1]) === 360);
    // Сдвиг ровно 180 на КАЖДОМ ключе -- иначе стороны разъедутся и
    // появится момент, когда видны обе или ни одной.
    // Вторая обычная сторона обязана быть ровно на 180 от первой -- иначе
    // между ними появится щель, в которой не видно ничего.
    check('14.4 вторая обычная сторона разнесена ровно на 180 градусов', (function () {
        if (!man || !back) return false;
        const byPct = {};
        man.forEach(function (m) { byPct[m[0]] = m[1]; });
        return back.every(function (b) {
            return byPct[b[0]] === undefined || b[1] - byPct[b[0]] === 180;
        });
    })());
// При целом обороте фигура заканчивает лицом в исходном положении,
    // поэтому дамка делит позицию с ПЕРВОЙ обычной стороной, а не со
    // второй -- иначе в конце была бы видна обычная текстура.
    check('14.4b дамка занимает ту же позицию, что ПЕРВАЯ обычная', (function () {
        if (!man || !king) return false;
        const byPct = {};
        man.forEach(function (m) { byPct[m[0]] = m[1]; });
        return king.every(function (k) { return byPct[k[0]] === undefined || byPct[k[0]] === k[1]; });
    })());
    // Монотонность: вращение не должно «отыгрывать назад».
    check('14.5 вращение монотонно, без отката', (function () {
        if (!man) return false;
        for (let i = 1; i < man.length; i++) if (man[i][1] < man[i - 1][1]) return false;
        return true;
    })());

    function kfTrack(name, prop) {
        const b = new RegExp('@keyframes ' + name + ' \\{[\\s\\S]*?\\n\\}').exec(CSS);
        if (!b) return null;
        const re = new RegExp('(\\d+)%\\s*\\{[^}]*' + prop + '\\(([-\\d.]+)%?\\)', 'g');
        return [...b[0].matchAll(re)].map(function (m) { return m[2]; }).join(',');
    }
    // Одна фигура, а не два элемента: подъём и масштаб должны совпадать.
    // Одна фигура, а не три элемента: у второй обычной и у дамки
    // траектории должны совпадать между собой.
    check('14.6 подъём одинаков у второй обычной и дамки',
        kfTrack('kingPromotionFlipBack', 'translateY') === kfTrack('kingPromotionFlipKing', 'translateY'));
    check('14.7 масштаб одинаков у второй обычной и дамки',
        kfTrack('kingPromotionFlipBack', 'scale') === kfTrack('kingPromotionFlipKing', 'scale'));

    check('14.8 backface скрыт у всех наложений -- иначе видны сразу несколько', (function () {
        const base = baseOverlayRule();
        return !!base && /backface-visibility: hidden/.test(base[0]);
    })());
    check('14.9 perspective задан локально в keyframes, а не на клетке',
        /@keyframes kingPromotionFlip \{[\s\S]*?perspective\(\d+px\)/.test(CSS) &&
        !/\.board-square[\s\S]{0,200}?perspective:/.test(CSS));

    // Сторона дамки обязана нести текстуру дамки и НЕ нести класс .king.
    check('14.10 у стороны дамки своя текстура', (function () {
        return /\.king-promotion-flip-king\.piece-dark \{[\s\S]*?king_dark\.png/.test(CSS) &&
               /\.king-promotion-flip-king\.piece-light \{[\s\S]*?king_light\.png/.test(CSS);
    })());
    check('14.11 ни одна сторона не получает класс .king (конфликт !important)', (function () {
        const eff2 = funcBody(CLEAN, 'playKingPromotionEffect');
        if (!eff2) return false;
        return /" king-promotion-flip"/.test(eff2) &&
               /" king-promotion-flip-king"/.test(eff2) &&
               !/piece " \+ colorClass \+ " king "/.test(eff2);
    })());
    check('14.12 финальный масштаб совпадает с настоящей дамкой (scale 1.1)',
        !!man && /100%\s*\{[^}]*scale\(1\.1\)/.test(
            /@keyframes kingPromotionFlipKing \{[\s\S]*?\n\}/.exec(CSS)[0]));

    // Обе стороны убираются вместе -- иначе одна останется на доске.
    check('14.13 обе стороны удаляются при уборке', (function () {
        const eff2 = funcBody(CLEAN, 'playKingPromotionEffect');
        return !!eff2 && /removeChild\(flip\)/.test(eff2) && /removeChild\(flipKing\)/.test(eff2);
    })());
    check('14.14 reduced-motion гасит ОБЕ стороны', (function () {
        const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
        return blocks.some(function (b) {
            return /\.king-promotion-flip,/.test(b) && /\.king-promotion-flip-king/.test(b) &&
                   /animation: none/.test(b) && /opacity: 0/.test(b);
        });
    })());
}

console.log('\n=== 15. ДАМКА ПОЯВЛЯЕТСЯ РОВНО ОДИН РАЗ ===');
{
    // Главная проверка этого раздела -- СИМУЛЯЦИЯ: по ключевым кадрам
    // восстанавливаем, что именно видит зритель на каждом проценте
    // анимации. Регулярка тут бессильна: прежняя схема из двух сторон
    // формально была корректной, но давала чередование
    // обычная -> дамка -> обычная -> дамка, потому что дамка становилась
    // лицевой уже на 90 градусах.
    function parseKf(name) {
        const b = new RegExp('@keyframes ' + name + ' \\{[\\s\\S]*?\\n\\}').exec(CSS);
        if (!b) return null;
        const out = [];
        const re = /([\d.]+)%\s*\{([^}]*)\}/g;
        let m;
        while ((m = re.exec(b[0])) !== null) {
            const pct = parseFloat(m[1]);
            const rot = /rotateX\(([-\d.]+)deg\)/.exec(m[2]);
            const op = /opacity:\s*([\d.]+)/.exec(m[2]);
            // КЛЮЧЕВОЕ: если opacity в кадре НЕ указана, свойство сохраняет
            // БАЗОВОЕ значение из общего селектора, а там стоит opacity: 0.
            // Прежняя версия этого теста подставляла здесь единицу и
            // поэтому не заметила, что первая обычная сторона невидима всю
            // анимацию. Базовое значение читаем из самого CSS, а не
            // предполагаем.
            out.push({ pct: pct, rot: rot ? parseFloat(rot[1]) : null, op: op ? parseFloat(op[1]) : baseOpacity() });
        }
        return out.sort(function (a, b2) { return a.pct - b2.pct; });
    }
    function at(kf, pct, field) {
        for (let i = 1; i < kf.length; i++) {
            if (pct <= kf[i].pct) {
                const a = kf[i - 1], b2 = kf[i];
                if (field === 'op') return pct < b2.pct ? a.op : b2.op;
                const x = (pct - a.pct) / (b2.pct - a.pct || 1);
                return a.rot + (b2.rot - a.rot) * x;
            }
        }
        return field === 'op' ? kf[kf.length - 1].op : kf[kf.length - 1].rot;
    }
    function facing(angle) {
        const m = ((angle % 360) + 360) % 360;
        return m < 90 || m > 270;
    }

    const man = parseKf('kingPromotionFlip');
    const back = parseKf('kingPromotionFlipBack');
    const king = parseKf('kingPromotionFlipKing');
    check('15.1 все три набора keyframes найдены', !!man && !!back && !!king);

    if (man && back && king) {
        // Что видно на каждом проценте: backface скрывает обратную
        // сторону, opacity гасит элемент целиком.
        const timeline = [];
        for (let p = 0; p <= 100; p += 0.5) {
            const manOn = facing(at(man, p, 'rot')) && at(man, p, 'op') > 0;
            const backOn = facing(at(back, p, 'rot')) && at(back, p, 'op') > 0;
            const kingOn = facing(at(king, p, 'rot')) && at(king, p, 'op') > 0;
            timeline.push({ p: p, ordinary: manOn || backOn, king: kingOn });
        }

        // Дамка включается один раз и не выключается.
        let kingSwitches = 0;
        for (let i = 1; i < timeline.length; i++) {
            if (timeline[i].king !== timeline[i - 1].king) kingSwitches++;
        }
        check('15.2 дамка становится видимой РОВНО ОДИН РАЗ', kingSwitches === 1,
            'переключений: ' + kingSwitches);

        const firstKing = timeline.findIndex(function (f) { return f.king; });
        check('15.3 дамка появляется, а не отсутствует вовсе', firstKing !== -1);
        check('15.4 после появления дамка больше не пропадает',
            firstKing !== -1 && timeline.slice(firstKing).every(function (f) { return f.king; }));

        // Обычная текстура не возвращается после превращения.
        check('15.5 после появления дамки обычная сторона НЕ возвращается',
            firstKing !== -1 && timeline.slice(firstKing).every(function (f) { return !f.ordinary; }));

        // До превращения обычная видна непрерывно -- вращение читается.
        // Допускаются только мгновения, когда обе стороны стоят ровно
        // ребром -- они физически невидимы и в кадре не читаются.
        check('15.6 до превращения обычная сторона видна практически непрерывно', (function () {
            if (firstKing === -1) return false;
            const gaps = timeline.slice(0, firstKing).filter(function (f) { return !f.ordinary; });
            return gaps.length <= 3;
        })(), firstKing !== -1 ? 'пропусков: ' + timeline.slice(0, firstKing).filter(function (f) { return !f.ordinary; }).length : '?');

        // Ни одного кадра, где видно и то и другое.
        check('15.7 обычная и дамка никогда не видны одновременно',
            timeline.every(function (f) { return !(f.ordinary && f.king); }));

        // Ни одного кадра пустоты (кроме рёберных моментов подмены).
        const blanks = timeline.filter(function (f) { return !f.ordinary && !f.king; });
        check('15.8 провалов в пустоту практически нет (только ребро)',
            blanks.length <= 3, 'пустых кадров: ' + blanks.length);

        // Превращение происходит в финальной части, а не в начале.
        check('15.9 дамка появляется в финальной части эффекта',
            firstKing !== -1 && timeline[firstKing].p >= 60,
            'на ' + (firstKing !== -1 ? timeline[firstKing].p : '?') + '%');

        // Итоговая текстура -- дамка.
        check('15.10 в конце видна именно дамка',
            timeline[timeline.length - 1].king && !timeline[timeline.length - 1].ordinary);

        // Вращение до превращения должно быть заметным.
        check('15.11 до превращения фигура успевает пройти два переворота',
            at(man, timeline[firstKing].p, 'rot') >= 270,
            String(Math.round(at(man, timeline[firstKing].p, 'rot'))) + '°');

        // Точная заказанная последовательность по УГЛУ поворота, а не по
        // проценту: 0-90 A, 90-270 B, 270-450 A, после 450 только дамка.
        function whoAt(angle) {
            // находим процент, соответствующий этому углу
            let p = null;
            for (let q = 0; q <= 100; q += 0.25) {
                if (at(man, q, 'rot') >= angle) { p = q; break; }
            }
            if (p === null) p = 100;
            const manOn = facing(at(man, p, 'rot')) && at(man, p, 'op') > 0;
            const backOn = facing(at(back, p, 'rot')) && at(back, p, 'op') > 0;
            const kingOn = facing(at(king, p, 'rot')) && at(king, p, 'op') > 0;
            if (kingOn) return 'king';
            if (manOn) return 'A';
            if (backOn) return 'B';
            return 'none';
        }
        check('15.16 на 45 градусах видна первая обычная сторона', whoAt(45) === 'A', whoAt(45));
        check('15.17 на 180 градусах видна вторая обычная сторона', whoAt(180) === 'B', whoAt(180));
        check('15.18 на 260 градусах ещё обычная (до подмены)', whoAt(260) === 'B', whoAt(260));
        check('15.19 на 320 градусах видна ТОЛЬКО дамка', whoAt(320) === 'king', whoAt(320));
        check('15.20 в самом конце оборота видна дамка', whoAt(359) === 'king', whoAt(359));
    }

    // Подмена обязана происходить на ребре, иначе она заметна.
// Подмена идёт между ПЕРВОЙ обычной стороной и дамкой -- они делят
    // позицию.
    check('15.12 обычная гаснет и дамка зажигается в один и тот же момент', (function () {
        const manKf = parseKf('kingPromotionFlip');
        if (!manKf || !king) return false;
        const off = manKf.find(function (k) { return k.op === 0; });
        const on = king.find(function (k) { return k.op === 1; });
        return !!off && !!on && off.pct === on.pct;
    })());
    check('15.13 подмена происходит, когда сторона стоит ребром', (function () {
        const manKf = parseKf('kingPromotionFlip');
        if (!manKf) return false;
        const off = manKf.find(function (k) { return k.op === 0; });
        if (!off) return false;
        const m = ((off.rot % 360) + 360) % 360;
        return Math.abs(m - 90) < 12 || Math.abs(m - 270) < 12;
    })());

    check('15.14 третье наложение создаётся и убирается', (function () {
        const eff2 = funcBody(CLEAN, 'playKingPromotionEffect');
        return !!eff2 && /king-promotion-flip-back/.test(eff2) &&
               /removeChild\(flipBack\)/.test(eff2);
    })());
    check('15.15 reduced-motion гасит все три наложения', (function () {
        const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
        return blocks.some(function (b) {
            return /\.king-promotion-flip,/.test(b) && /\.king-promotion-flip-back,/.test(b) &&
                   /\.king-promotion-flip-king/.test(b) && /animation: none/.test(b);
        });
    })());
}

console.log('\n=== 16. REDUCED-MOTION: ДАМКА ПОЯВЛЯЕТСЯ СРАЗУ ===');
{
    // При выключенных анимациях animationend не приходит, и уборка
    // срабатывает только по страховочному таймауту (~950 мс). Всё это
    // время настоящая дамка не должна оставаться скрытой, иначе игрок
    // почти секунду видит пустую клетку.
    const rmBlocks = CSS.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    const rm = rmBlocks.find(function (b) { return /king-promotion-flip/.test(b); });

    check('16.1 блок reduced-motion найден', !!rm);
    check('16.2 reduced-motion гасит ВСЕ три наложения',
        !!rm && /\.king-promotion-flip,/.test(rm) && /\.king-promotion-flip-back,/.test(rm) &&
        /\.king-promotion-flip-king/.test(rm) && /animation: none/.test(rm));
    check('16.3 reduced-motion НЕ скрывает настоящую дамку',
        !!rm && /\.piece-hidden-for-promotion[^{]*\{[^}]*opacity:\s*1/.test(rm));

    // Защита от двойной шашки: во время полёта оба класса висят вместе,
    // и переопределение не должно перебивать сокрытие на время полёта.
    check('16.4 переопределение не действует, пока шашка летит', (function () {
        if (!rm) return false;
        const m = /(\.piece-hidden-for-promotion[^{]*)\{[^}]*opacity:\s*1/.exec(rm);
        return !!m && /:not\(\.piece-hidden-for-ghost\)/.test(m[1]);
    })());

    // Каскад: считаем специфичность и порядок, а не надеемся на них.
    check('16.5 переопределение реально выигрывает каскад после полёта', (function () {
        if (!rm) return false;
        // Базовое правило сокрытия -- одиночный класс, (0,1,0).
        const base = /\.piece-hidden-for-promotion \{[^}]*opacity:\s*0\s*!important/.test(CSS);
        // Переопределение -- два класса, (0,2,0), и тоже !important.
        const over = /\.piece-hidden-for-promotion:not\(\.piece-hidden-for-ghost\) \{[^}]*opacity:\s*1\s*!important/.test(rm);
        return base && over;
    })());
    check('16.6 оба правила помечены !important (иначе одно из них не сработает)', (function () {
        if (!rm) return false;
        const over = /:not\(\.piece-hidden-for-ghost\) \{[^}]*opacity:\s*1\s*!important/.test(rm);
        const hide = /\.piece-hidden-for-promotion \{[^}]*opacity:\s*0\s*!important/.test(CSS);
        return over && hide;
    })());

    // Обычный режим не задет: сокрытие остаётся.
    check('16.7 в обычном режиме настоящая дамка по-прежнему скрыта', (function () {
        const outside = CSS.slice(0, CSS.indexOf('@media (prefers-reduced-motion'));
        return /\.piece-hidden-for-promotion \{[^}]*opacity:\s*0\s*!important/.test(outside);
    })());
    check('16.8 звук при reduced-motion не отключается', (function () {
        // В блоке reduced-motion не должно быть ничего про звук.
        return !!rm && !/audio|sound|king-promotion\.wav/i.test(rm);
    })());
}

console.log('\n=== 17. СИНХРОНИЗАЦИЯ ЗВУКА С ПОЯВЛЕНИЕМ ДАМКИ ===');
{
    function constOf(name) {
        const m = new RegExp('const ' + name + ' = ([\\d.]+)').exec(CLEAN);
        return m ? parseFloat(m[1]) : null;
    }
    const ghost = constOf('MOVE_GHOST_DURATION_MS');
    const dur = constOf('KING_PROMOTION_DURATION_MS');
    const frac = constOf('KING_PROMOTION_REVEAL_FRACTION');
    const off = constOf('KING_SOUND_RESOLVE_OFFSET_MS');
    // Объявлена многострочным выражением, поэтому вычисляем её так же,
    // как это делает сам код, из тех же констант.
    const delay = (ghost !== null && dur !== null && frac !== null && off !== null)
        ? Math.max(0, Math.round(ghost + dur * frac - off))
        : null;

    // 1000 мс при 360 градусах -- это сохранение ТЕМПА, а не ускорение:
    // 1500 * 360 / 540 = 1000, то есть один переворот занимает те же
    // ~500 мс, что и раньше.
    check('17.1 длительность превращения = 1000 мс', dur === 1000, String(dur));
    check('17.1b темп на один переворот сохранён (~500 мс)', (function () {
        const perFlip = dur / 2;          // 360 градусов = два переворота
        const before = 1500 / 3;          // 540 градусов = три переворота
        return Math.abs(perFlip - before) < 1;
    })(), String(dur / 2) + ' мс');
    check('17.2 длительность полёта не менялась', ghost === 150, String(ghost));

    // Доля должна совпадать с кадром в CSS -- иначе звук уедет молча.
    check('17.3 доля появления дамки совпадает с кадром в CSS', (function () {
        const b = /@keyframes kingPromotionFlipKing \{[\s\S]*?\n\}/.exec(CSS);
        if (!b || frac === null) return false;
        const m = /([\d.]+)%\s*\{[^}]*opacity:\s*1/.exec(b[0]);
        return !!m && Math.abs(parseFloat(m[1]) / 100 - frac) < 0.001;
    })(), 'CSS vs константа');

    // Позиция последней ноты проверяется ПО САМОМУ ФАЙЛУ, а не на слово.
    check('17.4 смещение разрешающей ноты совпадает с реальным WAV', (function () {
        const wav = fs.readFileSync(path.join(__dirname, '..', 'assets', 'king-promotion.wav'));
        // Минимальный разбор PCM WAV: ищем чанки fmt и data.
        let pos = 12, rate = 0, bits = 0, ch = 1, dataOff = 0, dataLen = 0;
        while (pos + 8 <= wav.length) {
            const id = wav.toString('ascii', pos, pos + 4);
            const size = wav.readUInt32LE(pos + 4);
            if (id === 'fmt ') {
                ch = wav.readUInt16LE(pos + 10);
                rate = wav.readUInt32LE(pos + 12);
                bits = wav.readUInt16LE(pos + 22);
            } else if (id === 'data') { dataOff = pos + 8; dataLen = size; break; }
            pos += 8 + size + (size % 2);
        }
        if (!rate || bits !== 16 || !dataLen) return false;
        const n = Math.floor(dataLen / 2 / ch);
        const env = new Float64Array(n);
        for (let i = 0; i < n; i++) env[i] = Math.abs(wav.readInt16LE(dataOff + i * 2 * ch)) / 32767;
        // сглаживание и поиск атак
        const win = Math.floor(rate * 0.004);
        const sm = new Float64Array(n);
        let acc = 0;
        for (let i = 0; i < n; i++) {
            acc += env[i];
            if (i >= win) acc -= env[i - win];
            sm[i] = acc / Math.min(i + 1, win);
        }
        let peak = 0;
        for (let i = 0; i < n; i++) if (sm[i] > peak) peak = sm[i];
        const thr = peak * 0.25;
        const onsets = [];
        const gap = Math.floor(rate * 0.09);
        for (let i = 0; i < n; i++) {
            if (sm[i] > thr && (onsets.length === 0 || i - onsets[onsets.length - 1] > gap)) onsets.push(i);
        }
        if (onsets.length < 4) return false;
        const lastMs = onsets[3] / rate * 1000;
        return Math.abs(lastMs - off) <= 30;
    })(), 'константа ' + off + ' мс');

    // Задержка обязана вычисляться, а не быть вписанной числом.
    check('17.5 задержка выводится из констант, а не захардкожена',
        /KING_PROMOTION_SOUND_DELAY_MS = Math\.max\(0, Math\.round\([\s\S]*?MOVE_GHOST_DURATION_MS[\s\S]*?KING_PROMOTION_DURATION_MS \* KING_PROMOTION_REVEAL_FRACTION[\s\S]*?KING_SOUND_RESOLVE_OFFSET_MS/.test(CLEAN));

    const reveal = ghost !== null && dur !== null && frac !== null ? Math.round(ghost + dur * frac) : null;
    check('17.6 дамка появляется на 875 мс от начала хода', reveal === 875, String(reveal));
    // 150 + 1000*0.725 - 420 = 455. Значение НЕ вписано в код: формула
    // пересчитала его сама после смены длительности.
    check('17.7 задержка звука = 455 мс', delay === 455, String(delay));
    check('17.7b число 455 в коде не захардкожено', !/\b455\b/.test(CLEAN));
    check('17.8 разрешающая нота попадает ТОЧНО в момент появления дамки',
        delay !== null && off !== null && (delay + off) === reveal,
        (delay + off) + ' vs ' + reveal);

    // Планирование только через Web Audio.
    check('17.9 задержка реализована планировщиком Web Audio, без setTimeout', (function () {
        const AUDIO = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-effects.js'), 'utf8');
        const b = funcBody(AUDIO, 'playKingSound');
        return !!b && /source\.start\(audioContext\.currentTime \+/.test(b) && !/setTimeout/.test(b);
    })());
    // Задержка теперь приходит функцией: она различает обычный режим и
    // reduced-motion. Проверяем, что она проброшена во все точки.
    check('17.10 задержка проброшена во все точки вызова',
        (CLEAN.match(/playSoundForMoveType\([^)]*kingPromotionSoundDelayMs\(\)\)/g) || []).length === 4);
    check('17.11 сам WAV не изменён и не растянут', (function () {
        const AUDIO = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-effects.js'), 'utf8');
        const b = funcBody(AUDIO, 'playKingSound');
        return !!b && !/playbackRate|detune/.test(b);
    })());
}

console.log('\n=== 18. ОТМЕНА ЗАПЛАНИРОВАННОГО ЗВУКА ПРЕВРАЩЕНИЯ ===');
{
    // Отложенная подача создала возможность, которой раньше не было:
    // к моменту воспроизведения партия может закончиться или игрок уйти с
    // доски. Здесь модуль реально ИСПОЛНЯЕТСЯ на фейковом Web Audio, а не
    // проверяется регуляркой -- гонку ссылок иначе не поймать.
    const started = [];
    const stopped = [];
    let now = 0;
    function makeSource() {
        const src = {
            buffer: null, onended: null, _started: false,
            connect: function () {},
            start: function (t) { src._started = true; started.push(t); },
            stop: function () {
                if (!src._started) throw new Error('InvalidStateError');
                stopped.push(src);
                if (typeof src.onended === 'function') src.onended();
            }
        };
        return src;
    }
    const fakeCtx = {
        state: 'running',
        get currentTime() { return now; },
        sampleRate: 44100,
        destination: {},
        createBufferSource: makeSource,
        createGain: function () { return { connect: function () {}, gain: { setValueAtTime: function () {} } }; },
        createBuffer: function () { return { getChannelData: function () { return new Float32Array(4); } }; },
        createBiquadFilter: function () { return { connect: function () {}, frequency: {}, Q: {} }; },
        createOscillator: function () { return { connect: function () {}, frequency: {}, start: function () {}, stop: function () {} }; }
    };
    const savedAC = global.AudioContext;
    const savedDoc = global.document;
    global.AudioContext = function () { return fakeCtx; };
    delete global.document; // чтобы preload не пытался fetch'ить
    delete require.cache[require.resolve('../shared/audio-effects.js')];
    const audio = require('../shared/audio-effects.js');
    global.AudioContext = savedAC;
    if (savedDoc) global.document = savedDoc;

    check('18.1 cancelKingSound экспортирована', typeof audio.cancelKingSound === 'function');

    // Буфер в Node не декодируется, поэтому подменяем внутреннее
    // состояние через тот же путь, что использует продакшен: играем
    // только если буфер есть. Здесь буфера нет -> звук не стартует,
    // и это само по себе проверяемое поведение.
    check('18.2 без декодированного буфера звук не планируется', (function () {
        started.length = 0;
        audio.playKingSound(818);
        return started.length === 0;
    })());

    // Дальше проверяем саму МЕХАНИКУ отмены на исходнике: поведение
    // с буфером в Node воспроизвести нельзя, но инварианты ссылки видны
    // в коде и должны быть именно такими.
    const AUDIO = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-effects.js'), 'utf8');
    const cancelBody = funcBody(AUDIO, 'cancelKingSound');
    const playBody = funcBody(AUDIO, 'playKingSound');

    check('18.3 ссылка обнуляется ДО stop (иначе onended затрёт новое состояние)', (function () {
        if (!cancelBody) return false;
        const nulled = cancelBody.indexOf('scheduledKingSource = null;');
        const stop = cancelBody.indexOf('source.stop()');
        return nulled !== -1 && stop !== -1 && nulled < stop;
    })());
    check('18.4 stop обёрнут в try/catch (узел мог уже завершиться)',
        !!cancelBody && /try \{ source\.stop\(\); \} catch/.test(cancelBody));
    check('18.5 отмена берёт локальную копию ссылки',
        !!cancelBody && /const source = scheduledKingSource;/.test(cancelBody));

    check('18.6 старый onended НЕ обнуляет ссылку на новый source',
        !!playBody && /if \(scheduledKingSource === source\) scheduledKingSource = null;/.test(playBody));
    check('18.7 новый вызов отменяет предыдущий ожидающий мотив', (function () {
        if (!playBody) return false;
        const cancel = playBody.indexOf('cancelKingSound()');
        const create = playBody.indexOf('createBufferSource()');
        return cancel !== -1 && create !== -1 && cancel < create;
    })());
    check('18.8 ссылка сохраняется до start, чтобы её можно было отменить', (function () {
        if (!playBody) return false;
        const save = playBody.indexOf('scheduledKingSource = source;');
        const start = playBody.indexOf('source.start(');
        return save !== -1 && start !== -1 && save < start;
    })());

    // Точки подключения.
    check('18.9 исход партии отменяет превращение ПЕРВЫМ действием', (function () {
        const b = funcBody(CLEAN, 'playEndGameOutcomeSound');
        if (!b) return false;
        const cancel = b.indexOf('cancelKingSound()');
        const firstLogic = b.indexOf('if (!currentState');
        return cancel !== -1 && firstLogic !== -1 && cancel < firstLogic;
    })());
    check('18.10 уход с игрового экрана отменяет звук', (function () {
        const b = funcBody(CLEAN, 'showScreen');
        return !!b && /if \(screen !== gameScreen\) cancelKingSound\(\);/.test(b);
    })());
    check('18.11 переход НА игровой экран звук НЕ отменяет', (function () {
        const b = funcBody(CLEAN, 'showScreen');
        // Отмена обязана быть под условием, а не безусловной.
        return !!b && !/^\s*cancelKingSound\(\);/m.test(b);
    })());
    // Отмена не должна висеть на уборке эффекта: при multi-capture
    // следующий прыжок отменяет ghost-анимации, а звук обязан прозвучать.
    check('18.12 уборка эффекта превращения звук НЕ отменяет', (function () {
        const b = funcBody(CLEAN, 'playKingPromotionEffect');
        return !!b && b.indexOf('cancelKingSound') === -1;
    })());
    check('18.13 для отмены не используется setTimeout',
        !!cancelBody && !/setTimeout/.test(cancelBody) && !!playBody && !/setTimeout/.test(playBody));

    // --- Сценарии ИСПОЛНЕНИЕМ, а не по тексту -------------------------
    (function () {
        let cancels = 0;
        let outcome = [];
        const saved = {};
        ['cancelKingSound', 'playVictorySound', 'playDefeatSound', 'playDrawSound',
         'hideStartupCover', 'hideScreenImmediately', 'startScreenInputGuard', 'getAppScreens',
         'currentState', 'isSpectator', 'myTelegramId', 'myColor',
         'menuScreen', 'timeControlScreen', 'waitingScreen', 'gameScreen', 'document'
        ].forEach(function (k) { saved[k] = global[k]; });

        global.cancelKingSound = function () { cancels++; };
        global.playVictorySound = function () { outcome.push('victory'); };
        global.playDefeatSound = function () { outcome.push('defeat'); };
        global.playDrawSound = function () { outcome.push('draw'); };
        global.hideStartupCover = function () {};
        global.startScreenInputGuard = function () {};
        function el() {
            return {
                classList: { add: function () {}, remove: function () {} },
                removeAttribute: function () {}
            };
        }
        global.menuScreen = el(); global.timeControlScreen = el();
        global.waitingScreen = el(); global.gameScreen = el();
        global.hideScreenImmediately = function (screen) {
            screen.classList.add('hidden');
        };
        global.getAppScreens = function () {
            return [global.menuScreen, global.timeControlScreen, global.waitingScreen, global.gameScreen];
        };
        global.document = { getElementById: function () { return el(); } };

        // eslint-disable-next-line no-eval
        eval(funcBody(CLEAN, 'showScreen'));
        // eslint-disable-next-line no-eval
        eval(funcBody(CLEAN, 'playEndGameOutcomeSound'));

        // Победный ход с превращением: мотив отменён, исход звучит.
        cancels = 0; outcome = [];
        global.isSpectator = false; global.myTelegramId = 'tg_1001'; global.myColor = 'light';
        global.currentState = { winner: 'light', moveType: 'king',
            players: { light: { id: 'tg_1001' }, dark: { id: 'tg_1002' } } };
        playEndGameOutcomeSound();
        check('18.14 победа с превращением: мотив отменён', cancels === 1, 'отмен: ' + cancels);
        check('18.15 победа с превращением: звук исхода остаётся',
            outcome.join(',') === 'victory', outcome.join(',') || '(тишина)');

        // Поражение -- то же самое.
        cancels = 0; outcome = [];
        global.currentState = { winner: 'dark', moveType: 'king',
            players: { light: { id: 'tg_1001' }, dark: { id: 'tg_1002' } } };
        playEndGameOutcomeSound();
        check('18.16 поражение с превращением: мотив отменён, исход звучит',
            cancels === 1 && outcome.join(',') === 'defeat');

        // Уход с доски отменяет.
        cancels = 0;
        showScreen(global.menuScreen);
        check('18.17 уход в меню отменяет мотив', cancels === 1, 'отмен: ' + cancels);
        cancels = 0;
        showScreen(global.waitingScreen);
        check('18.18 переход на экран ожидания отменяет мотив', cancels === 1);

        // Переход НА доску не отменяет -- там звук должен прозвучать.
        cancels = 0;
        showScreen(global.gameScreen);
        check('18.19 переход на игровой экран НЕ отменяет мотив', cancels === 0, 'отмен: ' + cancels);

        // Обычное превращение без финала: отмены не происходит вовсе.
        cancels = 0; outcome = [];
        global.currentState = { winner: null, moveType: 'king', players: {} };
        playEndGameOutcomeSound();
        check('18.20 превращение без финала: исход молчит',
            outcome.length === 0, outcome.join(','));

        Object.keys(saved).forEach(function (k) {
            if (saved[k] === undefined) delete global[k]; else global[k] = saved[k];
        });
    })();
}

console.log('\n=== 19. ЗАДЕРЖКА ЗВУКА ПРИ REDUCED-MOTION ===');
{
    // При выключенном движении наложения не показываются, и настоящая
    // дамка открывается сразу после полёта. Длинная задержка, рассчитанная
    // под полуторную секунду вращения, привела бы мотив почти на 700 мс
    // позже уже видимой дамки.
    const fn = funcBody(CLEAN, 'kingPromotionSoundDelayMs');
    check('19.1 функция задержки существует', !!fn);
    check('19.2 задержка вычисляется при каждом вызове, а не кэшируется',
        !!fn && /window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)/.test(fn));

    if (fn) {
        const saved = global.window;
        const constM = /const KING_PROMOTION_SOUND_DELAY_MS = Math\.max\(0, Math\.round\(([\s\S]*?)\)\);/.exec(CLEAN);
        check('19.3 базовая константа по-прежнему выводится из таймингов', !!constM);

        const ghost = parseFloat(/const MOVE_GHOST_DURATION_MS = ([\d.]+)/.exec(CLEAN)[1]);
        const dur = parseFloat(/const KING_PROMOTION_DURATION_MS = ([\d.]+)/.exec(CLEAN)[1]);
        const frac = parseFloat(/const KING_PROMOTION_REVEAL_FRACTION = ([\d.]+)/.exec(CLEAN)[1]);
        const off = parseFloat(/const KING_SOUND_RESOLVE_OFFSET_MS = ([\d.]+)/.exec(CLEAN)[1]);
        global.KING_PROMOTION_SOUND_DELAY_MS = Math.max(0, Math.round(ghost + dur * frac - off));

        // eslint-disable-next-line no-eval
        eval(fn);

        global.window = { matchMedia: function () { return { matches: false }; } };
        const normal = kingPromotionSoundDelayMs();
        global.window = { matchMedia: function () { return { matches: true }; } };
        const reduced = kingPromotionSoundDelayMs();
        global.window = {};
        const noMM = kingPromotionSoundDelayMs();
        global.window = saved;

        check('19.4 обычный режим -> 455 мс', normal === 455, String(normal));
        check('19.5 reduced-motion -> длинной задержки нет', reduced === 0, String(reduced));
        check('19.6 без matchMedia остаётся обычное поведение', noMM === 455, String(noMM));
        check('19.7 режимы действительно различаются', normal !== reduced);
    }

    // Все точки вызова обязаны спрашивать функцию, а не константу.
    check('19.8 все четыре вызова используют функцию, а не константу напрямую',
        (CLEAN.match(/playSoundForMoveType\([^)]*kingPromotionSoundDelayMs\(\)\)/g) || []).length === 4);
    check('19.9 константа больше не передаётся в звук напрямую',
        !/playSoundForMoveType\([^)]*KING_PROMOTION_SOUND_DELAY_MS\)/.test(CLEAN));

    // Отмена и приоритет исхода не задеты этой правкой.
    check('19.10 cancelKingSound по-прежнему подключена к обеим точкам',
        /if \(screen !== gameScreen\) cancelKingSound\(\);/.test(CLEAN) &&
        (function () {
            const b = funcBody(CLEAN, 'playEndGameOutcomeSound');
            return !!b && b.indexOf('cancelKingSound()') !== -1;
        })());
    check('19.11 для выбора задержки не используется setTimeout',
        !!fn && !/setTimeout/.test(fn));
    check('19.12 длительность 1000 мс и поворот 360 градусов',
        /const KING_PROMOTION_DURATION_MS = 1000;/.test(CLEAN) && /rotateX\(360deg\)/.test(CSS));
    // 540deg в CSS остаётся законно: это финальный угол ВТОРОЙ обычной
    // стороны, смещённой на 180 (180 + 360 = 540). Смотрим только на
    // первую сторону и на дамку -- они обязаны заканчиваться на 360.
    check('19.12b первая сторона и дамка заканчиваются на 360', (function () {
        const man = /@keyframes kingPromotionFlip \{[\s\S]*?\n\}/.exec(CSS);
        const king = /@keyframes kingPromotionFlipKing \{[\s\S]*?\n\}/.exec(CSS);
        return !!man && !!king &&
            /100%[^}]*rotateX\(360deg\)/.test(man[0]) &&
            /100%[^}]*rotateX\(360deg\)/.test(king[0]);
    })());

    // Устаревший комментарий про «вдвое медленнее» должен быть исправлен.
    check('19.13 комментарий о длительности не утверждает неверное',
        !/вдвое медленнее прежних 340/.test(SRC));
}

console.log('\n=== 20. ПОДЪЁМ НЕ ВЫХОДИТ ЗА ГРАНИЦЫ КЛЕТКИ ===');
{
    // Наложение -- 82% клетки (та же переменная, что у .piece), поэтому
    // свободное поле вокруг него внутри .square -- (100%-82%)/2 = 9%
    // высоты клетки. Раньше пик анимации (40%) поднимал наложение на
    // translateY(-28%) собственной высоты и одновременно расширял его
    // scale(1.17) -- суммарно верхний край уходил примерно на 30% высоты
    // клетки выше её границы. При 340-680 мс это пролетало быстро и было
    // незаметно; на нынешних 1000 мс держится ~400 мс и читается как
    // "фигура вылетает из клетки вверх".
    //
    // Тест не проверяет конкретные числа -- он проверяет ИНВАРИАНТ:
    // на любом кадре суммарный верхний выход (подъём в долях СОБСТВЕННОЙ
    // высоты наложения + половина прироста от scale, оба переведены в
    // доли высоты клетки через коэффициент 0.82) не должен превышать
    // свободное поле в 9%. Значит правка future-owner может подбирать
    // числа заново, а тест продолжит проверять реальный смысл, а не
    // конкретные -7%/scale(1.05).
    const PIECE_OF_CELL = 0.82;
    const CELL_MARGIN = (1 - PIECE_OF_CELL) / 2; // 9%

    function parseLiftScale(name) {
        const b = new RegExp('@keyframes ' + name + ' \\{[\\s\\S]*?\\n\\}').exec(CSS);
        if (!b) return null;
        const re = /([\d.]+)%\s*\{[^}]*translateY\((-?[\d.]+)%\)[^}]*scale\(([\d.]+)\)/g;
        const out = [];
        let m;
        while ((m = re.exec(b[0])) !== null) {
            out.push({ pct: parseFloat(m[1]), liftY: Math.abs(parseFloat(m[2])) / 100, scale: parseFloat(m[3]) });
        }
        return out;
    }

    ['kingPromotionFlip', 'kingPromotionFlipBack', 'kingPromotionFlipKing'].forEach(function (name) {
        const frames = parseLiftScale(name);
        check('20.1 ' + name + ': keyframes с translateY/scale найдены', !!frames && frames.length > 0);
        if (!frames) return;

        let maxExcursion = 0, worstFrame = null;
        frames.forEach(function (f) {
            const liftInCell = f.liftY * PIECE_OF_CELL;
            const scaleExtra = Math.max(0, (f.scale - 1) / 2) * PIECE_OF_CELL;
            const total = liftInCell + scaleExtra;
            if (total > maxExcursion) { maxExcursion = total; worstFrame = f.pct; }
        });
        check('20.2 ' + name + ': ни один кадр не выходит за свободное поле клетки (' +
            (CELL_MARGIN * 100).toFixed(0) + '%)',
            maxExcursion <= CELL_MARGIN + 0.001,
            'худший кадр ' + worstFrame + '% -> ' + (maxExcursion * 100).toFixed(1) + '% (лимит ' + (CELL_MARGIN * 100).toFixed(0) + '%)');
    });

    // Финальный кадр (100%) обязан остаться ЯКОРЕМ -- ровно тем же
    // translateY(0)/scale(1.1), что и раньше. Его нельзя было трогать при
    // уменьшении подъёма: не совпади он с отдыхающей .king { scale(1.1) },
    // в момент снятия наложения появился бы заметный скачок позиции.
    ['kingPromotionFlip', 'kingPromotionFlipBack', 'kingPromotionFlipKing'].forEach(function (name) {
        const b = new RegExp('@keyframes ' + name + ' \\{[\\s\\S]*?\\n\\}').exec(CSS);
        check('20.3 ' + name + ': финальный кадр остался якорем translateY(0) scale(1.1)',
            !!b && /100%\s*\{[^}]*translateY\(0\)[^}]*scale\(1\.1\)/.test(b[0]));
    });

    // Сама механика переворота (углы, момент смены стороны, длительность,
    // задержка, звук) этим PR не затрагивается -- меняется только высота
    // подъёма и масштаб.
    check('20.4 длительность и задержка не менялись',
        /const KING_PROMOTION_DURATION_MS = 1000;/.test(CLEAN) &&
        /const MOVE_GHOST_DURATION_MS = 150;/.test(CLEAN));
    check('20.5 угол поворота (360°) не менялся', /rotateX\(360deg\)/.test(CSS));
    check('20.6 момент смены стороны (72% / 72.5%) не менялся',
        /72%[^}]*rotateX\(270deg\)/.test(CSS) && /72\.5%[^}]*opacity: 0/.test(CSS));
}


console.log('\n=== 21. ОПТИЧЕСКАЯ ЦЕНТРОВКА ФИШЕК ===');
{
    // После выравнивания самой доски реальные Telegram-скриншоты всё ещё
    // показывали маленький систематический оптический сдвиг видимого диска
    // влево. DOM-box .piece при этом уже был математически центрирован.
    // Коррекция делается individual transform property "translate", а не
    // обычным transform: так она не перетирает .king scale, selected pulse,
    // move-ghost transform и promotion keyframes.
    const pieceRule = /\.piece\s*\{([\s\S]*?)\n\}/.exec(CSS);
    check('21.1 базовый .piece имеет оптическую коррекцию +0.5px вправо',
        !!pieceRule && /translate:\s*0\.5px\s+0\s*;/.test(pieceRule[1]));

    // Вертикальную координату намеренно не трогаем: пользовательский дефект
    // по X воспроизводится на desktop/mobile, а отдельный вертикальный баг
    // promotion исправлен траекторией keyframes в разделе 20.
    check('21.2 коррекция не добавляет вертикального сдвига',
        !!pieceRule && !/translate:\s*0\.5px\s+(?!0(?:\s|;))/.test(pieceRule[1]));

    // Все временные визуальные слои обязаны носить тот же базовый .piece,
    // иначе при начале/окончании хода возник бы полупиксельный скачок.
    check('21.3 move ghost использует базовый .piece',
        /ghost\.className\s*=\s*"piece "/.test(SRC));
    check('21.4 captured ghost сохраняет базовый .piece во внутреннем слое',
        /capturedPiece\.className\s*=\s*"piece "/.test(SRC));
    check('21.5 все три promotion-overlay используют базовый .piece',
        /flip\.className\s*=\s*"piece "/.test(SRC) &&
        /flipBack\.className\s*=\s*"piece "/.test(SRC) &&
        /flipKing\.className\s*=\s*"piece "/.test(SRC));

    // Статичные фигуры создаются тем же классом, значит обычная шашка и
    // дамка получают ту же коррекцию без отдельных offsets.
    check('21.6 статичная фигура создаётся с классом .piece',
        /piece\.classList\.add\("piece",/.test(SRC));
}

console.log('\n=== 22. CAPTURE EFFECT (#4) ===');
{
    const durationMatch = /const CAPTURE_EFFECT_DURATION_MS = (\d+);/.exec(CLEAN);
    const duration = durationMatch ? Number(durationMatch[1]) : 0;
    const moveGhost = funcBody(CLEAN, 'playMoveGhostAnimation') || '';
    const snapshots = funcBody(CLEAN, 'captureCapturedPieceSnapshotsBeforeUpdate') || '';

    check('22.1 длительность эффекта в диапазоне 100–180 мс',
        duration >= 100 && duration <= 180, 'duration=' + duration);

    check('22.2 старый 90ms fade-констант удалён',
        !/CAPTURE_FADE_DURATION_MS/.test(CLEAN));

    check('22.3 captured ghost по-прежнему строится только из snapshot',
        /capturedGhost\.className\s*=\s*"move-ghost-captured"/.test(moveGhost) &&
        /capturedPiece\.className\s*=\s*"piece "/.test(moveGhost) &&
        /capturedSnapshots/.test(moveGhost));

    check('22.4 snapshot по-прежнему только для capture + lastCapturedSquares',
        /moveType !== "capture"/.test(snapshots) &&
        /lastCapturedSquares/.test(snapshots));

    check('22.5 reduced-motion не создаёт новый capture motion',
        /!prefersReducedScreenMotion\(\)\s*&&\s*Array\.isArray\(capturedSnapshots\)/.test(moveGhost));

    check('22.6 CSS использует отдельный capturedGhostImpact = 180ms',
        /animation:\s*capturedGhostImpact var\(--capture-effect-duration, 180ms\)/.test(CSS) &&
        /@keyframes capturedGhostImpact\s*\{/.test(CSS));

    check('22.7 impact теперь заметнее и попадает в момент пересечения',
        /28%\s*\{[^}]*opacity:\s*1;[^}]*transform:\s*scale\(1\.12\) rotate\(-1\.5deg\)/.test(CSS));

    check('22.8 финал = fade + shrink + micro-rotation',
        /100%\s*\{[^}]*opacity:\s*0;[^}]*transform:\s*scale\(0\.48\) rotate\(5deg\)/.test(CSS));

    check('22.9 king-safe: transform живёт на wrapper, king-текстура на inner .piece',
        /capturedGhost\.className\s*=\s*"move-ghost-captured"/.test(moveGhost) &&
        /capturedPiece\.className\s*=\s*"piece "/.test(moveGhost) &&
        /\.move-ghost-captured-piece\s*\{[^}]*animation:\s*none\s*!important/.test(CSS));

    check('22.10 animationend фильтруется по target + имени',
        /event\.target !== capturedGhost/.test(moveGhost) &&
        /event\.animationName !== "capturedGhostImpact"/.test(moveGhost));

    check('22.11 fallback cleanup привязан к той же duration-константе',
        /setTimeout\(cleanupCapturedGhost, CAPTURE_EFFECT_DURATION_MS \+ 60\)/.test(moveGhost));

    check('22.12 декоративный ghost aria-hidden',
        /capturedGhost\.setAttribute\("aria-hidden", "true"\)/.test(moveGhost));

    check('22.13 reduced-motion CSS скрывает capture ghost защитно',
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.move-ghost-captured\s*\{[^}]*display:\s*none\s*!important/.test(CSS));

    check('22.14 captured ghost выше летящей шашки только визуальным z-index',
        /\.move-ghost-piece\s*\{[\s\S]*?z-index:\s*5;/.test(CSS) &&
        /\.move-ghost-captured\s*\{[\s\S]*?z-index:\s*6;/.test(CSS));

    check('22.15 есть отдельное impact-ring без нового DOM',
        /\.move-ghost-captured::after\s*\{/.test(CSS) &&
        /animation:\s*capturedGhostImpactRing/.test(CSS) &&
        /@keyframes capturedGhostImpactRing\s*\{/.test(CSS));

    check('22.16 cache-bust обновлён',
        Number((/style\.css\?v=(\d+)/.exec(HTML) || [])[1]) >= 51 &&
        Number((/script\.js\?v=(\d+)/.exec(HTML) || [])[1]) >= 235);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

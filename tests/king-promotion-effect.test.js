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
    /kingPromotionFlip[\s\S]*?rotateX\(90deg\)/.test(CSS));
check('5.5 текстура меняется В СЕРЕДИНЕ: наложение исчезает около 50%', (function () {
    const block = /@keyframes kingPromotionFlip \{[\s\S]*?\n\}/.exec(CSS);
    if (!block) return false;
    const m = /(\d+)%\s*\{[^}]*opacity: 0;/.exec(block[0]);
    if (!m) return false;
    const pct = parseInt(m[1], 10);
    return pct >= 45 && pct <= 60;
})());
check('5.6 свечение отдельным слоем, не через filter настоящей фигуры',
    /\.king-promotion-glow\s*\{[\s\S]*?radial-gradient/.test(CSS));
check('5.7 наложение не перехватывает клики',
    /\.king-promotion-flip\s*\{[\s\S]*?pointer-events: none/.test(CSS));

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
check('8.2 диспетчер звуков не изменён',
    /if \(type === "king"\) \{\s*\n\s*playKingSound\(\);/.test(AUDIO));
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
        run({ moveType: "king", lastMove: at, pieces: pieces }) === 2,
        'создано элементов: overlay + glow');
    check('10.5 превращение ЧЕРЕЗ ВЗЯТИЕ тоже даёт "king" и запускает один раз',
        run({ moveType: "king", lastMove: { to: { row: 7, col: 2 } }, pieces: { "7_2": { color: "dark", king: true } } }) === 2);
    check('10.6 нет lastMove -> тишина',
        run({ moveType: "king", lastMove: null, pieces: pieces }) === 0);
    check('10.7 клетки нет в DOM -> защитный выход без исключения',
        run({ moveType: "king", lastMove: { to: { row: 3, col: 3 } }, pieces: {} }) === 0);

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

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

// ==========================================================================
// T-1 (v182): ДВА ПРАВИЛА ДВИЖКА, КОТОРЫЕ РАНЬШЕ НЕ БЫЛИ ПОКРЫТЫ
//
// Обнаружено мутационным тестированием: обе мутации ниже проходили мимо
// всей сюиты незамеченными, хотя сам движок реализован верно.
//
//   1. простая шашка не может сделать ОБЫЧНЫЙ ход назад
//      (мутация: убрать проверку направления);
//   2. турецкий удар — уже побитая в этой серии фигура остаётся на доске
//      блокатором и не может быть перепрыгнута или побита повторно
//      (мутация: withPendingBlockers(pieces, pendingRemovals) -> pieces).
//
// Production-код НЕ меняется: проверяются настоящие функции script.js.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}
function grab(n) {
    const m = new RegExp('^function ' + n + '[\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}
// Собираем исходники ОДНОЙ строкой и вычисляем на верхнем уровне модуля,
// иначе объявления остались бы в области видимости колбэка.
eval(['pieceAt', 'canMoveNormally', 'canCaptureAt', 'getCaptureJumps', 'withPendingBlockers',
 'filterJumpsByMajorityRule', 'hasMandatoryCapture', 'hasAnyLegalMove', 'countPiecesOfColor',
 'checkWinCondition', 'getDrawPositionKey', 'attemptMove', 'getLegalDestinations']
    .map(grab).join('\n'));

// доска из схемы: '.' пусто, l/d простая, L/D дамка
function board(rows) {
    const p = {};
    rows.forEach(function (r, ri) {
        r.replace(/\s/g, '').split('').forEach(function (ch, ci) {
            if (ch === '.') return;
            p[ri + '_' + ci] = { color: (ch === 'l' || ch === 'L') ? 'light' : 'dark', king: (ch === 'L' || ch === 'D') };
        });
    });
    return p;
}
function state(pieces, turn, extra) {
    return Object.assign({
        pieces: pieces, turn: turn, mustContinueFrom: null,
        capturedDark: 0, capturedLight: 0, moveCount: 0,
        lastMovePath: null, lastCapturedSquares: null, pendingRemovals: []
    }, extra || {});
}

console.log('=== T-1.A. ПРОСТАЯ ШАШКА НЕ ХОДИТ НАЗАД ===');

// light идёт вверх (уменьшение row), dark — вниз
const bL = board(['........','........','........','........','...l....','........','........','........']);
check('A.1 light: обычный ход вперёд влево разрешён',  attemptMove(state(bL, 'light'), 4, 3, 3, 2, 'light') !== null);
check('A.2 light: обычный ход вперёд вправо разрешён', attemptMove(state(bL, 'light'), 4, 3, 3, 4, 'light') !== null);
check('A.3 light: обычный ход НАЗАД влево ЗАПРЕЩЁН',   attemptMove(state(bL, 'light'), 4, 3, 5, 2, 'light') === null);
check('A.4 light: обычный ход НАЗАД вправо ЗАПРЕЩЁН',  attemptMove(state(bL, 'light'), 4, 3, 5, 4, 'light') === null);

const bD = board(['........','........','........','........','...d....','........','........','........']);
check('A.5 dark: обычный ход вперёд влево разрешён',  attemptMove(state(bD, 'dark'), 4, 3, 5, 2, 'dark') !== null);
check('A.6 dark: обычный ход вперёд вправо разрешён', attemptMove(state(bD, 'dark'), 4, 3, 5, 4, 'dark') !== null);
check('A.7 dark: обычный ход НАЗАД влево ЗАПРЕЩЁН',   attemptMove(state(bD, 'dark'), 4, 3, 3, 2, 'dark') === null);
check('A.8 dark: обычный ход НАЗАД вправо ЗАПРЕЩЁН',  attemptMove(state(bD, 'dark'), 4, 3, 3, 4, 'dark') === null);

// дамка ходит в обе стороны — граница правила
const bK = board(['........','........','........','........','...L....','........','........','........']);
check('A.9 дамка ходит назад свободно', attemptMove(state(bK, 'light'), 4, 3, 5, 2, 'light') !== null);

// взятие назад простой шашкой — разрешено (правило русских шашек), не путать с A.3
const bBack = board(['........','........','........','........','..l.....','...d....','........','........']);
check('A.10 простая БЬЁТ назад (это разрешено)', attemptMove(state(bBack, 'light'), 4, 2, 6, 4, 'light') !== null);

// подсказки UI согласованы с движком
const hints = getLegalDestinations(bL, 4, 3, 'light', false, []);
check('A.11 UI не подсвечивает ходы назад',
    hints.every(function (h) { return h.row < 4; }),
    JSON.stringify(hints));

console.log('\n=== T-1.B. ТУРЕЦКИЙ УДАР: ПОБИТАЯ ОСТАЁТСЯ БЛОКАТОРОМ ===');

// дамка на 0_1; жертвы на 1_2 и 3_4; после первого удара дамка на 2_3
const bT = board([
    '.L......',
    '..d.d...',
    '........',
    '..d.d...',
    '........',
    '........',
    '........',
    '........']);
const s1 = attemptMove(state(bT, 'light'), 0, 1, 2, 3, 'light');
check('B.1 первый удар серии выполнен', s1 !== null);
check('B.2 побитая помещена в pendingRemovals, а не удалена сразу',
    s1 && s1.pendingRemovals.length === 1 && !s1.pieces['1_2']);
check('B.3 серия продолжается', s1 && s1.mustContinueFrom !== null && s1.turn === 'light');

if (s1) {
    const s2 = state(s1.pieces, 'light', {
        mustContinueFrom: s1.mustContinueFrom, pendingRemovals: s1.pendingRemovals,
        lastMovePath: s1.lastMovePath, lastCapturedSquares: s1.lastCapturedSquares,
        capturedDark: s1.capturedDark, moveCount: s1.moveCount
    });
    check('B.4 НЕЛЬЗЯ перепрыгнуть уже побитую 1_2 обратно на 0_1',
        attemptMove(s2, 2, 3, 0, 1, 'light') === null);
    check('B.5 подсказки UI тоже не предлагают прыжок через побитую',
        getLegalDestinations(s1.pieces, 2, 3, 'light', true, s1.pendingRemovals)
            .every(function (h) { return !(h.row === 0 && h.col === 1); }));
    check('B.6 блокатор виден в withPendingBlockers',
        !!withPendingBlockers(s1.pieces, s1.pendingRemovals)['1_2']);
    check('B.7 в самих pieces побитой уже нет', !s1.pieces['1_2']);

    // законное продолжение в другую сторону по-прежнему возможно
    const cont = attemptMove(s2, 2, 3, 4, 5, 'light');
    check('B.8 законное продолжение серии не сломано', cont !== null);
    check('B.9 обе жертвы сняты в конце серии',
        cont && !cont.pieces['1_2'] && !cont.pieces['3_4'] && cont.capturedDark === 2);
    check('B.10 pendingRemovals очищен по завершении серии',
        cont && cont.pendingRemovals.length === 0);
}

// простая шашка: та же защита
const bTs = board([
    '........',
    '..d.d...',
    '.l......',
    '........',
    '........',
    '........',
    '........',
    '........']);
const p1 = attemptMove(state(bTs, 'light'), 2, 1, 0, 3, 'light');
check('B.11 простая: первый удар серии выполнен', p1 !== null);
if (p1) {
    const p2 = state(p1.pieces, 'light', {
        mustContinueFrom: p1.mustContinueFrom, pendingRemovals: p1.pendingRemovals,
        lastMovePath: p1.lastMovePath, lastCapturedSquares: p1.lastCapturedSquares,
        capturedDark: p1.capturedDark, moveCount: p1.moveCount
    });
    check('B.12 простая: побитая осталась блокатором',
        p1.pendingRemovals.length === 1 && !!withPendingBlockers(p1.pieces, p1.pendingRemovals)['1_2']);
    check('B.13 простая: обратный прыжок через побитую запрещён',
        attemptMove(p2, 0, 3, 2, 1, 'light') === null);
}

// --- Ключевая позиция: блокатор должен ЗАКРЫВАТЬ дальнобойный путь дамке.
// Найдена специально: здесь снятие withPendingBlockers в attemptMove
// МЕНЯЕТ исход, поэтому именно эта проверка ловит регрессию.
// Дамка на 2_5 бьёт 3_4 и встаёт на 4_3. Побитая 3_4 остаётся блокатором
// на той же диагонали. Продолжение 4_3 -> 0_7 пролетело бы ЧЕРЕЗ неё и
// побило 1_6 — это турецкий удар и он обязан быть запрещён.
// При этом законное продолжение вниз (4_3 -> 6_1 через 5_2) обязано работать.
const bBlock = board([
    '........',
    '......d.',
    '.....L..',
    '....d...',
    '........',
    '..d.....',
    '........',
    '........']);
const k1 = attemptMove(state(bBlock, 'light'), 2, 5, 4, 3, 'light');
check('B.14 дальнобойный удар дамки выполнен', k1 !== null);
if (k1) {
    check('B.15 побитая 3_4 попала в pendingRemovals',
        k1.pendingRemovals.length === 1 && k1.pendingRemovals[0] === '3_4',
        JSON.stringify(k1.pendingRemovals));
    check('B.16 серия продолжается', k1.mustContinueFrom !== null && k1.turn === 'light');
    const k2 = state(k1.pieces, 'light', {
        mustContinueFrom: k1.mustContinueFrom, pendingRemovals: k1.pendingRemovals,
        lastMovePath: k1.lastMovePath, lastCapturedSquares: k1.lastCapturedSquares,
        capturedDark: k1.capturedDark, moveCount: k1.moveCount
    });
    check('B.17 дамка НЕ может пролететь СКВОЗЬ уже побитую 3_4 и побить 1_6',
        attemptMove(k2, 4, 3, 0, 7, 'light') === null,
        'блокатор не сработал — турецкий удар разрешён');
    check('B.18 UI тоже не предлагает пролёт сквозь блокатор',
        getLegalDestinations(k1.pieces, 4, 3, 'light', true, k1.pendingRemovals)
            .every(function (h) { return !(h.row === 0 && h.col === 7); }));
    check('B.19 законное продолжение в другую сторону работает',
        attemptMove(k2, 4, 3, 6, 1, 'light') !== null);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

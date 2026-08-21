// Базовые правила РУССКИХ шашек (шашки-64).
// Проверяет движок правил напрямую, без DOM и без Firebase.
const path = require('path');
const { extractFunc } = require('./helpers/loader');

[
  'canMoveNormally', 'hasAnyLegalMove', 'withPendingBlockers', 'canCaptureAt',
  'filterJumpsByMajorityRule', 'getCaptureJumps', 'createInitialPieces', 'pieceAt',
  'countPiecesOfColor', 'getLegalDestinations', 'hasMandatoryCapture',
  'getAllLegalMovesForBot', 'isCaptureMove', 'attemptMove', 'checkWinCondition'
].forEach(function (n) { try { eval(extractFunc(n)); global[n] = eval(n); } catch (e) {} });

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

// [row, col, isKing]
function bd(L, D) {
  const p = {};
  (L || []).forEach(x => { p[x[0] + '_' + x[1]] = { color: 'light', king: !!x[2] }; });
  (D || []).forEach(x => { p[x[0] + '_' + x[1]] = { color: 'dark', king: !!x[2] }; });
  return p;
}
function st(pieces, turn) {
  return {
    pieces: pieces, turn: turn || 'light', mustContinueFrom: null, pendingRemovals: [],
    capturedDark: 0, capturedLight: 0, moveCount: 0, winner: null, winReason: null, players: {}
  };
}
const has = (list, r, c) => list.some(d => d.row === r && d.col === c);

console.log('E. БАЗОВЫЕ ПРАВИЛА РУССКИХ ШАШЕК');

// --- E1. Обязательное взятие ---
{
  // light (4,3) может побить dark (3,2) с посадкой (2,1); light (6,1) свободен
  const p = bd([[4, 3], [6, 1]], [[3, 2]]);
  check('E1. hasMandatoryCapture видит обязательное взятие',
    hasMandatoryCapture(p, 'light') === true);
  // Глобальную обязательность взятия обеспечивает attemptMove:
  // тихий ход другой шашкой должен быть ОТКЛОНЁН.
  const quiet = attemptMove(st(p, 'light'), 6, 1, 5, 0, 'light');
  check('E1. тихий ход при доступном взятии ОТКЛОНЁН', quiet === null, 'результат: ' + (quiet ? 'принят' : 'null'));
  const capMoves = getLegalDestinations(p, 4, 3, 'light', false, []);
  check('E1. бьющая фигура имеет вариант взятия на (2,1)', has(capMoves, 2, 1), JSON.stringify(capMoves));
}

// --- E2. Простая бьёт НАЗАД (специфика русских шашек) ---
{
  // light ходит к row 0, значит (5,4) находится ПОЗАДИ light-шашки (4,3)
  const p = bd([[4, 3]], [[5, 4]]);
  const dest = getLegalDestinations(p, 4, 3, 'light', false, []);
  check('E2. простая шашка бьёт назад', has(dest, 6, 5), JSON.stringify(dest));
}

// --- E3. Дамка ходит на любое расстояние ---
{
  const p = bd([[7, 0, 1]], [[0, 1]]); // dark вне диагонали дамки, взятия нет
  const dest = getLegalDestinations(p, 7, 0, 'light', true, []);
  check('E3. дамка достаёт дальний конец диагонали (0,7)', has(dest, 0, 7), JSON.stringify(dest));
  check('E3. дамке доступны все 7 клеток диагонали', dest.length === 7, 'клеток: ' + dest.length);
}

// --- E4. Многоходовое взятие ---
{
  const p = bd([[5, 2]], [[4, 3], [2, 5]]);
  const r = attemptMove(st(p, 'light'), 5, 2, 3, 4, 'light');
  check('E4. первый прыжок цепочки принят', !!r);
  check('E4. цепочка не завершена — выставлен mustContinueFrom',
    !!(r && r.mustContinueFrom && r.mustContinueFrom.row === 3 && r.mustContinueFrom.col === 4),
    JSON.stringify(r && r.mustContinueFrom));
  check('E4. ход НЕ передан сопернику посреди цепочки', r && r.turn === 'light', r && r.turn);
}

// --- E5. Турецкий удар: срубленные снимаются только в конце цепочки ---
{
  const p = bd([[5, 2]], [[4, 3], [2, 5]]);
  const r = attemptMove(st(p, 'light'), 5, 2, 3, 4, 'light');
  check('E5. срубленная фигура помечена в pendingRemovals, а не снята сразу',
    !!(r && r.pendingRemovals && r.pendingRemovals.length === 1),
    JSON.stringify(r && r.pendingRemovals));
  // Турецкий удар реализован через блокирующие метки: срубленная клетка
  // остаётся ЗАНЯТОЙ для сканирования, поэтому её нельзя перепрыгнуть дважды.
  const blocked = withPendingBlockers(r.pieces, r.pendingRemovals);
  check('E5. срубленная клетка заблокирована (нельзя перепрыгнуть дважды)',
    !!blocked['4_3'] && blocked['4_3'].color === 'blocked', JSON.stringify(blocked['4_3']));
}

// --- E6. Продолжение боя после превращения — уже дамкой ---
{
  // light (2,1) бьёт (1,2) -> садится на (0,3) = дамочное поле,
  // и оттуда как ДАМКА может продолжить бой через (1,4) на (2,5)
  const p = bd([[2, 1]], [[1, 2], [1, 4]]);
  const r = attemptMove(st(p, 'light'), 2, 1, 0, 3, 'light');
  check('E6. взятие с выходом на дамочное поле принято', !!r);
  check('E6. шашка стала дамкой', !!(r && r.pieces['0_3'] && r.pieces['0_3'].king));
  check('E6. бой продолжается после превращения',
    !!(r && r.mustContinueFrom && r.mustContinueFrom.row === 0 && r.mustContinueFrom.col === 3),
    JSON.stringify(r && r.mustContinueFrom));
}

// --- E7. НЕТ правила большинства (отличие от международных шашек) ---
{
  // (5,2): вариант A бьёт 1 шашку, вариант B бьёт 2. Оба должны быть разрешены.
  const p = bd([[5, 2]], [[4, 1], [4, 3], [2, 5]]);
  const dest = getLegalDestinations(p, 5, 2, 'light', false, []);
  check('E7. доступен короткий вариант взятия (цепочка из 1)', has(dest, 3, 0), JSON.stringify(dest));
  check('E7. доступен длинный вариант взятия (цепочка из 2)', has(dest, 3, 4), JSON.stringify(dest));
  check('E7. filterJumpsByMajorityRule не отсекает варианты', dest.length >= 2, 'вариантов: ' + dest.length);
  // Главная проверка: игрок ВПРАВЕ выбрать КОРОТКУЮ цепочку, хотя есть длиннее.
  // Именно это отличает русские шашки от международных.
  const shortChain = attemptMove(st(p, 'light'), 5, 2, 3, 0, 'light');
  check('E7. короткая цепочка ПРИНЯТА, хотя доступна длиннее', !!shortChain);
  check('E7. после короткой цепочки ход переходит сопернику (принуждения продолжать нет)',
    !!(shortChain && shortChain.mustContinueFrom === null && shortChain.turn === 'dark'),
    JSON.stringify(shortChain && { mc: shortChain.mustContinueFrom, turn: shortChain.turn }));
}

// --- E8. Начальная расстановка соответствует русским шашкам ---
{
  const p = createInitialPieces();
  const light = Object.keys(p).filter(k => p[k].color === 'light');
  const dark = Object.keys(p).filter(k => p[k].color === 'dark');
  check('E8. по 12 шашек у каждой стороны', light.length === 12 && dark.length === 12,
    'light=' + light.length + ' dark=' + dark.length);
  check('E8. все шашки на тёмных клетках (row+col нечётно)',
    Object.keys(p).every(k => (Number(k.split('_')[0]) + Number(k.split('_')[1])) % 2 !== 0));
  check('E8. дамок в начальной позиции нет', Object.keys(p).every(k => !p[k].king));
}

module.exports = { passed: () => passed, failed: () => failed };

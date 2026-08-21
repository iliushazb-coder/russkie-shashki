const fs = require('fs');
const scriptCode = fs.readFileSync(process.env.TARGET_SCRIPT || require('path').join(__dirname,'..','script.js'), 'utf8');
function extractFunc(name) {
    const re = new RegExp('function ' + name + '\\([^)]*\\) \\{', 'g');
    const m = re.exec(scriptCode);
    if (!m) throw new Error('НЕ НАЙДЕНА: ' + name);
    let start = m.index; let i = scriptCode.indexOf('{', start); let depth = 1; i++;
    while (depth > 0) { if (scriptCode[i] === '{') depth++; else if (scriptCode[i] === '}') depth--; i++; }
    return scriptCode.slice(start, i);
}

eval(extractFunc('isOnLongRoad'));
eval(extractFunc('analyzeLongRoadEnding'));
eval(extractFunc('getDrawPositionKey'));
eval(extractFunc('checkAutomaticDraw'));
eval(extractFunc('computeNextDrawState'));

let passed = 0, failed = 0;
function check(name, cond, details) { console.log((cond ? '✅ ' : '❌ ') + name + (!cond && details ? ' — ' + details : '')); cond ? passed++ : failed++; }

// [row, col, isKing]
function board(lightArr, darkArr) {
    const p = {};
    lightArr.forEach(x => { p[x[0] + '_' + x[1]] = { color: 'light', king: !!x[2] }; });
    darkArr.forEach(x => { p[x[0] + '_' + x[1]] = { color: 'dark', king: !!x[2] }; });
    return p;
}
function freshKey(p) { return getDrawPositionKey(p, 'light'); }

// Симуляция одного завершённого хода
function move(state, color, from, to, opts) {
    opts = opts || {};
    const wasKing = !!(state.pieces[from] && state.pieces[from].king);
    const np = Object.assign({}, state.pieces);
    np[to] = Object.assign({}, np[from]);
    delete np[from];
    if (opts.captured) delete np[opts.captured];
    if (opts.promote) np[to].king = true;
    const enemy = color === 'light' ? 'dark' : 'light';
    const enemyLeft = Object.keys(np).filter(k => np[k].color === enemy).length;
    const result = {
        pieces: np, turn: enemy, mustContinueFrom: null,
        capturedDark: state.capturedDark + (opts.captured && color === 'light' ? 1 : 0),
        capturedLight: state.capturedLight + (opts.captured && color === 'dark' ? 1 : 0),
        lastMove: { to: { row: +to.split('_')[0], col: +to.split('_')[1] } },
        winner: (opts.captured && enemyLeft === 0) ? color : null
    };
    const ds = computeNextDrawState(state, result, wasKing);
    return Object.assign({}, state, result, ds);
}
function mkState(pieces, extra) {
    return Object.assign({
        pieces: pieces, turn: 'light', capturedDark: 0, capturedLight: 0,
        kingOnlyStreak: 0, noProgressStreak: 0, positionHistory: [],
        longRoadAttacker: null, longRoadStreak: 0, winner: null
    }, extra || {});
}

console.log('===== ШАГ 1: 2-3 фигуры -> 5 ходов =====');
{
    // 1. 1 дамка vs 1 дамка
    const p = board([[7, 0, 1]], [[0, 1, 1]]); // 2 фигуры, обе дамки
    check('1. 1 дамка vs 1 дамка, noProgress=4 -> ничьи нет', checkAutomaticDraw(p, 0, 4, [], freshKey(p), 0) === null);
    check('1. 1 дамка vs 1 дамка, noProgress=5 -> no_progress_5', checkAutomaticDraw(p, 0, 5, [], freshKey(p), 0) === 'no_progress_5');

    // 2. 1 дамка + 1 простая vs 1 дамка (3 фигуры, у обеих есть дамка)
    const p2 = board([[7, 0, 1], [6, 3, 0]], [[0, 1, 1]]);
    check('2. дамка+простая vs дамка (3 фигуры), noProgress=5 -> no_progress_5', checkAutomaticDraw(p2, 0, 5, [], freshKey(p2), 0) === 'no_progress_5');
    check('2. то же при noProgress=4 -> ничьи нет', checkAutomaticDraw(p2, 0, 4, [], freshKey(p2), 0) === null);

    // 3. взятие сбрасывает noProgress
    let s = mkState(board([[7, 0, 1], [6, 3, 0]], [[0, 1, 1], [5, 4, 0]]), { noProgressStreak: 4 });
    s = move(s, 'light', '7_0', '4_3', { captured: '5_4' });
    check('3. Взятие сбрасывает noProgressStreak в 0', s.noProgressStreak === 0, 'реально: ' + s.noProgressStreak);

    // 4. превращение в дамку сбрасывает noProgress
    let s2 = mkState(board([[7, 0, 1], [1, 2, 0]], [[0, 5, 1]]), { noProgressStreak: 4 });
    s2 = move(s2, 'light', '1_2', '0_3', { promote: true });
    check('4. Превращение в дамку сбрасывает noProgressStreak в 0', s2.noProgressStreak === 0, 'реально: ' + s2.noProgressStreak);

    // 5. 4 фигуры НЕ попадают в лимит 5 (там 30)
    const p4 = board([[7, 0, 1], [6, 3, 0]], [[0, 1, 1], [1, 4, 0]]); // 4 фигуры
    check('5. 4 фигуры при noProgress=5 -> НЕ ничья (действует лимит 30)', checkAutomaticDraw(p4, 0, 5, [], freshKey(p4), 0) === null);
    check('5. 4 фигуры при noProgress=30 -> no_progress_30', checkAutomaticDraw(p4, 0, 30, [], freshKey(p4), 0) === 'no_progress_30');
}

console.log('');
console.log('===== ШАГ 2: 3 фигуры vs одинокая дамка на большой дороге =====');
{
    // Одинокая дамка dark на большой дороге: (4,3)=d4, row+col=7
    const LR = [4, 3, 1];
    // 6. 3 дамки
    const p6 = board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [LR]);
    const a6 = analyzeLongRoadEnding(p6);
    check('6. 3 дамки vs дамка на большой дороге -> распознано, attacker=light', !!a6 && a6.attacker === 'light');

    // 7. 2 дамки + простая
    const p7 = board([[7, 0, 1], [7, 2, 1], [6, 5, 0]], [LR]);
    check('7. 2 дамки + простая vs дамка на большаке -> распознано', !!analyzeLongRoadEnding(p7));

    // 8. дамка + 2 простые
    const p8 = board([[7, 0, 1], [6, 5, 0], [6, 7, 0]], [LR]);
    check('8. дамка + 2 простые vs дамка на большаке -> распознано', !!analyzeLongRoadEnding(p8));

    // 8b. 3 простые (текущий текст ФШР их включает)
    const p8b = board([[6, 1, 0], [6, 5, 0], [6, 7, 0]], [LR]);
    check('8b. 3 простые vs дамка на большаке -> распознано (текущий текст ФШР их включает)', !!analyzeLongRoadEnding(p8b));

    // 9. 4 фигуры у сильной стороны -> НЕ это правило
    const p9 = board([[7, 0, 1], [7, 2, 1], [7, 4, 1], [6, 5, 0]], [LR]);
    check('9. 4 фигуры у сильной стороны -> правило НЕ действует', analyzeLongRoadEnding(p9) === null);

    // 10. дамка НЕ на большой дороге
    const p10 = board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[3, 2, 1]]); // row+col=5, не большак
    check('10. Дамка слабой стороны НЕ на большаке -> правило НЕ стартует', analyzeLongRoadEnding(p10) === null);

    // 10b. слабая фигура — простая, не дамка
    const p10b = board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[4, 3, 0]]);
    check('10b. Одинокая ПРОСТАЯ на большаке (не дамка) -> правило НЕ стартует', analyzeLongRoadEnding(p10b) === null);

    // 11/12. off-by-one по порогу
    check('11. longRoadStreak=4 -> ничьи НЕТ', checkAutomaticDraw(p6, 0, 0, [], freshKey(p6), 4) === null);
    check('12. longRoadStreak=5 -> long_road_5 РОВНО здесь', checkAutomaticDraw(p6, 0, 0, [], freshKey(p6), 5) === 'long_road_5');

    // 13. ходы слабой стороны не увеличивают счётчик + off-by-one в динамике
    let s = mkState(p6, { longRoadAttacker: 'light' });
    const log = [];
    let lp = '7_0', lalt = '5_0';
    let dp = '4_3', dalt = '3_4'; // обе клетки на большой дороге
    for (let i = 1; i <= 6; i++) {
        const nl = (lp === '7_0') ? lalt : '7_0';
        s = move(s, 'light', lp, nl); lp = nl;
        log.push({ after: 'light#' + i, streak: s.longRoadStreak, reason: s.drawReason });
        if (s.drawReason) break;
        const before = s.longRoadStreak;
        const nd = (dp === '4_3') ? dalt : '4_3';
        s = move(s, 'dark', dp, nd); dp = nd;
        if (s.longRoadStreak !== before) { log.push({ err: 'ход dark изменил счётчик!' }); break; }
    }
    check('13. Ходы слабой стороны НЕ увеличивают счётчик', !log.some(x => x.err));
    check('11-дин. После 4-го собственного хода сильной стороны ничьи нет', log[3] && log[3].streak === 4 && !log[3].reason, JSON.stringify(log[3]));
    check('12-дин. После 5-го собственного хода без взятия -> long_road_5', log[4] && log[4].streak === 5 && log[4].reason === 'long_road_5', JSON.stringify(log[4]));

    // 14. взятие дамки раньше -> обычная победа
    let s14 = mkState(board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[5, 2, 1]]), { longRoadAttacker: 'light', longRoadStreak: 3 });
    s14 = move(s14, 'light', '7_0', '4_3', { captured: '5_2' });
    check('14. Взятие одинокой дамки -> обычная победа (winner), не ничья', s14.winner === 'light' && s14.drawReason !== 'long_road_5');

    // 15. изменение материала -> сброс
    let s15 = mkState(board([[7, 0, 1], [7, 2, 1], [7, 4, 1], [6, 5, 0]], [LR]), { longRoadAttacker: 'light', longRoadStreak: 3 });
    s15 = move(s15, 'light', '6_5', '5_6'); // теперь 4 фигуры у сильной -> режим не действует
    check('15. Материал не соответствует -> longRoadStreak сброшен в 0', s15.longRoadStreak === 0 && s15.longRoadAttacker === null);

    // 15b. уход дамки с большой дороги -> сброс (наша трактовка, помечена в коде)
    let s15b = mkState(p6, { longRoadAttacker: 'light', longRoadStreak: 3 });
    s15b = move(s15b, 'dark', '4_3', '3_2'); // row+col=5, ушла с большака
    check('15b. Уход дамки с большой дороги -> счётчик сброшен', s15b.longRoadStreak === 0 && s15b.longRoadAttacker === null);

    // Момент установления: устанавливающий ход не считается
    let sEst = mkState(board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[3, 2, 1]]), { longRoadAttacker: null, longRoadStreak: 0 });
    sEst = move(sEst, 'dark', '3_2', '4_3'); // дамка ВСТУПАЕТ на большак — момент установления
    check('Устанавливающий ход НЕ засчитывается: streak=0, attacker определён', sEst.longRoadStreak === 0 && sEst.longRoadAttacker === 'light');
}

console.log('');
console.log('===== СБРОС / СИНХРОНИЗАЦИЯ =====');
{
    // 16. rematch / new game
    const freshCount = (scriptCode.match(/longRoadAttacker: null,\s*\n\s*longRoadStreak: 0,/g) || []).length;
    check('16. Все литералы свежей партии сбрасывают оба поля', freshCount >= 5, 'найдено: ' + freshCount);
    check('16. performRematchReset сбрасывает оба поля', /updates\["longRoadAttacker"\] = null;\s*\n\s*updates\["longRoadStreak"\] = 0;/.test(scriptCode));

    // 17. resume / cross-device
    eval(extractFunc('serializeOwnerBotState'));
    eval(extractFunc('deserializeOwnerBotState'));
    const orig = {
        pieces: board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[4, 3, 1]]),
        turn: 'light', mustContinueFrom: null, pendingRemovals: [],
        capturedDark: 9, capturedLight: 8, moveCount: 40, moveType: null,
        lastMove: null, lastMovePath: [], lastCapturedSquares: [],
        kingOnlyStreak: 2, noProgressStreak: 7, positionHistory: ['k'],
        longRoadAttacker: 'light', longRoadStreak: 3,
        winner: null, winReason: null, players: {}
    };
    const round = deserializeOwnerBotState(JSON.parse(JSON.stringify(serializeOwnerBotState(orig))));
    check('17. longRoadAttacker переживает serialize->JSON->deserialize', round.longRoadAttacker === 'light');
    check('17. longRoadStreak переживает roundtrip ровно', round.longRoadStreak === 3);
    const inact = deserializeOwnerBotState(JSON.parse(JSON.stringify(serializeOwnerBotState(
        Object.assign({}, orig, { longRoadAttacker: null, longRoadStreak: 0 })))));
    check('17. Неактивное состояние (null/0) не превращается в undefined/NaN', inact.longRoadAttacker === null && inact.longRoadStreak === 0);
}

console.log('');
console.log('===== РЕГРЕССИЯ (18-21) =====');
{
    // 18. троекратное повторение
    const pr = board([[7, 0, 1], [6, 3, 0], [5, 6, 0]], [[0, 1, 1], [1, 4, 0], [2, 7, 0]]); // 6 фигур
    const k = getDrawPositionKey(pr, 'light');
    check('18. Троекратное повторение работает как раньше', checkAutomaticDraw(pr, 0, 0, [k, 'x', k, 'y', k], k, 0) === 'threefold_repetition');

    // 19. 15 ходов только дамками
    check('19. kings_only_15 работает как раньше', checkAutomaticDraw(pr, 15, 0, [], k, 0) === 'kings_only_15');

    // 20. 30 / 60
    const p45 = board([[7, 0, 1], [6, 3, 0]], [[0, 1, 1], [1, 4, 0]]);
    const p67 = board([[7, 0, 1], [6, 3, 0], [5, 6, 0]], [[0, 1, 1], [1, 4, 0], [2, 7, 0]]);
    check('20. no_progress_30 (4-5 фигур) работает как раньше', checkAutomaticDraw(p45, 0, 30, [], freshKey(p45), 0) === 'no_progress_30');
    check('20. no_progress_60 (6-7 фигур) работает как раньше', checkAutomaticDraw(p67, 0, 60, [], freshKey(p67), 0) === 'no_progress_60');
    check('20. 6-7 фигур при noProgress=30 -> ещё НЕ ничья', checkAutomaticDraw(p67, 0, 30, [], freshKey(p67), 0) === null);

    // 21. bot и online — одна и та же функция
    check('21. Ровно ОДНО определение computeNextDrawState (общее для bot и online)', (scriptCode.match(/^function computeNextDrawState/gm) || []).length === 1);
    check('21. Ровно 5 реальных call sites (те же, что и до правки)', (scriptCode.match(/const drawState = computeNextDrawState\(/g) || []).length === 5);
}

console.log('');
console.log('ИТОГ: ' + passed + '/' + (passed + failed));

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
function check(n, c, d) { console.log((c ? '✅ ' : '❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

function board(L, D) {
    const p = {};
    L.forEach(x => { p[x[0] + '_' + x[1]] = { color: 'light', king: !!x[2] }; });
    D.forEach(x => { p[x[0] + '_' + x[1]] = { color: 'dark', king: !!x[2] }; });
    return p;
}
function mkState(pieces, extra) {
    return Object.assign({
        pieces, turn: 'light', capturedDark: 0, capturedLight: 0,
        kingOnlyStreak: 0, noProgressStreak: 0, positionHistory: [],
        longRoadAttacker: null, longRoadStreak: 0, winner: null
    }, extra || {});
}
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
    return Object.assign({}, state, result, computeNextDrawState(state, result, wasKing));
}

console.log('===== ЧАСТЬ 1: ШАГ 1 — детальная перепроверка =====');
{
    // 1 дамка vs 1 дамка, реальные чередующиеся ходы
    let s = mkState(board([[7, 0, 1]], [[0, 3, 1]]));
    const seq = [['light', '7_0', '6_1'], ['dark', '0_3', '1_4'], ['light', '6_1', '5_0'],
                 ['dark', '1_4', '2_3'], ['light', '5_0', '4_1'], ['dark', '2_3', '3_2']];
    const log = [];
    for (let i = 0; i < seq.length; i++) {
        s = move(s, seq[i][0], seq[i][1], seq[i][2]);
        log.push({ ply: i + 1, np: s.noProgressStreak, reason: s.drawReason });
        if (s.drawReason) break;
    }
    check('1a. 1 дамка vs 1 дамка: после 4 полуходов ничьи НЕТ', log[3] && !log[3].reason && log[3].np === 4, JSON.stringify(log[3]));
    check('1b. После 5-го — ничья no_progress_5', log[4] && log[4].reason === 'no_progress_5' && log[4].np === 5, JSON.stringify(log[4]));

    // Ход простой БЕЗ превращения не сбрасывает noProgress
    // light простая на 4_1 идёт на 3_2 (вперёд для light — к row 0), НЕ превращение
    let s2 = mkState(board([[7, 0, 1], [4, 1, 0]], [[0, 3, 1]]), { noProgressStreak: 2 });
    s2 = move(s2, 'light', '4_1', '3_2');
    check('1c. Обычный ход простой БЕЗ превращения НЕ сбрасывает noProgress (2 -> 3)', s2.noProgressStreak === 3, 'реально: ' + s2.noProgressStreak);
    check('1c-контроль. kingOnlyStreak при этом СБРАСЫВАЕТСЯ (ходила простая)', s2.kingOnlyStreak === 0, 'реально: ' + s2.kingOnlyStreak);

    // Взятие сбрасывает
    let s3 = mkState(board([[7, 0, 1], [4, 1, 0]], [[0, 3, 1], [3, 2, 0]]), { noProgressStreak: 4 });
    s3 = move(s3, 'light', '7_0', '2_5', { captured: '3_2' });
    check('1d. Взятие сбрасывает noProgress в 0', s3.noProgressStreak === 0, 'реально: ' + s3.noProgressStreak);

    // Превращение сбрасывает
    let s4 = mkState(board([[7, 0, 1], [1, 2, 0]], [[0, 5, 1]]), { noProgressStreak: 4 });
    s4 = move(s4, 'light', '1_2', '0_1', { promote: true });
    check('1e. Превращение простой в дамку сбрасывает noProgress в 0', s4.noProgressStreak === 0, 'реально: ' + s4.noProgressStreak);

    // 4 фигуры — лимит 5 не действует
    const p4 = board([[7, 0, 1], [6, 3, 0]], [[0, 1, 1], [1, 4, 0]]);
    check('1f. 4 фигуры: noProgress=5 -> НЕ ничья', checkAutomaticDraw(p4, 0, 5, [], getDrawPositionKey(p4, 'light'), 0) === null);
    check('1f. 4 фигуры: noProgress=29 -> ещё НЕ ничья', checkAutomaticDraw(p4, 0, 29, [], getDrawPositionKey(p4, 'light'), 0) === null);
    check('1f. 4 фигуры: noProgress=30 -> no_progress_30', checkAutomaticDraw(p4, 0, 30, [], getDrawPositionKey(p4, 'light'), 0) === 'no_progress_30');
}

console.log('');
console.log('===== ЧАСТЬ 2: уход дамки с большой дороги — фактическое поведение =====');
{
    const P = board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[4, 3, 1]]); // дамка dark на d4, большак
    let s = mkState(P, { longRoadAttacker: 'light', longRoadStreak: 3 });
    console.log('Исходно: longRoadStreak = 3, дамка на большаке (4_3)');
    s = move(s, 'dark', '4_3', '3_2'); // 3+2=5 — НЕ большак
    console.log('После ухода дамки на 3_2 (вне большака): longRoadStreak =', s.longRoadStreak, ', attacker =', s.longRoadAttacker);
    check('2a. Уход с большака -> счётчик сброшен в 0 (наша трактовка)', s.longRoadStreak === 0 && s.longRoadAttacker === null);
    s = move(s, 'light', '7_0', '6_1');
    s = move(s, 'dark', '3_2', '4_3'); // вернулась на большак
    console.log('После возврата на большак: longRoadStreak =', s.longRoadStreak, ', attacker =', s.longRoadAttacker);
    check('2b. Возврат на большак -> отсчёт начинается заново с 0', s.longRoadStreak === 0 && s.longRoadAttacker === 'light');
    check('2c. Порог всё равно требует дамку НА большаке в момент проверки',
        checkAutomaticDraw(board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[3, 2, 1]]), 0, 0, [], 'k', 99) === null);
}

console.log('');
console.log('===== ЧАСТЬ 3A: реальная последовательность — 1 дамка vs 1 дамка =====');
{
    let s = mkState(board([[7, 0, 1]], [[0, 3, 1]]));
    let lp = '7_0', la = '6_1', dp = '0_3', da = '1_4';
    let fired = null, firedPly = null, counters = null;
    for (let ply = 1; ply <= 20; ply++) {
        if (ply % 2 === 1) { const n = (lp === '7_0') ? la : '7_0'; s = move(s, 'light', lp, n); lp = n; }
        else { const n = (dp === '0_3') ? da : '0_3'; s = move(s, 'dark', dp, n); dp = n; }
        if (s.drawReason) { fired = s.drawReason; firedPly = ply; counters = { np: s.noProgressStreak, ko: s.kingOnlyStreak, hist: s.positionHistory.length }; break; }
    }
    console.log('ПЕРВЫМ сработало:', fired, 'на полуходе', firedPly);
    console.log('  noProgressStreak =', counters.np, '| kingOnlyStreak =', counters.ko);
    console.log('  (порог no_progress_5 = 5; kings_only_15 = 15; threefold требует 3 повтора)');
    check('3A. Первым срабатывает no_progress_5', fired === 'no_progress_5');
    check('3A. Именно на 5-м полуходе — раньше kings_only_15 (15) и threefold', firedPly === 5);
}

console.log('');
console.log('===== ЧАСТЬ 3B-1: 3 фигуры vs дамка на большаке, БЕЗ повторов позиций =====');
{
    let s = mkState(board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[4, 3, 1]]), { longRoadAttacker: 'light' });
    // Все клетки dark — на большой дороге (row+col=7), позиции не повторяются
    const seq = [
        ['light', '7_0', '6_1'], ['dark', '4_3', '3_4'],
        ['light', '7_2', '6_3'], ['dark', '3_4', '2_5'],
        ['light', '7_4', '6_5'], ['dark', '2_5', '1_6'],
        ['light', '6_1', '5_0'], ['dark', '1_6', '0_7'],
        ['light', '6_3', '5_2']
    ];
    let fired = null, firedPly = null, lrAt = null;
    for (let i = 0; i < seq.length; i++) {
        s = move(s, seq[i][0], seq[i][1], seq[i][2]);
        if (s.drawReason) { fired = s.drawReason; firedPly = i + 1; lrAt = s.longRoadStreak; break; }
    }
    console.log('ПЕРВЫМ сработало:', fired, 'на полуходе', firedPly, '| longRoadStreak =', lrAt);
    console.log('  (это 5-й СОБСТВЕННЫЙ ход сильной стороны; noProgress был', s.noProgressStreak, 'при пороге 30 для 4 фигур)');
    check('3B-1. Срабатывает long_road_5', fired === 'long_road_5');
    check('3B-1. Именно на 5-м собственном ходе сильной стороны (ply 9)', firedPly === 9 && lrAt === 5);
    check('3B-1. noProgress (порог 30 для 4 фигур) НЕ успел сработать', s.noProgressStreak < 30);
}

console.log('');
console.log('===== ЧАСТЬ 3B-2: то же, но с ПОВТОРАМИ позиций (конкуренция с threefold) =====');
{
    let s = mkState(board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[4, 3, 1]]), { longRoadAttacker: 'light' });
    let lp = '7_0', la = '6_1', dp = '4_3', da = '3_4'; // обе клетки dark на большаке
    let fired = null, firedPly = null, lrAt = null, repeats = null;
    for (let ply = 1; ply <= 20; ply++) {
        if (ply % 2 === 1) { const n = (lp === '7_0') ? la : '7_0'; s = move(s, 'light', lp, n); lp = n; }
        else { const n = (dp === '4_3') ? da : '4_3'; s = move(s, 'dark', dp, n); dp = n; }
        if (s.drawReason) {
            fired = s.drawReason; firedPly = ply; lrAt = s.longRoadStreak;
            const k = s.positionHistory[s.positionHistory.length - 1];
            repeats = s.positionHistory.filter(x => x === k).length;
            break;
        }
    }
    console.log('ПЕРВЫМ сработало:', fired, 'на полуходе', firedPly);
    console.log('  longRoadStreak =', lrAt, '| повторов текущей позиции в истории =', repeats);
    check('3B-2. При повторяющихся ходах сработало корректное правило', fired === 'long_road_5' || fired === 'threefold_repetition');
    console.log('  ФАКТИЧЕСКИЙ порядок зафиксирован выше — оба исхода легитимны по ФШР (ничья)');
}

console.log('');
console.log('===== ЧАСТЬ 4: коды drawReason =====');
{
    const p23 = board([[7, 0, 1]], [[0, 3, 1]]);
    check('4a. 2-3 фигуры / 5 ходов -> код "no_progress_5"', checkAutomaticDraw(p23, 0, 5, [], getDrawPositionKey(p23, 'light'), 0) === 'no_progress_5');
    const pLR = board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[4, 3, 1]]);
    check('4b. 3 фигуры vs дамка на большаке / 5 собств. ходов -> код "long_road_5"', checkAutomaticDraw(pLR, 0, 0, [], getDrawPositionKey(pLR, 'light'), 5) === 'long_road_5');
    check('4c. Старые коды не изменились', ['threefold_repetition', 'kings_only_15', 'no_progress_30', 'no_progress_60'].every(c => scriptCode.includes('"' + c + '"')));
    check('4d. Шаг 3 в код НЕ внедрён (kings_vs_king_15 отсутствует)', !scriptCode.includes('kings_vs_king_15'));
}

console.log('');
console.log('ИТОГ: ' + passed + '/' + (passed + failed));

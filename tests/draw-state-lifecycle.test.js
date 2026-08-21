const fs = require('fs');
const scriptCode = fs.readFileSync(process.env.TARGET_SCRIPT || require('path').join(__dirname,'..','script.js'), 'utf8');
function ex(name) {
    const re = new RegExp('function ' + name + '\\([^)]*\\) \\{', 'g');
    const m = re.exec(scriptCode);
    if (!m) throw new Error('НЕ НАЙДЕНА: ' + name);
    let s = m.index; let i = scriptCode.indexOf('{', s); let d = 1; i++;
    while (d > 0) { if (scriptCode[i] === '{') d++; else if (scriptCode[i] === '}') d--; i++; }
    return scriptCode.slice(s, i);
}
eval(ex('isOnLongRoad')); eval(ex('analyzeLongRoadEnding')); eval(ex('getDrawPositionKey'));
eval(ex('checkAutomaticDraw')); eval(ex('computeNextDrawState'));
eval(ex('serializeOwnerBotState')); eval(ex('deserializeOwnerBotState'));
global.createInitialPieces = function () { return {}; };
global.myTelegramName = 'Игрок';
eval(ex('buildFreshBotGameState'));

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '✅ ' : '❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

function board(L, D) {
    const p = {};
    L.forEach(x => { p[x[0] + '_' + x[1]] = { color: 'light', king: !!x[2] }; });
    D.forEach(x => { p[x[0] + '_' + x[1]] = { color: 'dark', king: !!x[2] }; });
    return p;
}
function move(state, color, from, to, opts) {
    opts = opts || {};
    const wasKing = !!(state.pieces[from] && state.pieces[from].king);
    const np = Object.assign({}, state.pieces);
    np[to] = Object.assign({}, np[from]); delete np[from];
    if (opts.captured) delete np[opts.captured];
    if (opts.promote) np[to].king = true;
    const enemy = color === 'light' ? 'dark' : 'light';
    const left = Object.keys(np).filter(k => np[k].color === enemy).length;
    const r = {
        pieces: np, turn: enemy, mustContinueFrom: null,
        capturedDark: state.capturedDark + (opts.captured && color === 'light' ? 1 : 0),
        capturedLight: state.capturedLight + (opts.captured && color === 'dark' ? 1 : 0),
        lastMove: { to: { row: +to.split('_')[0], col: +to.split('_')[1] } },
        winner: (opts.captured && left === 0) ? color : null
    };
    return Object.assign({}, state, r, computeNextDrawState(state, r, wasKing));
}
function mk(pieces, extra) {
    return Object.assign({
        pieces, turn: 'light', capturedDark: 0, capturedLight: 0,
        kingOnlyStreak: 0, noProgressStreak: 0, positionHistory: [],
        longRoadAttacker: null, longRoadStreak: 0, winner: null,
        mustContinueFrom: null, pendingRemovals: [], moveCount: 0, moveType: null,
        lastMove: null, lastMovePath: [], lastCapturedSquares: [],
        winReason: null, players: {}
    }, extra || {});
}
// Firebase реально УДАЛЯЕТ null-поля — эмулируем это точно, а не просто JSON
function throughFirebase(obj) {
    const out = JSON.parse(JSON.stringify(obj));
    for (const k in out) if (out[k] === null) delete out[k];
    return out;
}
// Путь online-комнаты: как код реально читает поля из room
function readFromRoom(room) {
    return {
        pieces: room.pieces, turn: room.turn, mustContinueFrom: room.mustContinueFrom || null,
        capturedDark: room.capturedDark || 0, capturedLight: room.capturedLight || 0,
        kingOnlyStreak: room.kingOnlyStreak || 0,
        noProgressStreak: room.noProgressStreak || 0,
        positionHistory: room.positionHistory || [],
        longRoadAttacker: room.longRoadAttacker || null,
        longRoadStreak: room.longRoadStreak || 0,
        winner: room.winner || null
    };
}

const LR_BOARD = board([[7, 0, 1], [7, 2, 1], [7, 4, 1]], [[4, 3, 1]]); // дамка dark на d4 = большак

console.log('===== 1-2. НОВАЯ ПАРТИЯ -> null / 0 =====');
{
    const fresh = buildFreshBotGameState();
    check('1. Новая bot-партия (buildFreshBotGameState): longRoadAttacker=null', fresh.longRoadAttacker === null);
    check('1. Новая bot-партия: longRoadStreak=0', fresh.longRoadStreak === 0);
    check('1. Новая bot-партия: noProgressStreak=0', fresh.noProgressStreak === 0);
    // online-партия: литералы createOnlineRoom / createRoomAndShowWaiting / addToMatchmakingQueue
    const onlineLiterals = (scriptCode.match(/longRoadAttacker: null,\s*\n\s*longRoadStreak: 0,/g) || []).length;
    check('2. Все 5 литералов свежей партии (bot + online) содержат null/0', onlineLiterals === 5, 'найдено: ' + onlineLiterals);
}

console.log('');
console.log('===== 3. Правило активировалось -> значения накапливаются =====');
{
    let s = mk(LR_BOARD, { longRoadAttacker: 'light' });
    s = move(s, 'light', '7_0', '6_1');
    s = move(s, 'dark', '4_3', '3_4');
    s = move(s, 'light', '7_2', '6_3');
    check('3. После 2 собственных ходов сильной стороны: longRoadStreak=2', s.longRoadStreak === 2, 'реально: ' + s.longRoadStreak);
    check('3. longRoadAttacker сохранён', s.longRoadAttacker === 'light');
    check('3. noProgressStreak тоже накапливается (3 полухода)', s.noProgressStreak === 3, 'реально: ' + s.noProgressStreak);
    global.__mid = s;
}

console.log('');
console.log('===== 4-5. RESUME (то же устройство / другое устройство) + ПРОДОЛЖЕНИЕ ХОДОВ =====');
{
    const before = global.__mid;
    // Полный реальный путь bot-сессии: serialize -> Firebase (null удаляются) -> deserialize
    const restored = deserializeOwnerBotState(throughFirebase(serializeOwnerBotState(before)));
    check('4. Resume: longRoadAttacker восстановлен', restored.longRoadAttacker === 'light', 'реально: ' + restored.longRoadAttacker);
    check('4. Resume: longRoadStreak восстановлен ровно (2)', restored.longRoadStreak === 2, 'реально: ' + restored.longRoadStreak);
    check('4. Resume: noProgressStreak восстановлен ровно (3)', restored.noProgressStreak === 3, 'реально: ' + restored.noProgressStreak);

    // ГЛАВНОЕ: продолжаем ходы ПОСЛЕ восстановления — счёт должен идти с 2, не с 0
    let s = Object.assign({}, before, restored);
    s = move(s, 'dark', '3_4', '2_5');
    s = move(s, 'light', '7_4', '6_5');
    check('5. После resume счёт продолжился с восстановленного значения: longRoadStreak=3', s.longRoadStreak === 3, 'реально: ' + s.longRoadStreak);
    check('5. noProgressStreak тоже продолжился: 5', s.noProgressStreak === 5, 'реально: ' + s.noProgressStreak);

    // Доводим до порога ПОСЛЕ восстановления — правило должно сработать вовремя
    s = move(s, 'dark', '2_5', '1_6');
    s = move(s, 'light', '6_1', '5_0');   // 4-й собственный
    check('5. После 4-го собственного хода (через resume) ничьи ещё НЕТ', !s.drawReason && s.longRoadStreak === 4, JSON.stringify({ r: s.drawReason, lr: s.longRoadStreak }));
    s = move(s, 'dark', '1_6', '0_7');
    s = move(s, 'light', '6_3', '5_2');   // 5-й собственный
    check('5. После 5-го собственного хода (через resume) -> long_road_5', s.drawReason === 'long_road_5' && s.longRoadStreak === 5, JSON.stringify({ r: s.drawReason, lr: s.longRoadStreak }));
}

console.log('');
console.log('===== 6-7. ONLINE ROOM: snapshot + reconnect + ПРОДОЛЖЕНИЕ =====');
{
    let s = mk(LR_BOARD, { longRoadAttacker: 'light' });
    s = move(s, 'light', '7_0', '6_1');
    s = move(s, 'dark', '4_3', '3_4');
    s = move(s, 'light', '7_2', '6_3'); // longRoadStreak = 2

    // Запись в room, как это делает online-код
    const room = {
        pieces: s.pieces, turn: s.turn, mustContinueFrom: s.mustContinueFrom,
        capturedDark: s.capturedDark, capturedLight: s.capturedLight,
        kingOnlyStreak: s.kingOnlyStreak, noProgressStreak: s.noProgressStreak,
        positionHistory: s.positionHistory,
        longRoadAttacker: s.longRoadAttacker, longRoadStreak: s.longRoadStreak,
        winner: s.winner
    };
    const afterSnapshot = readFromRoom(throughFirebase(room));
    check('6. Online snapshot: longRoadAttacker не потерян', afterSnapshot.longRoadAttacker === 'light');
    check('6. Online snapshot: longRoadStreak не потерян (2)', afterSnapshot.longRoadStreak === 2, 'реально: ' + afterSnapshot.longRoadStreak);
    check('6. Online snapshot: noProgressStreak не потерян (3)', afterSnapshot.noProgressStreak === 3);

    // Reconnect = повторное чтение того же room + продолжение ходов
    let s2 = Object.assign({}, s, afterSnapshot);
    s2 = move(s2, 'dark', '3_4', '2_5');
    s2 = move(s2, 'light', '7_4', '6_5');
    check('7. После reconnect счёт продолжился с 2 -> 3, а не с нуля', s2.longRoadStreak === 3, 'реально: ' + s2.longRoadStreak);
    check('7. noProgressStreak после reconnect: 5', s2.noProgressStreak === 5, 'реально: ' + s2.noProgressStreak);
}

console.log('');
console.log('===== 8-9. REMATCH / НОВАЯ ПАРТИЯ -> null / 0 =====');
{
    check('8. performRematchReset обнуляет longRoadAttacker/longRoadStreak',
        /updates\["longRoadAttacker"\] = null;\s*\n\s*updates\["longRoadStreak"\] = 0;/.test(scriptCode));
    check('8. performRematchReset обнуляет и noProgressStreak (как раньше)',
        /updates\["noProgressStreak"\] = 0;/.test(scriptCode));
    const fresh = buildFreshBotGameState();
    check('9. Новая партия через buildFreshBotGameState -> null/0', fresh.longRoadAttacker === null && fresh.longRoadStreak === 0);
    check('9. Старый streak из прошлой партии НЕ переносится', fresh.longRoadStreak === 0);
}

console.log('');
console.log('===== 10-11. ВЫХОД ИЗ УСЛОВИЯ И ПОВТОРНЫЙ ВХОД =====');
{
    let s = mk(LR_BOARD, { longRoadAttacker: 'light' });
    s = move(s, 'light', '7_0', '6_1');
    s = move(s, 'dark', '4_3', '3_4');
    s = move(s, 'light', '7_2', '6_3');
    check('10-подготовка: longRoadStreak накоплен (2)', s.longRoadStreak === 2);

    s = move(s, 'dark', '3_4', '2_3'); // 2+3=5 — УШЛА с большака
    check('10. Выход из условия -> longRoadAttacker=null, longRoadStreak=0', s.longRoadAttacker === null && s.longRoadStreak === 0);

    s = move(s, 'light', '6_1', '5_0');
    s = move(s, 'dark', '2_3', '3_4'); // ВЕРНУЛАСЬ на большак (3+4=7)
    check('11. Повторный вход: attacker снова определён', s.longRoadAttacker === 'light');
    check('11. Повторный вход: отсчёт начинается ЗАНОВО с 0, старый streak НЕ вернулся', s.longRoadStreak === 0, 'реально: ' + s.longRoadStreak);

    s = move(s, 'light', '7_4', '6_5');
    check('11. Первый собственный ход после повторного входа -> 1 (а не 3)', s.longRoadStreak === 1, 'реально: ' + s.longRoadStreak);
}

console.log('');
console.log('===== no_progress_5: новых полей НЕ нужно, существующее поле переживает всё =====');
{
    // 2 фигуры, обе дамки, накапливаем noProgress=3
    let s = mk(board([[7, 0, 1]], [[0, 3, 1]]));
    s = move(s, 'light', '7_0', '6_1');
    s = move(s, 'dark', '0_3', '1_4');
    s = move(s, 'light', '6_1', '5_0');
    check('np-1. Накоплено noProgressStreak=3', s.noProgressStreak === 3);

    // bot resume
    const r1 = deserializeOwnerBotState(throughFirebase(serializeOwnerBotState(s)));
    check('np-2. bot resume: noProgressStreak=3 сохранён', r1.noProgressStreak === 3);
    let a = Object.assign({}, s, r1);
    a = move(a, 'dark', '1_4', '2_3');
    check('np-3. После bot resume счёт продолжился 3 -> 4', a.noProgressStreak === 4, 'реально: ' + a.noProgressStreak);
    a = move(a, 'light', '5_0', '4_1');
    check('np-4. 5-й полуход после resume -> no_progress_5 РОВНО вовремя', a.drawReason === 'no_progress_5' && a.noProgressStreak === 5, JSON.stringify({ r: a.drawReason, np: a.noProgressStreak }));

    // cross-device / online snapshot
    const room = { pieces: s.pieces, turn: s.turn, kingOnlyStreak: s.kingOnlyStreak, noProgressStreak: s.noProgressStreak, positionHistory: s.positionHistory, longRoadAttacker: s.longRoadAttacker, longRoadStreak: s.longRoadStreak };
    const rr = readFromRoom(throughFirebase(room));
    check('np-5. online snapshot: noProgressStreak=3 сохранён', rr.noProgressStreak === 3);
    let b = Object.assign({}, s, rr);
    b = move(b, 'dark', '1_4', '2_3');
    check('np-6. После online snapshot счёт продолжился 3 -> 4', b.noProgressStreak === 4);

    // rematch reset
    check('np-7. Новых полей для no_progress_5 не потребовалось (используется существующий noProgressStreak)',
        !scriptCode.includes('noProgress5') && !scriptCode.includes('shortEndgameStreak'));
}

console.log('');
console.log('===== Граничный случай: longRoadStreak=0 переживает удаление null Firebase =====');
{
    const s = mk(LR_BOARD, { longRoadAttacker: null, longRoadStreak: 0 });
    const r = deserializeOwnerBotState(throughFirebase(serializeOwnerBotState(s)));
    check('null/0 не превращается в undefined/NaN после удаления null полей Firebase',
        r.longRoadAttacker === null && r.longRoadStreak === 0 && !Number.isNaN(r.longRoadStreak));
    const rr = readFromRoom(throughFirebase({ pieces: {}, turn: 'light', longRoadAttacker: null, longRoadStreak: 0 }));
    check('То же для online-пути чтения из room', rr.longRoadAttacker === null && rr.longRoadStreak === 0);
}

console.log('');
console.log('ИТОГ: ' + passed + '/' + (passed + failed));

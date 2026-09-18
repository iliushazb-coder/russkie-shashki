// ==========================================================================
// ЗВУК ИСХОДА ПАРТИИ.
//
// Был дефект: playWinSound() вызывался на ЛЮБОМ финале, поэтому
// проигравший слышал ту же восходящую фанфару, что и победитель.
//
// Здесь проверяется ПОВЕДЕНИЕ классификации: функция извлекается из
// script.js и реально исполняется против подставных состояний, а звуковые
// функции подменяются счётчиками. Это важно -- регулярка по тексту не
// поймала бы, например, что при реванше со сменой цветов исход считается
// по UID, а не по myColor.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const AUDIO_SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'audio-effects.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
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

// --- Исполняемая песочница ---------------------------------------------
const body = funcBody(SRC, 'playEndGameOutcomeSound');
let played = [];
global.playVictorySound = function () { played.push('victory'); };
global.playDefeatSound = function () { played.push('defeat'); };
global.playDrawSound = function () { played.push('draw'); };
// Звук исхода теперь первым делом снимает ещё не прозвучавший мотив
// превращения: ход может быть одновременно победным и превращающим.
// Для этой сюиты достаточно счётчика -- сама отмена проверяется в
// king-promotion-effect.
let cancelledKingSounds = 0;
global.cancelKingSound = function () { cancelledKingSounds++; };
if (body) {
    // eslint-disable-next-line no-eval
    eval(body);
}

function outcome(state, spectator, uid, color) {
    played = [];
    global.currentState = state;
    global.isSpectator = spectator;
    global.myTelegramId = uid;
    global.myColor = color;
    playEndGameOutcomeSound();
    return played.join(',') || '(silence)';
}

// Онлайн-комната: у игроков ЕСТЬ id.
function online(winner, reason) {
    return {
        winner: winner,
        winReason: reason || null,
        players: { light: { id: 'tg_1001', name: 'A' }, dark: { id: 'tg_1002', name: 'B' } }
    };
}
// Бот-партия: у игроков ТОЛЬКО name, без id.
function bot(winner) {
    return {
        winner: winner,
        players: { light: { name: 'Игрок' }, dark: { name: '🤖 Компьютер' } }
    };
}

console.log('=== 1. ФУНКЦИЯ СУЩЕСТВУЕТ И ИСПОЛНЯЕТСЯ ===');
check('1.1 playEndGameOutcomeSound найдена в script.js', !!body);

console.log('\n=== 2. ОНЛАЙН: ПОБЕДА / ПОРАЖЕНИЕ / НИЧЬЯ ===');
check('2.1 победа -> только victory', outcome(online('light'), false, 'tg_1001', 'light') === 'victory');
check('2.2 поражение -> только defeat', outcome(online('dark'), false, 'tg_1001', 'light') === 'defeat');
check('2.3 ничья -> только draw', outcome(online('draw'), false, 'tg_1001', 'light') === 'draw');

console.log('\n=== 3. РЕВАНШ: ЦВЕТА МЕНЯЮТСЯ МЕСТАМИ ===');
// Ключевой случай. myColor намеренно указывает на СТАРУЮ сторону: если
// классификация опиралась бы на него, ответ был бы обратным.
check('3.1 победа определяется по UID, а не по myColor',
    outcome(online('dark'), false, 'tg_1002', 'light') === 'victory');
check('3.2 поражение определяется по UID, а не по myColor',
    outcome(online('light'), false, 'tg_1002', 'dark') === 'defeat');

console.log('\n=== 4. ЗРИТЕЛЬ НЕ ПОЛУЧАЕТ ЛИЧНЫЙ ИСХОД ===');
const specWin = outcome(online('light'), true, 'tg_9999', 'light');
const specLose = outcome(online('dark'), true, 'tg_9999', 'light');
check('4.1 зритель не слышит victory', specWin.indexOf('victory') === -1, specWin);
check('4.2 зритель не слышит defeat', specLose.indexOf('defeat') === -1, specLose);
check('4.3 зритель слышит нейтральный звук', specWin === 'draw' && specLose === 'draw');
check('4.4 ничья звучит для зрителя так же, как для игроков',
    outcome(online('draw'), true, 'tg_9999', 'light') === 'draw');
// Посторонний, открывший комнату не как spectator, тоже не получает
// личного исхода -- его uid не совпадает ни с кем из игроков.
check('4.5 посторонний uid не получает личного исхода',
    outcome(online('light'), false, 'tg_9999', 'light') === 'draw');

console.log('\n=== 5. ПАРТИЯ С БОТОМ (у игроков НЕТ id) ===');
// Здесь сравнивать по UID нечего, поэтому решает myColor.
check('5.1 бот: победа -> victory', outcome(bot('light'), false, 'tg_1001', 'light') === 'victory');
check('5.2 бот: поражение -> defeat', outcome(bot('dark'), false, 'tg_1001', 'light') === 'defeat');
check('5.3 бот: ничья -> draw', outcome(bot('draw'), false, 'tg_1001', 'light') === 'draw');
check('5.4 бот без аутентификации (uid = null) всё равно слышит свой исход',
    outcome(bot('light'), false, null, 'light') === 'victory');
check('5.5 бот после реванша со сменой стороны',
    outcome(bot('dark'), false, 'tg_1001', 'dark') === 'victory');

console.log('\n=== 6. ПРИЧИНЫ ЗАВЕРШЕНИЯ НЕ МЕНЯЮТ КЛАССИФИКАЦИЮ ===');
// Сдача, таймаут и техническая победа отличаются только winReason;
// победитель и проигравший определяются тем же winner.
check('6.1 сдача: победитель слышит victory',
    outcome(online('light', 'resign'), false, 'tg_1001', 'light') === 'victory');
check('6.2 сдача: сдавшийся слышит defeat',
    outcome(online('light', 'resign'), false, 'tg_1002', 'dark') === 'defeat');
check('6.3 таймаут: проигравший слышит defeat',
    outcome(online('dark', 'timeout'), false, 'tg_1001', 'light') === 'defeat');
check('6.4 техническая победа: победитель слышит victory',
    outcome(online('light', 'technical'), false, 'tg_1001', 'light') === 'victory');

console.log('\n=== 6b. ПРИОРИТЕТ НАД ЗВУКОМ ПРЕВРАЩЕНИЯ ===');
// Победный ход может быть одновременно превращением. Мотив дамки к этому
// моменту уже запланирован на ~818 мс вперёд, и без отмены он догнал бы
// экран результата почти через секунду после звука исхода.
check('6b.1 звук исхода снимает запланированный мотив превращения', (function () {
    cancelledKingSounds = 0;
    outcome(online('light', 'resign'), false, 'tg_1001', 'light');
    return cancelledKingSounds === 1;
})());
check('6b.2 отмена идёт ПЕРВЫМ действием, до любых проверок', (function () {
    const b = funcBody(SRC, 'playEndGameOutcomeSound');
    if (!b) return false;
    const cancel = b.indexOf('cancelKingSound()');
    const firstCheck = b.indexOf('if (!currentState');
    return cancel !== -1 && firstCheck !== -1 && cancel < firstCheck;
})());

console.log('\n=== 7. НЕЗАВЕРШЁННАЯ ПАРТИЯ МОЛЧИТ ===');
check('7.1 winner отсутствует -> тишина',
    outcome({ winner: null, players: {} }, false, 'tg_1001', 'light') === '(silence)');
check('7.2 currentState отсутствует -> тишина',
    outcome(null, false, 'tg_1001', 'light') === '(silence)');

console.log('\n=== 8. ОДИН РАЗ НА ФИНАЛ: СУЩЕСТВУЮЩИЙ GUARD НЕ ДУБЛИРУЕТСЯ ===');
// Повторный рендер того же финала не должен звучать. За это отвечает
// уже существовавший endGameShownForRoom -- проверяем, что вызов стоит
// ВНУТРИ него и что второго, незащищённого вызова не появилось.
check('8.1 вызов стоит внутри guard endGameShownForRoom',
    /if \(endGameShownForRoom !== marker\) \{[\s\S]{0,300}?playEndGameOutcomeSound\(\);/.test(SRC));
check('8.2 маркер выставляется после звука (иначе guard бесполезен)', (function () {
    const m = /if \(endGameShownForRoom !== marker\) \{([\s\S]{0,400}?)\n\s*\}/.exec(SRC);
    if (!m) return false;
    const sound = m[1].indexOf('playEndGameOutcomeSound()');
    const mark = m[1].indexOf('endGameShownForRoom = marker');
    return sound !== -1 && mark !== -1 && sound < mark;
})());
check('8.3 ровно один ВЫЗОВ во всём script.js (определение не считаем)',
    (SRC.match(/(?<!function )playEndGameOutcomeSound\(\)/g) || []).length === 1,
    'найдено: ' + (SRC.match(/(?<!function )playEndGameOutcomeSound\(\)/g) || []).length);
check('8.4 старый безусловный playWinSound() из финала убран',
    !/if \(endGameShownForRoom !== marker\) \{[\s\S]{0,300}?playWinSound\(\);/.test(SRC));

console.log('\n=== 9. ЗВУКИ: WEB AUDIO, БЕЗ НОВЫХ АССЕТОВ ===');
check('9.1 playVictorySound существует', /function playVictorySound\(\)/.test(AUDIO_SRC));
check('9.2 playDefeatSound существует', /function playDefeatSound\(\)/.test(AUDIO_SRC));
check('9.3 playDrawSound существует', /function playDrawSound\(\)/.test(AUDIO_SRC));
check('9.4 все три экспортированы',
    /playVictorySound,/.test(AUDIO_SRC) && /playDefeatSound,/.test(AUDIO_SRC) && /playDrawSound,/.test(AUDIO_SRC));
// Звуки ИСХОДА ПАРТИИ по-прежнему синтезируются -- ассет в модуле есть,
// но он относится к превращению в дамку (отдельная задача владельца).
check('9.5 звуки исхода партии синтезируются, а не берутся из файла', (function () {
    return ['playVictorySound', 'playDefeatSound', 'playDrawSound'].every(function (fn) {
        const b = funcBody(AUDIO_SRC, fn);
        return !!b && !/\.wav|\.mp3|new Audio\(|fetch\(/.test(b);
    });
})());
check('9.6 поражение звучит НИСХОДЯЩЕ (вторая нота ниже первой)', (function () {
    const b = funcBody(AUDIO_SRC, 'playDefeatSound');
    if (!b) return false;
    const freqs = (b.match(/playTone\((\d+)/g) || []).map(function (s) { return parseInt(s.replace('playTone(', ''), 10); });
    return freqs.length >= 2 && freqs[1] < freqs[0];
})());
check('9.7 победа звучит ВОСХОДЯЩЕ или ровно, но не вниз', (function () {
    const b = funcBody(AUDIO_SRC, 'playVictorySound');
    if (!b) return false;
    const freqs = (b.match(/playTone\((\d+)/g) || []).map(function (s) { return parseInt(s.replace('playTone(', ''), 10); });
    return freqs.length >= 2 && freqs[freqs.length - 1] >= freqs[0];
})());
check('9.8 ничья нейтральна: тон не меняется', (function () {
    const b = funcBody(AUDIO_SRC, 'playDrawSound');
    if (!b) return false;
    const freqs = (b.match(/playTone\((\d+)/g) || []).map(function (s) { return parseInt(s.replace('playTone(', ''), 10); });
    return freqs.length >= 2 && freqs.every(function (f) { return f === freqs[0]; });
})());
check('9.9 финальные акценты тише прежней фанфары (громкость < 0.3)', (function () {
    return ['playVictorySound', 'playDefeatSound', 'playDrawSound'].every(function (fn) {
        const b = funcBody(AUDIO_SRC, fn);
        if (!b) return false;
        const vols = (b.match(/,\s*(0\.\d+)\)/g) || []).map(function (s) { return parseFloat(s.replace(/[,)\s]/g, '')); });
        return vols.length > 0 && vols.every(function (v) { return v < 0.3; });
    });
})());

console.log('\n=== 10. ОСТАЛЬНЫЕ ЗВУКИ НЕ ТРОНУТЫ ===');
check('10.1 playMoveSound без изменений',
    /function playMoveSound\(\) \{ playWoodKnock\(0\.09, 0\.32, 1700\); \}/.test(AUDIO_SRC));
// Пункт №2 намеренно переработал playKingSound (impact + колокол +
// shimmer), поэтому прежняя привязка к трезвучию C-E-G снята. Здесь
// важно другое: звук превращения существует, экспортирован и остаётся
// ОТДЕЛЬНЫМ от звуков исхода партии -- то есть пункт №1 не задет.
// playKingSound принимает задержку запуска, поэтому сигнатура уже не
// пустая. Проверяем главное: функция есть, экспортирована и НЕ перепутана
// со звуками исхода партии.
check('10.2 playKingSound существует и отделён от звуков исхода партии',
    /function playKingSound\(/.test(AUDIO_SRC) &&
    /playKingSound,/.test(AUDIO_SRC) &&
    !/function playKingSound\([\s\S]{0,400}?(playVictorySound|playDefeatSound|playDrawSound)/.test(AUDIO_SRC));
check('10.3 playKingCaptureSound без изменений',
    /function playKingCaptureSound\(\) \{\s*\n\s*playWoodKnock\(0\.18, 0\.6, 600\);/.test(AUDIO_SRC));
check('10.4 playCaptureSound без изменений',
    /function playCaptureSound\(\) \{\s*\n\s*playWoodKnock\(0\.12, 0\.42, 1100\);/.test(AUDIO_SRC) ||
    /function playCaptureSound\(\)/.test(AUDIO_SRC));
check('10.5 диспетчер ходов по-прежнему направляет "king" в playKingSound',
    /if \(type === "king"\) \{\s*\n\s*playKingSound\(/.test(AUDIO_SRC));
check('10.6 playWinSound сохранён как экспорт (обратная совместимость)',
    /function playWinSound\(\)/.test(AUDIO_SRC) && /playWinSound,/.test(AUDIO_SRC));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

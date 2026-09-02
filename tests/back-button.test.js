const fs = require('fs');

// v194: панель показывает рейтинг отдельным сегментом, а окно итога —
// изменение рейтинга. Харнессу нужны эти элементы.
// v195: имя и рейтинг рисуются отдельной функцией.
global.renderPlayerNameCell = function (cell, marker, name, rating) {
    if (!cell) return;
    cell.textContent = marker + name + (rating ? ' ' + rating : '');
};
global.ratingSegmentForColor = function () { return ''; };
global.endGameRating = { textContent: '' };
global.statsYourRank = { textContent: '' };
global.lastSettlementDisplay = null;
const scriptCode = fs.readFileSync(process.env.TARGET_SCRIPT || require('path').join(__dirname,'..','script.js'), 'utf8');
function extractFunc(name) {
    const re = new RegExp('function ' + name + '\\([^)]*\\) \\{', 'g');
    const m = re.exec(scriptCode);
    if (!m) throw new Error('НЕ НАЙДЕНА: ' + name);
    let start = m.index; let i = scriptCode.indexOf('{', start); let depth = 1; i++;
    while (depth > 0) { if (scriptCode[i] === '{') depth++; else if (scriptCode[i] === '}') depth--; i++; }
    return scriptCode.slice(start, i);
}

let passed = 0, failed = 0;
function check(name, cond, details) { console.log((cond ? '✅ ' : '❌ ') + name + (!cond && details ? ' — ' + details : '')); cond ? passed++ : failed++; }

// --- Реальный DOM-мок с классами, отслеживающий фактическое состояние ---
function makeEl(name) {
    const el = {
        _classes: new Set(['menu-button']),
        classList: {
            add: function (c) { el._classes.add(c); },
            remove: function (c) { el._classes.delete(c); },
            toggle: function (c, force) {
                if (force === undefined) { if (el._classes.has(c)) el._classes.delete(c); else el._classes.add(c); }
                else if (force) el._classes.add(c);
                else el._classes.delete(c);
            },
            contains: function (c) { return el._classes.has(c); }
        },
        textContent: '',
        get hidden() { return el._classes.has('hidden'); }
    };
    global.__elements = global.__elements || {};
    global.__elements[name] = el;
    return el;
}

// btn-back-bot/btn-back-spectator/btn-offer-draw/btn-resign — старт с
// РЕАЛЬНЫХ дефолтов из HTML: первые два начинаются с hidden, последние два — без
global.btnBackBot = makeEl('btnBackBot'); global.btnBackBot._classes.add('hidden');
global.btnBackSpectator = makeEl('btnBackSpectator');
// Мок для слепого querySelectorAll: если продакшен вернётся к массовому
// переключению всех .menu-button, тест должен ЧИСТО упасть, а не рухнуть.
global.document = global.document || {};
global.document.querySelectorAll = function (sel) {
  if (sel === '#game-screen .menu-button') {
    return [global.btnOfferDraw, global.btnResign, global.btnBackBot, global.btnBackSpectator];
  }
  return [];
}; global.btnBackSpectator._classes.add('hidden');
global.btnOfferDraw = makeEl('btnOfferDraw'); // без hidden по умолчанию
global.btnResign = makeEl('btnResign'); // без hidden по умолчанию

// --- Остальные зависимости renderBoard()/renderPlayerPanels() — честные
// минимальные заглушки ТОЛЬКО для того, что НЕ относится к самому багу
// (доска/анимация/зрители/модалка конца игры), НЕ для renderPlayerPanels ---
global.ensureBoardBuilt = function () {};
global.captureCapturedPieceSnapshotsBeforeUpdate = function () { return []; };
global.updateBoardPieces = function () {};
global.playMoveGhostAnimation = function () {};
global.renderSpectatorsList = function () {};
global.renderEndGameModal = function () {};
global.showMoveHints = function () {};
global.resetMustCaptureHintTimer = function () {};
global.renderLastMoveArrow = function () {};
global.checkRematchProposal = function () {};
global.checkDrawProposal = function () {};
global.checkOpponentAbsence = function () {};
global.selectedFrom = null;
global.botColor = 'dark';
global.botMoveTimer = null;
global.playerTopName = makeEl('playerTopName');
global.playerBottomName = makeEl('playerBottomName');
global.playerTopCaptured = makeEl('playerTopCaptured');
global.playerBottomCaptured = makeEl('playerBottomCaptured');
global.playerTopStatus = makeEl('playerTopStatus');
global.playerBottomStatus = makeEl('playerBottomStatus');
global.playerTopPanel = makeEl('playerTopPanel');
global.playerBottomPanel = makeEl('playerBottomPanel');
global.renderCapturedIcons = function () {};
global.applyStatusToElement = function () {};
global.statusForColor = function () { return { text: '', cls: '' }; };
global.t = function (k) { return k; };

// РЕАЛЬНЫЕ функции — не заглушки. Именно это и было упущено в прошлых тестах.
eval(extractFunc('renderPlayerPanels'));
global.renderPlayerPanels = renderPlayerPanels;
eval(extractFunc('renderBoard'));

function runScenario(flags) {
    global.myColor = flags.myColor;
    global.isBotGame = flags.isBotGame;
    global.isOnlineGame = flags.isOnlineGame;
    global.isSpectator = flags.isSpectator;
    global.ownerSessionAttached = flags.ownerSessionAttached;
    global.currentState = flags.currentState;
    renderBoard(); // РЕАЛЬНЫЙ renderBoard(), который сам вызывает РЕАЛЬНЫЙ renderPlayerPanels() внутри

    return {
        backBotVisible: !global.btnBackBot.hidden,
        backSpectatorVisible: !global.btnBackSpectator.hidden,
        offerDrawVisible: !global.btnOfferDraw.hidden,
        resignVisible: !global.btnResign.hidden
    };
}

function countBackButtons(r) { return (r.backBotVisible ? 1 : 0) + (r.backSpectatorVisible ? 1 : 0); }

console.log('===== ИНТЕГРАЦИОННЫЙ ТЕСТ: renderBoard() -> renderPlayerPanels() -> итоговый DOM =====');
console.log('(используются РЕАЛЬНЫЕ функции, не заглушки — именно то взаимодействие, где жил баг)');
console.log('');

console.log('--- 1. SYNCED BOT OWNER (основной путь) ---');
{
    const r = runScenario({ myColor: 'light', isBotGame: true, isOnlineGame: false, isSpectator: false, ownerSessionAttached: true, currentState: { pieces: {}, winner: null } });
    console.log(JSON.stringify(r));
    check('1. Ровно 1 кнопка "Назад"', countBackButtons(r) === 1);
    check('1. Это именно btnBackBot', r.backBotVisible === true && r.backSpectatorVisible === false);
}

console.log('');
console.log('--- 2. LEGACY BOT OWNER ---');
{
    const r = runScenario({ myColor: 'dark', isBotGame: true, isOnlineGame: false, isSpectator: false, ownerSessionAttached: false, currentState: { pieces: {}, winner: null } });
    console.log(JSON.stringify(r));
    check('2. Ровно 1 кнопка "Назад"', countBackButtons(r) === 1);
    check('2. Это именно btnBackBot', r.backBotVisible === true && r.backSpectatorVisible === false);
}

console.log('');
console.log('--- 3. SPECTATOR BOT-ПАРТИИ ---');
{
    const r = runScenario({ myColor: null, isBotGame: false, isOnlineGame: true, isSpectator: true, ownerSessionAttached: false, currentState: { pieces: {}, winner: null } });
    console.log(JSON.stringify(r));
    check('3. Ровно 1 кнопка "Назад"', countBackButtons(r) === 1);
    check('3. Это именно btnBackSpectator', r.backSpectatorVisible === true && r.backBotVisible === false);
}

console.log('');
console.log('--- 4. SPECTATOR ОБЫЧНОЙ ONLINE-ПАРТИИ ---');
{
    const r = runScenario({ myColor: null, isBotGame: false, isOnlineGame: true, isSpectator: true, ownerSessionAttached: false, currentState: { pieces: {}, winner: null } });
    console.log(JSON.stringify(r));
    check('4. Ровно 1 кнопка "Назад"', countBackButtons(r) === 1);
    check('4. Это именно btnBackSpectator', r.backSpectatorVisible === true && r.backBotVisible === false);
}

console.log('');
console.log('--- 5. ОБЫЧНЫЙ ONLINE-ИГРОК (light и dark) ---');
{
    const rLight = runScenario({ myColor: 'light', isBotGame: false, isOnlineGame: true, isSpectator: false, ownerSessionAttached: false, currentState: { pieces: {}, winner: null } });
    console.log('light:', JSON.stringify(rLight));
    check('5a. Online player (light): без лишней кнопки "Назад"', countBackButtons(rLight) === 0);

    const rDark = runScenario({ myColor: 'dark', isBotGame: false, isOnlineGame: true, isSpectator: false, ownerSessionAttached: false, currentState: { pieces: {}, winner: null } });
    console.log('dark:', JSON.stringify(rDark));
    check('5b. Online player (dark): без лишней кнопки "Назад"', countBackButtons(rDark) === 0);
}

console.log('');
console.log('--- 6. У SPECTATOR "Сдаться"/"Ничья" СКРЫТЫ ---');
{
    const r = runScenario({ myColor: null, isBotGame: false, isOnlineGame: true, isSpectator: true, ownerSessionAttached: false, currentState: { pieces: {}, winner: null } });
    check('6a. btnOfferDraw скрыта у зрителя', r.offerDrawVisible === false);
    check('6b. btnResign скрыта у зрителя', r.resignVisible === false);
}

console.log('');
console.log('--- 7. У ОБЫЧНОГО ИГРОКА "Сдаться"/"Ничья" ВИДНЫ ---');
{
    const rOnline = runScenario({ myColor: 'light', isBotGame: false, isOnlineGame: true, isSpectator: false, ownerSessionAttached: false, currentState: { pieces: {}, winner: null } });
    check('7a. Online player: btnOfferDraw видна', rOnline.offerDrawVisible === true);
    check('7b. Online player: btnResign видна', rOnline.resignVisible === true);

    const rOwner = runScenario({ myColor: 'light', isBotGame: true, isOnlineGame: false, isSpectator: false, ownerSessionAttached: true, currentState: { pieces: {}, winner: null } });
    check('7c. Synced bot owner: btnOfferDraw видна', rOwner.offerDrawVisible === true);
    check('7d. Synced bot owner: btnResign видна', rOwner.resignVisible === true);
}

// =====================================================================
// Дополнительно: полный перебор всех 16 комбинаций через РЕАЛЬНУЮ цепочку
// =====================================================================
console.log('');
console.log('--- ДОПОЛНИТЕЛЬНО: полный перебор всех 16 комбинаций флагов через РЕАЛЬНУЮ renderBoard()->renderPlayerPanels() ---');
{
    let anyTwoVisible = false;
    let anyBadDrawResignState = false;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) for (let d = 0; d < 2; d++) {
        const combo = { isBotGame: !!a, isSpectator: !!b, ownerSessionAttached: !!c, hasWinner: !!d };
        const r = runScenario({
            myColor: combo.isSpectator ? null : 'light',
            isBotGame: combo.isBotGame, isOnlineGame: true, isSpectator: combo.isSpectator,
            ownerSessionAttached: combo.ownerSessionAttached,
            currentState: { pieces: {}, winner: combo.hasWinner ? 'light' : null }
        });
        if (countBackButtons(r) === 2) anyTwoVisible = true;
        // Сдаться/Ничья должны зависеть ТОЛЬКО от isSpectator, не от остальных трёх флагов
        const expectedDrawResign = !combo.isSpectator;
        if (r.offerDrawVisible !== expectedDrawResign || r.resignVisible !== expectedDrawResign) anyBadDrawResignState = true;
    }
    check('Полный перебор: ни одна из 16 комбинаций не даёт 2 кнопки "Назад"', anyTwoVisible === false);
    check('Полный перебор: Сдаться/Ничья всегда корректно следуют ТОЛЬКО за isSpectator', anyBadDrawResignState === false);
}

console.log('');
console.log('ИТОГ: ' + passed + '/' + (passed + failed));

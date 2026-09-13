// SPECTATOR STATUS + READ-ONLY FINISH FLOW
// Characterization/TDD suite for the real production bugs observed on 2026-09-13.
// Uses functions extracted from production script.js; no copied implementation.
const { SRC, extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(name, condition, detail) {
    console.log((condition ? '  ✅ ' : '  ❌ ') + name + (!condition && detail ? ' — ' + detail : ''));
    if (condition) passed++; else failed++;
}

function fakeClassList(hidden) {
    const s = new Set(hidden ? ['hidden'] : []);
    return {
        add: function (c) { s.add(c); },
        remove: function (c) { s.delete(c); },
        contains: function (c) { return s.has(c); },
        toggle: function (c, force) {
            if (force === true) { s.add(c); return true; }
            if (force === false) { s.delete(c); return false; }
            if (s.has(c)) { s.delete(c); return false; }
            s.add(c); return true;
        }
    };
}

function extractListener(marker) {
    const start = SRC.indexOf(marker);
    if (start < 0) return '';
    const fn = SRC.indexOf('function', start);
    if (fn < 0) return '';
    let brace = SRC.indexOf('{', fn);
    if (brace < 0) return '';
    let i = brace + 1, depth = 1;
    while (i < SRC.length && depth > 0) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') depth--;
        i++;
    }
    return SRC.slice(fn, i);
}

function hasEarlySpectatorGuard(marker) {
    const body = extractListener(marker);
    if (!body) return false;
    const guard = body.search(/if\s*\(\s*isSpectator\s*\)\s*(?:\{\s*)?return\b/);
    if (guard < 0) return false;
    const mutationTokens = ['database.', 'callWorker(', 'submitRated', 'performRematchReset(', 'waitForSettlement'];
    let firstMutation = Infinity;
    mutationTokens.forEach(function (token) {
        const idx = body.indexOf(token);
        if (idx >= 0 && idx < firstMutation) firstMutation = idx;
    });
    return guard < firstMutation;
}

let loadError = null;
try {
    global.CONNECTION_SETTLE_MS = Number(/const CONNECTION_SETTLE_MS = (\d+);/.exec(SRC)[1]);
    global.RECONNECT_GRACE_MS = Number(/const RECONNECT_GRACE_MS = (\d+);/.exec(SRC)[1]);
    global.PRESENCE_STALE_WARNING_MS = Number(/const PRESENCE_STALE_WARNING_MS = (\d+);/.exec(SRC)[1]);
    global.TECHNICAL_WIN_REASON = /const TECHNICAL_WIN_REASON = "([a-z]+)";/.exec(SRC)[1];
    eval(extractFunc('getAuthoritativeAbsenceMs'));
    eval(extractFunc('statusForColor'));
    eval(extractFunc('checkRematchProposal'));
    eval(extractFunc('checkDrawProposal'));
    eval(extractFunc('renderEndGameModal'));
} catch (e) {
    loadError = e && e.message ? e.message : String(e);
}

const NOW = 1700000000000;
let monoNow = 0;
function resetStatusState() {
    global.isOnlineGame = true;
    global.isBotGame = false;
    global.isSpectator = true;
    global.isFirebaseConnected = true;
    global.serverTimeOffsetReady = true;
    global.roomSnapshotSeenSinceConnect = false;
    global.connectedSinceMono = 0;
    monoNow = global.CONNECTION_SETTLE_MS + 1000;
    global.getMonotonicNow = function () { return monoNow; };
    global.getEstimatedServerNow = function () { return NOW; };
    global.t = function (k) { return k; };
    global.currentState = {
        presence: {
            light: { online: true, lastSeen: NOW - 1000, onlineSince: NOW - 60000 },
            dark: { online: true, lastSeen: NOW - 1000, onlineSince: NOW - 60000 }
        }
    };
}

function resetProposalUi() {
    global.isOnlineGame = true;
    global.isSpectator = true;
    global.myColor = null;
    global.openCalls = 0;
    global.closeCalls = 0;
    global.openModal = function () { global.openCalls++; };
    global.closeModal = function () { global.closeCalls++; };
    global.t = function (k) { return k; };

    global.rematchRequestModal = { classList: fakeClassList(true) };
    global.rematchRequestText = { textContent: '' };
    global.endGameModal = { querySelector: function () { return { classList: fakeClassList(false) }; } };
    global.endGameText = { textContent: '' };
    global.btnNewGame = { classList: fakeClassList(false) };
    global.btnCloseGame = { classList: fakeClassList(false), textContent: '' };

    global.drawOfferModal = { classList: fakeClassList(true) };
    global.drawOfferText = { textContent: '' };
    global.btnDrawAccept = { classList: fakeClassList(false) };
    global.btnDrawDecline = { classList: fakeClassList(false) };
    global.btnDrawCancel = { classList: fakeClassList(false) };
}

function resetEndGameUi(asSpectator) {
    global.isOnlineGame = true;
    global.isBotGame = false;
    global.isSpectator = !!asSpectator;
    global.localOnlyBotGame = false;
    global.myTelegramId = asSpectator ? 'VIEWER' : 'WINNER';
    global.roomCode = 'ROOM1';
    global.currentBotMatchId = null;
    global.currentState = {
        winner: 'light',
        winReason: 'resign',
        moveCount: 10,
        matchNumber: 0,
        players: {
            light: { id: 'WINNER', name: 'Tatiana' },
            dark: { id: 'LOSER', name: 'Marina' }
        }
    };
    global.endGameText = { textContent: '' };
    global.endGameSubtext = { textContent: '' };
    global.endGameRating = { textContent: '' };
    const buttons = { classList: fakeClassList(false) };
    global.endGameModal = {
        classList: fakeClassList(false),
        querySelector: function () { return buttons; }
    };
    global.btnNewGame = { classList: fakeClassList(false) };
    global.btnCloseGame = { classList: fakeClassList(false), textContent: '' };
    global.lastSettlementDisplay = { confirmed: true, before: 1110, after: 1125, delta: 15 };
    global.endGameShownForRoom = 'ROOM1_0_10';
    global.statsRecordedForRoom = 'ROOM1_0_10';
    global.statsInFlightForRoom = null;
    global.statsInFlightOnlineMarker = null;
    global.playWinSound = function () {};
    global.recordGameResult = function () {};
    global.openModal = function () {};
    global.closeModal = function () {};
    const dict = {
        whites: 'Whites', blacks: 'Blacks', btn_to_menu: 'To menu', btn_close: 'Close',
        win_reason_disconnect: 'Opponent did not return',
        win_reason_resign_win: 'Opponent resigned. You won.',
        win_reason_resign_loss: 'You resigned. Opponent won.',
        resign_result_label: 'Resignation', winner_label: 'Winner',
        rating_change_unconfirmed: 'Rating change unconfirmed', rating_check_in_stats: 'Check in stats'
    };
    global.t = function (k) { return Object.prototype.hasOwnProperty.call(dict, k) ? dict[k] : k; };
}

(function main() {
    if (loadError) {
        check('0. spectator functions load from production script.js', false, loadError);
        console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
        process.exitCode = 1;
        return;
    }

    console.log('1. SPECTATOR PRESENCE DISPLAY');
    resetStatusState();
    let st = statusForColor('dark');
    check('1.1 stable read-only spectator sees online player as in-game',
        st.cls === 'status-online' && st.text === 'status_in_game', JSON.stringify(st));

    resetStatusState();
    monoNow = global.CONNECTION_SETTLE_MS - 1;
    st = statusForColor('dark');
    check('1.2 spectator still connecting before stable-connection threshold',
        st.cls === 'status-neutral' && st.text === 'status_connecting', JSON.stringify(st));

    resetStatusState();
    global.isSpectator = false;
    st = statusForColor('dark');
    check('1.3 player reconnect safety is NOT weakened by spectator exception',
        st.cls === 'status-neutral' && st.text === 'status_connecting', JSON.stringify(st));

    resetStatusState();
    global.currentState.presence.dark = {
        online: false,
        absentSince: NOW - 30000,
        lastSeen: NOW - 30000
    };
    st = statusForColor('dark');
    check('1.4 stable spectator sees the same offline countdown class',
        st.cls === 'status-countdown' && /^status_offline\s+\d+sec$/.test(st.text), JSON.stringify(st));

    console.log('2. SPECTATOR MUST NOT RECEIVE DECISION MODALS');
    resetProposalUi();
    global.currentState = { winner: 'light', rematchProposal: { by: 'light', name: 'Tatiana' } };
    checkRematchProposal();
    check('2.1 rematch proposal is suppressed for spectator', global.openCalls === 0 && global.closeCalls >= 1,
        'open=' + global.openCalls + ', close=' + global.closeCalls);

    resetProposalUi();
    global.currentState = { winner: null, drawProposal: { by: 'light', name: 'Tatiana' } };
    checkDrawProposal();
    check('2.2 draw proposal is suppressed for spectator', global.openCalls === 0 && global.closeCalls >= 1,
        'open=' + global.openCalls + ', close=' + global.closeCalls);

    console.log('3. DEFENSE-IN-DEPTH: SPECTATOR NEVER ENTERS MUTATION HANDLERS');
    [
        'btnOfferDraw.addEventListener',
        'btnDrawAccept.addEventListener',
        'btnDrawDecline.addEventListener',
        'btnDrawCancel.addEventListener',
        'btnResignYes.addEventListener',
        'btnNewGame.addEventListener',
        'btnRematchAccept.addEventListener',
        'btnRematchDecline.addEventListener'
    ].forEach(function (marker) {
        check('3.x early spectator guard: ' + marker, hasEarlySpectatorGuard(marker));
    });
    const rematchResetSrc = extractFunc('performRematchReset');
    check('3.9 performRematchReset itself rejects spectator',
        /if\s*\(\s*isSpectator\s*\)/.test(rematchResetSrc));
    check('3.10 reactions remain read-only for spectator',
        /function sendReaction\([^)]*\)\s*\{\s*if\s*\(isSpectator\)\s*return;/.test(SRC));

    console.log('4. RESIGN RESULT TEXT + RATING');
    resetEndGameUi(false);
    renderEndGameModal();
    check('4.1 winning player gets explicit resign-win explanation',
        global.endGameSubtext.textContent === 'Opponent resigned. You won.', global.endGameSubtext.textContent);
    check('4.2 winning player keeps existing confirmed Elo delta',
        global.endGameRating.textContent === '⭐1110 → 1125  (+15)', global.endGameRating.textContent);

    resetEndGameUi(true);
    renderEndGameModal();
    check('4.3 spectator gets named, neutral resign result',
        global.endGameSubtext.textContent === 'Resignation: Marina. Winner: Tatiana.', global.endGameSubtext.textContent);
    check('4.4 spectator never gets somebody else\'s Elo delta', global.endGameRating.textContent === '', global.endGameRating.textContent);

    console.log('5. EXISTING SPECTATOR LIFECYCLE MUST STAY INTACT');
    const renderEndSrc = extractFunc('renderEndGameModal');
    const watchSrc = extractFunc('watchGroupRoomAsSpectator');
    check('5.1 cleared winner closes end-game modal so rematch board can reappear',
        /else\s*\{\s*closeModal\(endGameModal\);\s*\}/.test(renderEndSrc));
    check('5.2 deleted room returns spectator to menu',
        /if\s*\(!room\s*\|\|\s*!room\.pieces\)[\s\S]*?showScreen\(menuScreen\)/.test(watchSrc));

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    if (failed) process.exitCode = 1;
})();

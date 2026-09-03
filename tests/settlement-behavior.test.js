// Behavioral execution tests for the rated settlement client flow.
// The suite extracts the real production functions from ../script.js and
// executes them in an isolated harness with only network/timer/UI boundaries
// stubbed. Production code itself is not copied or rewritten here.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, condition, info) {
    if (condition) {
        passed++;
        console.log('  ✅ ' + name);
    } else {
        failed++;
        console.log('  ❌ ' + name + (info ? ' — ' + info : ''));
    }
}

function grabFunction(name) {
    const m = new RegExp('^function ' + name + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена production-функция ' + name);
    return m[0];
}

function grabConst(name) {
    const m = new RegExp('^const ' + name + ' = [\\s\\S]*?;\\n', 'm').exec(SRC);
    if (!m) throw new Error('не найдена production-константа ' + name);
    return m[0];
}

const PRODUCTION = [
    grabConst('SETTLEMENT_TERMINAL_ERRORS'),
    grabConst('SETTLE_BACKOFF_MS'),
    grabConst('SETTLE_BACKOFF_MAX_MS'),
    grabFunction('ratedGenerationKey'),
    grabFunction('buildEloMatchId'),
    grabFunction('freezeSettlementContext'),
    grabFunction('workerErrorCode'),
    grabFunction('isSettlementTerminalError'),
    grabFunction('getSettlePhase'),
    grabFunction('isSettlementSettled'),
    grabFunction('finishOnlineResultMarkerForGeneration'),
    grabFunction('requestSettlement'),
    grabFunction('applySettlementResult')
].join('\n');

function makeHarness() {
    const factory = new Function('productionSource', `
        return (function () {
            let currentState = null;
            let roomCode = null;
            let myTelegramId = null;
            let isSpectator = false;
            let ratedJoinState = {};
            let settleState = {};
            let lastSettlementDisplay = null;
            let statsInFlightOnlineMarker = null;
            let statsRecordedForRoom = null;
            let firebaseAllowed = true;
            let renderCount = 0;
            const workerCalls = [];
            const workerQueue = [];
            const timers = [];

            function canUseFirebase() { return firebaseAllowed; }
            function getRatedJoinPhase(key) {
                const st = ratedJoinState[key];
                return st ? st.phase : 'idle';
            }
            function expectedRatedMatchIdForState(state, code) {
                if (!state || !code || typeof state.createdAt !== 'number') return null;
                return buildEloMatchId(code, state.createdAt, state.matchNumber);
            }
            function registeredMatchIdForState(state, code) {
                if (!state || !code) return null;
                const rs = state.ratingsAtStart;
                if (!rs || typeof rs.light !== 'number' || typeof rs.dark !== 'number') return null;
                const expected = expectedRatedMatchIdForState(state, code);
                if (!expected || state.ratedMatchId !== expected) return null;
                return expected;
            }
            function callWorker(workerPath, payload) {
                workerCalls.push({ path: workerPath, payload: payload });
                if (workerQueue.length === 0) {
                    return Promise.reject(new Error('unexpected_extra_call'));
                }
                const item = workerQueue.shift();
                if (item.type === 'deferred') return item.deferred.promise;
                if (item.type === 'reject') return Promise.reject(item.error);
                return Promise.resolve(item.value);
            }
            function setTimeout(fn, ms) {
                timers.push({ fn: fn, ms: ms });
                return timers.length;
            }
            function renderEndGameModal() { renderCount++; }

            eval(productionSource);

            function keyNow() {
                return ratedGenerationKey(roomCode,
                    currentState && currentState.matchNumber,
                    currentState && currentState.createdAt);
            }
            function canonicalMatchId(state, code) {
                return buildEloMatchId(code, state.createdAt, state.matchNumber);
            }
            function setGame(opts) {
                roomCode = opts.roomCode || 'ROOM1';
                myTelegramId = opts.myUid || 'u-light';
                isSpectator = !!opts.spectator;
                currentState = {
                    matchNumber: opts.matchNumber === undefined ? 1 : opts.matchNumber,
                    createdAt: opts.createdAt === undefined ? 1000 : opts.createdAt,
                    ratedMatchId: null,
                    ratingsAtStart: {
                        light: opts.lightRating === undefined ? 1200 : opts.lightRating,
                        dark: opts.darkRating === undefined ? 1300 : opts.darkRating
                    },
                    players: {
                        light: { id: opts.lightUid || 'u-light', name: 'Light' },
                        dark: { id: opts.darkUid || 'u-dark', name: 'Dark' }
                    },
                    winner: opts.winner || 'light',
                    status: 'finished'
                };
                currentState.ratedMatchId = canonicalMatchId(currentState, roomCode);
                const key = keyNow();
                ratedJoinState[key] = { phase: 'success', attempts: 0, matchId: currentState.ratedMatchId };
                return key;
            }
            function changeGeneration(matchNumber, createdAt) {
                currentState = Object.assign({}, currentState, {
                    matchNumber: matchNumber,
                    createdAt: createdAt === undefined ? currentState.createdAt : createdAt
                });
                currentState.ratedMatchId = canonicalMatchId(currentState, roomCode);
                const key = keyNow();
                ratedJoinState[key] = { phase: 'success', attempts: 0, matchId: currentState.ratedMatchId };
                return key;
            }
            function deferred() {
                let resolve, reject;
                const promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
                return { promise: promise, resolve: resolve, reject: reject };
            }

            return {
                setGame,
                changeGeneration,
                requestSettlement,
                applySettlementResult,
                freezeSettlementContext,
                keyNow,
                queueSuccess: function (value) { workerQueue.push({ type: 'resolve', value: value }); },
                queueReject: function (message) { workerQueue.push({ type: 'reject', error: new Error(message) }); },
                queueDeferred: function () {
                    const d = deferred();
                    workerQueue.push({ type: 'deferred', deferred: d });
                    return d;
                },
                runNextTimer: function () {
                    const t = timers.shift();
                    if (t) t.fn();
                    return t;
                },
                setFirebaseAllowed: function (v) { firebaseAllowed = !!v; },
                setSpectator: function (v) { isSpectator = !!v; },
                setMarker: function (v) { statsInFlightOnlineMarker = v; },
                setDisplay: function (v) { lastSettlementDisplay = v; },
                get: function () {
                    return {
                        currentState,
                        roomCode,
                        workerCalls: workerCalls.slice(),
                        timers: timers.slice(),
                        settleState: JSON.parse(JSON.stringify(settleState)),
                        ratedJoinState: JSON.parse(JSON.stringify(ratedJoinState)),
                        display: lastSettlementDisplay && JSON.parse(JSON.stringify(lastSettlementDisplay)),
                        marker: statsInFlightOnlineMarker,
                        recordedMarker: statsRecordedForRoom,
                        renderCount
                    };
                }
            };
        })();
    `);
    return factory(PRODUCTION);
}

function flush() {
    return new Promise(function (resolve) { setImmediate(resolve); });
}

(async function main() {
    console.log('=== SETTLEMENT BEHAVIOR ===');

    // 1. Success, light attribution, completed guard and marker finalization.
    {
        const h = makeHarness();
        const key = h.setGame({ myUid: 'u-light', lightRating: 1200, darkRating: 1300 });
        h.setMarker('marker-light');
        h.queueSuccess({ ratingConfirmed: true, deltas: { light: 17, dark: -17 } });
        h.requestSettlement();
        await flush();
        const s = h.get();
        check('1.1 success sends exactly one /rated/settle', s.workerCalls.length === 1 && s.workerCalls[0].path === '/rated/settle');
        check('1.2 success sends frozen roomCode + canonical matchId', s.workerCalls[0].payload.roomCode === 'ROOM1' && /^elo_ROOM1_1000_1$/.test(s.workerCalls[0].payload.matchId));
        check('1.3 success -> completed', s.settleState[key] && s.settleState[key].phase === 'completed');
        check('1.4 light attribution uses light delta', s.display && s.display.confirmed === true && s.display.before === 1200 && s.display.delta === 17 && s.display.after === 1217);
        check('1.5 success finalizes current UI marker', s.marker === null && s.recordedMarker === 'marker-light');
        h.requestSettlement();
        await flush();
        check('1.6 completed never sends another settlement', h.get().workerCalls.length === 1);
    }

    // 2. Dark attribution must come from frozen UID->color, not a mutable local color.
    {
        const h = makeHarness();
        h.setGame({ myUid: 'u-dark', lightRating: 1450, darkRating: 1370 });
        h.queueSuccess({ ratingConfirmed: true, deltas: { light: 12, dark: -12 } });
        h.requestSettlement();
        await flush();
        const d = h.get().display;
        check('2.1 dark attribution uses dark before', d && d.before === 1370);
        check('2.2 dark attribution uses dark delta', d && d.delta === -12 && d.after === 1358);
    }

    // 3. Valid response without authoritative rating confirmation.
    {
        const h = makeHarness();
        const key = h.setGame({ myUid: 'u-light', lightRating: 1111 });
        h.queueSuccess({ ratingConfirmed: false, deltas: { light: 99, dark: -99 } });
        h.requestSettlement();
        await flush();
        const s = h.get();
        check('3.1 ratingConfirmed:false is still a completed server response', s.settleState[key] && s.settleState[key].phase === 'completed');
        check('3.2 unconfirmed response never invents a delta', s.display && s.display.confirmed === false && s.display.before === 1111 && !Object.prototype.hasOwnProperty.call(s.display, 'delta'));
    }

    // 4. Temporary failure schedules exact first backoff and retries to success.
    {
        const h = makeHarness();
        const key = h.setGame({});
        h.setMarker('retry-marker');
        h.queueReject('db_read_failed');
        h.queueSuccess({ ratingConfirmed: true, deltas: { light: 5, dark: -5 } });
        h.requestSettlement();
        await flush();
        let s = h.get();
        check('4.1 transient error -> retryWait', s.settleState[key] && s.settleState[key].phase === 'retryWait');
        check('4.2 transient error releases in-flight UI marker', s.marker === null);
        check('4.3 first retry uses production 1000ms backoff', s.timers.length === 1 && s.timers[0].ms === 1000);
        h.runNextTimer();
        await flush();
        s = h.get();
        check('4.4 retry sends a second request', s.workerCalls.length === 2);
        check('4.5 retry can complete successfully', s.settleState[key] && s.settleState[key].phase === 'completed' && s.display && s.display.confirmed === true);
    }

    // 5. Terminal failure is final and never schedules a retry.
    {
        const h = makeHarness();
        const key = h.setGame({ lightRating: 1234 });
        h.queueReject('card_mismatch');
        h.requestSettlement();
        await flush();
        const s = h.get();
        check('5.1 terminal error -> terminalFailed', s.settleState[key] && s.settleState[key].phase === 'terminalFailed');
        check('5.2 terminal error schedules no timer', s.timers.length === 0);
        check('5.3 terminal error renders honest unconfirmed state', s.display && s.display.confirmed === false && s.display.before === 1234);
        h.requestSettlement();
        await flush();
        check('5.4 terminalFailed never sends another settlement', h.get().workerCalls.length === 1);
    }

    // 6. Parallel calls while the first request is unresolved are coalesced.
    {
        const h = makeHarness();
        const key = h.setGame({});
        const d = h.queueDeferred();
        h.requestSettlement();
        h.requestSettlement();
        let s = h.get();
        check('6.1 inFlight guard prevents a second HTTP call', s.workerCalls.length === 1);
        check('6.2 unresolved request is visibly inFlight', s.settleState[key] && s.settleState[key].phase === 'inFlight');
        d.resolve({ ratingConfirmed: true, deltas: { light: 1, dark: -1 } });
        await flush();
        check('6.3 deferred request completes normally', h.get().settleState[key].phase === 'completed');
    }

    // 7. Late response from generation N must not touch generation N+1 UI.
    {
        const h = makeHarness();
        const oldKey = h.setGame({ matchNumber: 1, createdAt: 9000, lightRating: 1000 });
        h.setMarker('old-marker');
        h.setDisplay({ confirmed: true, before: 2000, after: 2007, delta: 7 });
        const d = h.queueDeferred();
        h.requestSettlement();
        const newKey = h.changeGeneration(2, 9000);
        h.setMarker('new-marker');
        const before = h.get().display;
        d.resolve({ ratingConfirmed: true, deltas: { light: 30, dark: -30 } });
        await flush();
        const s = h.get();
        check('7.1 old request may finish only its own generation state', s.settleState[oldKey] && s.settleState[oldKey].phase === 'completed' && oldKey !== newKey);
        check('7.2 stale success does not consume new generation marker', s.marker === 'new-marker');
        check('7.3 stale success does not overwrite current UI rating', JSON.stringify(s.display) === JSON.stringify(before));
        check('7.4 stale success does not render the new generation modal', s.renderCount === 0);
    }

    // 8. A scheduled retry from an old generation must die before a new HTTP call.
    {
        const h = makeHarness();
        const oldKey = h.setGame({ matchNumber: 4, createdAt: 7777 });
        h.queueReject('db_write_failed');
        h.requestSettlement();
        await flush();
        const timer = h.get().timers[0];
        h.changeGeneration(5, 7777);
        h.runNextTimer();
        await flush();
        const s = h.get();
        check('8.1 old generation stays retryWait after becoming stale', s.settleState[oldKey] && s.settleState[oldKey].phase === 'retryWait');
        check('8.2 stale scheduled retry sends no second request', s.workerCalls.length === 1 && timer && timer.ms === 1000);
    }

    // 9. Entry guards: no auth / spectator must not call Worker.
    {
        const h = makeHarness();
        h.setGame({});
        h.setFirebaseAllowed(false);
        h.queueSuccess({ ratingConfirmed: true, deltas: { light: 1, dark: -1 } });
        h.requestSettlement();
        await flush();
        check('9.1 canUseFirebase=false blocks settlement', h.get().workerCalls.length === 0);
    }
    {
        const h = makeHarness();
        h.setGame({ spectator: true });
        h.queueSuccess({ ratingConfirmed: true, deltas: { light: 1, dark: -1 } });
        h.requestSettlement();
        await flush();
        check('9.2 spectator blocks settlement', h.get().workerCalls.length === 0);
    }

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})().catch(function (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
});

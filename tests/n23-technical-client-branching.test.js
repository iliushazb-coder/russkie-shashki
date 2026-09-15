const fs = require("fs");
const vm = require("vm");

const lines = fs.readFileSync("script.js", "utf8").split("\n");
let passed = 0;
let failed = 0;

function ok(cond, name, info) {
    if (cond) { passed++; console.log("✅ " + name); }
    else { failed++; console.log("❌ " + name + (info !== undefined ? "  — " + info : "")); }
}

function extractByLineAnchors(startAnchor, endAnchor) {
    const startIdx = lines.findIndex((l) => l.startsWith(startAnchor));
    const endIdx = lines.findIndex((l, i) => i > startIdx && l.startsWith(endAnchor));
    if (startIdx < 0 || endIdx < 0) return "";
    return lines.slice(startIdx, endIdx).join("\n");
}

// ============================================================
// writeTechnicalResult(): rated -> submitRatedTechnicalClaim (не прямая
// запись); registration-in-flight -> fail closed, ничего не пишет вовсе;
// true unrated -> legacy прямая запись, без изменений (regression).
// ============================================================

const wtrText = extractByLineAnchors("function writeTechnicalResult(", "function submitRatedTechnicalClaim(");
ok(!!wtrText, "1. найден writeTechnicalResult целиком");

function baseContext(overrides) {
    const events = [];
    const ctx = Object.assign({
        canUseFirebase: () => true,
        isOnlineGame: true, isBotGame: false, isSpectator: false,
        roomCode: "ABC123",
        currentState: {
            players: { light: { id: "tg_111" }, dark: { id: "tg_222" } },
            presence: {
                light: { online: true, onlineSince: 1_700_000_000_000 },
                dark: { online: false, absentSince: 1_700_000_000_000 }
            }
        },
        myTelegramId: "tg_111", myColor: "light",
        isFirebaseConnected: true,
        canTrustAbsenceForCleanup: () => true,
        getAuthoritativeAbsenceMs: () => 70000,
        getOnlineSessionMs: () => 70000,
        RECONNECT_GRACE_MS: 60000,
        technicalResultInFlight: false,
        TECHNICAL_WIN_REASON: "disconnect",
        ratedJoinState: {},
        currentRatedGenerationKey: () => "gen-key",
        submitRatedTechnicalClaim: function (matchId, loserColor, reason) { events.push(["submitRatedTechnicalClaim", matchId, loserColor, reason]); },
        database: { ref: function () { return { update: function () { events.push(["directWrite"]); return { then: function () { return { catch: function () {} }; } }; } }; } },
        firebase: { database: { ServerValue: { TIMESTAMP: "SV" } } }
    }, overrides);
    ctx._events = events;
    return ctx;
}

{
    const ctx = baseContext({ currentState: Object.assign({}, baseContext().currentState, { ratedMatchId: "elo_ABC123_1700000000000_0" }) });
    const fn = vm.runInNewContext("(function(){ " + wtrText + "\nreturn writeTechnicalResult; })()", ctx);
    fn("dark");
    ok(ctx._events.some((e) => e[0] === "submitRatedTechnicalClaim"), "2. rated: вызывает submitRatedTechnicalClaim, не прямую запись");
    ok(!ctx._events.some((e) => e[0] === "directWrite"), "3. rated: НЕ пишет room.result напрямую");
}

{
    const cs = baseContext().currentState; // без ratedMatchId
    const ctx = baseContext({ currentState: cs, ratedJoinState: { "gen-key": { phase: "inFlight" } } });
    const fn = vm.runInNewContext("(function(){ " + wtrText + "\nreturn writeTechnicalResult; })()", ctx);
    const result = fn("dark");
    ok(ctx._events.length === 0, "4. registration-in-flight: fail closed, ничего не пишет и не вызывает Worker", "события: " + JSON.stringify(ctx._events));
    ok(result === false, "5. registration-in-flight: возвращает false (не 'в процессе', а честный отказ)");
}

{
    const ctx = baseContext(); // без ratedMatchId, без ratedJoinState -- true unrated
    const fn = vm.runInNewContext("(function(){ " + wtrText + "\nreturn writeTechnicalResult; })()", ctx);
    fn("dark");
    ok(ctx._events.some((e) => e[0] === "directWrite"), "6. true unrated: legacy прямая запись сохранена (regression)");
    ok(!ctx._events.some((e) => e[0] === "submitRatedTechnicalClaim"), "7. true unrated: НЕ вызывает Worker-путь");
}

// ============================================================
// checkTimeout(): та же rated/fail-closed/legacy развилка.
// ============================================================

const ctText = extractByLineAnchors("function checkTimeout() {", "// ===== ПРИСОЕДИНЕНИЕ ПО ССЫЛКЕ =====");
ok(!!ctText, "8. найден checkTimeout целиком");

function timeoutContext(overrides) {
    const events = [];
    const ctx = Object.assign({
        isSpectator: false, isOnlineGame: true,
        currentState: { timeControlSeconds: 30, turnStartedAt: 1_700_000_000_000, turn: "dark" },
        canUseFirebase: () => true,
        serverTimeOffsetReady: true,
        getEstimatedServerNow: () => 1_700_000_100_000, // +100s, well past 30s control
        isFirebaseConnected: true,
        roomCode: "ABC123",
        ratedJoinState: {},
        currentRatedGenerationKey: () => "gen-key",
        submitRatedTechnicalClaim: function (matchId, loser, reason) { events.push(["submitRatedTechnicalClaim", matchId, loser, reason]); },
        database: { ref: function () { return { transaction: function () { events.push(["directTransaction"]); return { catch: function () {} }; } }; } }
    }, overrides);
    ctx._events = events;
    return ctx;
}

{
    const ctx = timeoutContext({ currentState: Object.assign({}, timeoutContext().currentState, { ratedMatchId: "elo_ABC123_1700000000000_0" }) });
    const fn = vm.runInNewContext("(function(){ " + ctText + "\nreturn checkTimeout; })()", ctx);
    fn();
    ok(ctx._events.some((e) => e[0] === "submitRatedTechnicalClaim" && e[3] === "timeout"), "9. rated: вызывает submitRatedTechnicalClaim(reason='timeout')");
    ok(!ctx._events.some((e) => e[0] === "directTransaction"), "10. rated: НЕ запускает прямую whole-room транзакцию");
}

{
    const ctx = timeoutContext({ ratedJoinState: { "gen-key": { phase: "retryWait" } } });
    const fn = vm.runInNewContext("(function(){ " + ctText + "\nreturn checkTimeout; })()", ctx);
    fn();
    ok(ctx._events.length === 0, "11. registration-in-flight: fail closed, ничего не пишет", "события: " + JSON.stringify(ctx._events));
}

{
    const ctx = timeoutContext();
    const fn = vm.runInNewContext("(function(){ " + ctText + "\nreturn checkTimeout; })()", ctx);
    fn();
    ok(ctx._events.some((e) => e[0] === "directTransaction"), "12. true unrated: legacy транзакция сохранена (regression)");
    ok(!ctx._events.some((e) => e[0] === "submitRatedTechnicalClaim"), "13. true unrated: НЕ вызывает Worker-путь");
}


// ============================================================
// U-Y (№23 disconnect latch). checkOpponentAbsence() взводит
// opponentAbsenceHandled сразу, как только rated claim ОТПРАВЛЕН (иначе
// запрос уходил бы каждую секунду). Но при НЕ-окончательной ошибке
// (db_read_failed/db_write_failed/сеть) исход попытки неизвестен, а latch
// уже взведён -- и disconnect не пере-проверялся бы НИКОГДА до смены
// комнаты. Legacy unrated-путь такой сброс уже имел: это была асимметрия.
// ============================================================

const asyncChecks = [];

const srtcText = extractByLineAnchors("function submitRatedTechnicalClaim(", "function getOpponentAbsenceMs(");
ok(!!srtcText, "U0. найден submitRatedTechnicalClaim целиком");

const coaText = extractByLineAnchors("function checkOpponentAbsence(", "function getAuthoritativeAbsenceMs(");
ok(!!coaText, "U1. найден checkOpponentAbsence целиком");

// Durable pending-store с теми же семантиками, что в проде даёт связка
// generateNonTurnRequestId + clearPendingRatedActionId: повторный вызов
// ПЕРЕИСПОЛЬЗУЕТ сохранённый id, пока его явно не очистили.
function claimContext(errorCode, resolveInstead) {
    const events = [];
    const pending = {};
    const DEFINITIVE = ["stale_generation", "match_not_registered", "not_a_participant", "invalid_request_id"];
    const ctx = {
        opponentAbsenceHandled: true, // ровно как его уже взвёл checkOpponentAbsence()
        myColor: "light",
        roomCode: "ABC123",
        currentState: { moveCount: 7 },
        console: { log: function () {} },
        generateNonTurnRequestId: function (color, type, moveCount, matchId) {
            const key = matchId + "|" + type;
            if (pending[key]) return pending[key];
            pending[key] = color + "_" + type + "_" + moveCount + "_r" + (Object.keys(pending).length + 1);
            return pending[key];
        },
        clearPendingRatedActionId: function (matchId, type) {
            events.push(["clearPending", matchId, type]);
            delete pending[matchId + "|" + type];
        },
        isDefinitiveRatedActionOutcome: function (error) {
            return DEFINITIVE.indexOf(error && error.message) !== -1;
        },
        workerErrorCode: function (error) { return error && error.message; },
        _events: events,
        _pending: pending
    };
    ctx.callWorker = function (path, body) {
        events.push(["callWorker", path, body.requestId, body.reason]);
        return resolveInstead ? Promise.resolve({ ok: true }) : Promise.reject(new Error(errorCode));
    };
    return ctx;
}

function runClaim(ctx, reason, matchId) {
    const fn = vm.runInNewContext("(function(){ " + srtcText + "\nreturn submitRatedTechnicalClaim; })()", ctx);
    return fn(matchId, "dark", reason);
}

// checkOpponentAbsence() с уже пройденными absence/trust-условиями:
// единственное, что решает исход -- состояние latch.
function absenceTickContext(latch) {
    const ctx = {
        opponentAbsenceHandled: latch,
        isSpectator: false,
        isOnlineGame: true,
        currentState: { presence: {} },
        myColor: "light",
        _wtr: 0,
        getOpponentAbsenceMs: function () { return 999999; },
        canTrustAbsenceForCleanup: function () { return true; },
        RECONNECT_GRACE_MS: 60000,
        console: { log: function () {} }
    };
    ctx.writeTechnicalResult = function () { ctx._wtr++; return true; };
    return ctx;
}

function runAbsenceTick(ctx) {
    const fn = vm.runInNewContext("(function(){ " + coaText + "\nreturn checkOpponentAbsence; })()", ctx);
    fn();
    return ctx._wtr;
}

// ---------- U: rated disconnect, НЕ-окончательная ошибка ----------
{
    const ctx = claimContext("db_read_failed");
    asyncChecks.push(runClaim(ctx, "disconnect", "M1").then(function () {
        ok(ctx.opponentAbsenceHandled === false,
            "U2. rated disconnect + non-definitive error: opponentAbsenceHandled сброшен в false",
            "получено: " + ctx.opponentAbsenceHandled);
        ok(!ctx._events.some((e) => e[0] === "clearPending"),
            "U3. rated disconnect + non-definitive error: pending requestId НЕ очищен");
        ok(runAbsenceTick(absenceTickContext(ctx.opponentAbsenceHandled)) === 1,
            "U4. со снятым latch следующий absence tick снова доходит до technical claim");

        return runClaim(ctx, "disconnect", "M1").then(function () {
            const calls = ctx._events.filter((e) => e[0] === "callWorker");
            ok(calls.length === 2,
                "U5. повторный claim действительно ушёл на /rated/claim-technical", "вызовов: " + calls.length);
            ok(calls[0][2] === calls[1][2],
                "U6. retry переиспользует ТОТ ЖЕ durable requestId, а не новый",
                calls[0][2] + " vs " + calls[1][2]);
        });
    }).catch(function (e) {
        ok(false, "U2-U6. непойманная ошибка в сценарии", e && e.message);
    }));
}

// ---------- V: rated disconnect SUCCESS ----------
{
    const ctx = claimContext(null, true);
    asyncChecks.push(runClaim(ctx, "disconnect", "M2").then(function () {
        ok(ctx.opponentAbsenceHandled === true,
            "V1. rated disconnect SUCCESS: opponentAbsenceHandled остаётся true (latch не снимается)",
            "получено: " + ctx.opponentAbsenceHandled);
        ok(ctx._events.some((e) => e[0] === "clearPending" && e[2] === "technical_disconnect"),
            "V2. rated disconnect SUCCESS: pending requestId очищен");
        ok(runAbsenceTick(absenceTickContext(ctx.opponentAbsenceHandled)) === 0,
            "V3. при взведённом latch лишний disconnect claim до нового room-state не запускается");
    }).catch(function (e) {
        ok(false, "V1-V3. непойманная ошибка в сценарии", e && e.message);
    }));
}

// ---------- W: rated disconnect, ОКОНЧАТЕЛЬНАЯ ошибка ----------
{
    const ctx = claimContext("stale_generation");
    asyncChecks.push(runClaim(ctx, "disconnect", "M3").then(function () {
        ok(ctx._events.some((e) => e[0] === "clearPending" && e[2] === "technical_disconnect"),
            "W1. rated disconnect + definitive error: pending requestId очищен");
        ok(ctx.opponentAbsenceHandled === true,
            "W2. rated disconnect + definitive error: latch НЕ снимается",
            "получено: " + ctx.opponentAbsenceHandled);
        ok(runAbsenceTick(absenceTickContext(ctx.opponentAbsenceHandled)) === 0,
            "W3. следующий секундный тик НЕ начинает request loop по терминальной ошибке");
    }).catch(function (e) {
        ok(false, "W1-W3. непойманная ошибка в сценарии", e && e.message);
    }));
}

// ---------- X: TIMEOUT regression (правка обязана быть disconnect-specific) ----------
{
    const ctx = claimContext("db_read_failed");
    asyncChecks.push(runClaim(ctx, "timeout", "M4").then(function () {
        ok(ctx.opponentAbsenceHandled === true,
            "X1. TIMEOUT + non-definitive error: opponentAbsenceHandled НЕ трогается",
            "получено: " + ctx.opponentAbsenceHandled);
        ok(!ctx._events.some((e) => e[0] === "clearPending"),
            "X2. TIMEOUT + non-definitive error: pending requestId не очищен (как было)");
        const calls = ctx._events.filter((e) => e[0] === "callWorker");
        ok(calls.length === 1 && calls[0][1] === "/rated/claim-technical" && calls[0][3] === "timeout",
            "X3. TIMEOUT по-прежнему уходит своим существующим путём");
    }).catch(function (e) {
        ok(false, "X1-X3. непойманная ошибка в сценарии", e && e.message);
    }));
}

{
    const ctx = claimContext("stale_generation");
    asyncChecks.push(runClaim(ctx, "timeout", "M5").then(function () {
        ok(ctx._events.some((e) => e[0] === "clearPending" && e[2] === "technical_timeout"),
            "X4. TIMEOUT + definitive error: pending очищается ровно как прежде");
        ok(ctx.opponentAbsenceHandled === true,
            "X5. TIMEOUT + definitive error: disconnect latch не вмешивается");
    }).catch(function (e) {
        ok(false, "X4-X5. непойманная ошибка в сценарии", e && e.message);
    }));
}

// ---------- Y: legacy / unrated disconnect regression ----------
{
    const ctx = baseContext({ currentState: baseContext().currentState }); // без ratedMatchId
    const fn = vm.runInNewContext("(function(){ " + wtrText + "\nreturn writeTechnicalResult; })()", ctx);
    const res = fn("dark");
    ok(res === true, "Y1. legacy unrated disconnect: writeTechnicalResult по-прежнему возвращает true");
    ok(ctx._events.some((e) => e[0] === "directWrite"),
        "Y2. legacy unrated disconnect: прямая запись в комнату сохранена (regression)");
    ok(!ctx._events.some((e) => e[0] === "submitRatedTechnicalClaim"),
        "Y3. legacy unrated disconnect: Worker-путь НЕ используется");
}

ok(/opponentAbsenceHandled = false;/.test(wtrText),
    "Y4. legacy unrated catch по-прежнему сам сбрасывает latch (ветка не тронута, симметрия сохранена)");

Promise.all(asyncChecks).then(function () {
    console.log("\nИТОГ: " + passed + "/" + (passed + failed) + ", провалено: " + failed);
    process.exitCode = failed ? 1 : 0;
});

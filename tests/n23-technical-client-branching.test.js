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

console.log("\nИТОГ: " + passed + "/" + (passed + failed) + ", провалено: " + failed);
process.exitCode = failed ? 1 : 0;

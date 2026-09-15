// №23 production investigation: TEMP diagnostic logging added to
// /rated/claim-technical to pin down the exact cause of a real production
// 409 (root cause not yet fixed by this file -- this is observability
// only, to be removed once the real cause is found).
//
// Design under test: REQUEST-SCOPED ctx = { logged: false }, created fresh
// inside handleSettlement() for every HTTP request, passed through the
// whole claim-technical call chain (handleSettlement -> claimTechnicalOutcome
// -> commitTerminalOutcome -> classifyExistingTerminalClaim). No
// module-global diagnostic state of any kind -- a prior WeakSet-based
// design was replaced specifically because it could not deduplicate
// primitive/null thrown values, causing a real double-log through the
// full HTTP path (inner withPhase + outer handleSettlement catch).
//
// Driven through the REAL exported Worker functions against an in-memory
// fake RTDB (tests/helpers/fake-rtdb.js) -- no real network, no emulator,
// Rules are NOT applied here. Several tests go through the REAL
// worker.default.fetch(request, env) HTTP entrypoint specifically, because
// the cross-catch dedup invariant can only be proven at that level.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createInitialPieces } = require("../../shared/game-engine.js");
const { createFakeRtdb } = require("../helpers/fake-rtdb.js");

import {
  getServerIdToken,
  joinRatedMatch,
  claimTechnicalOutcome,
  dbGet,
  resetServerTokenCache
} from "../../worker/index.mjs";

const worker = await import("../../worker/index.mjs");

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

const FIREBASE_DB_URL = "https://fake-db.example.com";

function withCapturedDiagnostics(fn) {
  const original = console.error;
  const captured = [];
  console.error = function () { captured.push(Array.prototype.slice.call(arguments)); };
  return Promise.resolve().then(fn).then(
    function (result) { console.error = original; return { result: result, error: null, captured: captured }; },
    function (error) { console.error = original; return { result: null, error: error, captured: captured }; }
  );
}
function diagnosticEventsOnly(captured) {
  return captured.filter(function (args) { return args[0] === "claim_technical_diagnostic"; });
}

// ---------- direct-call (claimTechnicalOutcome) scenario builder ----------
async function setupGenuineDisconnectScenario() {
  resetServerTokenCache();
  const NOW = 1_700_000_000_000;
  let currentNow = NOW;
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, function () { return currentNow; });
  const env = {
    FIREBASE_DB_URL,
    FIREBASE_SERVICE_ACCOUNT_EMAIL: "x@x.iam.gserviceaccount.com",
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "x",
    FIREBASE_WEB_API_KEY: "k"
  };
  const baseFetch = function (url, options) {
    const u = typeof url === "string" ? url : url.url;
    if (u.indexOf("identitytoolkit.googleapis.com") !== -1) {
      return Promise.resolve({
        ok: true, status: 200, headers: { get: function () { return null; } },
        json: function () { return Promise.resolve({ idToken: "fake-server-id-token", expiresIn: 3600 }); }
      });
    }
    return rtdb.fetch(url, options);
  };
  const deps = {
    now: function () { return currentNow; },
    signCustomToken: function () { return Promise.resolve("fake-custom-token"); },
    fetch: baseFetch
  };

  rtdb.store.data = {
    rooms: { ABC123: {
      players: { light: { id: "tg_111", name: "Ilyusha" }, dark: { id: "tg_222", name: "Tatiana" } },
      status: "active", createdAt: NOW, matchNumber: 0,
      pieces: createInitialPieces(), turn: "light", moveCount: 0,
      presence: { light: { online: true, lastSeen: NOW }, dark: { online: true, lastSeen: NOW } }
    } },
    stats: { tg_111: { rating: 1200 }, tg_222: { rating: 1180 } }
  };

  const token = await getServerIdToken(env, deps);
  const join = await joinRatedMatch(env, deps, "tg_111", "ABC123");
  const matchId = join.matchId;

  currentNow += 3 * 60 * 1000;
  const room = rtdb.store.data.rooms.ABC123;
  room.presence.dark = {
    online: false, onlineSince: room.presence.dark.onlineSince,
    absentSince: currentNow - 70000, lastSeen: currentNow - 70000
  };

  const card = await dbGet(env, deps, token, "matches/" + matchId);

  return {
    env: env, deps: deps, rtdb: rtdb, token: token, matchId: matchId, card: card,
    setNow: function (v) { currentNow = v; }, getNow: function () { return currentNow; }
  };
}

// ---------- full HTTP-stack (worker.default.fetch) scenario builder ----------
function cardWithParticipantsHttp(roomCode) {
  return {
    roomCode: roomCode, createdAt: 1_700_000_000_000, matchNumber: 0, replayVersion: 1,
    participants: {
      tg_111: { color: "light", ratingAtJoin: 1200, name: "Alice" },
      tg_222: { color: "dark", ratingAtJoin: 1180, name: "Bob" }
    }
  };
}
function setupFakeGlobalFetchHttp(rtdb, callerUid) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.indexOf("identitytoolkit.googleapis.com/v1/accounts:lookup") !== -1) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ users: [{ localId: callerUid, disabled: false }] }) };
    }
    if (u.indexOf("identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken") !== -1) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ idToken: "fake-server-id-token", expiresIn: 3600 }) };
    }
    return rtdb.fetch(url, options);
  };
  return () => { global.fetch = original; };
}
function makeHttpRequest(body, token) {
  return new Request("https://worker.example.com/rated/claim-technical", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(body)
  });
}
const httpEnv = {
  FIREBASE_DB_URL: "https://fake-db.example.com",
  FIREBASE_SERVICE_ACCOUNT_EMAIL: "test@example.iam.gserviceaccount.com",
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey,
  FIREBASE_WEB_API_KEY: "fake-web-key"
};

async function runHttpClaim(rtdbSeed, callerUid, requestBody, brokenFetchOverride) {
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, () => 1_700_000_100_000);
  rtdb.store.data = rtdbSeed;
  const restore = setupFakeGlobalFetchHttp(rtdb, callerUid);
  if (brokenFetchOverride) {
    const inner = global.fetch;
    global.fetch = async (url, options) => brokenFetchOverride(url, options, inner);
  }
  const original = console.error;
  const captured = [];
  console.error = (...args) => { captured.push(args); };
  try {
    const request = makeHttpRequest(requestBody, "fake-caller-token-long-enough-1234567890");
    const response = await worker.default.fetch(request, httpEnv);
    const data = await response.json();
    return { response, data, captured: diagnosticEventsOnly(captured) };
  } finally {
    console.error = original;
    restore();
  }
}

// =====================================================================
// J. Happy path -> 0 events (direct call)
// =====================================================================
test("J. обычный прямой успешный claim (без единого сбоя) -> 0 diagnostic events", async () => {
  const s = await setupGenuineDisconnectScenario();
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, s.deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-happy", reason: "disconnect" });
  });
  assert.equal(outcome.error, null);
  assert.equal(outcome.result.winner, "light");
  assert.deepEqual(diagnosticEventsOnly(outcome.captured), []);
});

// =====================================================================
// K. Recovered idempotent PATCH failure -> success + 0 events
// =====================================================================
test("K. PATCH fail, recheck находит уже успешно созданный terminal claim -> HTTP-успех, 0 diagnostic events", async () => {
  const s = await setupGenuineDisconnectScenario();
  let patchAttempted = false;
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (options && options.method === "PATCH" && !patchAttempted) {
        patchAttempted = true;
        return s.rtdb.fetch(url, options).then(function () {
          return { ok: false, status: 504, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } };
        });
      }
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-recovered", reason: "disconnect" }, ctx);
  });
  assert.equal(outcome.error, null, "ожидался успех (idempotent recovery)");
  assert.equal(outcome.result.winner, "light");
  assert.deepEqual(diagnosticEventsOnly(outcome.captured), []);
});

// =====================================================================
// L. Empty recheck -> ровно 1 commit_terminal/db_write_failed (status сохранён)
// =====================================================================
test("L. PATCH fail, recheck не находит ничего -> ровно 1 event phase=commit_terminal reason=db_write_failed с сохранённым валидным status", async () => {
  const s = await setupGenuineDisconnectScenario();
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (options && options.method === "PATCH") {
        return Promise.resolve({ ok: false, status: 403, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } });
      }
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-empty-recheck", reason: "disconnect" }, ctx);
  });
  assert.ok(outcome.error);
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "commit_terminal", reason: "db_write_failed", httpStatus: 403 });
});

// F (валидация статуса): невалидный (не-integer / вне диапазона) status -> httpStatus=null, валидный -> проходит.
test("F. commit_terminal/db_write_failed: валидный integer 100..599 status проходит в httpStatus; невалидный -> httpStatus=null", async () => {
  const badStatuses = [
    { value: 0, label: "zero" },
    { value: -1, label: "negative" },
    { value: 700, label: "toohigh" },
    { value: 99, label: "toolow" },
    { value: NaN, label: "nan" },
    { value: 200.5, label: "fractional" }
  ];
  for (const { value: badStatus, label } of badStatuses) {
    const s = await setupGenuineDisconnectScenario();
    const deps = Object.assign({}, s.deps, {
      fetch: function (url, options) {
        const u = typeof url === "string" ? url : url.url;
        if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
        if (options && options.method === "PATCH") {
          return Promise.resolve({ ok: false, status: badStatus, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } });
        }
        return s.rtdb.fetch(url, options);
      }
    });
    const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
      return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-badstatus-" + label, reason: "disconnect" }, ctx);
    });
    const events = diagnosticEventsOnly(outcome.captured);
    assert.equal(events.length, 1);
    assert.equal(events[0][1].phase, "commit_terminal");
    assert.equal(events[0][1].reason, "db_write_failed");
    assert.equal(events[0][1].httpStatus, null, "невалидный status (" + badStatus + ") должен дать httpStatus=null, не сырое значение");
  }
  const s2 = await setupGenuineDisconnectScenario();
  const deps2 = Object.assign({}, s2.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s2.deps.fetch(url, options);
      if (options && options.method === "PATCH") {
        return Promise.resolve({ ok: false, status: 503, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } });
      }
      return s2.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  const outcome2 = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s2.env, deps2, s2.token, s2.matchId, s2.card, "tg_111", { requestId: "req-goodstatus", reason: "disconnect" }, ctx);
  });
  const events2 = diagnosticEventsOnly(outcome2.captured);
  assert.equal(events2[0][1].httpStatus, 503);
});

// =====================================================================
// M. terminal_recheck failure -> ровно 1 terminal_recheck/db_read_failed
// =====================================================================
test("M. PATCH fail, сам recheck тоже падает -> ровно 1 event phase=terminal_recheck reason=db_read_failed", async () => {
  const s = await setupGenuineDisconnectScenario();
  let patchHappened = false;
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (options && options.method === "PATCH") {
        patchHappened = true;
        return Promise.resolve({ ok: false, status: 500, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } });
      }
      if (patchHappened && u.indexOf("ratedTerminal") !== -1 && (!options || !options.method || options.method === "GET")) {
        return Promise.resolve({ ok: false, status: 500, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } });
      }
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-recheck-fails", reason: "disconnect" }, ctx);
  });
  assert.ok(outcome.error);
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "terminal_recheck", reason: "db_read_failed", httpStatus: null });
});

// =====================================================================
// N. Conflicting terminal -> ровно 1 terminal_conflict
// =====================================================================
test("N. уже существующий КОНФЛИКТУЮЩИЙ terminal claim -> ровно 1 event phase=commit_terminal reason=terminal_conflict", async () => {
  const s = await setupGenuineDisconnectScenario();
  await s.rtdb.fetch(FIREBASE_DB_URL + "/ratedTerminal/" + encodeURIComponent(s.matchId) + ".json", {
    method: "PUT",
    body: JSON.stringify({
      matchId: s.matchId, roomCode: "ABC123", source: "technical", kind: "timeout",
      requestId: "OTHER_REQ", winnerId: "tg_999", loserId: "tg_888", seq: "000000", createdAt: s.getNow()
    })
  });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, s.deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-conflict", reason: "disconnect" }, ctx);
  });
  assert.ok(outcome.error);
  assert.equal(outcome.error.message, "terminal_conflict");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "commit_terminal", reason: "terminal_conflict", httpStatus: null });
});

// =====================================================================
// I. match_not_rated -> phase=validate_match_card, ровно 1 event
// =====================================================================
test("I. cardByColor() бросает match_not_rated (малформed card.participants) -> ровно 1 event phase=validate_match_card reason=match_not_rated", async () => {
  const s = await setupGenuineDisconnectScenario();
  const malformedCard = Object.assign({}, s.card, { participants: { onlyOneUid: { color: "light" } } });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, s.deps, s.token, s.matchId, malformedCard, "tg_111", { requestId: "req-badcard", reason: "disconnect" }, ctx);
  });
  assert.ok(outcome.error);
  assert.equal(outcome.error.message, "match_not_rated");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "validate_match_card", reason: "match_not_rated", httpStatus: null });
});

// =====================================================================
// H. app_check_unavailable сохраняется как safe reason
// =====================================================================
test("H. app_check_unavailable (реальный код из dbHeaders()) остаётся собственным safe reason, не unexpected_internal", async () => {
  const s = await setupGenuineDisconnectScenario();
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject(new Error("app_check_unavailable"));
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-appcheck", reason: "disconnect" }, ctx);
  });
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "app_check_unavailable", httpStatus: null });
});

// =====================================================================
// G. message getter читается максимум 1 раз
// =====================================================================
test("G. message getter читается максимум ОДИН раз за диагностируемую ошибку", async () => {
  const s = await setupGenuineDisconnectScenario();
  let messageReadCount = 0;
  const countingErr = {};
  Object.defineProperty(countingErr, "message", { get: function () { messageReadCount++; return "stale_generation"; } });
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject(countingErr);
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-counting-msg", reason: "disconnect" }, ctx);
  });
  assert.equal(messageReadCount, 1, "message getter должен быть прочитан ровно 1 раз");
});

// =====================================================================
// E. unrelated phase -> status getter 0 обращений
// =====================================================================
test("E. status getter НИ РАЗУ не вызывается, если phase/reason не commit_terminal/db_write_failed", async () => {
  const s = await setupGenuineDisconnectScenario();
  let statusReadCount = 0;
  const hostileErr = new Error("stale_generation");
  Object.defineProperty(hostileErr, "status", { get: function () { statusReadCount++; return 500; } });
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject(hostileErr);
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-counting-status", reason: "disconnect" }, ctx);
  });
  assert.equal(statusReadCount, 0, "status getter не должен вызываться вовсе для phase!=commit_terminal");
});

// =====================================================================
// O/Q. match_not_registered early return -> ровно 1 event, HTTP не меняется
// =====================================================================
test("O/Q. HTTP: match_not_registered (early return) -> ровно 1 event phase=read_match_card, HTTP status/body не изменены", async () => {
  const MATCH_ID_HTTP = "elo_ABC123_1700000000000_0";
  const seed = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID_HTTP, status: "active" } },
    matches: { [MATCH_ID_HTTP]: Object.assign(cardWithParticipantsHttp("ABC123"), { roomCode: "SOME_OTHER_ROOM" }) }
  };
  const { response, data, captured } = await runHttpClaim(seed, "tg_111", { roomCode: "ABC123", matchId: MATCH_ID_HTTP, requestId: "http-mnr-1", reason: "disconnect" });
  assert.equal(response.status, 409);
  assert.deepEqual(data, { ok: false, error: "match_not_registered" });
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0][1], { phase: "read_match_card", reason: "match_not_registered", httpStatus: null });
});

// =====================================================================
// A/D. full HTTP path, primitive thrown deep inside -> ровно 1 event
// =====================================================================
test("A/D. HTTP: примитивная строка брошена внутри read_live_room -> ровно 1 diagnostic event на весь HTTP request (не 2)", async () => {
  const MATCH_ID_HTTP = "elo_ABC123_1700000000000_0";
  const seed = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID_HTTP, status: "active", presence: { light: { online: true }, dark: { online: false } } } },
    matches: { [MATCH_ID_HTTP]: cardWithParticipantsHttp("ABC123") }
  };
  const { response, data, captured } = await runHttpClaim(seed, "tg_111",
    { roomCode: "ABC123", matchId: MATCH_ID_HTTP, requestId: "http-primitive-1", reason: "disconnect" },
    async (url, options, inner) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("/rooms/ABC123.json") !== -1 && (!options || !options.method || options.method === "GET")) {
        throw "a_primitive_thrown_value";
      }
      return inner(url, options);
    });
  assert.equal(response.status, 409);
  assert.equal(data.ok, false);
  assert.equal(captured.length, 1, "должно быть РОВНО 1 событие, не 2 (было бы 2 при старом WeakSet-дизайне)");
  assert.deepEqual(captured[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

// =====================================================================
// B. full HTTP path, null/undefined thrown -> ровно 1 event
// =====================================================================
test("B. HTTP: null брошен внутри read_live_room -> ровно 1 diagnostic event", async () => {
  const MATCH_ID_HTTP = "elo_ABC123_1700000000000_0";
  const seed = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID_HTTP, status: "active", presence: { light: { online: true }, dark: { online: false } } } },
    matches: { [MATCH_ID_HTTP]: cardWithParticipantsHttp("ABC123") }
  };
  const { response, captured } = await runHttpClaim(seed, "tg_111",
    { roomCode: "ABC123", matchId: MATCH_ID_HTTP, requestId: "http-null-1", reason: "disconnect" },
    async (url, options, inner) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("/rooms/ABC123.json") !== -1 && (!options || !options.method || options.method === "GET")) {
        throw null;
      }
      return inner(url, options);
    });
  assert.equal(response.status, 409);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

test("B2. HTTP: undefined брошен внутри read_live_room -> ровно 1 diagnostic event", async () => {
  const MATCH_ID_HTTP = "elo_ABC123_1700000000000_0";
  const seed = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID_HTTP, status: "active", presence: { light: { online: true }, dark: { online: false } } } },
    matches: { [MATCH_ID_HTTP]: cardWithParticipantsHttp("ABC123") }
  };
  const { response, captured } = await runHttpClaim(seed, "tg_111",
    { roomCode: "ABC123", matchId: MATCH_ID_HTTP, requestId: "http-undef-1", reason: "disconnect" },
    async (url, options, inner) => {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("/rooms/ABC123.json") !== -1 && (!options || !options.method || options.method === "GET")) {
        throw undefined;
      }
      return inner(url, options);
    });
  assert.equal(response.status, 409);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

// =====================================================================
// C. два разных request ctx + тот же Error object -> по 1 событию на request
// =====================================================================
test("C. одна и та же (переиспользованная) Error-инстанция брошена в ДВУХ независимых HTTP-запросах -> каждый запрос получает СВОЁ 1 событие (нет cross-request suppression)", async () => {
  const sharedErr = new Error("stale_generation");
  const MATCH_ID_HTTP = "elo_ABC123_1700000000000_0";
  const seed = () => ({
    rooms: { ABC123: { ratedMatchId: MATCH_ID_HTTP, status: "active", presence: { light: { online: true }, dark: { online: false } } } },
    matches: { [MATCH_ID_HTTP]: cardWithParticipantsHttp("ABC123") }
  });
  const brokenFetch = async (url, options, inner) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.indexOf("/rooms/ABC123.json") !== -1 && (!options || !options.method || options.method === "GET")) {
      throw sharedErr;
    }
    return inner(url, options);
  };

  const first = await runHttpClaim(seed(), "tg_111", { roomCode: "ABC123", matchId: MATCH_ID_HTTP, requestId: "http-shared-1", reason: "disconnect" }, brokenFetch);
  const second = await runHttpClaim(seed(), "tg_111", { roomCode: "ABC123", matchId: MATCH_ID_HTTP, requestId: "http-shared-2", reason: "disconnect" }, brokenFetch);

  assert.equal(first.captured.length, 1, "первый запрос должен получить своё событие");
  assert.equal(second.captured.length, 1, "второй запрос ДОЛЖЕН тоже получить событие -- не подавлен тем, что тот же Error object уже 'видели' в первом запросе");
  assert.deepEqual(first.captured[0][1], { phase: "read_live_room", reason: "stale_generation", httpStatus: null });
  assert.deepEqual(second.captured[0][1], { phase: "read_live_room", reason: "stale_generation", httpStatus: null });
});

// =====================================================================
// Frozen Error
// =====================================================================
test("Frozen Error, брошенный внутри dbGet -- тот же объект долетает немутированным, ровно 1 event unexpected_internal", async () => {
  const s = await setupGenuineDisconnectScenario();
  const frozenErr = Object.freeze(new Error("weird_native_failure"));
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject(frozenErr);
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-frozen", reason: "disconnect" }, ctx);
  });
  assert.equal(outcome.error, frozenErr);
  assert.equal(Object.isFrozen(frozenErr), true);
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

// =====================================================================
// Proxy с throwing message/status getter
// =====================================================================
test("Proxy с throwing message/status getter-ловушками -- диагностика не падает, не мутирует, 1 event unexpected_internal", async () => {
  const s = await setupGenuineDisconnectScenario();
  const proxyErr = new Proxy({}, {
    get: function (target, prop) {
      if (prop === "message" || prop === "status") throw new Error("proxy trap fired");
      return target[prop];
    }
  });
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject(proxyErr);
      return s.rtdb.fetch(url, options);
    }
  });
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-proxy", reason: "disconnect" }, ctx);
  });
  assert.equal(outcome.error, proxyErr);
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

// =====================================================================
// P. Secret non-leak
// =====================================================================
test("P. диагностический лог никогда не содержит Authorization/токены/requestId/uid/matchId/roomCode/тело запроса; payload строго {phase,reason,httpStatus}", async () => {
  const s = await setupGenuineDisconnectScenario();
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (options && options.method === "PATCH") {
        return Promise.resolve({ ok: false, status: 403, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } });
      }
      return s.rtdb.fetch(url, options);
    }
  });
  const secretRequestId = "req-SECRET-should-never-leak-anywhere";
  const ctx = { logged: false };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: secretRequestId, reason: "disconnect" }, ctx);
  });
  const events = diagnosticEventsOnly(outcome.captured);
  assert.ok(events.length >= 1);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.indexOf(secretRequestId), -1);
  assert.equal(serialized.indexOf(s.matchId), -1);
  assert.equal(serialized.indexOf("tg_111"), -1);
  assert.equal(serialized.indexOf(s.token), -1);
  for (const e of events) {
    assert.deepEqual(Object.keys(e[1]).sort(), ["httpStatus", "phase", "reason"]);
  }
});

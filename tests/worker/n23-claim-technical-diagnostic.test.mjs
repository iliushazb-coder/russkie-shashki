// №23 production investigation: TEMP diagnostic logging added to
// /rated/claim-technical to pin down the exact cause of a real production
// 409 (root cause not yet fixed by this commit -- this file only proves
// the diagnostic logging itself is correct, safe, and does not alter
// business logic/HTTP semantics). Driven through the REAL exported Worker
// functions against an in-memory fake RTDB (tests/helpers/fake-rtdb.js) --
// no real network, no emulator, Rules are NOT applied here.
//
// This whole file, and the TEMP DIAGNOSTIC block it tests in
// worker/index.mjs, should be deleted together once the real production
// root cause has been found and fixed.

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

// Перехватывает console.error за время выполнения fn, возвращает и
// результат/ошибку, и список перехваченных вызовов -- не полагается на
// побочные эффекты снаружи текущего теста.
async function withCapturedDiagnostics(fn) {
  const original = console.error;
  const captured = [];
  console.error = function () { captured.push(Array.prototype.slice.call(arguments)); };
  try {
    const result = await fn();
    return { result, error: null, captured };
  } catch (error) {
    return { result: null, error, captured };
  } finally {
    console.error = original;
  }
}

function diagnosticEventsOnly(captured) {
  return captured.filter(function (args) { return args[0] === "claim_technical_diagnostic"; });
}

// Строит реальную рейтинговую активную комнату через настоящую регистрацию
// (joinRatedMatch), затем сдвигает время на 3 минуты и переводит dark в
// authoritative offline -- ровно тот сценарий, что воспроизводит реальный
// production-repro (3-минутный disconnect, второй игрок online).
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
    env, deps, rtdb, token, matchId, card,
    setNow: function (v) { currentNow = v; },
    getNow: function () { return currentNow; }
  };
}

// ---------- 1. PATCH fail + recovered idempotent success -> 200 и 0 diagnostic logs ----------
test("PATCH fail, recheck находит уже успешно созданный terminal claim -> HTTP-успех, 0 diagnostic events", async () => {
  const s = await setupGenuineDisconnectScenario();
  let patchAttempted = false;
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (options && options.method === "PATCH" && !patchAttempted) {
        patchAttempted = true;
        // PATCH реально применяется на сервере (fake-rtdb фактически
        // коммитит), но КЛИЕНТ получает сетевую ошибку в самом ответе --
        // классический "ложный timeout", ради которого существует recovery.
        return s.rtdb.fetch(url, options).then(function () {
          return { ok: false, status: 504, headers: { get: function () { return null; } }, json: function () { return Promise.resolve({}); } };
        });
      }
      return s.rtdb.fetch(url, options);
    }
  });
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-recovered", reason: "disconnect" });
  });
  assert.equal(outcome.error, null, "ожидался успех (idempotent recovery), а не ошибка");
  assert.equal(outcome.result.winner, "light");
  assert.deepEqual(diagnosticEventsOnly(outcome.captured), [], "успешный идемпотентный recovery не должен создавать diagnostic events");
});

// ---------- 2. PATCH fail + empty recheck -> ровно 1 commit_terminal/db_write_failed ----------
test("PATCH fail, recheck не находит ничего -> ровно 1 event phase=commit_terminal reason=db_write_failed с сохранённым status", async () => {
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
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-empty-recheck", reason: "disconnect" });
  });
  assert.ok(outcome.error, "ожидалась ошибка");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1, "ожидался ровно 1 diagnostic event");
  assert.deepEqual(events[0][1], { phase: "commit_terminal", reason: "db_write_failed", httpStatus: 403 });
});

// ---------- 3. PATCH fail + recheck failure -> ровно 1 terminal_recheck/db_read_failed ----------
test("PATCH fail, сам recheck тоже падает -> ровно 1 event phase=terminal_recheck reason=db_read_failed", async () => {
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
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-recheck-fails", reason: "disconnect" });
  });
  assert.ok(outcome.error);
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "terminal_recheck", reason: "db_read_failed", httpStatus: null });
});

// ---------- 4. Conflicting terminal -> ровно 1 terminal_conflict ----------
test("уже существующий КОНФЛИКТУЮЩИЙ terminal claim (другой requestId/исход) -> ровно 1 event phase=commit_terminal reason=terminal_conflict", async () => {
  const s = await setupGenuineDisconnectScenario();
  await s.rtdb.fetch(FIREBASE_DB_URL + "/ratedTerminal/" + encodeURIComponent(s.matchId) + ".json", {
    method: "PUT",
    body: JSON.stringify({
      matchId: s.matchId, roomCode: "ABC123", source: "technical", kind: "timeout",
      requestId: "OTHER_REQ", winnerId: "tg_999", loserId: "tg_888", seq: "000000", createdAt: s.getNow()
    })
  });
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, s.deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-conflict", reason: "disconnect" });
  });
  assert.ok(outcome.error);
  assert.equal(outcome.error.message, "terminal_conflict");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "commit_terminal", reason: "terminal_conflict", httpStatus: null });
});

// ---------- 5. Direct success -> 0 logs ----------
test("обычный прямой успешный claim (без единого сбоя) -> 0 diagnostic events", async () => {
  const s = await setupGenuineDisconnectScenario();
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, s.deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-happy", reason: "disconnect" });
  });
  assert.equal(outcome.error, null);
  assert.equal(outcome.result.winner, "light");
  assert.deepEqual(diagnosticEventsOnly(outcome.captured), []);
});

// ---------- 6. Explicit classified throw -> ровно 1 log ----------
test("explicit throw (technical_evidence_insufficient -- оба игрока online) -> ровно 1 event phase=verify_evidence", async () => {
  const s = await setupGenuineDisconnectScenario();
  // Возвращаем dark обратно в online -- доказательств недостаточно.
  s.rtdb.store.data.rooms.ABC123.presence.dark = { online: true, onlineSince: s.getNow(), lastSeen: s.getNow() };
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, s.deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-insufficient", reason: "disconnect" });
  });
  assert.ok(outcome.error);
  assert.equal(outcome.error.message, "technical_evidence_insufficient");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "verify_evidence", reason: "technical_evidence_insufficient", httpStatus: null });
});

// ---------- 7. match_not_registered early-return -> диагностируется отдельно ----------
// В отличие от остальных тестов этого файла (прямой вызов
// claimTechnicalOutcome), match_not_registered формируется РАНЬШЕ, в самом
// route-обработчике handleSettlement -- поэтому проверяем через ПОЛНЫЙ
// HTTP-стек (worker.default.fetch), тем же паттерном, что уже установлен
// в n23-claim-technical-http.test.mjs. Заодно доказывает требование
// "клиентские HTTP status/body не меняются" именно для этой ветки.
function cardWithParticipantsHttp(matchId) {
  return {
    roomCode: "ABC123", createdAt: 1_700_000_000_000, matchNumber: 0, replayVersion: 1,
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

test("HTTP: match_not_registered (early return, не throw) -> ровно 1 diagnostic event phase=read_match_card, HTTP-ответ клиенту не изменён (409 + тот же error code)", async () => {
  const MATCH_ID_HTTP = "elo_ABC123_1700000000000_0";
  const rtdb = createFakeRtdb("https://fake-db.example.com", () => 1_700_000_100_000);
  rtdb.store.data = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID_HTTP, status: "active" } },
    // card с ДРУГИМ roomCode -- воспроизводит найденную дыру раннего return.
    matches: { [MATCH_ID_HTTP]: Object.assign(cardWithParticipantsHttp(MATCH_ID_HTTP), { roomCode: "SOME_OTHER_ROOM" }) }
  };
  const restore = setupFakeGlobalFetchHttp(rtdb, "tg_111");
  const original = console.error;
  const captured = [];
  console.error = function () { captured.push(Array.prototype.slice.call(arguments)); };
  try {
    const request = makeHttpRequest({ roomCode: "ABC123", matchId: MATCH_ID_HTTP, requestId: "http-mnr-1", reason: "disconnect" }, "fake-caller-token-long-enough-1234567890");
    const response = await worker.default.fetch(request, httpEnv);
    const data = await response.json();
    assert.equal(response.status, 409, "HTTP status должен остаться 409, как и до диагностики");
    assert.deepEqual(data, { ok: false, error: "match_not_registered" }, "тело ответа клиенту должно остаться прежним, byte-for-byte");
    const events = diagnosticEventsOnly(captured);
    assert.equal(events.length, 1, "ожидался ровно 1 diagnostic event для этой ранее непокрытой ветки");
    assert.deepEqual(events[0][1], { phase: "read_match_card", reason: "match_not_registered", httpStatus: null });
  } finally {
    console.error = original;
    restore();
  }
});

// ---------- 8. Frozen Error ----------
test("frozen Error, брошенный внутри dbGet -- тот же объект долетает НЕмутированным, ровно 1 event unexpected_internal", async () => {
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
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-frozen", reason: "disconnect" });
  });
  assert.equal(outcome.error, frozenErr, "должен долететь ТОТ ЖЕ объект (identity), не пересозданный");
  assert.equal(Object.isFrozen(frozenErr), true, "объект не должен был перестать быть frozen (доказывает отсутствие мутации)");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

// ---------- 9. Primitive/null thrown ----------
test("примитив (строка) брошен вместо Error -- не роняет диагностику, 1 event unexpected_internal, raw-значение НЕ в логе", async () => {
  const s = await setupGenuineDisconnectScenario();
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject("just_a_raw_string_secret_lookalike");
      return s.rtdb.fetch(url, options);
    }
  });
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-primitive", reason: "disconnect" });
  });
  assert.equal(outcome.error, "just_a_raw_string_secret_lookalike");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
  const serialized = JSON.stringify(outcome.captured);
  assert.equal(serialized.indexOf("just_a_raw_string_secret_lookalike"), -1, "сырое примитивное значение не должно попасть в лог");
});

test("null брошен -- не роняет диагностику, не мутирует (мутация невозможна), 1 event unexpected_internal", async () => {
  const s = await setupGenuineDisconnectScenario();
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject(null);
      return s.rtdb.fetch(url, options);
    }
  });
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-null", reason: "disconnect" });
  });
  assert.equal(outcome.error, null);
  // outcome.error===null здесь означает "поймали null" (см. withCapturedDiagnostics: catch(error) { return {error} }) --
  // отличаем от "успеха" по отсутствию result.
  assert.equal(outcome.result, null);
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

// ---------- 10. Proxy с throwing message/status getter ----------
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
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-proxy", reason: "disconnect" });
  });
  assert.equal(outcome.error, proxyErr, "должен долететь тот же Proxy-объект");
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
});

// ---------- 11. Unknown phase/reason -> unexpected_internal (структурная проверка closed-set) ----------
test("неизвестное сообщение ошибки (не входит в closed-set) -> reason=unexpected_internal, а не сырой текст", async () => {
  const s = await setupGenuineDisconnectScenario();
  const strangeErr = new Error("some_totally_unlisted_internal_code");
  const deps = Object.assign({}, s.deps, {
    fetch: function (url, options) {
      const u = typeof url === "string" ? url : url.url;
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) return s.deps.fetch(url, options);
      if (u.indexOf("/rooms/ABC123") !== -1) return Promise.reject(strangeErr);
      return s.rtdb.fetch(url, options);
    }
  });
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: "req-unknown", reason: "disconnect" });
  });
  const events = diagnosticEventsOnly(outcome.captured);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0][1], { phase: "read_live_room", reason: "unexpected_internal", httpStatus: null });
  const serialized = JSON.stringify(outcome.captured);
  assert.equal(serialized.indexOf("some_totally_unlisted_internal_code"), -1, "неизвестный, невнесённый в closed-set текст не должен попасть в лог");
});

// ---------- 12. Никаких секретов/чувствительных полей в логах ----------
test("диагностический лог никогда не содержит Authorization/токены/requestId/uid/matchId/roomCode/тело запроса", async () => {
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
  const outcome = await withCapturedDiagnostics(function () {
    return claimTechnicalOutcome(s.env, deps, s.token, s.matchId, s.card, "tg_111", { requestId: secretRequestId, reason: "disconnect" });
  });
  const events = diagnosticEventsOnly(outcome.captured);
  assert.ok(events.length >= 1);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.indexOf(secretRequestId), -1, "requestId не должен попадать в diagnostic-лог");
  assert.equal(serialized.indexOf(s.matchId), -1, "matchId не должен попадать в diagnostic-лог");
  assert.equal(serialized.indexOf("tg_111"), -1, "uid не должен попадать в diagnostic-лог");
  assert.equal(serialized.indexOf(s.token), -1, "server id token не должен попадать в diagnostic-лог");
  // Разрешённые ключи -- строго только phase/reason/httpStatus.
  for (const e of events) {
    assert.deepEqual(Object.keys(e[1]).sort(), ["httpStatus", "phase", "reason"]);
  }
});

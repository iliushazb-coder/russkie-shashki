// №23: диагностический тест HTTP routing /rated/claim-technical через
// РЕАЛЬНЫЙ default.fetch(request, env) -- не через прямой вызов
// claimTechnicalOutcome(). settlementDeps() внутри worker/index.mjs
// жёстко использует ГЛОБАЛЬНЫЙ fetch (не инъекцируемый deps), поэтому
// здесь временно подменяется global.fetch на роутер, покрывающий
// identitytoolkit (проверка caller-токена + серверный custom-token обмен)
// и RTDB REST (через ту же persistence-модель, что и fake-rtdb.js).
//
// createFirebaseCustomToken() использует Web Crypto RS256 с реальным
// PKCS8-ключом -- сгенерирован одноразовый (эфемерный, только для этого
// теста) RSA-ключ, чтобы подпись реально прошла; сам JWT никуда наружу не
// уходит -- signInWithCustomToken перехвачен нашим фейковым fetch и не
// проверяет подпись вовсе.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createFakeRtdb } = require("../helpers/fake-rtdb.js");

const worker = await import("../../worker/index.mjs");

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

const FIREBASE_DB_URL = "https://fake-db.example.com";
const MATCH_ID = "elo_ABC123_1700000000000_0";

function cardWithParticipants() {
  return {
    roomCode: "ABC123", createdAt: 1_700_000_000_000, matchNumber: 0, replayVersion: 1,
    participants: {
      tg_111: { color: "light", ratingAtJoin: 1200, name: "Alice" },
      tg_222: { color: "dark", ratingAtJoin: 1180, name: "Bob" }
    }
  };
}

function setupFakeGlobalFetch(rtdb, callerUid) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.indexOf("identitytoolkit.googleapis.com/v1/accounts:lookup") !== -1) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ users: [{ localId: callerUid, disabled: false }] })
      };
    }
    if (u.indexOf("identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken") !== -1) {
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ idToken: "fake-server-id-token", expiresIn: 3600 })
      };
    }
    return rtdb.fetch(url, options);
  };
  return () => { global.fetch = original; };
}

function makeRequest(body, token) {
  return new Request("https://worker.example.com/rated/claim-technical", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
    body: JSON.stringify(body)
  });
}

const env = {
  FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT_EMAIL: "test@example.iam.gserviceaccount.com",
  FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey, FIREBASE_WEB_API_KEY: "fake-web-key"
};

test("HTTP: POST /rated/claim-technical through the real default.fetch -- genuine disconnect claim succeeds end-to-end (auth -> routing -> handler -> RTDB)", async () => {
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, () => 1_700_000_100_000);
  const now = 1_700_000_100_000;
  rtdb.store.data = {
    rooms: { ABC123: {
      ratedMatchId: MATCH_ID, status: "active",
      presence: { light: { online: true, onlineSince: now - 61000 }, dark: { online: false, absentSince: now - 61000 } }
    } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  const restore = setupFakeGlobalFetch(rtdb, "tg_111");
  try {
    const request = makeRequest({ roomCode: "ABC123", matchId: MATCH_ID, requestId: "http-r1", reason: "disconnect" }, "fake-caller-token-long-enough-1234567890");
    const response = await worker.default.fetch(request, env);
    const data = await response.json();
    assert.equal(response.status, 200, "expected 200, got " + response.status + " body=" + JSON.stringify(data));
    assert.equal(data.ok, true);
    assert.equal(data.winnerId, "tg_111");
    assert.ok(rtdb.store.data.ratedTerminal && rtdb.store.data.ratedTerminal[MATCH_ID]);
  } finally {
    restore();
  }
});

test("HTTP: POST /rated/claim-technical -- insufficient evidence surfaces as a real HTTP error response, not a silent 200", async () => {
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, () => 1_700_000_100_000);
  const now = 1_700_000_100_000;
  rtdb.store.data = {
    rooms: { ABC123: {
      ratedMatchId: MATCH_ID, status: "active",
      presence: { light: { online: true, onlineSince: now - 61000 }, dark: { online: true, onlineSince: now - 61000 } }
    } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  const restore = setupFakeGlobalFetch(rtdb, "tg_111");
  try {
    const request = makeRequest({ roomCode: "ABC123", matchId: MATCH_ID, requestId: "http-r2", reason: "disconnect" }, "fake-caller-token-long-enough-1234567890");
    const response = await worker.default.fetch(request, env);
    const data = await response.json();
    assert.notEqual(response.status, 200, "insufficient evidence must not return 200");
    assert.equal(data.ok, false);
  } finally {
    restore();
  }
});

test("HTTP: POST /rated/claim-technical -- unauthenticated caller (invalid bearer) is rejected with 401, never reaches the handler", async () => {
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, () => 1_700_000_100_000);
  const restore = setupFakeGlobalFetch(rtdb, null); // lookup returns no matching user
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const u = typeof url === "string" ? url : url.url;
    if (u.indexOf("accounts:lookup") !== -1) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ users: [] }) };
    }
    return originalFetch(url, options);
  };
  try {
    const request = makeRequest({ roomCode: "ABC123", matchId: MATCH_ID, requestId: "http-r3", reason: "disconnect" }, "garbage-token-long-enough-1234567890xxxx");
    const response = await worker.default.fetch(request, env);
    assert.equal(response.status, 401);
  } finally {
    restore();
  }
});

// Перенесено из удалённого tests/worker/n23-claim-technical-diagnostic.test.mjs
// как ЧИСТЫЙ HTTP-контракт (без какой-либо проверки diagnostic logging):
// это единственное место, где покрыт early-return match_not_registered.
test("HTTP: POST /rated/claim-technical -- match card missing/foreign for this room -> exactly HTTP 409 { ok:false, error:\"match_not_registered\" }", async () => {
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, () => 1_700_000_100_000);
  rtdb.store.data = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active" } },
    // card существует, но принадлежит ДРУГОЙ комнате -> card.roomCode !== roomCode
    matches: { [MATCH_ID]: Object.assign(cardWithParticipants(), { roomCode: "SOME_OTHER_ROOM" }) }
  };
  const restore = setupFakeGlobalFetch(rtdb, "tg_111");
  try {
    const request = makeRequest(
      { roomCode: "ABC123", matchId: MATCH_ID, requestId: "http-mnr-1", reason: "disconnect" },
      "fake-caller-token-long-enough-1234567890"
    );
    const response = await worker.default.fetch(request, env);
    const data = await response.json();
    assert.equal(response.status, 409);
    assert.deepEqual(data, { ok: false, error: "match_not_registered" });
    assert.equal(rtdb.store.data.ratedTerminal, undefined, "ничего не записано");
  } finally {
    restore();
  }
});

test("HTTP: POST /rated/claim-technical -- no match card at all for this matchId -> the same 409 match_not_registered contract", async () => {
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, () => 1_700_000_100_000);
  rtdb.store.data = { rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active" } } }; // matches отсутствует вовсе
  const restore = setupFakeGlobalFetch(rtdb, "tg_111");
  try {
    const request = makeRequest(
      { roomCode: "ABC123", matchId: MATCH_ID, requestId: "http-mnr-2", reason: "timeout" },
      "fake-caller-token-long-enough-1234567890"
    );
    const response = await worker.default.fetch(request, env);
    const data = await response.json();
    assert.equal(response.status, 409);
    assert.deepEqual(data, { ok: false, error: "match_not_registered" });
  } finally {
    restore();
  }
});

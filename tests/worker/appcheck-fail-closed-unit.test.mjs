// №26: App Check fail-closed. Exercises the real dbHeaders() gate through
// the 4 exported RTDB helpers (dbGet/dbGetWithEtag/dbPutIfMatch/
// dbPatchRoot) -- dbHeaders/getAppCheckToken/isAppCheckRequired are not
// exported themselves, matching this file's own scope (worker/index.mjs
// only touched isAppCheckRequired, dbHeaders, settlementPublicError, and
// exported resetAppCheckCache for test isolation).

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  dbGet, dbGetWithEtag, dbPutIfMatch, dbPatchRoot,
  resetAppCheckCache, resetServerTokenCache, isPermissionDeniedError,
  refreshLeaderboardName, joinRatedMatch, commitRatedEvent, settleMatch
} from "../../worker/index.mjs";

const require = createRequire(import.meta.url);
const { createFakeRtdb } = require("../helpers/fake-rtdb.js");

const FIREBASE_DB_URL = "https://fake-db.example.com";
const APPCHECK_EXCHANGE_URL_PART = "firebaseappcheck.googleapis.com";
const OAUTH_URL_PART = "oauth2.googleapis.com";

function makeEnvDeps(options = {}) {
  resetAppCheckCache();
  resetServerTokenCache();
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, function () { return 1_700_000_010_000; });
  rtdb.store.data = options.seed || {};
  const env = {
    FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT_EMAIL: "x@x.iam.gserviceaccount.com",
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "x", FIREBASE_WEB_API_KEY: "x",
    FIREBASE_APP_ID: "1:123456789:web:abcdef0123456789",
    APP_CHECK_REQUIRED: options.appCheckRequired // undefined by default -- explicit opt-in only
  };
  const rtdbFetchCalls = [];
  const deps = {
    now: function () { return 1_700_000_010_000; },
    signCustomToken: async () => "fake-custom-token",
    signOauthAssertion: async () => "fake-oauth-assertion",
    signAppCheckToken: async () => "fake-appcheck-custom-token",
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.indexOf(OAUTH_URL_PART) !== -1) {
        if (options.oauthFails) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: "fake-access-token", expires_in: 3600 }) };
      }
      if (u.indexOf(APPCHECK_EXCHANGE_URL_PART) !== -1) {
        if (options.appCheckExchangeFails !== false) { // default: fails, unless explicitly told to succeed
          return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ token: "fake-appcheck-token", ttl: "3600s" }) };
      }
      if (u.indexOf("identitytoolkit.googleapis.com") !== -1) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ idToken: "fake-server-id-token", expiresIn: 3600 }) };
      }
      // Реальный RTDB-запрос
      rtdbFetchCalls.push({ url: u, method: opts && opts.method, headers: opts && opts.headers });
      return rtdb.fetch(url, opts);
    }
  };
  return { env, deps, rtdb, rtdbFetchCalls };
}

async function getToken() { return "unused"; } // все 4 helper'а сами не используют "token" для авторизации самого AppCheck-вызова -- это отдельный внутренний механизм getAppCheckToken

// ===== dbHeaders через все 4 helper'а =====

for (const [name, run] of [
  ["dbGet", async (env, deps) => dbGet(env, deps, "irrelevant", "rooms/ABC123")],
  ["dbGetWithEtag", async (env, deps) => dbGetWithEtag(env, deps, "irrelevant", "rooms/ABC123")],
  ["dbPutIfMatch", async (env, deps) => dbPutIfMatch(env, deps, "irrelevant", "rooms/ABC123", "\"etag\"", { a: 1 })],
  ["dbPatchRoot", async (env, deps) => dbPatchRoot(env, deps, "irrelevant", { "rooms/ABC123/a": 1 })]
]) {
  test(`${name}: required=false + App Check token unavailable -> unchanged fail-open behavior (real fetch still happens, no header)`, async () => {
    const { env, deps, rtdb, rtdbFetchCalls } = makeEnvDeps({ appCheckRequired: undefined, appCheckExchangeFails: true });
    rtdb.store.data = { rooms: { ABC123: { a: 0 } } };
    await run(env, deps); // не должен бросить
    assert.equal(rtdbFetchCalls.length, 1, "реальный RTDB fetch должен был произойти (прежнее поведение)");
    const hdrs = rtdbFetchCalls[0].headers || {};
    assert.equal(hdrs["X-Firebase-AppCheck"], undefined, "заголовок отсутствует, как и раньше");
  });

  test(`${name}: required=true + valid token -> RTDB request carries X-Firebase-AppCheck`, async () => {
    const { env, deps, rtdb, rtdbFetchCalls } = makeEnvDeps({ appCheckRequired: "true", appCheckExchangeFails: false });
    rtdb.store.data = { rooms: { ABC123: { a: 0 } } };
    await run(env, deps);
    assert.equal(rtdbFetchCalls.length, 1, "реальный RTDB fetch должен был произойти");
    assert.equal(rtdbFetchCalls[0].headers["X-Firebase-AppCheck"], "fake-appcheck-token");
  });

  test(`${name}: required=true + token unavailable -> RTDB request does NOT happen at all, throws app_check_unavailable`, async () => {
    const { env, deps, rtdb, rtdbFetchCalls } = makeEnvDeps({ appCheckRequired: "true", appCheckExchangeFails: true });
    rtdb.store.data = { rooms: { ABC123: { a: 0 } } };
    await assert.rejects(run(env, deps), /app_check_unavailable/);
    assert.equal(rtdbFetchCalls.length, 0, "RTDB fetch не должен был произойти вовсе");
  });
}

// ===== опечатка/некорректное значение APP_CHECK_REQUIRED остаётся false =====

test("isAppCheckRequired: any value other than the exact string 'true' (case-insensitive) stays false -- no accidental fail-closed", async () => {
  for (const v of [undefined, "", "1", "yes", "REQUIRED", "false", "TRUE "]) {
    const { env, deps, rtdb, rtdbFetchCalls } = makeEnvDeps({ appCheckRequired: v, appCheckExchangeFails: true });
    rtdb.store.data = { rooms: { ABC123: { a: 0 } } };
    if (v === "TRUE ") {
      // с завершающим пробелом -- намеренно НЕ считается "true", остаётся false
      await dbGet(env, deps, "irrelevant", "rooms/ABC123");
      assert.equal(rtdbFetchCalls.length, 1, `значение ${JSON.stringify(v)} должно оставаться fail-open`);
      continue;
    }
    await dbGet(env, deps, "irrelevant", "rooms/ABC123");
    assert.equal(rtdbFetchCalls.length, 1, `значение ${JSON.stringify(v)} должно оставаться fail-open`);
  }
});

test("isAppCheckRequired: exact 'TRUE' (any case) does trigger fail-closed", async () => {
  for (const v of ["true", "True", "TRUE"]) {
    const { env, deps, rtdb, rtdbFetchCalls } = makeEnvDeps({ appCheckRequired: v, appCheckExchangeFails: true });
    rtdb.store.data = { rooms: { ABC123: { a: 0 } } };
    await assert.rejects(dbGet(env, deps, "irrelevant", "rooms/ABC123"));
    assert.equal(rtdbFetchCalls.length, 0, `значение ${JSON.stringify(v)} должно быть fail-closed`);
  }
});

// ===== app_check_unavailable не путается с permission_denied =====

test("app_check_unavailable is NOT misclassified as isPermissionDeniedError (no .status, or not 401/403)", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ appCheckRequired: "true", appCheckExchangeFails: true });
  rtdb.store.data = { rooms: { ABC123: { a: 0 } } };
  try {
    await dbGet(env, deps, "irrelevant", "rooms/ABC123");
    assert.fail("должен был бросить");
  } catch (error) {
    assert.equal(error.message, "app_check_unavailable");
    assert.notEqual(error.status, 401);
    assert.notEqual(error.status, 403);
    assert.equal(isPermissionDeniedError(error), false, "не должна быть перепутана с настоящим Rules-отказом");
  }
});

// ===== rated join/event/settle воспринимают её как transient =====

test("rated join: App Check required+unavailable surfaces as app_check_unavailable, not a terminal join error", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ appCheckRequired: "true", appCheckExchangeFails: true });
  rtdb.store.data = {
    rooms: { ABC123: { players: { light: { id: "tg_1", name: "A" }, dark: { id: "tg_2", name: "B" } }, status: "active", createdAt: 1_700_000_000_000, matchNumber: 0 } }
  };
  await assert.rejects(
    joinRatedMatch(env, deps, "tg_1", "ABC123"),
    /app_check_unavailable/
  );
});

test("rated event: App Check required+unavailable surfaces as app_check_unavailable, not a terminal event error", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ appCheckRequired: "true", appCheckExchangeFails: true });
  const MATCH_ID = "elo_ABC123_1700000000000_0";
  rtdb.store.data = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active" } }
  };
  const card = { roomCode: "ABC123", createdAt: 1_700_000_000_000, matchNumber: 0, replayVersion: 1,
    participants: { alice: { color: "light", ratingAtJoin: 1200, name: "Alice" }, bob: { color: "dark", ratingAtJoin: 1180, name: "Bob" } } };
  await assert.rejects(
    commitRatedEvent(env, deps, "irrelevant", MATCH_ID, card, "alice", { requestId: "r1", type: "resign" }),
    /app_check_unavailable/
  );
});

test("rated settle: App Check required+unavailable surfaces as app_check_unavailable, not a terminal settle error", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ appCheckRequired: "true", appCheckExchangeFails: true });
  rtdb.store.data = { rooms: {} };
  await assert.rejects(
    settleMatch(env, deps, "alice", "ABC123", "elo_ABC123_1700000000000_0"),
    /app_check_unavailable/
  );
});

// ===== №25: /auth/telegram (via refreshLeaderboardName) остаётся best-effort =====

test("refreshLeaderboardName: App Check required+unavailable is LOG-only, does not throw (preserves #25's best-effort contract)", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ appCheckRequired: "true", appCheckExchangeFails: true, seed: { stats: { tg_1: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "Old" } } } });
  await assert.doesNotReject(refreshLeaderboardName(env, deps, "tg_1", "New"));
  assert.equal(rtdb.store.data.stats.tg_1.name, "Old", "имя не обновилось (App Check недоступен), но функция не бросила");
});

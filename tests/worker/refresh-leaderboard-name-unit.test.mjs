// №25: unit tests for refreshLeaderboardName -- the best-effort side
// effect inside /auth/telegram that keeps leaderboard's stats/$uid/name in
// sync with the player's current Telegram display name. Driven through the
// REAL exported Worker function against an in-memory fake RTDB (same
// pattern as tests/worker/rated-replay-unit.test.mjs) -- no real network,
// no emulator. Rules are NOT applied here (that's rated-events.rules.test.mjs
// against the real Rules Emulator, extended separately for this feature);
// this file exercises refreshLeaderboardName's own logic and its promise
// that it never throws.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { refreshLeaderboardName, resetServerTokenCache } from "../../worker/index.mjs";

const require = createRequire(import.meta.url);
const { createFakeRtdb } = require("../helpers/fake-rtdb.js");

const FIREBASE_DB_URL = "https://fake-db.example.com";

function makeEnvDeps(options = {}) {
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, function () { return 1_700_000_010_000; });
  rtdb.store.data = options.seed || {};
  const env = { FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT_EMAIL: "x", FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "x", FIREBASE_WEB_API_KEY: "x" };
  const deps = {
    now: function () { return 1_700_000_010_000; },
    signCustomToken: options.signCustomToken || (async () => "fake-custom-token"),
    fetch: async (url, opts) => {
      if (typeof url === "string" && url.indexOf("identitytoolkit.googleapis.com") !== -1) {
        if (options.identityFails) return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ idToken: "fake-server-id-token", expiresIn: 3600 })
        };
      }
      return rtdb.fetch(url, opts);
    }
  };
  return { env, deps, rtdb };
}

async function getToken(env, deps) {
  resetServerTokenCache();
  return "unused"; // refreshLeaderboardName gets its own token internally via getServerIdToken
}

test("existing stats + changed name -> exactly one targeted stats/<uid>/name PATCH", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ seed: { stats: { tg_1: { rating: 1200, wins: 3, losses: 1, draws: 0, name: "OldName" } } } });
  await refreshLeaderboardName(env, deps, "tg_1", "NewName");
  assert.equal(rtdb.store.data.stats.tg_1.name, "NewName", "name должен обновиться");
});

test("PATCH payload contains ONLY stats/<uid>/name -- rating/wins/losses/draws are untouched", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ seed: { stats: { tg_1: { rating: 1234, wins: 7, losses: 2, draws: 1, name: "OldName" } } } });
  let patchBody = null;
  const realFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (opts && opts.method === "PATCH") patchBody = JSON.parse(opts.body);
    return realFetch(url, opts);
  };
  await refreshLeaderboardName(env, deps, "tg_1", "NewName");
  assert.ok(patchBody, "PATCH должен был произойти");
  assert.deepEqual(Object.keys(patchBody), ["stats/tg_1/name"], "payload должен содержать ТОЛЬКО этот один путь -- не rating/wins/losses/draws, даже с тем же значением");
  const st = rtdb.store.data.stats.tg_1;
  assert.equal(st.rating, 1234, "rating не должен измениться");
  assert.equal(st.wins, 7, "wins не должен измениться");
  assert.equal(st.losses, 2, "losses не должен измениться");
  assert.equal(st.draws, 1, "draws не должен измениться");
  assert.equal(st.name, "NewName");
});

test("stats missing entirely -> no write, no creation, no error logged (guard works correctly, not just crashes and is swallowed)", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ seed: {} });
  const logs = [];
  const realLog = console.log;
  console.log = function () { logs.push(Array.prototype.slice.call(arguments)); };
  try {
    await refreshLeaderboardName(env, deps, "tg_1", "SomeName");
  } finally {
    console.log = realLog;
  }
  assert.equal(rtdb.store.data.stats, undefined, "узел stats не должен быть создан вовсе");
  assert.equal(logs.length, 0, "guard должен корректно распознать отсутствие узла, а не молча упасть на null.name и быть пойманным общим catch");
});

test("same name -> no write at all", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ seed: { stats: { tg_1: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "SameName" } } } });
  let patchCalled = false;
  const realFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (opts && opts.method === "PATCH") patchCalled = true;
    return realFetch(url, opts);
  };
  await refreshLeaderboardName(env, deps, "tg_1", "SameName");
  assert.equal(patchCalled, false, "не должно быть ни одного PATCH-вызова при совпадении имени");
});

test("refresh READ failure -> refreshLeaderboardName does not throw (best-effort)", async () => {
  const { env, deps } = makeEnvDeps({ seed: { stats: { tg_1: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "OldName" } } } });
  const realFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (opts && opts.method === "GET" && typeof url === "string" && url.indexOf("stats/tg_1") !== -1) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    }
    return realFetch(url, opts);
  };
  await assert.doesNotReject(refreshLeaderboardName(env, deps, "tg_1", "NewName"));
});

test("server-token (getServerIdToken) failure -> refreshLeaderboardName does not throw (best-effort)", async () => {
  const { env, deps } = makeEnvDeps({ seed: { stats: { tg_1: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "OldName" } } }, identityFails: true });
  await assert.doesNotReject(refreshLeaderboardName(env, deps, "tg_1", "NewName"));
});

test("PATCH (write) failure -> refreshLeaderboardName does not throw (best-effort)", async () => {
  const { env, deps } = makeEnvDeps({ seed: { stats: { tg_1: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "OldName" } } } });
  const realFetch = deps.fetch;
  deps.fetch = async (url, opts) => {
    if (opts && opts.method === "PATCH") return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) };
    return realFetch(url, opts);
  };
  await assert.doesNotReject(refreshLeaderboardName(env, deps, "tg_1", "NewName"));
});

test("counters/rating survive a name refresh unchanged even across a simulated concurrent settlement write on a different field", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ seed: { stats: { tg_1: { rating: 1500, wins: 10, losses: 5, draws: 2, name: "OldName" } } } });
  // Симулируем "конкурентный" settlement, коснувшийся ДРУГОГО поля того же узла,
  // ПЕРЕД тем как refresh применит свой собственный targeted PATCH.
  rtdb.store.data.stats.tg_1.rating = 1516; // как будто settlement уже применился
  await refreshLeaderboardName(env, deps, "tg_1", "NewName");
  assert.equal(rtdb.store.data.stats.tg_1.rating, 1516, "settlement-изменённый rating остаётся нетронутым");
  assert.equal(rtdb.store.data.stats.tg_1.name, "NewName");
});

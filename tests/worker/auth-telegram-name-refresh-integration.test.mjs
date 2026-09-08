// №25: end-to-end integration test for /auth/telegram, using REAL crypto
// throughout (a genuine RSA keypair for createFirebaseCustomToken's RS256
// signing, and a genuine HMAC-SHA256-signed Telegram initData string,
// matching validateTelegramInitData's own verification algorithm exactly)
// -- not mocked-out, since both are pure local crypto with no network call
// of their own. Only the network calls refreshLeaderboardName makes
// internally (identitytoolkit token exchange, RTDB REST GET/PATCH) are
// intercepted, via a temporary global fetch override, matching the same
// failure-mode coverage as the isolated unit tests in
// refresh-leaderboard-name-unit.test.mjs -- this file instead proves the
// property at the level actually requested: that /auth/telegram's own HTTP
// response is unaffected, not just that the inner function never throws.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import worker from "../../worker/index.mjs";

const BOT_TOKEN = "123456:test-bot-token-for-integration-tests-only";

function buildValidInitData(user, botToken, authDateSeconds) {
  const params = new URLSearchParams();
  params.set("user", JSON.stringify(user));
  params.set("auth_date", String(authDateSeconds));
  params.set("query_id", "AAtest");
  const dataCheckString = Array.from(params.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

function makeRsaKeyPairPem() {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });
  return privateKey;
}

function makeEnv(overrides = {}) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    FIREBASE_SERVICE_ACCOUNT_EMAIL: "test@test-project.iam.gserviceaccount.com",
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: makeRsaKeyPairPem(),
    FIREBASE_WEB_API_KEY: "fake-web-api-key",
    FIREBASE_DB_URL: "https://fake-db.example.com",
    TELEGRAM_AUTH_MAX_AGE_SECONDS: "3600"
  }, overrides);
}

function makeRequest(initData) {
  return new Request("https://worker.example.com/auth/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData })
  });
}

// В памяти состояние RTDB для этого теста -- достаточно упрощённо, только
// stats/<uid>, поскольку refreshLeaderboardName трогает только этот путь.
function installFetchMock(options) {
  const statsStore = options.seedStats || {};
  const original = globalThis.fetch;
  const patchCalls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.indexOf("identitytoolkit.googleapis.com") !== -1) {
      if (options.identityFails) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ idToken: "fake-server-id-token", expiresIn: 3600 }), { status: 200 });
    }
    if (u.indexOf("stats%2F") !== -1 || u.indexOf("stats/") !== -1) {
      const uidMatch = u.match(/stats%2F([^./?]+)|stats\/([^./?]+)/);
      const uid = uidMatch ? (uidMatch[1] || uidMatch[2]) : null;
      if (opts && opts.method === "GET") {
        if (options.readFails) return new Response("{}", { status: 500 });
        return new Response(JSON.stringify(statsStore[uid] || null), { status: 200 });
      }
    }
    if (opts && opts.method === "PATCH") {
      patchCalls.push({ url: u, body: opts.body });
      if (options.patchFails) return new Response("{}", { status: 403 });
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected fetch in test: " + u + " " + (opts && opts.method));
  };
  return { restore: () => { globalThis.fetch = original; }, patchCalls };
}

test("/auth/telegram succeeds normally, refresh applies when name changed and stats already exist", async () => {
  const env = makeEnv();
  const mock = installFetchMock({ seedStats: { tg_777: { rating: 1200, wins: 1, losses: 0, draws: 0, name: "OldName" } } });
  try {
    const initData = buildValidInitData({ id: 777, first_name: "NewName" }, BOT_TOKEN, Math.floor(Date.now() / 1000));
    const res = await worker.fetch(makeRequest(initData), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.uid, "tg_777");
    assert.equal(typeof body.customToken, "string");
    assert.equal(mock.patchCalls.length, 1, "ровно один PATCH для реального изменения имени");
    const patched = JSON.parse(mock.patchCalls[0].body);
    assert.deepEqual(Object.keys(patched), ["stats/tg_777/name"], "payload содержит ТОЛЬКО этот один путь");
  } finally {
    mock.restore();
  }
});

test("/auth/telegram still succeeds (200, ok:true, customToken present) when refresh's RTDB READ fails", async () => {
  const env = makeEnv();
  const mock = installFetchMock({ seedStats: { tg_778: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "Old" } }, readFails: true });
  try {
    const initData = buildValidInitData({ id: 778, first_name: "Fresh" }, BOT_TOKEN, Math.floor(Date.now() / 1000));
    const res = await worker.fetch(makeRequest(initData), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.customToken, "string");
  } finally {
    mock.restore();
  }
});

test("/auth/telegram still succeeds when refresh's own server-token exchange fails", async () => {
  const env = makeEnv();
  const mock = installFetchMock({ seedStats: { tg_779: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "Old" } }, identityFails: true });
  try {
    const initData = buildValidInitData({ id: 779, first_name: "Fresh" }, BOT_TOKEN, Math.floor(Date.now() / 1000));
    const res = await worker.fetch(makeRequest(initData), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.customToken, "string");
  } finally {
    mock.restore();
  }
});

test("/auth/telegram still succeeds when refresh's own PATCH (write) fails", async () => {
  const env = makeEnv();
  const mock = installFetchMock({ seedStats: { tg_780: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "Old" } }, patchFails: true });
  try {
    const initData = buildValidInitData({ id: 780, first_name: "Fresh" }, BOT_TOKEN, Math.floor(Date.now() / 1000));
    const res = await worker.fetch(makeRequest(initData), env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.customToken, "string");
  } finally {
    mock.restore();
  }
});

test("the srv_settlement server id token is never present anywhere in the /auth/telegram response body (security: not leaked to client)", async () => {
  const env = makeEnv();
  const mock = installFetchMock({ seedStats: { tg_781: { rating: 1200, wins: 0, losses: 0, draws: 0, name: "Old" } } });
  try {
    const initData = buildValidInitData({ id: 781, first_name: "Fresh" }, BOT_TOKEN, Math.floor(Date.now() / 1000));
    const res = await worker.fetch(makeRequest(initData), env);
    const rawBody = await res.text();
    assert.equal(rawBody.indexOf("fake-server-id-token"), -1, "srv_settlement id token не должен попасть в ответ клиенту");
    const body = JSON.parse(rawBody);
    assert.deepEqual(Object.keys(body).sort(), ["customToken", "name", "ok", "uid"].sort(), "response содержит только клиентские поля, ничего лишнего от srv_settlement");
    assert.notEqual(body.customToken, "fake-server-id-token");
  } finally {
    mock.restore();
  }
});

test("/auth/telegram with an INVALID Telegram signature still fails auth normally (unaffected by #25 change)", async () => {
  const env = makeEnv();
  const mock = installFetchMock({});
  try {
    const params = new URLSearchParams();
    params.set("user", JSON.stringify({ id: 999, first_name: "X" }));
    params.set("auth_date", String(Math.floor(Date.now() / 1000)));
    params.set("hash", "0000000000000000000000000000000000000000000000000000000000000000"); // заведомо неверный
    const res = await worker.fetch(makeRequest(params.toString()), env);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
  } finally {
    mock.restore();
  }
});

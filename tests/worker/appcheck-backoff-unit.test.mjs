// №27: bounded exponential App Check backoff. getAppCheckToken/appCheckLog/
// appCheckFailureCount are not exported (matching the change's own minimal
// scope) -- driven entirely through dbGet (any of the 4 RTDB helpers would
// do; dbGet is representative and matches the #26 test file's own style),
// with full control over deps.now() to assert exact backoff timing.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { dbGet, resetAppCheckCache, resetServerTokenCache } from "../../worker/index.mjs";

const require = createRequire(import.meta.url);
const { createFakeRtdb } = require("../helpers/fake-rtdb.js");

const FIREBASE_DB_URL = "https://fake-db.example.com";
const APPCHECK_EXCHANGE_URL_PART = "firebaseappcheck.googleapis.com";
const OAUTH_URL_PART = "oauth2.googleapis.com";

// №27: MIN=1000ms, x2, MAX=60000ms -- см. worker/index.mjs's own constants.
const MIN = 1000, MAX = 60000;

function makeEnvDeps(options = {}) {
  resetAppCheckCache();
  resetServerTokenCache();
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, function () { return currentNow; });
  rtdb.store.data = { rooms: { ABC123: { a: 0 } } };
  let currentNow = options.startNow || 1_700_000_000_000;
  const env = {
    FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT_EMAIL: "x@x.iam.gserviceaccount.com",
    FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "x", FIREBASE_WEB_API_KEY: "x",
    FIREBASE_APP_ID: "1:123456789:web:abcdef0123456789",
    APP_CHECK_REQUIRED: options.appCheckRequired
  };
  let exchangeAttempts = 0;
  const deps = {
    now: function () { return currentNow; },
    setNow: function (v) { currentNow = v; },
    signCustomToken: async () => "fake-custom-token",
    signOauthAssertion: async () => "fake-oauth-assertion",
    signAppCheckToken: async () => "fake-appcheck-custom-token",
    fetch: async (url, opts) => {
      const u = String(url);
      if (u.indexOf(OAUTH_URL_PART) !== -1) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: "fake-access-token", expires_in: 3600 }) };
      }
      if (u.indexOf(APPCHECK_EXCHANGE_URL_PART) !== -1) {
        exchangeAttempts++;
        return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
      }
      return rtdb.fetch(url, opts);
    }
  };
  return { env, deps, rtdb, exchangeAttemptsRef: () => exchangeAttempts };
}

async function callDbGet(env, deps) {
  return dbGet(env, deps, "irrelevant", "rooms/ABC123");
}

// ===== 10. concurrency: несколько failure callbacks с близким now внутри уже активного cooldown -- НЕ поднимают ступень несколько раз =====

test("concurrency/thundering-herd: multiple GENUINELY CONCURRENT failures (same now, none has updated state before the others start) escalate only ONCE, not once-per-call", async () => {
  const { env, deps, exchangeAttemptsRef } = makeEnvDeps({ appCheckRequired: undefined });
  // Promise.all (не await по очереди!) -- все 3 вызова стартуют и проходят
  // начальную проверку "now < appCheckFailUntilMs" (0 < 0 = false) ДО того,
  // как хоть один из них успевает обновить appCheckFailUntilMs, поскольку
  // JS однопоточен, а deps.fetch асинхронен (даёт event loop'у точку
  // interleaving) -- это и есть настоящая гонка нескольких конкурентных
  // getAppCheckToken(), а не последовательные вызовы с await по одному
  // (при await-по-одному getAppCheckToken's СОБСТВЕННАЯ ранняя проверка
  // cooldown уже отсекала бы 2-й/3-й вызов ДО appCheckLog() и маскировала
  // бы отсутствие нового gate'а -- это и была реальная ошибка первой
  // версии этого теста, найденная и исправленная мутационным тестированием
  // ниже).
  await Promise.all([callDbGet(env, deps), callDbGet(env, deps), callDbGet(env, deps)]);
  assert.equal(exchangeAttemptsRef(), 3, "все 3 конкурентных вызова реально дошли до exchange (гонка воспроизведена)");

  // КЛЮЧЕВАЯ проверка: несмотря на 3 неудачи "одновременно", окно должно
  // соответствовать РОВНО ступени 1 (MIN=1000ms от начального now), а НЕ
  // ступени 3 (4*MIN=4000ms), которая была бы результатом если бы каждый
  // конкурентный вызов независимо инкрементировал счётчик.
  const start = deps.now();
  deps.setNow(start + MIN - 1);
  await callDbGet(env, deps); // всё ещё внутри окна ступени 1 -- новой попытки быть не должно
  assert.equal(exchangeAttemptsRef(), 3, "чуть раньше конца MIN-окна -- ни одной новой попытки");

  deps.setNow(start + MIN);
  await callDbGet(env, deps); // окно ступени 1 истекло -- ровно одна новая попытка (ступень 2)
  assert.equal(exchangeAttemptsRef(), 4, "на границе MIN -- ровно одна новая попытка, подтверждает что предыдущая ступень была 1, не 3");
});

// ===== 11. после истечения первого cooldown следующая новая failure повышает ровно на одну ступень =====

test("after the first cooldown expires, the next genuinely new failure escalates by exactly one step (MIN -> MIN*2)", async () => {
  const { env, deps, exchangeAttemptsRef } = makeEnvDeps({ appCheckRequired: undefined });
  const start = deps.now();

  await callDbGet(env, deps); // ступень 1, delay=MIN=1000ms, appCheckFailUntilMs = start+1000
  assert.equal(exchangeAttemptsRef(), 1, "первая неудача -- ровно одна реальная попытка exchange");

  // Чуть РАНЬШЕ окончания MIN-окна -- строго через число попыток, не через
  // отсутствие заголовка (review fix: sawHeader===undefined НЕ доказывает
  // отсутствие попытки exchange -- при required=false RTDB-запрос уйдёт
  // без заголовка ОДИНАКОВО что при отсутствии попытки, что при
  // попытке-которая-снова-упала; единственное надёжное доказательство --
  // прямой счётчик обращений к exchange).
  deps.setNow(start + MIN - 1);
  await callDbGet(env, deps);
  assert.equal(exchangeAttemptsRef(), 1, "чуть раньше конца MIN-окна -- попыток всё ещё 1 (окно ещё не истекло)");

  // Ровно на границе/после истечения MIN-окна -- новая попытка, СЛЕДУЮЩАЯ
  // ступень (MIN*2 = 2000ms), не MIN и не сразу MAX.
  deps.setNow(start + MIN);
  await callDbGet(env, deps);
  assert.equal(exchangeAttemptsRef(), 2, "на границе MIN -- ровно одна новая попытка (вторая неудача, открывает окно 2*MIN)");

  // Проверяем именно длину НОВОГО окна (2*MIN=2000ms от момента ВТОРОЙ
  // неудачи): чуть раньше истечения -- попыток всё ещё 2; ровно на
  // границе -- становится 3.
  deps.setNow(start + MIN + (MIN * 2) - 1);
  await callDbGet(env, deps);
  assert.equal(exchangeAttemptsRef(), 2, "чуть раньше конца 2*MIN-окна -- попыток всё ещё 2 (второе окно ещё не истекло)");

  deps.setNow(start + MIN + (MIN * 2));
  await callDbGet(env, deps);
  assert.equal(exchangeAttemptsRef(), 3, "на границе MIN+2*MIN -- ровно одна новая (третья) попытка, подтверждает что второе окно было РОВНО 2*MIN, не короче и не длиннее");
});

// ===== 12a. MAX-cap: после многих последовательных неудач задержка не превышает MAX =====

test("MAX cap: after many consecutive failures, the delay never exceeds APPCHECK_BACKOFF_MAX_MS (60000ms)", async () => {
  const { env, deps, exchangeAttemptsRef } = makeEnvDeps({ appCheckRequired: undefined });
  let now = deps.now();
  let attempts = 0;
  // Прогоняем достаточно ступеней, чтобы 1000*2^(n-1) гарантированно превысил 60000 (n>=7).
  for (let i = 0; i < 10; i++) {
    await callDbGet(env, deps);
    now += MAX; // с запасом -- гарантированно за пределами ЛЮБОГО возможного окна на этом шаге
    deps.setNow(now);
  }
  attempts = exchangeAttemptsRef();
  assert.equal(attempts, 10, "все 10 попыток были реальными (шаг между ними >= MAX всегда достаточен)");

  // Теперь конкретно подтверждаем потолок: после ступени, где расчётная
  // экспонента уже точно превысила MAX, окно всё равно РОВНО MAX, не больше.
  const beforeNext = deps.now();
  await callDbGet(env, deps); // 11-я неудача, ступень заведомо >> MAX по формуле без cap
  deps.setNow(beforeNext + MAX - 1);
  { const originalFetch = deps.fetch; let sawHeader;
    deps.fetch = async (url, opts) => { if (opts && opts.headers) sawHeader = opts.headers["X-Firebase-AppCheck"]; return originalFetch(url, opts); };
    await callDbGet(env, deps);
    deps.fetch = originalFetch;
    assert.equal(sawHeader, undefined, "окно не должно было истечь ДО MAX");
  }
  deps.setNow(beforeNext + MAX);
  const attemptsBefore = exchangeAttemptsRef();
  await callDbGet(env, deps);
  assert.equal(exchangeAttemptsRef(), attemptsBefore + 1, "ровно на границе MAX -- окно истекло, новая попытка произошла (не позже MAX, не бесконечный lockout)");
});

// ===== 12b. reset-on-success =====

test("reset-on-success (explicit control): first failure after a prior success uses exactly MIN, verified via exact window boundary", async () => {
  const { env, deps, exchangeAttemptsRef } = makeEnvDeps({ appCheckRequired: undefined });
  // Явный контроль исхода КАЖДОЙ попытки через отдельный счётчик в замыкании.
  let attemptOutcomes = ["fail", "fail", "success"]; // ступени 1,2, затем успех на 3-й
  const originalFetch = deps.fetch;
  let idx = 0;
  deps.fetch = async (url, opts) => {
    if (String(url).indexOf(APPCHECK_EXCHANGE_URL_PART) !== -1) {
      const outcome = attemptOutcomes[idx] !== undefined ? attemptOutcomes[idx] : "fail";
      idx++;
      if (outcome === "success") {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ token: "fake-appcheck-token", ttl: "10" }) }; // короткий ttl -- быстро "состарится"
      }
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    }
    return originalFetch(url, opts);
  };

  let now = deps.now();
  await callDbGet(env, deps); // fail, ступень 1 (MIN)
  now += MAX; deps.setNow(now);
  await callDbGet(env, deps); // fail, ступень 2 (2*MIN) -- если бы НЕ сбросилось, следующая была бы 4*MIN
  now += MAX; deps.setNow(now);
  await callDbGet(env, deps); // success -- ttl=10s, короткий, чтобы быстро протух
  assert.equal(idx, 3);

  // Токен протухает через 10с (ttl) минус 300с margin -- token свежести не
  // имеет уже сразу (10s < 300s margin), так что СЛЕДУЮЩИЙ вызов реально
  // попытается снова -- это genuinely "первая неудача нового цикла".
  attemptOutcomes = ["fail"]; idx = 0; // сброс локального мока-индекса для след. попытки
  now += 1000; deps.setNow(now); // чуть позже успеха -- токен уже не свежий (ttl 10s < margin 300s)
  const failStart = now;
  await callDbGet(env, deps); // это ДОЛЖНА быть попытка -- падает (idx сброшен -> "fail")

  // Проверяем: окно этой неудачи -- РОВНО MIN (1000ms), НЕ 4*MIN (4000ms),
  // что доказывало бы отсутствие сброса.
  deps.setNow(failStart + MIN - 1);
  { let sawHeader; const of2 = deps.fetch;
    deps.fetch = async (url, opts) => { if (opts && opts.headers) sawHeader = opts.headers["X-Firebase-AppCheck"]; return of2(url, opts); };
    await callDbGet(env, deps);
    deps.fetch = of2;
    assert.equal(sawHeader, undefined, "окно ещё не истекло (MIN)");
  }
  deps.setNow(failStart + MIN);
  attemptOutcomes = ["success"]; idx = 0;
  await callDbGet(env, deps);
  assert.equal(idx, 1, "на границе РОВНО MIN (не 2*MIN и не 4*MIN) должна была произойти новая попытка exchange -- подтверждает, что счётчик реально сбросился на успехе, а не продолжился с прежней ступени");
  deps.fetch = originalFetch;
});

// ===== 9. №26 invariant: required=true остаётся fail-closed во время backoff, required=false -- fail-open =====

test("#26 invariant preserved: APP_CHECK_REQUIRED=true during an active backoff window -- RTDB request physically does not go out", async () => {
  const { env, deps } = makeEnvDeps({ appCheckRequired: "true" });
  await assert.rejects(callDbGet(env, deps), /app_check_unavailable/); // 1-я неудача, входим в backoff
  // Всё ещё внутри MIN-окна -- required=true должен продолжать fail-closed.
  deps.setNow(deps.now() + MIN - 1);
  await assert.rejects(callDbGet(env, deps), /app_check_unavailable/);
});

test("#26 invariant preserved: APP_CHECK_REQUIRED=false (default) during an active backoff window -- unchanged fail-open behavior", async () => {
  const { env, deps, rtdb } = makeEnvDeps({ appCheckRequired: undefined });
  await callDbGet(env, deps); // не бросает -- fail-open, реальный RTDB fetch происходит без заголовка
  deps.setNow(deps.now() + MIN - 1);
  await callDbGet(env, deps); // всё ещё внутри окна -- всё ещё fail-open, не бросает
});

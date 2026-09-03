/**
 * Dark settlement candidate. Not deployed.
 *
 * Invariants:
 * - caller UID comes from a Firebase ID token verified by the Worker entrypoint;
 * - RTDB access uses a Firebase ID token for uid=srv_settlement, so Rules apply;
 * - receipt + BOTH players' stats are one atomic multi-location PATCH;
 * - receipt is create-only in Rules and is the cross-version idempotency lock;
 * - расчёт партии — ОДНА атомарная операция: квитанция и обе статистики
   одним корневым PATCH. Никаких последующих записей нет, поэтому
   частичного состояния не бывает по построению;
 * - no stats.recentMatches marker is used.
 */

const SRV_UID = "srv_settlement";
const ELO_K = 32;
const ELO_START = 1000;

let cachedServerToken = null;

export function resetServerTokenCache() { cachedServerToken = null; }

export function isServerTokenFresh(cache, nowMs) {
  return !!cache && typeof cache.idToken === "string" && cache.expiresAtMs - nowMs > 300000;
}

export async function getServerIdToken(env, deps) {
  const now = deps.now();
  if (isServerTokenFresh(cachedServerToken, now)) return cachedServerToken.idToken;
  if (!deps.signCustomToken) throw new Error("server_signer_missing");

  const customToken = await deps.signCustomToken(
    SRV_UID,
    env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
    env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY,
    Math.floor(now / 1000)
  );

  const res = await deps.fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" +
      encodeURIComponent(env.FIREBASE_WEB_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  );
  if (!res.ok) throw new Error("server_identity_failed");
  const data = await res.json();
  if (!data || typeof data.idToken !== "string") throw new Error("server_identity_failed");

  cachedServerToken = {
    idToken: data.idToken,
    expiresAtMs: now + Number(data.expiresIn || 3600) * 1000
  };
  return cachedServerToken.idToken;
}


// ============ APP CHECK ДЛЯ СЕРВЕРНОЙ ЛИЧНОСТИ (OAuth2 + exchange) ============
//
// База с включённым принуждением App Check отвергает запрос без заголовка
// X-Firebase-AppCheck даже с валидным ID-token и даже на публично читаемом
// пути. Клиентский SDK шлёт заголовок сам, голый REST из Worker — нет.
//
// Порядок ровно как в Firebase Admin SDK:
//   1. подписать OAuth2 assertion ключом сервисного аккаунта;
//   2. обменять его на access token на oauth2.googleapis.com;
//   3. вызвать exchangeCustomToken С ЗАГОЛОВКОМ Authorization: Bearer;
//   4. полученный App Check токен класть в X-Firebase-AppCheck.
//
// Шаг 3 требует OAuth: метод объявляет scopes cloud-platform и firebase, а
// customToken в теле — это ПРОВЕРЯЕМЫЕ ДАННЫЕ, а не учётные данные запроса.
// Именно поэтому Admin SDK ходит туда через AuthorizedHttpClient.
//
// ВАЖНО ПРО ГРАНИЦЫ: OAuth используется ТОЛЬКО для выпуска App Check
// токена. Доступ к базе по-прежнему идёт с Firebase ID token, поэтому
// Security Rules выполняются как раньше. Административного обхода правил
// здесь нет.
//
// Единственная новая переменная: FIREBASE_APP_ID. Номер проекта берётся
// из неё же — второй сегмент идентификатора вида 1:<number>:web:<hex>.

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/firebase";
const APPCHECK_TOKEN_EXCHANGE_AUD =
  "https://firebaseappcheck.googleapis.com/google.firebase.appcheck.v1.TokenExchangeService";

// Пауза после неудачи: постоянная ошибка настройки не должна порождать
// повторный сетевой обмен на КАЖДОЙ операции с базой.
const APPCHECK_FAIL_COOLDOWN_MS = 60000;

let cachedAccessToken = null;     // { token, expiresAtMs }
let cachedAppCheckToken = null;   // { token, expiresAtMs }
let appCheckFailUntilMs = 0;
let appCheckLastError = null;

function resetAppCheckCache() {
  cachedAccessToken = null;
  cachedAppCheckToken = null;
  appCheckFailUntilMs = 0;
  appCheckLastError = null;
}

function isTokenFresh(cache, nowMs) {
  return !!cache && typeof cache.token === "string"
    && cache.expiresAtMs - nowMs > 300000;
}

function projectNumberFromAppId(appId) {
  const m = /^1:(\d+):web:[0-9a-f]+$/.exec(String(appId || ""));
  return m ? m[1] : null;
}

// Диагностика: только фиксированный код и HTTP-статус.
function appCheckLog(code, status, nowMs) {
  const allowed = ["not_configured", "oauth_sign_failed", "oauth_failed",
    "oauth_malformed", "exchange_failed", "exchange_malformed", "sign_failed"];
  const safe = allowed.indexOf(code) !== -1 ? code : "unknown";
  appCheckLastError = safe;
  if (typeof nowMs === "number") appCheckFailUntilMs = nowMs + APPCHECK_FAIL_COOLDOWN_MS;
  try {
    const prefix = (safe.indexOf("oauth") === 0) ? "OAUTH_DEBUG" : "APPCHECK_DEBUG";
    let line = prefix + " error=" + safe;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      line += " status=" + status;
    }
    console.error(line);
  } catch (_) {}
}

// Подписанный assertion для обмена на access token.
async function createOauthAssertion(serviceAccountEmail, privateKeyPem, nowSeconds) {
  if (typeof serviceAccountEmail !== "string" || !serviceAccountEmail.includes("@")) {
    throw new Error("firebase_service_account_email_missing");
  }
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccountEmail,
    scope: GOOGLE_OAUTH_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  return signRs256Jwt(header, payload, privateKeyPem);
}

async function createAppCheckCustomToken(appId, serviceAccountEmail, privateKeyPem, nowSeconds) {
  if (typeof serviceAccountEmail !== "string" || !serviceAccountEmail.includes("@")) {
    throw new Error("firebase_service_account_email_missing");
  }
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: APPCHECK_TOKEN_EXCHANGE_AUD,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    app_id: appId
  };
  return signRs256Jwt(header, payload, privateKeyPem);
}

// Общая подпись: та же схема, что уже используется для custom token Auth.
async function signRs256Jwt(header, payload, privateKeyPem) {
  const signingInput =
    stringToBase64Url(JSON.stringify(header)) + "." +
    stringToBase64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8Bytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, utf8.encode(signingInput)));
  return signingInput + "." + bytesToBase64Url(signature);
}

async function getGoogleAccessToken(env, deps) {
  const now = deps.now();
  if (isTokenFresh(cachedAccessToken, now)) return cachedAccessToken.token;

  let assertion;
  try {
    const sign = deps.signOauthAssertion || createOauthAssertion;
    assertion = await sign(env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
      env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY, Math.floor(now / 1000));
  } catch (e) {
    appCheckLog("oauth_sign_failed", null, now);
    return null;
  }

  const body = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
    "&assertion=" + encodeURIComponent(assertion);
  const res = await deps.fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  });
  if (!res.ok) { appCheckLog("oauth_failed", res.status, now); return null; }
  const data = await res.json();
  if (!data || typeof data.access_token !== "string") {
    appCheckLog("oauth_malformed", null, now); return null;
  }
  const ttl = Number(data.expires_in || 3600);
  cachedAccessToken = { token: data.access_token, expiresAtMs: now + ttl * 1000 };
  return cachedAccessToken.token;
}

// Возвращает App Check токен либо null. null означает: запрос уйдёт БЕЗ
// заголовка, то есть ровно как в текущем production.
async function getAppCheckToken(env, deps) {
  const now = deps.now();
  if (isTokenFresh(cachedAppCheckToken, now)) return cachedAppCheckToken.token;
  if (now < appCheckFailUntilMs) return null;

  const appId = env.FIREBASE_APP_ID;
  const projectNumber = projectNumberFromAppId(appId);
  if (!appId || !projectNumber) { appCheckLog("not_configured", null, now); return null; }

  try {
    const accessToken = await getGoogleAccessToken(env, deps);
    if (!accessToken) return null;   // причина уже записана

    const sign = deps.signAppCheckToken || createAppCheckCustomToken;
    const customToken = await sign(appId, env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
      env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY, Math.floor(now / 1000));

    const res = await deps.fetch(
      "https://firebaseappcheck.googleapis.com/v1/projects/" + projectNumber +
        "/apps/" + encodeURIComponent(appId) + ":exchangeCustomToken",
      { method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + accessToken
        },
        body: JSON.stringify({ customToken: customToken }) });
    if (!res.ok) { appCheckLog("exchange_failed", res.status, now); return null; }
    const data = await res.json();
    if (!data || typeof data.token !== "string") {
      appCheckLog("exchange_malformed", null, now); return null;
    }
    const ttlSec = parseInt(String(data.ttl || "3600"), 10) || 3600;
    cachedAppCheckToken = { token: data.token, expiresAtMs: now + ttlSec * 1000 };
    appCheckLastError = null;
    appCheckFailUntilMs = 0;
    return cachedAppCheckToken.token;
  } catch (e) {
    appCheckLog("sign_failed", null, now);
    return null;
  }
}

async function dbHeaders(env, deps, extra) {
  const h = Object.assign({}, extra || {});
  const token = await getAppCheckToken(env, deps);
  if (token) h["X-Firebase-AppCheck"] = token;
  return h;
}

function dbUrl(env, path, token) {
  const base = String(env.FIREBASE_DB_URL || "").replace(/\/$/, "");
  const clean = String(path || "").replace(/^\//, "");
  return base + "/" + clean + ".json?auth=" + encodeURIComponent(token);
}

export async function dbGet(env, deps, token, path) {
  const r = await deps.fetch(dbUrl(env, path, token),
    { method: "GET", headers: await dbHeaders(env, deps) });
  if (!r.ok) throw new Error("db_read_failed");
  return await r.json();
}

export async function dbGetWithEtag(env, deps, token, path) {
  const r = await deps.fetch(dbUrl(env, path, token), {
    method: "GET",
    headers: await dbHeaders(env, deps, { "X-Firebase-ETag": "true" })
  });
  if (!r.ok) throw new Error("db_read_failed");
  return { value: await r.json(), etag: r.headers.get("ETag") };
}

export async function dbPutIfMatch(env, deps, token, path, etag, value) {
  const r = await deps.fetch(dbUrl(env, path, token), {
    method: "PUT",
    headers: await dbHeaders(env, deps, { "if-match": etag, "Content-Type": "application/json" }),
    body: JSON.stringify(value)
  });
  if (r.status === 412) return { ok: false, conflict: true };
  if (!r.ok) throw new Error("db_write_failed");
  return { ok: true, conflict: false };
}

export async function dbPatchRoot(env, deps, token, updates) {
  const r = await deps.fetch(dbUrl(env, "", token), {
    method: "PATCH",
    headers: await dbHeaders(env, deps, { "Content-Type": "application/json" }),
    body: JSON.stringify(updates)
  });
  if (!r.ok) {
    const err = new Error("db_write_failed");
    err.status = r.status;
    throw err;
  }
  return true;
}

function serverIncrement(delta) {
  return { ".sv": { increment: delta } };
}
function serverTimestamp() {
  return { ".sv": "timestamp" };
}

export function buildCanonicalMatchId(roomCode, createdAt, matchNumber) {
  const stamp = typeof createdAt === "number" && isFinite(createdAt) ? createdAt : 0;
  const num = typeof matchNumber === "number" && isFinite(matchNumber) ? matchNumber : 0;
  return "elo_" + roomCode + "_" + stamp + "_" + num;
}

export function callerColor(room, uid) {
  const p = (room && room.players) || {};
  if (p.light && p.light.id === uid) return "light";
  if (p.dark && p.dark.id === uid) return "dark";
  return null;
}

export function decideRegistration(index, room) {
  const mn = typeof room.matchNumber === "number" ? room.matchNumber : 0;
  if (index && index.createdAt !== room.createdAt) {
    return mn === 0 ? { ok: true, matchNumber: 0, fresh: true } : { ok: false, reason: "not_first_match" };
  }
  if (!index) return mn === 0 ? { ok: true, matchNumber: 0 } : { ok: false, reason: "not_first_match" };
  const last = typeof index.lastMatchNumber === "number" ? index.lastMatchNumber : 0;
  if (mn === last) return { ok: true, matchNumber: mn, already: true };
  if (mn === last + 1) return { ok: true, matchNumber: mn };
  return { ok: false, reason: "match_number_jump" };
}

export function eloDeltas(lightRating, darkRating, result) {
  if (!Number.isFinite(lightRating) || lightRating < 0 ||
      !Number.isFinite(darkRating) || darkRating < 0) {
    throw new Error("card_mismatch");
  }

  const expectedLight = 1 / (1 + Math.pow(10, (darkRating - lightRating) / 400));
  const scoreLight = result === "draw" ? 0.5 : result === "light" ? 1 : 0;
  const originalLight = Math.round(ELO_K * (scoreLight - expectedLight));

  // One original delta is authoritative; the other side is always its exact
  // opposite. If the negative side cannot pay the full loss, cap BOTH sides
  // by that frozen rating so the settlement stays strict zero-sum and >= 0.
  if (originalLight === 0) return { light: 0, dark: 0 };
  const negativeRating = originalLight < 0 ? lightRating : darkRating;
  const cap = Math.min(Math.abs(originalLight), negativeRating);
  if (cap === 0) return { light: 0, dark: 0 };
  const light = originalLight < 0 ? -cap : cap;
  return { light, dark: -light };
}

export function roomOutcome(room) {
  const w = room && room.winner;
  return w === "light" || w === "dark" || w === "draw" ? w : null;
}

function safeName(value, fallback) {
  const s = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return String(s || "Игрок").slice(0, 48);
}

function normalizeStatsNode(cur, uid, name) {
  const st = cur && typeof cur === "object" && !Array.isArray(cur) ? Object.assign({}, cur) : {};
  let changed = !(cur && typeof cur === "object" && !Array.isArray(cur));
  const setIf = (key, value, valid) => {
    if (!valid(st[key])) { st[key] = value; changed = true; }
  };
  setIf("wins", 0, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  setIf("losses", 0, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  setIf("rating", ELO_START, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  setIf("draws", 0, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  if (typeof st.name !== "string" || !st.name.length || st.name.length >= 50) {
    st.name = safeName(name, uid);
    changed = true;
  }
  return { node: st, changed };
}

export async function ensureStatsInitialized(env, deps, token, uid, name) {
  const path = "stats/" + uid;
  for (let i = 0; i < 6; i++) {
    const cur = await dbGetWithEtag(env, deps, token, path);
    const normalized = normalizeStatsNode(cur.value, uid, name);
    if (!normalized.changed) return normalized.node;
    const put = await dbPutIfMatch(env, deps, token, path, cur.etag, normalized.node);
    if (put.ok) return normalized.node;
  }
  throw new Error("stats_init_conflict");
}

function cardByColor(card) {
  const parts = card && card.participants;
  if (!parts || typeof parts !== "object") throw new Error("match_not_rated");
  const uids = Object.keys(parts);
  if (uids.length !== 2) throw new Error("match_not_rated");
  const by = {};
  for (const uid of uids) {
    const color = parts[uid] && parts[uid].color;
    if (color !== "light" && color !== "dark") throw new Error("match_not_rated");
    if (by[color]) throw new Error("match_not_rated");
    by[color] = uid;
  }
  if (!by.light || !by.dark || by.light === by.dark) throw new Error("match_not_rated");
  return by;
}

export function sameGeneration(card, roomCode, room) {
  if (!card || !room) return false;
  const mn = typeof room.matchNumber === "number" ? room.matchNumber : 0;
  return card.roomCode === roomCode && card.createdAt === room.createdAt && card.matchNumber === mn;
}

function cardMatchesRoomPlayers(card, room) {
  const by = cardByColor(card);
  return !!(
    room && room.players && room.players.light && room.players.dark &&
    room.players.light.id === by.light && room.players.dark.id === by.dark
  );
}

function validateExistingCard(card, roomCode, room, expectedLight, expectedDark) {
  if (!sameGeneration(card, roomCode, room)) throw new Error("card_mismatch");
  const by = cardByColor(card);
  if (by.light !== expectedLight || by.dark !== expectedDark) throw new Error("card_mismatch");
  const lp = card.participants[by.light];
  const dp = card.participants[by.dark];
  if (typeof lp.ratingAtJoin !== "number" || typeof dp.ratingAtJoin !== "number") throw new Error("card_mismatch");
  return card;
}

async function ensureMatchCard(env, deps, token, matchId, card) {
  const path = "matches/" + matchId;
  const cur = await dbGetWithEtag(env, deps, token, path);
  if (cur.value) return cur.value;
  const put = await dbPutIfMatch(env, deps, token, path, cur.etag, card);
  if (put.ok) return card;
  const existing = await dbGet(env, deps, token, path);
  if (!existing) throw new Error("card_conflict");
  return existing;
}

async function finalizePointer(env, deps, token, roomCode, matchId, card) {
  const latestRoom = await dbGet(env, deps, token, "rooms/" + roomCode);
  if (!latestRoom || !sameGeneration(card, roomCode, latestRoom)) throw new Error("stale_generation");
  // Mixed-version safety: registration must become visible to cached v193 only
  // while THIS generation is still a live game. If the game finished while
  // /rated/join was in flight, publishing ratingsAtStart afterwards can make
  // v193 switch from its already-taken legacy fallback to the canonical receipt
  // path, allowing the same physical result to be counted by two mechanisms.
  if (latestRoom.status !== "active" || roomOutcome(latestRoom)) throw new Error("room_not_active");
  // A normal rematch changes both matchNumber and sides, but re-check the player
  // binding too: never publish a snapshot captured for a different seat layout.
  if (!cardMatchesRoomPlayers(card, latestRoom)) throw new Error("card_mismatch");
  const index = await dbGet(env, deps, token, "matchIndex/" + roomCode);
  if (!index || index.matchId !== matchId || index.createdAt !== latestRoom.createdAt ||
      index.lastMatchNumber !== latestRoom.matchNumber) {
    throw new Error("stale_generation");
  }
  // Migration compatibility: publish the authoritative rating snapshot into the
  // legacy room shape at the same time as ratedMatchId. Cached v193 clients
  // require BOTH ratingsAtStart values to choose their canonical elo_<...>
  // receipt path; without the full snapshot they fall back to direct stats and
  // online_<...> идентификаторы, несовместимые с расчётом на сервере.
  const by = cardByColor(card);
  await dbPatchRoot(env, deps, token, {
    ["rooms/" + roomCode + "/ratedMatchId"]: matchId,
    ["rooms/" + roomCode + "/ratingsAtStart/light"]: card.participants[by.light].ratingAtJoin,
    ["rooms/" + roomCode + "/ratingsAtStart/dark"]: card.participants[by.dark].ratingAtJoin
  });
}

export async function joinRatedMatch(env, deps, callerUid, roomCode) {
  const token = await getServerIdToken(env, deps);
  const room = await dbGet(env, deps, token, "rooms/" + roomCode);
  if (!room || !room.players) throw new Error("room_not_found");
  const color = callerColor(room, callerUid);
  if (!color) throw new Error("not_a_player");
  if (room.status !== "active" || roomOutcome(room)) throw new Error("room_not_active");

  const lightId = room.players.light && room.players.light.id;
  const darkId = room.players.dark && room.players.dark.id;
  if (!lightId || !darkId || lightId === darkId || !/^tg_\d+$/.test(lightId) || !/^tg_\d+$/.test(darkId)) {
    throw new Error("room_not_ready");
  }
  if (typeof room.createdAt !== "number" || !isFinite(room.createdAt) || room.createdAt <= 0 ||
      typeof room.matchNumber !== "number" || !Number.isInteger(room.matchNumber) || room.matchNumber < 0) {
    throw new Error("room_not_ready");
  }

  const idxPath = "matchIndex/" + roomCode;
  const idx = await dbGetWithEtag(env, deps, token, idxPath);
  const verdict = decideRegistration(idx.value, room);
  if (!verdict.ok) throw new Error(verdict.reason);
  const matchId = buildCanonicalMatchId(roomCode, room.createdAt, verdict.matchNumber);

  // Initialize/freeze ratings before claiming the index. The card is create-only
  // in practice, so the first creator fixes the snapshot for all retries.
  const [sl, sd] = await Promise.all([
    ensureStatsInitialized(env, deps, token, lightId, room.players.light.name),
    ensureStatsInitialized(env, deps, token, darkId, room.players.dark.name)
  ]);

  const proposedCard = {
    roomCode,
    createdAt: room.createdAt,
    matchNumber: verdict.matchNumber,
    participants: {
      [lightId]: { color: "light", ratingAtJoin: sl.rating, name: safeName(room.players.light.name, lightId) },
      [darkId]: { color: "dark", ratingAtJoin: sd.rating, name: safeName(room.players.dark.name, darkId) }
    }
  };

  const card = await ensureMatchCard(env, deps, token, matchId, proposedCard);
  validateExistingCard(card, roomCode, room, lightId, darkId);

  let indexIsOurs = verdict.already && idx.value && idx.value.matchId === matchId;
  if (!indexIsOurs) {
    const claim = await dbPutIfMatch(env, deps, token, idxPath, idx.etag, {
      matchId,
      lastMatchNumber: verdict.matchNumber,
      pair: lightId + "|" + darkId,
      createdAt: room.createdAt
    });
    if (claim.conflict) {
      const again = await dbGet(env, deps, token, idxPath);
      if (!again || again.matchId !== matchId || again.createdAt !== room.createdAt ||
          again.lastMatchNumber !== verdict.matchNumber) {
        throw new Error("registration_conflict");
      }
    }
  }

  await finalizePointer(env, deps, token, roomCode, matchId, card);
  return { matchId, color, already: !!verdict.already };
}

export function validateReceiptAgainstCard(receipt, card, expectedResult) {
  if (!receipt || typeof receipt !== "object") throw new Error("receipt_mismatch");
  const by = cardByColor(card);
  if (receipt.lightId !== by.light || receipt.darkId !== by.dark) throw new Error("receipt_mismatch");
  if (receipt.result !== "light" && receipt.result !== "dark" && receipt.result !== "draw") {
    throw new Error("receipt_mismatch");
  }
  if (expectedResult && receipt.result !== expectedResult) throw new Error("receipt_mismatch");
  if (receipt.settledBy !== undefined && receipt.settledBy !== "worker") throw new Error("receipt_mismatch");

  if (receipt.settledBy === "worker") {
    const rl = card.participants[by.light].ratingAtJoin;
    const rd = card.participants[by.dark].ratingAtJoin;
    const d = eloDeltas(rl, rd, receipt.result);
    if (receipt.lightRatingBefore !== rl || receipt.darkRatingBefore !== rd ||
        receipt.lightDelta !== d.light || receipt.darkDelta !== d.dark) {
      throw new Error("receipt_mismatch");
    }
  }
  return by;
}

function buildSettlementUpdates(matchId, card, result) {
  const by = cardByColor(card);
  const rl = card.participants[by.light].ratingAtJoin;
  const rd = card.participants[by.dark].ratingAtJoin;
  const d = eloDeltas(rl, rd, result);
  const u = {};
  u["eloMatches/" + matchId] = {
    lightId: by.light,
    darkId: by.dark,
    result,
    lightRatingBefore: rl,
    darkRatingBefore: rd,
    lightDelta: d.light,
    darkDelta: d.dark,
    settledBy: "worker",
    createdAt: serverTimestamp()
  };
  u["stats/" + by.light + "/rating"] = serverIncrement(d.light);
  u["stats/" + by.dark + "/rating"] = serverIncrement(d.dark);
  if (result === "draw") {
    u["stats/" + by.light + "/draws"] = serverIncrement(1);
    u["stats/" + by.dark + "/draws"] = serverIncrement(1);
  } else if (result === "light") {
    u["stats/" + by.light + "/wins"] = serverIncrement(1);
    u["stats/" + by.dark + "/losses"] = serverIncrement(1);
  } else {
    u["stats/" + by.dark + "/wins"] = serverIncrement(1);
    u["stats/" + by.light + "/losses"] = serverIncrement(1);
  }
  return { updates: u, deltas: d, by };
}



async function settleFromReceiptWithoutRoom(env, deps, token, matchId, callerUid) {
  const card = await dbGet(env, deps, token, "matches/" + matchId);
  if (!card || !card.participants) throw new Error("match_not_registered");
  if (!Object.prototype.hasOwnProperty.call(card.participants, callerUid)) throw new Error("not_a_participant");
  const receipt = await dbGet(env, deps, token, "eloMatches/" + matchId);
  if (!receipt) throw new Error("nothing_to_resume");
  // Without the live room, only a Worker-owned receipt is trusted for the outcome.
  if (receipt.settledBy !== "worker") throw new Error("legacy_receipt_room_missing");
  validateReceiptAgainstCard(receipt, card, null);
  return {
    matchId,
    already: true,
    source: "worker_receipt_without_room",
    ratingConfirmed: true,
    deltas: { light: receipt.lightDelta, dark: receipt.darkDelta },
    result: receipt.result
  };
}

export async function settleMatch(env, deps, callerUid, roomCode, knownMatchId) {
  const token = await getServerIdToken(env, deps);
  const room = await dbGet(env, deps, token, "rooms/" + roomCode);

  if (!room) {
    if (typeof knownMatchId !== "string" || !knownMatchId) throw new Error("room_not_found");
    return await settleFromReceiptWithoutRoom(env, deps, token, knownMatchId, callerUid);
  }

  const matchId = room.ratedMatchId;
  if (typeof matchId !== "string" || !matchId) throw new Error("match_not_registered");
  const card = await dbGet(env, deps, token, "matches/" + matchId);
  if (!card) throw new Error("match_not_registered");
  if (!sameGeneration(card, roomCode, room)) throw new Error("stale_generation");
  if (!cardMatchesRoomPlayers(card, room)) throw new Error("card_mismatch");
  if (!Object.prototype.hasOwnProperty.call(card.participants || {}, callerUid)) throw new Error("not_a_participant");

  if (room.status !== "finished") throw new Error("match_not_finished");
  const result = roomOutcome(room);
  if (!result) throw new Error("match_not_finished");

  let existing = await dbGet(env, deps, token, "eloMatches/" + matchId);
  if (existing) {
    validateReceiptAgainstCard(existing, card, result);
    if (existing.settledBy === "worker") {
      return {
        matchId,
        already: true,
        source: "worker",
        ratingConfirmed: true,
        deltas: { light: existing.lightDelta, dark: existing.darkDelta },
        result: existing.result
      };
    }
    // Under BRIDGE-A a legacy receipt is not authoritative proof that the
    // matching stats increments were applied: cached v193 normally writes
    // receipt + stats atomically, but the transition rules still allow a
    // forged create-only receipt. Treat it as the settlement lock for
    // compatibility, but do not tell C1 that an exact rating delta is
    // confirmed. BRIDGE-B removes this transitional ambiguity entirely.
    return {
      matchId,
      already: true,
      source: "legacy",
      ratingConfirmed: false,
      deltas: null,
      result: existing.result
    };
  }

  const by = cardByColor(card);
  await Promise.all([
    ensureStatsInitialized(env, deps, token, by.light, card.participants[by.light].name),
    ensureStatsInitialized(env, deps, token, by.dark, card.participants[by.dark].name)
  ]);

  const built = buildSettlementUpdates(matchId, card, result);
  let wrote = false;
  try {
    await dbPatchRoot(env, deps, token, built.updates);
    wrote = true;
  } catch (error) {
    // A concurrent v193/Worker settlement can make the create-only receipt reject
    // our whole atomic PATCH. Re-read the lock; only a valid matching receipt turns
    // this failure into an idempotent success.
    existing = await dbGet(env, deps, token, "eloMatches/" + matchId);
    if (!existing) throw error;
    validateReceiptAgainstCard(existing, card, result);
  }

  if (wrote) {
    return {
      matchId,
      already: false,
      source: "worker",
      ratingConfirmed: true,
      deltas: built.deltas,
      result
    };
  }
  if (existing && existing.settledBy === "worker") {
    return {
      matchId,
      already: true,
      source: "concurrent",
      ratingConfirmed: true,
      deltas: { light: existing.lightDelta, dark: existing.darkDelta },
      result: existing.result
    };
  }
  return {
    matchId,
    already: true,
    source: "concurrent",
    ratingConfirmed: false,
    deltas: null,
    result: existing ? existing.result : result
  };
}

const FIREBASE_CUSTOM_TOKEN_AUD =
  "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

const utf8 = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringToBase64Url(value) {
  return bytesToBase64Url(utf8.encode(value));
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("telegram_hash_invalid");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

async function importHmacKey(rawBytes, usages) {
  return crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await importHmacKey(keyBytes, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

function sortedDataCheckString(params) {
  const pairs = [];
  for (const [key, value] of params.entries()) {
    // Telegram's bot-token validation excludes only hash.
    // A newer "signature" field, if present, remains part of this check string.
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("\n");
}

function safeDisplayName(user) {
  let name = "Игрок";
  if (typeof user.username === "string" && user.username.trim()) {
    name = "@" + user.username.trim();
  } else if (typeof user.first_name === "string" && user.first_name.trim()) {
    name = user.first_name.trim();
  }
  // Existing RTDB rules require name.length < 50.
  return name.slice(0, 49);
}

export async function validateTelegramInitData(
  initData,
  botToken,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 3600,
  futureSkewSeconds = 60
) {
  if (typeof initData !== "string" || initData.length < 1 || initData.length > 16384) {
    throw new Error("init_data_invalid");
  }
  if (typeof botToken !== "string" || botToken.length < 10) {
    throw new Error("bot_token_missing");
  }

  const params = new URLSearchParams(initData);
  const hashes = params.getAll("hash");
  if (hashes.length !== 1) throw new Error("telegram_hash_missing_or_duplicate");
  const suppliedHash = hexToBytes(hashes[0]);

  const dataCheckString = sortedDataCheckString(params);

  // Telegram Mini App algorithm:
  // secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
  // hash       = HMAC_SHA256(key=secret_key, data=data_check_string)
  const secretKeyBytes = await hmacSha256(
    utf8.encode("WebAppData"),
    utf8.encode(botToken)
  );
  const verifyKey = await importHmacKey(secretKeyBytes, ["verify"]);
  const signatureOK = await crypto.subtle.verify(
    "HMAC",
    verifyKey,
    suppliedHash,
    utf8.encode(dataCheckString)
  );
  if (!signatureOK) throw new Error("telegram_signature_invalid");

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) throw new Error("auth_date_invalid");
  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate)) throw new Error("auth_date_invalid");
  if (authDate > nowSeconds + futureSkewSeconds) throw new Error("auth_date_from_future");
  if (nowSeconds - authDate > maxAgeSeconds) throw new Error("auth_date_too_old");

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("telegram_user_missing");

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error("telegram_user_invalid_json");
  }

  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error("telegram_user_id_invalid");
  }

  const uid = `tg_${user.id}`;
  if (uid.length > 128) throw new Error("firebase_uid_too_long");

  return {
    uid,
    telegramId: String(user.id),
    name: safeDisplayName(user),
    authDate
  };
}

function pemToPkcs8Bytes(pem) {
  if (typeof pem !== "string" || !pem.includes("PRIVATE KEY")) {
    throw new Error("firebase_private_key_missing");
  }
  // Supports Cloudflare secrets pasted with either real newlines or escaped \n.
  const normalized = pem.replace(/\\n/g, "\n");
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!base64) throw new Error("firebase_private_key_invalid");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createFirebaseCustomToken(
  uid,
  serviceAccountEmail,
  privateKeyPem,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  if (typeof uid !== "string" || uid.length < 1 || uid.length > 128) {
    throw new Error("firebase_uid_invalid");
  }
  if (typeof serviceAccountEmail !== "string" || !serviceAccountEmail.includes("@")) {
    throw new Error("firebase_service_account_email_missing");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: FIREBASE_CUSTOM_TOKEN_AUD,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    uid
  };

  const signingInput =
    stringToBase64Url(JSON.stringify(header)) +
    "." +
    stringToBase64Url(JSON.stringify(payload));

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      privateKey,
      utf8.encode(signingInput)
    )
  );

  return signingInput + "." + bytesToBase64Url(signature);
}

function parseAllowedOrigins(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store"
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // allows direct diagnostic calls; auth still requires signed initData
  return parseAllowedOrigins(env.ALLOWED_ORIGINS).includes(origin);
}

function jsonResponse(request, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env)
    }
  });
}

function publicErrorCode(error) {
  const code = error && error.message ? String(error.message) : "auth_failed";
  const known = new Set([
    "init_data_invalid",
    "telegram_hash_missing_or_duplicate",
    "telegram_hash_invalid",
    "telegram_signature_invalid",
    "auth_date_invalid",
    "auth_date_from_future",
    "auth_date_too_old",
    "telegram_user_missing",
    "telegram_user_invalid_json",
    "telegram_user_id_invalid"
  ]);
  return known.has(code) ? code : "auth_failed";
}


function settlementCorsHeaders(request, env) {
  const headers = corsHeaders(request, env);
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  return headers;
}

function jsonSettlementResponse(request, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...settlementCorsHeaders(request, env)
    }
  });
}

function extractBearer(request) {
  const raw = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+([^\s]+)$/i.exec(raw);
  if (!m || m[1].length < 20 || m[1].length > 10000) throw new Error("firebase_auth_invalid");
  return m[1];
}

export async function verifyCallerFirebaseIdToken(env, idToken, fetchFn = fetch) {
  if (!env.FIREBASE_WEB_API_KEY) throw new Error("server_not_configured");
  const res = await fetchFn(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
      encodeURIComponent(env.FIREBASE_WEB_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error("firebase_auth_invalid");
  const data = await res.json();
  if (!data || !Array.isArray(data.users) || data.users.length !== 1) throw new Error("firebase_auth_invalid");
  const user = data.users[0];
  const uid = user && user.localId;
  if (user && user.disabled === true) throw new Error("firebase_auth_invalid");
  if (typeof uid !== "string" || !/^tg_\d+$/.test(uid)) throw new Error("firebase_auth_invalid");
  return uid;
}

function validFirebasePathAtom(value, maxLen) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen && !/[.#$\[\]\/]/.test(value);
}

function settlementPublicError(error) {
  const code = error && error.message ? String(error.message) : "settlement_failed";
  const allowed = new Set([
    "room_not_found", "not_a_player", "room_not_active", "room_not_ready",
    "not_first_match", "match_number_jump", "registration_conflict",
    "stale_generation", "match_not_registered", "match_not_rated",
    "not_a_participant", "match_not_finished", "card_mismatch",
    "receipt_mismatch", "nothing_to_resume", "legacy_receipt_room_missing",
    "stats_init_conflict"
  ]);
  return allowed.has(code) ? code : "settlement_failed";
}

function settlementDeps() {
  return {
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    signCustomToken: createFirebaseCustomToken
  };
}

async function handleSettlement(request, env, url) {
  if (!originAllowed(request, env)) {
    return jsonSettlementResponse(request, env, 403, { ok: false, error: "origin_denied" });
  }
  if (!env.FIREBASE_SERVICE_ACCOUNT_EMAIL || !env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY ||
      !env.FIREBASE_WEB_API_KEY || !env.FIREBASE_DB_URL) {
    return jsonSettlementResponse(request, env, 503, { ok: false, error: "server_not_configured" });
  }

  let callerUid;
  try {
    callerUid = await verifyCallerFirebaseIdToken(env, extractBearer(request));
  } catch (error) {
    const code = error && error.message === "server_not_configured" ? "server_not_configured" : "firebase_auth_invalid";
    return jsonSettlementResponse(request, env, code === "server_not_configured" ? 503 : 401, { ok: false, error: code });
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonSettlementResponse(request, env, 400, { ok: false, error: "invalid_json" }); }

  try {
    const roomCode = body && body.roomCode;
    if (!validFirebasePathAtom(roomCode, 50)) {
      return jsonSettlementResponse(request, env, 400, { ok: false, error: "room_code_invalid" });
    }

    if (url.pathname === "/rated/join") {
      const result = await joinRatedMatch(env, settlementDeps(), callerUid, roomCode);
      return jsonSettlementResponse(request, env, 200, { ok: true, ...result });
    }
    if (url.pathname === "/rated/settle") {
      const knownMatchId = body && body.matchId;
      if (knownMatchId !== undefined && knownMatchId !== null && !validFirebasePathAtom(knownMatchId, 149)) {
        return jsonSettlementResponse(request, env, 400, { ok: false, error: "match_id_invalid" });
      }
      const result = await settleMatch(env, settlementDeps(), callerUid, roomCode, knownMatchId || null);
      return jsonSettlementResponse(request, env, 200, { ok: true, ...result });
    }
    return jsonSettlementResponse(request, env, 404, { ok: false, error: "not_found" });
  } catch (error) {
    const publicCode = settlementPublicError(error);
    const forbidden = publicCode === "not_a_player" || publicCode === "not_a_participant";
    return jsonSettlementResponse(request, env, forbidden ? 403 : 409, { ok: false, error: publicCode });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!originAllowed(request, env)) {
        return jsonResponse(request, env, 403, { ok: false, error: "origin_denied" });
      }
      // Authorization is needed only by settlement endpoints, but allowing it on
      // the shared preflight does not change /auth/telegram semantics.
      return new Response(null, { status: 204, headers: settlementCorsHeaders(request, env) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(request, env, 200, { ok: true });
    }

    if (request.method === "POST" && (url.pathname === "/rated/join" || url.pathname === "/rated/settle")) {
      return handleSettlement(request, env, url);
    }

    if (request.method !== "POST" || url.pathname !== "/auth/telegram") {
      return jsonResponse(request, env, 404, { ok: false, error: "not_found" });
    }

    // Everything below is the existing Telegram auth path, kept semantically unchanged.
    if (!originAllowed(request, env)) {
      return jsonResponse(request, env, 403, { ok: false, error: "origin_denied" });
    }

    if (!env.TELEGRAM_BOT_TOKEN ||
        !env.FIREBASE_SERVICE_ACCOUNT_EMAIL ||
        !env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      return jsonResponse(request, env, 503, { ok: false, error: "server_not_configured" });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(request, env, 400, { ok: false, error: "invalid_json" });
    }

    const maxAge = Number(env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 3600);
    if (!Number.isFinite(maxAge) || maxAge < 60 || maxAge > 86400) {
      return jsonResponse(request, env, 503, { ok: false, error: "server_not_configured" });
    }

    try {
      const identity = await validateTelegramInitData(
        body && body.initData,
        env.TELEGRAM_BOT_TOKEN,
        Math.floor(Date.now() / 1000),
        maxAge
      );

      const customToken = await createFirebaseCustomToken(
        identity.uid,
        env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
        env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY
      );

      return jsonResponse(request, env, 200, {
        ok: true,
        customToken,
        uid: identity.uid,
        name: identity.name
      });
    } catch (error) {
      return jsonResponse(request, env, 401, {
        ok: false,
        error: publicErrorCode(error)
      });
    }
  }
};

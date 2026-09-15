// №23: тесты РЕАЛЬНЫХ экспортируемых функций worker/index.mjs
// (commitTerminalOutcome, verifyDisconnectEvidence, verifyTimeoutEvidence)
// через существующий fake-rtdb harness (persistence-механика: ETag-CAS,
// atomic PATCH -- всё или ничего; Rules здесь НЕ применяются, это
// отдельно проверено в n23-terminal-design.rules.test.js через
// rule-eval-harness).

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { commitTerminalOutcome, verifyDisconnectEvidence, verifyTimeoutEvidence } from "../../worker/index.mjs";

const require = createRequire(import.meta.url);
const { createFakeRtdb } = require("../helpers/fake-rtdb.js");
const { createInitialPieces } = require("../../shared/game-engine.js");

const FIREBASE_DB_URL = "https://fake-db.example.com";
const MATCH_ID = "elo_ABC123_1700000000000_0";

function makeEnvDeps(nowStart) {
  let currentNow = nowStart;
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, function () { return currentNow; });
  const env = { FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT_EMAIL: "x", FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "x", FIREBASE_WEB_API_KEY: "x" };
  const deps = {
    now: function () { return currentNow; },
    setNow: function (v) { currentNow = v; },
    signCustomToken: async () => "fake-custom-token",
    fetch: async (url, options) => {
      if (typeof url === "string" && url.indexOf("identitytoolkit.googleapis.com") !== -1) {
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ idToken: "fake-server-id-token", expiresIn: 3600 })
        };
      }
      return rtdb.fetch(url, options);
    }
  };
  return { env, deps, store: rtdb.store, setNow: (v) => { currentNow = v; } };
}

function candidateFor(requestId, source, nextSeqStr, extra) {
  return {
    claim: Object.assign({ matchId: MATCH_ID, roomCode: "ABC123", source, kind: extra && extra.kind, requestId, seq: nextSeqStr, createdAt: 1_700_000_100_000 }),
    nextSeqStr,
    eventPayload: { type: source === "technical" ? "technical_result" : (extra && extra.eventType) || "resign", requestId },
    projectionUpdates: extra && extra.projectionUpdates
  };
}

test("REAL commitTerminalOutcome: first attempt on empty store creates claim + event atomically", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  const r = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r1", "protected", "000001"));
  assert.equal(r.ok, true);
  assert.ok(store.data.ratedTerminal && store.data.ratedTerminal[MATCH_ID]);
  assert.ok(store.data.ratedEvents[MATCH_ID].events["000001"]);
});

test("REAL commitTerminalOutcome: identical retry (same requestId) is idempotent, no duplicate event written", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r1", "protected", "000001"));
  const before = JSON.stringify(store.data);
  const retry = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r1", "protected", "000001"));
  assert.equal(retry.ok, true);
  assert.equal(JSON.stringify(store.data), before, "store must be byte-identical -- no second write happened");
});

test("REAL commitTerminalOutcome: conflicting requestId on already-claimed matchId -> terminal_conflict, store unchanged", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r1", "protected", "000001"));
  const before = JSON.stringify(store.data);
  const conflict = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r2", "technical", "000001"));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "terminal_conflict");
  assert.equal(JSON.stringify(store.data), before);
});

test("REAL commitTerminalOutcome: B2 path -- dbPatchRoot itself is rejected (simulating a Rules denial the fake persistence layer cannot arbitrate), Worker reclassifies against the winning claim instead of crashing", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  // fake-rtdb НЕ применяет Rules (документировано в самом файле) -- значит
  // оно не может арбитрировать create-once между двумя параллельными
  // dbPatchRoot само по себе. Настоящая атомарность create-once доказана
  // ОТДЕЛЬНО, на уровне текста самого Rules-правила, в
  // n23-terminal-design.rules.test.js (ratedTerminal: overwrite DENY).
  // Здесь проверяется другое: КОРРЕКТНОСТЬ САМОГО Worker-кода в ветке B2
  // (dbPatchRoot упал -> перечитать -> classify), для чего Rules-отказ
  // симулируется прямым throw на конкретном вызове.
  let patchCalls = 0;
  const originalFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH" && patchCalls === 0) {
      patchCalls++;
      // Кто-то ДРУГОЙ уже выиграл -- в реальном RTDB это будет 400 из-за
      // Rules; на уровне dbPatchRoot это проявляется как throw.
      store.data.ratedTerminal = { [MATCH_ID]: candidateFor("winner-r", "protected", "000001").claim };
      store.data.ratedEvents = { [MATCH_ID]: { events: { "000001": candidateFor("winner-r", "protected", "000001").eventPayload } } };
      const err = new Error("db_write_failed");
      err.status = 400;
      throw err;
    }
    return originalFetch(url, options);
  };

  const loser = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("loser-r", "technical", "000001"));
  assert.equal(loser.ok, false);
  assert.equal(loser.reason, "terminal_conflict");
  assert.equal(store.data.ratedEvents[MATCH_ID].events["000001"].requestId, "winner-r");
});

test("REAL commitTerminalOutcome: structurally anomalous claim-without-event is rejected, not silently repaired", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = { ratedTerminal: { [MATCH_ID]: { requestId: "r1" } } }; // событие отсутствует -- аномалия, не race
  const r = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r1", "protected", "000001"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "fail_closed_incomplete_terminal");
  assert.equal(r.requiresManualReview, true);
});

// ---------- verifyDisconnectEvidence / verifyTimeoutEvidence: раздельные, не размытые ----------

test("verifyDisconnectEvidence: genuine 60s+ absence both sides -> true", () => {
  const now = 1_700_000_100_000;
  const room = { presence: {
    light: { online: false, absentSince: now - 61000 },
    dark: { online: true, onlineSince: now - 61000 }
  } };
  assert.equal(verifyDisconnectEvidence(room, "light", "dark", now), true);
});

test("verifyDisconnectEvidence: loser absence under 60s -> false", () => {
  const now = 1_700_000_100_000;
  const room = { presence: {
    light: { online: false, absentSince: now - 30000 },
    dark: { online: true, onlineSince: now - 61000 }
  } };
  assert.equal(verifyDisconnectEvidence(room, "light", "dark", now), false);
});

test("verifyDisconnectEvidence: winner online-stability under 60s -> false", () => {
  const now = 1_700_000_100_000;
  const room = { presence: {
    light: { online: false, absentSince: now - 61000 },
    dark: { online: true, onlineSince: now - 5000 }
  } };
  assert.equal(verifyDisconnectEvidence(room, "light", "dark", now), false);
});

test("verifyTimeoutEvidence: elapsed beyond time control -> true", () => {
  const now = 1_700_000_100_000;
  const room = { turn: "dark", turnStartedAt: now - 40000, timeControlSeconds: 30 };
  assert.equal(verifyTimeoutEvidence(room, "dark", now), true);
});

test("verifyTimeoutEvidence: not yet elapsed -> false", () => {
  const now = 1_700_000_100_000;
  const room = { turn: "dark", turnStartedAt: now - 10000, timeControlSeconds: 30 };
  assert.equal(verifyTimeoutEvidence(room, "dark", now), false);
});

test("CORE INVARIANT end-to-end: joinRatedMatch (first registration) refreshes a pre-seeded, deeply-forged onlineSince atomically with ratedMatchId -- the forged value never becomes valid disconnect evidence", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  const NOW = 1_700_000_100_000;
  const { joinRatedMatch } = await import("../../worker/index.mjs");

  store.data = {
    rooms: { ABC123: {
      players: { light: { id: "tg_111", name: "Alice" }, dark: { id: "tg_222", name: "Bob" } },
      status: "active", createdAt: NOW - 5000, matchNumber: 0,
      pieces: createInitialPieces(), turn: "light", moveCount: 0,
      // Forged BEFORE registration, ratedMatchId absent at this point --
      // allowed under the unrated exemption (already tested separately).
      presence: {
        light: { online: true, onlineSince: NOW - 999999999, absentSince: null, lastSeen: NOW - 1000 },
        dark: { online: false, absentSince: NOW - 999999999, onlineSince: NOW - 2000000000 }
      }
    } },
    stats: { tg_111: { rating: 1200 }, tg_222: { rating: 1180 } }
  };

  const result = await joinRatedMatch(env, deps, "tg_111", "ABC123");
  const room = store.data.rooms.ABC123;

  assert.equal(room.ratedMatchId, result.matchId, "registration completed");
  assert.notEqual(room.presence.light.onlineSince, NOW - 999999999,
    "the pre-registration forged onlineSince must NOT survive -- it must have been refreshed atomically with ratedMatchId");
  assert.ok(room.presence.light.onlineSince >= NOW - 100 && room.presence.light.onlineSince <= NOW + 5000,
    "refreshed value must be genuinely close to real server time, not another arbitrary number");
  assert.notEqual(room.presence.dark.absentSince, NOW - 999999999,
    "the SAME closure must apply to the offline side's absentSince -- both colors refreshed, not just the joiner's own");
  assert.equal(room.presence.light.online, true, "the refresh must NOT flip the online boolean -- only the timestamp proof");
  assert.equal(room.presence.dark.online, false, "same for dark -- boolean preserved exactly as it already was live");
});

test("verifyTimeoutEvidence: claimed loser does not match room.turn -> false (prevents claiming against the wrong side)", () => {
  const now = 1_700_000_100_000;
  const room = { turn: "light", turnStartedAt: now - 40000, timeControlSeconds: 30 };
  assert.equal(verifyTimeoutEvidence(room, "dark", now), false);
});

// ---------- claimTechnicalOutcome: полный HTTP-handler-уровня путь ----------

import { claimTechnicalOutcome, verifiedReplayOutcome } from "../../worker/index.mjs";

function cardWithParticipants() {
  return {
    roomCode: "ABC123", createdAt: 1_700_000_000_000, matchNumber: 0, replayVersion: 1,
    participants: {
      tg_111: { color: "light", ratingAtJoin: 1200, name: "Alice" },
      tg_222: { color: "dark", ratingAtJoin: 1180, name: "Bob" }
    }
  };
}

test("claimTechnicalOutcome: genuine disconnect, caller is the stable-online winner -> succeeds, event+claim+projection all land atomically", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  const now = 1_700_000_100_000;
  store.data = {
    rooms: { ABC123: {
      ratedMatchId: MATCH_ID, status: "active",
      presence: { light: { online: true, onlineSince: now - 61000 }, dark: { online: false, absentSince: now - 61000 } }
    } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  const r = await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r1", reason: "disconnect" });
  assert.equal(r.winnerId, "tg_111");
  assert.equal(r.loserId, "tg_222");
  assert.ok(store.data.ratedTerminal[MATCH_ID]);
  assert.equal(store.data.rooms.ABC123.winner, "light");
  assert.equal(store.data.rooms.ABC123.winReason, "disconnect");
  assert.equal(store.data.rooms.ABC123.status, "finished");
});

test("claimTechnicalOutcome: insufficient evidence (opponent still online) -> throws, nothing written", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  const now = 1_700_000_100_000;
  store.data = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active",
      presence: { light: { online: true, onlineSince: now - 61000 }, dark: { online: true, onlineSince: now - 61000 } } } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  await assert.rejects(
    claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r1", reason: "disconnect" }),
    /technical_evidence_insufficient/
  );
  assert.equal(store.data.ratedTerminal, undefined);
});

test("claimTechnicalOutcome: caller cannot claim on behalf of a stale/foreign generation -> throws stale_generation", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {
    rooms: { ABC123: { ratedMatchId: "elo_ABC123_1700000000000_1", status: "active" } }, // другое поколение
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  await assert.rejects(
    claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r1", reason: "disconnect" }),
    /stale_generation/
  );
});

test("claimTechnicalOutcome + verifiedReplayOutcome: the resulting protected event is recognized as a genuine terminal outcome end-to-end", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  const now = 1_700_000_100_000;
  store.data = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active", turn: "dark", turnStartedAt: now - 40000, timeControlSeconds: 30 } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r1", reason: "timeout" });
  const winner = await verifiedReplayOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants());
  assert.equal(winner, "light");
});

test("retry with a DIFFERENT requestId but the SAME semantic outcome (e.g. localStorage reset between attempts) -> idempotent success, NOT a false conflict, no second event written", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  const now = 1_700_000_100_000;
  store.data = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active",
      presence: { light: { online: true, onlineSince: now - 61000 }, dark: { online: false, absentSince: now - 61000 } } } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  const first = await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r1", reason: "disconnect" });
  const eventsBefore = JSON.stringify(store.data.ratedEvents[MATCH_ID].events);

  // Другой requestId (как после сброса localStorage), тот же вызывающий,
  // те же обстоятельства -> та же самая заявка семантически.
  const retry = await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r2-different", reason: "disconnect" });

  assert.equal(retry.winnerId, first.winnerId);
  assert.equal(JSON.stringify(store.data.ratedEvents[MATCH_ID].events), eventsBefore, "no second event must be appended");
});

test("retry with a DIFFERENT requestId AND a genuinely DIFFERENT claimed winner (opponent also claiming) -> real terminal_conflict, not silently accepted", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  const now = 1_700_000_100_000;
  store.data = {
    rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active",
      presence: { light: { online: true, onlineSince: now - 61000 }, dark: { online: false, absentSince: now - 61000 } } } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
  await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r1", reason: "disconnect" });
  // dark (tg_222) пытается заявить ПРОТИВОПОЛОЖНЫЙ исход -- это НЕ retry,
  // это конкурирующая заявка, должна быть отклонена как реальный конфликт.
  await assert.rejects(
    claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_222", { requestId: "r-dark", reason: "disconnect" }),
    /terminal_conflict|technical_evidence_insufficient/
  );
});


// =====================================================================
// Z1-Z4: SERVER RACE -- technical_result не должен append'иться ПОСЛЕ уже
// durable обычного terminal-события (resign/draw_accept/финальный turn).
//
// Обычный commitRatedEvent делает fetchAllEvents -> replayEvents ->
// dbPutIfMatch, и только ПОТОМ отдельный await syncProjection(). Значит
// существует реальное окно, когда terminal-событие уже durable, а room
// projection ещё active/без winner -- и все evidence-проверки technical
// пути в этот момент проходят. Без настоящего replay в
// claimTechnicalOutcome в лог попадал ВТОРОЙ terminal, после чего
// replayEvents() на settlement бросал event_after_terminal и Elo не
// начислялся вовсе.
// =====================================================================

// Обычное terminal-событие resign от dark (проигравшего), durable в логе.
function persistedResignEvent() {
  return {
    requestId: "dark_0_resign", type: "resign", actorUid: "tg_222", color: "dark",
    matchId: MATCH_ID, roomCode: "ABC123", createdAt: 1_700_000_000_000,
    matchNumber: 0, ts: 1_700_000_050_000
  };
}

// Комната, в которой обычный terminal УЖЕ durable, но его syncProjection
// ещё не отработал: status active, winner отсутствует. Evidence для
// technical claim при этом полностью валиден.
function raceStore(now) {
  return {
    rooms: { ABC123: {
      ratedMatchId: MATCH_ID, status: "active",
      players: { light: { id: "tg_111", name: "Alice" }, dark: { id: "tg_222", name: "Bob" } },
      presence: { light: { online: true, onlineSince: now - 61000 }, dark: { online: false, absentSince: now - 61000 } }
    } },
    matches: { [MATCH_ID]: cardWithParticipants() }
  };
}

function eventsOf(store) {
  const node = store.data.ratedEvents && store.data.ratedEvents[MATCH_ID];
  return (node && node.events) || {};
}

// ---------- Z1: PRE-EXISTING NORMAL TERMINAL ----------
test("Z1: technical claim при уже durable resign (room ещё active, ratedTerminal нет) -> match_already_terminal, лог не испорчен, projection отремонтирована", async () => {
  const now = 1_700_000_100_000;
  const { env, deps, store } = makeEnvDeps(now);
  store.data = raceStore(now);
  store.data.ratedEvents = { [MATCH_ID]: { events: { "000000": persistedResignEvent() } } };

  assert.equal(store.data.rooms.ABC123.status, "active", "предусловие: комната ещё active");
  assert.equal(store.data.rooms.ABC123.winner, undefined, "предусловие: winner ещё нет");
  assert.equal(store.data.ratedTerminal, undefined, "предусловие: ratedTerminal отсутствует");

  let thrown = null;
  try {
    await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", { requestId: "r-tech-1", reason: "disconnect" });
  } catch (e) { thrown = e; }

  assert.ok(thrown, "вызов обязан завершиться ошибкой");
  assert.equal(thrown.message, "match_already_terminal");

  const events = eventsOf(store);
  assert.deepEqual(Object.keys(events), ["000000"], "второй terminal НЕ добавлен -- в логе только исходный resign");
  assert.equal(events["000000"].type, "resign", "исходный resign остаётся единственным terminal");
  assert.equal(store.data.ratedTerminal, undefined, "ratedTerminal НЕ создан");

  // syncProjection обязана была отремонтировать комнату из authoritative лога.
  const room = store.data.rooms.ABC123;
  assert.equal(room.status, "finished", "projection отремонтирована: status");
  assert.equal(room.winner, "light", "winner выведен из resign (сдался dark -> победил light)");
  assert.equal(room.winReason, "resign", "winReason выведен из resign");
});

// ---------- Z2: IDEMPOTENT TECHNICAL RETRY ----------
test("Z2: идемпотентный повтор ТОГО ЖЕ technical claim остаётся SUCCESS (existing ratedTerminal классифицируется ДО нового guard)", async () => {
  const now = 1_700_000_100_000;
  const { env, deps, store } = makeEnvDeps(now);
  store.data = raceStore(now);
  const body = { requestId: "r-tech-idem", reason: "disconnect" };

  const first = await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", body);
  assert.equal(first.winner, "light");
  const afterFirst = Object.keys(eventsOf(store));
  assert.equal(afterFirst.length, 1, "первый claim создал ровно одно событие");
  assert.ok(store.data.ratedTerminal[MATCH_ID], "первый claim создал ratedTerminal");

  // Теперь protectedLogAlreadyTerminal === true (technical_result уже в логе).
  // Порядок guard'ов обязан оставить это SUCCESS, а не превратить в
  // match_already_terminal.
  const retry = await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", body);
  assert.equal(retry.winner, "light", "повтор обязан остаться SUCCESS");

  const afterRetry = Object.keys(eventsOf(store));
  assert.deepEqual(afterRetry, afterFirst, "количество событий не выросло");
  assert.equal(afterRetry.length, 1, "второй technical_result НЕ создан");
});

// ---------- Z3: LOW-LEVEL GUARD ----------
test("Z3: commitTerminalOutcome с protectedLogAlreadyTerminal=true и отсутствующим ratedTerminal -> match_already_terminal, ничего не записано", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  const candidate = candidateFor("r-guard", "technical", "000003", { kind: "timeout" });
  candidate.protectedLogAlreadyTerminal = true;

  const r = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidate);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "match_already_terminal");
  assert.deepEqual(store.data, {}, "ни claim, ни event, ни projection не записаны");
});

test("Z3b: тот же candidate с protectedLogAlreadyTerminal=false пишется как обычно (guard не задевает здоровый путь)", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  const candidate = candidateFor("r-ok", "technical", "000003", { kind: "timeout" });
  candidate.protectedLogAlreadyTerminal = false;

  const r = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidate);
  assert.equal(r.ok, true);
  assert.ok(store.data.ratedTerminal[MATCH_ID]);
  assert.ok(store.data.ratedEvents[MATCH_ID].events["000003"]);
});

// ---------- Z4: RACE -- обычный terminal выиграл тот же next seq ----------
test("Z4: обычный terminal durable-записан в тот же next seq между чтением и PATCH -> technical PATCH отклонён, на retry исход match_already_terminal, лог остаётся корректным", async () => {
  const now = 1_700_000_100_000;
  const { env, deps, store } = makeEnvDeps(now);
  store.data = raceStore(now);
  const body = { requestId: "r-tech-race", reason: "disconnect" };

  // Первый вызов: лог прочитан пустым, но ПЕРЕД самим technical PATCH другой
  // writer durable-записывает обычный terminal в ТОТ ЖЕ seq 000000, и PATCH
  // отклоняется.
  let injected = false;
  const racingDeps = Object.assign({}, deps, {
    fetch: async (url, options) => {
      if (options && options.method === "PATCH" && !injected) {
        injected = true;
        store.data.ratedEvents = { [MATCH_ID]: { events: { "000000": persistedResignEvent() } } };
        return { ok: false, status: 412, headers: { get: () => null }, json: async () => ({}) };
      }
      return deps.fetch(url, options);
    }
  });

  let firstError = null;
  try {
    await claimTechnicalOutcome(env, racingDeps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", body);
  } catch (e) { firstError = e; }
  assert.ok(firstError, "первый вызов обязан завершиться ошибкой (неоднозначный write)");
  assert.equal(store.data.ratedTerminal, undefined, "ratedTerminal после неудачного PATCH отсутствует");

  // Retry: fetchAllEvents теперь ВИДИТ обычный terminal.
  let retryError = null;
  try {
    await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants(), "tg_111", body);
  } catch (e) { retryError = e; }

  assert.ok(retryError, "retry обязан завершиться definitive-отказом");
  assert.equal(retryError.message, "match_already_terminal");

  const events = eventsOf(store);
  assert.deepEqual(Object.keys(events), ["000000"], "technical_result НЕ append'нут -- в логе ровно один terminal");
  assert.equal(events["000000"].type, "resign");
  assert.equal(store.data.ratedTerminal, undefined, "ratedTerminal так и не создан");

  const room = store.data.rooms.ABC123;
  assert.equal(room.status, "finished", "syncProjection отремонтировала комнату");
  assert.equal(room.winner, "light");
  assert.equal(room.winReason, "resign");

  // Финальный лог обязан корректно replay'иться НАСТОЯЩИМ settlement-путём:
  // verifiedReplayOutcome() внутри делает fetchAllEvents + replayEvents, то
  // есть бросил бы event_after_terminal, если бы второй terminal попал в лог.
  const finalWinner = await verifiedReplayOutcome(env, deps, "fake-token", MATCH_ID, cardWithParticipants());
  assert.equal(finalWinner, "light", "финальный лог replay'ится в единственный terminal, без event_after_terminal");
});

// =====================================================================
// Перенесено из удалённого tests/worker/n23-claim-technical-diagnostic.test.mjs
// как ЧИСТЫЕ production-регрессии (без какой-либо проверки diagnostic
// logging): это единственное место, где такое покрытие существует.
//
// Все три K/L/M проверяют recovery-семантику commitTerminalOutcome:
//
//   try { await dbPatchRoot(...); return success; }
//   catch (error) {
//     const after = await dbGet(...);
//     if (!after) throw error;
//     return classifyExistingTerminalClaim(...);
//   }
//
// K -- PATCH фактически прошёл, но ответ потерян -> recheck восстанавливает SUCCESS;
// L -- ничего не записалось -> наружу уходит ИСХОДНАЯ write-ошибка со своим status;
// M -- сам recheck упал -> наружу уходит ЕГО read-ошибка, не замаскированная write-ошибкой.
// =====================================================================

test("K. REAL commitTerminalOutcome: ambiguous write -- PATCH фактически применился, но вызывающая сторона получила non-ok/504; recheck находит СВОЙ ЖЕ claim -> SUCCESS без второго event", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  const candidate = candidateFor("r-ambiguous", "technical", "000000", { kind: "disconnect" });

  // Это НЕ сценарий B2: там побеждает ДРУГОЙ writer и корректный исход --
  // terminal_conflict. Здесь запись наша собственная и она реально прошла,
  // потерян только ответ сети.
  let patchCalls = 0;
  const originalFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH" && patchCalls === 0) {
      patchCalls++;
      await originalFetch(url, options); // запись РЕАЛЬНО применяется на сервере
      return { ok: false, status: 504, headers: { get: () => null }, json: async () => ({}) };
    }
    return originalFetch(url, options);
  };

  const r = await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidate);
  assert.equal(r.ok, true, "потерянный ответ при фактически успешной записи обязан восстановиться как SUCCESS");
  assert.equal(r.claim.requestId, "r-ambiguous", "восстановлен именно НАШ claim");
  assert.deepEqual(Object.keys(store.data.ratedEvents[MATCH_ID].events), ["000000"], "второй event не создан");
  assert.equal(store.data.ratedTerminal[MATCH_ID].requestId, "r-ambiguous");
});

test("L. REAL commitTerminalOutcome: PATCH упал окончательно и recheck вернул null -> наружу уходит ИСХОДНАЯ db_write_failed с сохранённым status", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  const originalFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH") {
      return { ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) };
    }
    return originalFetch(url, options);
  };

  let thrown = null;
  try {
    await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r-lost", "technical", "000000", { kind: "timeout" }));
  } catch (e) { thrown = e; }

  assert.ok(thrown, "ошибка обязана быть проброшена, а не проглочена");
  assert.equal(thrown.message, "db_write_failed", "именно исходная write-ошибка, не что-то другое");
  assert.equal(thrown.status, 403, "status исходной write-ошибки обязан сохраниться");
  assert.equal(store.data.ratedTerminal, undefined, "ничего не записано");
});

test("M. REAL commitTerminalOutcome: PATCH упал и САМ recheck тоже упал -> наружу уходит db_read_failed от recheck, не замаскированная исходной write-ошибкой", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  let patched = false;
  const originalFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    const u = typeof url === "string" ? url : url.url;
    if (options && options.method === "PATCH") {
      patched = true;
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    }
    // Первое (до PATCH) чтение ratedTerminal обязано пройти нормально --
    // ломаем только recheck ПОСЛЕ неудачного PATCH.
    if (patched && u.indexOf("ratedTerminal") !== -1) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    }
    return originalFetch(url, options);
  };

  let thrown = null;
  try {
    await commitTerminalOutcome(env, deps, "fake-token", MATCH_ID, candidateFor("r-recheck-fail", "technical", "000000", { kind: "timeout" }));
  } catch (e) { thrown = e; }

  assert.ok(thrown);
  assert.equal(thrown.message, "db_read_failed", "наружу обязана уйти ошибка recheck, а не исходная db_write_failed");
  assert.equal(store.data.ratedTerminal, undefined);
});

test("I. claimTechnicalOutcome: малформед rated match card (participants не валидная пара) -> match_not_rated, ничего не записано", async () => {
  const { env, deps, store } = makeEnvDeps(1_700_000_100_000);
  store.data = {};
  const malformedCard = Object.assign({}, cardWithParticipants(), { participants: { onlyOneUid: { color: "light" } } });

  let thrown = null;
  try {
    await claimTechnicalOutcome(env, deps, "fake-token", MATCH_ID, malformedCard, "tg_111", { requestId: "r-badcard", reason: "disconnect" });
  } catch (e) { thrown = e; }

  assert.ok(thrown, "малформед card обязан быть отвергнут");
  assert.equal(thrown.message, "match_not_rated");
  assert.deepEqual(store.data, {}, "ничего не записано");
});

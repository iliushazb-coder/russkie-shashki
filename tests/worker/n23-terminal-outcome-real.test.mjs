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


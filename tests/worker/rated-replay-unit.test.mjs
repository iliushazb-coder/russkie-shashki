// №23: unit tests for the protected event log / replay / Model 3-lite
// machinery, driven through the REAL exported Worker functions against an
// in-memory fake RTDB (tests/helpers/fake-rtdb.js) — no real network, no
// emulator. Rules are NOT applied here (that's rated-events.rules.test.mjs,
// against the real Rules Emulator); this file exercises the Worker's own
// CAS/idempotency/replay logic and its interaction with persisted state.

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { createInitialPieces } = createRequire(import.meta.url)("../../shared/game-engine.js");

import {
  commitRatedEvent,
  syncProjection,
  verifiedReplayOutcome,
  settleMatch,
  resetServerTokenCache,
  checkEventBudget
} from "../../worker/index.mjs";

const require = createRequire(import.meta.url);
const { createFakeRtdb } = require("../helpers/fake-rtdb.js");

const FIREBASE_DB_URL = "https://fake-db.example.com";
const MATCH_ID = "elo_ABC123_1700000000000_0";

function makeEnvDeps() {
  let currentNow = 1_700_000_010_000;
  const rtdb = createFakeRtdb(FIREBASE_DB_URL, function () { return currentNow; });
  // По умолчанию сеем комнату, указывающую на MATCH_ID -- большинству тестов
  // это нужно только для того, чтобы commitRatedEvent's liveRoom-проверка
  // (round 11 fix) прошла; тесты, которым нужна ДРУГАЯ room-специфика
  // (settleMatch и т.п.), перезаписывают rtdb.store.data целиком сами.
  rtdb.store.data = { rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active" } } };
  const env = { FIREBASE_DB_URL, FIREBASE_SERVICE_ACCOUNT_EMAIL: "x", FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY: "x", FIREBASE_WEB_API_KEY: "x" };
  const deps = {
    now: function () { return currentNow; },
    setNow: function (v) { currentNow = v; },
    signCustomToken: async () => "fake-custom-token",
    fetch: async (url, options) => {
      if (typeof url === "string" && url.indexOf("identitytoolkit.googleapis.com") !== -1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ idToken: "fake-server-id-token", expiresIn: 3600 })
        };
      }
      return rtdb.fetch(url, options);
    }
  };
  return { env, deps, rtdb };
}

function card(overrides = {}) {
  return {
    roomCode: "ABC123", createdAt: 1_700_000_000_000, matchNumber: 0, replayVersion: 1,
    participants: {
      alice: { color: "light", ratingAtJoin: 1200, name: "Alice" },
      bob: { color: "dark", ratingAtJoin: 1180, name: "Bob" }
    },
    ...overrides
  };
}

async function getToken(env, deps) {
  resetServerTokenCache();
  const { getServerIdToken } = await import("../../worker/index.mjs");
  return getServerIdToken(env, deps);
}

// ===== commitRatedEvent: basic append, illegal, wrong actor =====

test("commitRatedEvent appends a legal single-jump turn as seq 000000", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const result = await commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  assert.equal(result.seq, "000000");
  assert.equal(result.already, false);
});

test("commitRatedEvent rejects a move by the wrong actor (not light's turn)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, card(), "bob", {
      requestId: "r1", type: "turn", path: [{ row: 2, col: 1 }, { row: 3, col: 0 }]
    }),
    /wrong_actor_turn/
  );
});

test("commitRatedEvent rejects an illegal move (no piece at from-square)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", {
      requestId: "r1", type: "turn", path: [{ row: 0, col: 0 }, { row: 1, col: 1 }]
    }),
    /illegal_segment/
  );
});

test("commitRatedEvent rejects a non-participant caller", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, card(), "mallory", {
      requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
    }),
    /not_a_participant/
  );
});

// ===== v11 fix (review Point 2): commitRatedEvent rejects append to a stale/non-live generation =====

test("commitRatedEvent rejects append when the room is entirely missing (found on review: without this, a technically-ended match's card+log could accept an artificial resign long after the fact)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  rtdb.store.data.rooms = {}; // room отсутствует вовсе -- нелегитимный контекст для append
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", { requestId: "r1", type: "resign" }),
    /stale_generation/
  );
});

test("commitRatedEvent rejects append when the room exists but points to a DIFFERENT (newer or unrelated) generation", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  rtdb.store.data.rooms.ABC123.ratedMatchId = "elo_ABC123_1700000000000_99"; // другая generation
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", { requestId: "r1", type: "resign" }),
    /stale_generation/
  );
});

// ===== v15 fix (review): room.status is participant-controlled, must NOT gate this check =====

test("commitRatedEvent rejects append when the room has a GENUINE technical-disconnect result recorded (technical-first correctly blocks a later protected append)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  rtdb.store.data.rooms.ABC123.result = {
    winnerColor: "dark", loserColor: "light", winnerId: "bob", loserId: "alice",
    winReason: "disconnect", status: "finished", decidedAt: 1_700_000_005_000
  };
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", { requestId: "r1", type: "resign" }),
    /stale_generation/
  );
});

test("commitRatedEvent does NOT reject append when room.status was forged to 'finished' WITHOUT a genuine result (found on review: room.status alone is participant-controlled -- a losing participant could otherwise forge this to permanently deny the match from ever reaching a rated outcome)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  rtdb.store.data.rooms.ABC123.status = "finished"; // forged, no result/winner/winReason at all
  const result = await commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", { requestId: "r1", type: "resign" });
  assert.equal(result.already, false, "a forged bare status must not block a genuinely legitimate protected append");
});

test("commitRatedEvent succeeds when the room correctly points to this exact matchId (the normal, live-gameplay case)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const result = await commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", { requestId: "r1", type: "resign" });
  assert.equal(result.already, false);
});

// ===== idempotency =====

test("same requestId + same canonical claim returns the existing seq (idempotent retry)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const claim = { requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }] };
  const first = await commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", claim);
  const second = await commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", claim);
  assert.equal(first.seq, second.seq);
  assert.equal(second.already, true);
});

test("same requestId + DIFFERENT claim is rejected as idempotency_conflict", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  await commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, card(), "alice", {
      requestId: "r1", type: "turn", path: [{ row: 5, col: 2 }, { row: 4, col: 3 }]
    }),
    /idempotency_conflict/
  );
});

// ===== concurrency: two concurrent valid requests reading the same head =====

test("two concurrent commitRatedEvent calls for the SAME match serialize onto seq 000000 and 000001, not both onto 000000", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  // Первый ход (light, seq 000000), затем — второй запрос (dark, отвечает
  // после первого) отправляется КОНКУРЕНТНО со вторым light-запросом на
  // другой сегмент; здесь проверяем именно "не оба претендента получают
  // один и тот же seq" — гоняем два НЕЗАВИСИМЫХ первых-хода запроса
  // параллельно на пустой лог.
  const [r1, r2] = await Promise.all([
    commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
      requestId: "reqA", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
    }).catch(function (e) { return { error: e.message }; }),
    commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
      requestId: "reqB", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
    }).catch(function (e) { return { error: e.message }; })
  ]);
  // Один из двух обязан пройти как seq 000000; другой либо получает
  // wrong_actor_turn/illegal_segment (потому что после первого хода
  // очередь уже не light) — в любом случае НИКОГДА не оба успешно
  // становятся seq 000000 одновременно.
  const succeeded = [r1, r2].filter(function (r) { return !r.error; });
  assert.equal(succeeded.length, 1, "ровно один из двух конкурентных первых-ходов должен пройти");
  assert.equal(succeeded[0].seq, "000000");
});

// ===== stale generation =====

test("commitRatedEvent for a card with mismatched roomCode/generation still replays independently per matchId (no cross-generation bleed)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c1 = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c1, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  const OTHER_MATCH = "elo_ABC123_1700000000000_1";
  const c2 = card({ matchNumber: 1 });
  rtdb.store.data.rooms.ABC123.ratedMatchId = OTHER_MATCH; // симулирует реванш: room теперь на НОВОЙ generation
  const result = await commitRatedEvent(env, deps, token, OTHER_MATCH, c2, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  assert.equal(result.seq, "000000", "новый matchId стартует с чистого лога, не наследует seq от другой generation");
});

// ===== resign / draw / self-accept =====

test("resign sets the opposite color as winner via replay, not a client-claimed winner", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });
  const outcome = await verifiedReplayOutcome(env, deps, token, MATCH_ID, c);
  assert.equal(outcome, "dark");
});

test("event after terminal (resign) is rejected via replay.terminal (round 15: liveRoom fail-fast no longer gates on room.status, which syncProjection itself sets after a legitimate resign -- gating on that participant-adjacent field would have reintroduced the exact class of bug round 15 fixed elsewhere; match_already_terminal from the log itself is correct here)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, c, "bob", {
      requestId: "r2", type: "turn", path: [{ row: 2, col: 1 }, { row: 3, col: 0 }]
    }),
    /match_already_terminal/
  );
});

// ===== v5 fix: retry с ДРУГИМ requestId после terminal-события всё равно чинит projection =====

test("a retry with a DIFFERENT requestId after a durable terminal event still repairs a stale projection (Blocker found on review: random-per-call requestId broke the old same-requestId repair path)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });

  // Симулируем "syncProjection тогда не удался": стираем ratedReplay/winner
  // так, будто projection после успешного append никогда не применилась.
  const room = rtdb.store.data.rooms.ABC123;
  delete room.ratedReplay;
  delete room.winner;
  delete room.winReason;
  room.status = "active";

  // Игрок (не зная, что событие уже durable) нажимает resign СНОВА — НОВЫЙ
  // requestId (ровно то, что теперь происходит с v4-случайной схемой).
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r2-completely-different", type: "resign" }),
    /match_already_terminal/,
    "второе resign всё ещё корректно отклонено — матч уже terminal"
  );

  // НО: сама попытка (даже отклонённая) должна была отремонтировать projection.
  assert.equal(room.ratedReplay && room.ratedReplay.acceptedSeq, 0, "projection восстановлена несмотря на match_already_terminal");
  assert.equal(room.winner, "dark", "room.winner восстановлен из replay, не потерян");
  assert.equal(room.status, "finished");
});

// ===== v6 fix: repair-attempt failure на terminal-ветке НЕ должна маскироваться под match_already_terminal =====

test("if the terminal-branch repair attempt ITSELF genuinely fails, the client sees that failure, NOT a disguised match_already_terminal (found on review: swallowing let the client wrongly treat an unsynced projection as a settled, retry-safe-to-forget outcome)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });

  delete rtdb.store.data.rooms.ABC123.ratedReplay;
  delete rtdb.store.data.rooms.ABC123.winner;
  rtdb.store.data.rooms.ABC123.status = "active";

  const forcedDeps = withForcedPatchStatus(deps, 500); // не 401/403 — не "кто-то уже продвинул", настоящая ошибка
  await assert.rejects(
    commitRatedEvent(env, forcedDeps, token, MATCH_ID, c, "alice", { requestId: "r2-different-again", type: "resign" }),
    function (err) { return err.message !== "match_already_terminal"; },
    "клиент обязан увидеть НАСТОЯЩУЮ ошибку repair'а, а не match_already_terminal — иначе он ошибочно снимет свой pending-marker, решив, что исход уже 'доказан'"
  );
  assert.equal(rtdb.store.data.rooms.ABC123.ratedReplay, undefined, "projection корректно осталась несинхронизированной — ошибка не замаскирована");
});

test("self-accept of one's own draw offer is rejected", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "draw_offer" });
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r2", type: "draw_accept" }),
    /self_accept_rejected/
  );
});

test("opponent accepting a live draw offer produces a verified draw outcome", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "draw_offer" });
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "bob", { requestId: "r2", type: "draw_accept" });
  const outcome = await verifiedReplayOutcome(env, deps, token, MATCH_ID, c);
  assert.equal(outcome, "draw");
});

test("draw_accept with no prior offer at all is rejected", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, c, "bob", { requestId: "r1", type: "draw_accept" }),
    /stale_or_missing_offer/
  );
});

// ===== Blocker 1 fix: draw_cancel invalidates a live offer =====

test("draw_offer then draw_cancel: a later draw_accept referencing the cancelled offer is rejected", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "draw_offer" });
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r2", type: "draw_cancel" });
  await assert.rejects(
    commitRatedEvent(env, deps, token, MATCH_ID, c, "bob", { requestId: "r3", type: "draw_accept" }),
    /stale_or_missing_offer/,
    "отменённое предложение НЕ должно быть acceptable, даже если оно было последним draw_offer по seq"
  );
});

test("draw_offer, draw_cancel, then a FRESH draw_offer is acceptable (cancel does not permanently poison future offers)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "draw_offer" });
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r2", type: "draw_cancel" });
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r3", type: "draw_offer" });
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "bob", { requestId: "r4", type: "draw_accept" });
  const outcome = await verifiedReplayOutcome(env, deps, token, MATCH_ID, c);
  assert.equal(outcome, "draw");
});

// ===== Blocker 1 fix: requestId collision on re-offer at same moveCount =====

test("script.js-equivalent requestId generation distinguishes offer/cancel/re-offer at the SAME moveCount (no idempotency false-positive)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  // Симулирует client-side generateNonTurnRequestId ПОСЛЕ фикса: разные
  // логические действия при одном и том же moveCount получают РАЗНЫЕ
  // requestId, ДАЖЕ если "reload" сбросил бы любой module-level counter —
  // требование closed на review, см. tests/rated-draw-cancel-ordering.test.js
  // для прямого теста самой generateNonTurnRequestId.
  const r1 = await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "light_draw_offer_0_a1b2c3", type: "draw_offer" });
  const r2 = await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "light_draw_cancel_0_d4e5f6", type: "draw_cancel" });
  const r3 = await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "light_draw_offer_0_g7h8i9", type: "draw_offer" });
  assert.equal(r1.already, false);
  assert.equal(r2.already, false);
  assert.equal(r3.already, false, "третье, ЛОГИЧЕСКИ отдельное действие не должно быть принято за retry первого");
  assert.notEqual(r1.seq, r3.seq, "offer после cancel — НОВОЕ событие, а не дубликат старого");
});

test("Worker-side idempotency still works when a client DELIBERATELY reuses the same requestId (genuine retry semantics preserved)", async () => {
  const { env, deps } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  const claim = { requestId: "light_draw_offer_0_fixed", type: "draw_offer" };
  const first = await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", claim);
  const retry = await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", claim);
  assert.equal(first.seq, retry.seq);
  assert.equal(retry.already, true, "тот же requestId + тот же claim -> retry, не новое событие");
});

// ===== syncProjection: monotonic, does not read room.winner =====

test("syncProjection writes room.turn/pieces derived from replay, independent of any pre-existing room.winner", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  // Испортить room.winner напрямую в fake-хранилище — как мог бы malicious participant.
  rtdb.store.data = rtdb.store.data || {};
  rtdb.store.data.rooms = rtdb.store.data.rooms || {};
  rtdb.store.data.rooms.ABC123 = Object.assign({}, rtdb.store.data.rooms.ABC123, { winner: "dark", winReason: "forged" });

  await syncProjection(env, deps, token, MATCH_ID, c);

  const room = rtdb.store.data.rooms.ABC123;
  assert.equal(room.turn, "dark", "projection корректно переключила ход независимо от forged winner");
  assert.equal(room.ratedReplay.acceptedSeq, 0);
  // Примечание: syncProjection использует PATCH-семантику и трогает
  // winner/winReason ТОЛЬКО при terminal-исходе (replay.terminalOutcome) —
  // для non-terminal хода forged winner/winReason законно остаются
  // нетронутыми в room (PATCH не обязан очищать поля, которые не
  // перечисляет). Реальная security-гарантия — что settleMatch НИКОГДА не
  // читает room.winner для Elo — отдельно проверена ниже.
});

test("syncProjection is idempotent when called twice on the same log state", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  const before = JSON.stringify(rtdb.store.data.rooms.ABC123.ratedReplay);
  await syncProjection(env, deps, token, MATCH_ID, c); // повторный вызов — тот же acceptedSeq, Rules DENY ожидаемо
  const after = JSON.stringify(rtdb.store.data.rooms.ABC123.ratedReplay);
  assert.equal(before, after, "повторный syncProjection на том же логе не меняет acceptedSeq");
});

// ===== Blocker 2 fix: completed-turn projection restores UI/timer fields =====

test("syncProjection writes lastMove/lastMovePath/lastCapturedSquares/moveType/pendingRemovals from the completed turn", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  const room = rtdb.store.data.rooms.ABC123;
  assert.deepEqual(room.lastMove, { from: { row: 5, col: 0 }, to: { row: 4, col: 1 } });
  assert.deepEqual(room.lastMovePath, [{ row: 5, col: 0 }, { row: 4, col: 1 }]);
  assert.deepEqual(room.lastCapturedSquares, []);
  assert.equal(room.moveType, "move");
  assert.deepEqual(room.pendingRemovals, []);
});

// ===== v8 fix: non-turn events (resign/draw_offer/etc.) must NOT rewind the board =====

test("resign submitted MID unfinished multi-capture chain does not rewind rooms/$room's board (Model 3-lite: intermediate jumps stay client-direct and are never in the protected log)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  const engine = require("../../shared/game-engine.js");

  // Реальный mid-chain scenario через настоящий движок (тот же сценарий
  // promotion-mid-chain, что уже использовался для draw-state equivalence
  // proof в №22): light бьёт (1,2), приземляется (0,3), промоушен в короля,
  // ОБЯЗАН продолжить цепочку — mustContinueFrom !== null.
  const initialPieces = {
    "2_1": { color: "light", king: false },
    "1_2": { color: "dark", king: false },
    "2_5": { color: "dark", king: false }
  };
  const baseState = {
    pieces: initialPieces, turn: "light", mustContinueFrom: null,
    capturedDark: 0, capturedLight: 0, moveCount: 0,
    lastMovePath: null, lastCapturedSquares: null, pendingRemovals: [],
    kingOnlyStreak: 0, noProgressStreak: 0, positionHistory: [],
    longRoadAttacker: null, longRoadStreak: 0
  };
  const midChainResult = engine.attemptMove(baseState, 2, 1, 0, 3, "light");
  assert.notEqual(midChainResult.mustContinueFrom, null, "тестовая геометрия должна давать незавершённую цепочку");

  // Ровно то, что performMove() пишет НАПРЯМУЮ в room для промежуточного
  // прыжка (Model 3-lite, без изменений) -- protected log при этом ПУСТ,
  // т.к. только ЗАВЕРШАЮЩИЙ сегмент когда-либо идёт через /rated/event.
  rtdb.store.data = {};
  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = { ABC123: {
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    createdAt: c.createdAt, matchNumber: c.matchNumber, ratedMatchId: MATCH_ID,
    status: "active",
    pieces: midChainResult.pieces, turn: midChainResult.turn,
    mustContinueFrom: midChainResult.mustContinueFrom,
    moveCount: midChainResult.moveCount,
    lastMove: midChainResult.lastMove, lastMovePath: midChainResult.lastMovePath,
    lastCapturedSquares: midChainResult.lastCapturedSquares, moveType: midChainResult.moveType,
    pendingRemovals: midChainResult.pendingRemovals
  } };

  const roomBefore = JSON.parse(JSON.stringify(rtdb.store.data.rooms.ABC123));

  // Игрок resign'ит ПОСЕРЕДИНЕ этой ещё не завершённой серии взятий --
  // pre-№23 код это ВСЕГДА разрешал и корректно сохранял доску как есть.
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r-resign-mid-chain", type: "resign" });

  const roomAfter = rtdb.store.data.rooms.ABC123;
  assert.deepEqual(roomAfter.pieces, roomBefore.pieces, "pieces НЕ должны откатиться к состоянию до текущего хода");
  assert.deepEqual(roomAfter.mustContinueFrom, roomBefore.mustContinueFrom, "mustContinueFrom (mid-chain маркер) сохранён как есть");
  assert.equal(roomAfter.moveCount, roomBefore.moveCount, "moveCount не откатился");
  assert.deepEqual(roomAfter.lastMovePath, roomBefore.lastMovePath, "lastMovePath (визуальный путь текущего прыжка) сохранён");
  // Но исход всё равно корректно применён:
  assert.equal(roomAfter.winner, "dark", "resign всё равно корректно даёт победу оппоненту");
  assert.equal(roomAfter.winReason, "resign");
  assert.equal(roomAfter.status, "finished");
});

test("syncProjection writes turnStartedAt on first materialization, immutable on repeat syncs of the same board (Round 5 anti-extension property preserved under round-9's boardSeq-gated design)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  const firstTurnStartedAt = rtdb.store.data.rooms.ABC123.turnStartedAt;
  assert.equal(typeof firstTurnStartedAt, "number");
  // Продвинуть fake "now" и вызвать syncProjection ЕЩЁ РАЗ на том же логе
  // (boardSeq уже материализован для этого хода) — turnStartedAt НЕ должен
  // сдвинуться вперёд (иначе reconnect/retry мог бы продлевать ход
  // текущему игроку).
  deps.setNow(1_700_000_099_999);
  await syncProjection(env, deps, token, MATCH_ID, c);
  assert.equal(rtdb.store.data.rooms.ABC123.turnStartedAt, firstTurnStartedAt,
    "turnStartedAt immutable при повторном sync того же уже-материализованного хода");
});

// ===== v9 fix (review point 2): turnStartedAt = реальное время материализации, не historical event.ts =====

test("turnStartedAt reflects the ACTUAL materialization time, not the event's historical commit ts, when syncProjection is delayed", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  // Форсируем провал ПЕРВОЙ попытки syncProjection (внутри commitRatedEvent
  // сразу после append) реальной (не 403) ошибкой -- событие уже durable,
  // board ещё НЕ материализована.
  deps.setNow(1_700_000_010_000);
  rtdb.store.data = { rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active" } }, matches: { [MATCH_ID]: c } };
  const forcedDeps = withForcedPatchStatus(deps, 500);
  await assert.rejects(
    commitRatedEvent(env, forcedDeps, token, MATCH_ID, c, "alice", {
      requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
    })
  );
  assert.equal(rtdb.store.data.rooms.ABC123.ratedReplay, undefined, "board ещё не материализована после форсированного провала");

  // Реальное время "прошло" на 25 секунд -- ТОЛЬКО ТЕПЕРЬ repair успешно
  // материализует board (например, opponent's любое следующее касание).
  deps.setNow(1_700_000_035_000);
  await syncProjection(env, deps, token, MATCH_ID, c);
  const turnStartedAt = rtdb.store.data.rooms.ABC123.turnStartedAt;
  assert.equal(turnStartedAt, 1_700_000_035_000,
    "turnStartedAt должен отражать МОМЕНТ РЕАЛЬНОЙ материализации (25 секунд спустя), а не historical event.ts (1_700_000_010_000) -- иначе задержка repair'а списывает время у ожидающего игрока ещё до того, как он увидел свой ход");
});

// ===== v10 fix (review Blocker 2): FULLY SEPARATE budgets -- draw-spam can NEVER exhaust the game-event budget =====

function fillEventsMixed(rtdb, matchId, entries) {
  rtdb.store.data = rtdb.store.data || {};
  rtdb.store.data.ratedEvents = rtdb.store.data.ratedEvents || {};
  rtdb.store.data.ratedEvents[matchId] = rtdb.store.data.ratedEvents[matchId] || { events: {} };
  entries.forEach(function (type, i) {
    const seqStr = String(i).padStart(6, "0");
    rtdb.store.data.ratedEvents[matchId].events[seqStr] = {
      requestId: "seed-" + i, type: type, actorUid: "alice", color: "light",
      matchId: matchId, roomCode: "ABC123", createdAt: 1_700_000_000_000, matchNumber: 0,
      ts: 1_700_000_000_000 + i
    };
  });
}
function fillEventsDirectly(rtdb, matchId, count, type) {
  fillEventsMixed(rtdb, matchId, new Array(count).fill(type));
}

test("Blocker 2 exact exploit scenario: checkEventBudget for 490 draw-spam + 10 legitimate turns (combined 500) still allows a terminal event (separate budgets, not a shared reserve)", () => {
  // Прямой unit-тест чистой функции подсчёта -- избегает необходимости
  // строить 500 РЕАЛЬНО легальных ходов только чтобы прогнать через полный
  // replay (что здесь избыточно: тестируем именно СЧЁТ, не легальность).
  const list = new Array(490).fill({ type: "draw_offer" }).concat(new Array(10).fill({ type: "turn" }));
  assert.doesNotThrow(function () { checkEventBudget(list, "resign"); },
    "terminal-событие обязано пройти: game-event счётчик считает только 10 turn-событий (далеко от 500), draw-спам НИКОГДА в него не засчитывается");
});

test("checkEventBudget: draw_offer/draw_cancel rejected once THEIR OWN (separate) budget is exhausted, independent of game-event count", () => {
  const list = new Array(40).fill({ type: "draw_offer" }); // ровно MAX_DRAW_NEGOTIATION_EVENTS
  assert.throws(function () { checkEventBudget(list, "draw_offer"); }, /draw_action_limit_exceeded/);
  assert.throws(function () { checkEventBudget(list, "draw_cancel"); }, /draw_action_limit_exceeded/);
  assert.doesNotThrow(function () { checkEventBudget(list, "resign"); }, "game-event бюджет не затронут draw-неготиацией");
});

test("checkEventBudget: 500 legitimate turn events (game-event budget exhausted) do NOT block draw_offer -- budgets independent in both directions", () => {
  const list = new Array(500).fill({ type: "turn" });
  assert.throws(function () { checkEventBudget(list, "turn"); }, /event_limit_exceeded/);
  assert.doesNotThrow(function () { checkEventBudget(list, "draw_offer"); },
    "draw_offer's собственный бюджет ещё пуст, несмотря на полностью исчерпанный game-event бюджет");
});

test("a retry (dup requestId) of an ALREADY-EXISTING event still succeeds via the idempotent path even when its own budget is completely full (dup-check runs before checkEventBudget)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  fillEventsDirectly(rtdb, MATCH_ID, 45, "draw_offer"); // за пределами MAX_DRAW_NEGOTIATION_EVENTS=40
  rtdb.store.data.ratedEvents[MATCH_ID].events["000005"].requestId = "existing-req";

  const retry = await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "existing-req", type: "draw_offer" });
  assert.equal(retry.already, true, "dup-check идёт ПЕРЕД checkEventBudget, независимо от заполненности бюджета этого типа");
});


test("joinRatedMatch (rematch) clears a leftover ratedReplay from the PRIOR generation, so the new generation's syncProjection is not permanently blocked by stale higher numbers", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch, getServerIdToken } = await import("../../worker/index.mjs");

  const OLD_MATCH_ID = "elo_ABC123_1700000000000_0";
  rtdb.store.data = {
    rooms: { ABC123: {
      players: { light: { id: "tg_111", name: "Alice" }, dark: { id: "tg_222", name: "Bob" } },
      status: "active", createdAt: 1_700_000_000_000, matchNumber: 1,
      // Реванш: доска уже сброшена клиентом к начальной (как в production) --
      // №23 pristine guard требует именно этого для НОВОЙ generation.
      pieces: createInitialPieces(), turn: "light", moveCount: 0,
      // Реванш: старая generation оставила ratedReplay с ВЫСОКИМИ числами --
      // ratedMatchId ещё СТАРЫЙ на этом этапе (join его перебиндит).
      ratedMatchId: OLD_MATCH_ID,
      ratedReplay: { matchId: OLD_MATCH_ID, acceptedSeq: 6, boardSeq: 5 }
    } },
    matchIndex: { ABC123: { matchId: OLD_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 0 } },
    matches: { [OLD_MATCH_ID]: card({ matchNumber: 0 }) },
    eloMatches: { [OLD_MATCH_ID]: { settledBy: "worker", result: "light" } },
    stats: { tg_111: { rating: 1210 }, tg_222: { rating: 1190 } }
  };

  const token = await getToken(env, deps);
  const result = await joinRatedMatch(env, deps, "tg_111", "ABC123");
  assert.notEqual(result.matchId, OLD_MATCH_ID, "join создал НОВУЮ generation, не переиспользовал старую");

  const room = rtdb.store.data.rooms.ABC123;
  assert.equal(room.ratedMatchId, result.matchId, "ratedMatchId корректно перебиндился на новую generation");
  assert.equal(room.ratedReplay, undefined,
    "leftover ratedReplay от прошлой generation должен быть очищен -- иначе monotonic-check навсегда блокирует projection новой партии");
});

// ===== v10 fix (review IMPORTANT 2): idempotent /rated/join retry for the SAME generation must NOT wipe real progress =====

test("joinRatedMatch retry (reconnect) for the SAME already-established generation does NOT wipe an in-progress ratedReplay", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");

  const SAME_MATCH_ID = "elo_ABC123_1700000000000_0";
  rtdb.store.data = {
    rooms: { ABC123: {
      players: { light: { id: "tg_111", name: "Alice" }, dark: { id: "tg_222", name: "Bob" } },
      status: "active", createdAt: 1_700_000_000_000, matchNumber: 0,
      // Матч УЖЕ идёт под этой же generation, с реальным прогрессом.
      ratedMatchId: SAME_MATCH_ID,
      // finalizePointer публикует pointer и ratingsAtStart ОДНИМ атомарным
      // патчем, поэтому установленная generation всегда несёт оба поля.
      ratingsAtStart: { light: 1210, dark: 1190 },
      ratedReplay: { matchId: SAME_MATCH_ID, acceptedSeq: 12, boardSeq: 11 },
      pieces: { d4: { color: "light", king: false } }, turn: "dark", moveCount: 12
    } },
    matchIndex: { ABC123: { matchId: SAME_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 0 } },
    matches: { [SAME_MATCH_ID]: card({ matchNumber: 0, participants: {
      tg_111: { color: "light", ratingAtJoin: 1200, name: "Alice" },
      tg_222: { color: "dark", ratingAtJoin: 1180, name: "Bob" }
    } }) },
    stats: { tg_111: { rating: 1200 }, tg_222: { rating: 1180 } }
  };

  const token = await getToken(env, deps);
  const result = await joinRatedMatch(env, deps, "tg_111", "ABC123");
  assert.equal(result.matchId, SAME_MATCH_ID, "retry возвращает ТУ ЖЕ generation, не создаёт новую");
  assert.equal(result.already, true);

  const room = rtdb.store.data.rooms.ABC123;
  assert.deepEqual(room.ratedReplay, { matchId: SAME_MATCH_ID, acceptedSeq: 12, boardSeq: 11 },
    "reconnect/retry для ТОЙ ЖЕ generation НЕ должен стирать реальный прогресс -- ratedMatchId не менялся, значит сброс не нужен");
});


test("draw_offer's own syncProjection call catches up an EARLIER turn's board write that had previously failed (boardSeq tracks the last TURN, not the absolute latest event)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();

  // seq0: turn event durable, но его СОБСТВЕННЫЙ board-write форсированно
  // падает реальной (не 403) ошибкой -- ratedReplay/board никогда не
  // материализуются для этого хода.
  rtdb.store.data = { rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active" } }, matches: { [MATCH_ID]: c } };
  const forcedDeps = withForcedPatchStatus(deps, 500);
  await assert.rejects(
    commitRatedEvent(env, forcedDeps, token, MATCH_ID, c, "alice", {
      requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
    })
  );
  assert.equal(rtdb.store.data.rooms.ABC123.ratedReplay, undefined, "board ещё не материализована после форсированного провала");

  // seq1: draw_offer -- НЕ turn, но commitRatedEvent для него ТОЖЕ вызывает
  // syncProjection (на этот раз без форсированного провала). До round-9
  // фикса (простой latestIsTurn-gate) эта попытка НЕ тронула бы board вовсе
  // (latest=draw_offer, non-turn) -- acceptedSeq продвинулся бы до 1, и
  // ПОСЛЕДУЮЩИЙ permission-denied repair-check увидел бы acceptedSeq>=1 и
  // ошибочно счёл всё синхронизированным, хотя board всё ещё ДО seq0.
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r2", type: "draw_offer" });

  const room = rtdb.store.data.rooms.ABC123;
  assert.notEqual(room, undefined, "draw_offer's own syncProjection обязана была догнать board seq0-хода");
  assert.equal(room.ratedReplay.boardSeq, 0, "boardSeq корректно указывает на последний TURN (seq0), а не на seq1 (draw_offer)");
  assert.equal(room.ratedReplay.acceptedSeq, 1, "acceptedSeq отражает общую log-позицию (включая draw_offer)");
  assert.deepEqual(room.lastMovePath, [{ row: 5, col: 0 }, { row: 4, col: 1 }], "board реально материализована по seq0-ходу");
});

function withForcedPatchStatus(baseDeps, status) {
  let used = false;
  return Object.assign({}, baseDeps, {
    fetch: async function (url, options) {
      if (!used && options && options.method === "PATCH") {
        used = true;
        return { ok: false, status, headers: { get: () => null }, json: async () => null };
      }
      return baseDeps.fetch(url, options);
    }
  });
}

test("syncProjection treats a permission-denied PATCH as a safe no-op ONLY after confirming room is already at/past the expected seq", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  // room уже реально на acceptedSeq=0 (только что записано выше). Форсируем
  // 403 на следующем PATCH и убеждаемся, что syncProjection корректно
  // перечитывает ratedReplay, видит acceptedSeq>=latestSeq и НЕ бросает.
  const forcedDeps = withForcedPatchStatus(deps, 403);
  await assert.doesNotReject(syncProjection(env, forcedDeps, token, MATCH_ID, c));
});

test("syncProjection does NOT swallow a genuine permission-denied when room is NOT actually caught up", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  });
  // Испортить ratedReplay так, будто projection НИКОГДА не применялась
  // (acceptedSeq отсутствует) — реальная 403 в этой ситуации НЕ должна
  // считаться безопасным no-op.
  delete rtdb.store.data.rooms.ABC123.ratedReplay;
  const forcedDeps = withForcedPatchStatus(deps, 403);
  await assert.rejects(
    syncProjection(env, forcedDeps, token, MATCH_ID, c),
    /projection_sync_denied_unexpected/
  );
});

test("commitRatedEvent propagates a genuine projection-sync failure instead of silently returning success", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  // Форсируем 403 на ПЕРВОМ PATCH (внутри commitRatedEvent's собственный
  // syncProjection-вызов после успешного append) и подготавливаем room так,
  // будто ratedReplay ещё не существует вовсе — значит permission-denied
  // здесь НЕ может быть безопасным no-op.
  rtdb.store.data = { rooms: { ABC123: { ratedMatchId: MATCH_ID, status: "active" } }, matches: { [MATCH_ID]: c } };
  const forcedDeps = withForcedPatchStatus(deps, 403);
  await assert.rejects(
    commitRatedEvent(env, forcedDeps, token, MATCH_ID, c, "alice", {
      requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
    }),
    /projection_sync_denied_unexpected/,
    "событие уже durable, но клиент НЕ должен получить success, пока projection не подтверждена"
  );
  // Событие тем не менее уже durable (append прошёл ДО попытки projection) —
  // ретрай с тем же requestId должен снова попытаться синхронизировать, а
  // НЕ создать второе событие.
  const eventsAfter = rtdb.store.data.ratedEvents[MATCH_ID].events;
  assert.equal(Object.keys(eventsAfter).length, 1, "append уже durable несмотря на упавший projection-sync");
});

// ===== settleMatch: room.winner is never Elo truth for replayVersion>=1 =====

test("settleMatch (replayVersion>=1) ignores a forged room.winner and settles on the verified replay outcome instead", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" }); // dark должен выиграть

  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = { ABC123: {
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    createdAt: c.createdAt, matchNumber: c.matchNumber, ratedMatchId: MATCH_ID,
    status: "finished",
    winner: "light", winReason: "forged" // malicious/forged room state claiming the OPPOSITE outcome
  } };

  const result = await settleMatch(env, deps, "alice", "ABC123", null);
  assert.equal(result.result, "dark", "settlement следует verified replay (resign -> dark), а не forged room.winner (light)");
});

// ===== v12 fix (review): explicit "protected terminal committed FIRST, then a later disconnect write to room" scenario =====

test("protected terminal event committed FIRST -- a LATER disconnect-style write to room.winner/winReason/status does not change the Elo outcome settleMatch derives", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  // Шаг 1: A resign'ит -- protected terminal event durable, dark выигрывает.
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });

  // Шаг 2 (ПОЗЖЕ): симулируем гонку с disconnect-detector'ом ДРУГОГО
  // participant'а, который (не зная о resign) независимо записал ТЕХНИЧЕСКИЙ
  // результат НАПРЯМУЮ в room -- ровно shape реального client-side
  // technical-result transaction (result{...} + winner/winReason/status).
  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = { ABC123: {
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    createdAt: c.createdAt, matchNumber: c.matchNumber, ratedMatchId: MATCH_ID,
    status: "finished",
    winner: "light", winReason: "disconnect", // РОВНО противоположный исход
    result: { winnerColor: "light", loserColor: "dark", winnerId: "alice", loserId: "bob",
      winReason: "disconnect", status: "finished", decidedAt: 1_700_000_020_000 }
  } };

  const result = await settleMatch(env, deps, "alice", "ABC123", null);
  assert.equal(result.result, "dark",
    "protected replay (resign -> dark) остаётся authoritative -- поздний disconnect-write НЕ меняет Elo, независимо от того, что room временно показывает противоположное");
});

test("settleMatch (replayVersion>=1) settles from replay even when room.status is NOT 'finished' (participant-controlled/stale UX projection must not veto server-verified Elo)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" }); // dark выигрывает

  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = { ABC123: {
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    createdAt: c.createdAt, matchNumber: c.matchNumber, ratedMatchId: MATCH_ID,
    status: "active" // НЕ "finished" — stale/malicious projection, protected log уже terminal
  } };

  const result = await settleMatch(env, deps, "alice", "ABC123", null);
  assert.equal(result.result, "dark", "settlement из replay проходит несмотря на room.status !== 'finished'");
});

test("settleMatch (replayVersion>=1) settles correctly from replay even when BOTH room.status and room.winner conflict with the protected log", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" }); // dark выигрывает

  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = { ABC123: {
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    createdAt: c.createdAt, matchNumber: c.matchNumber, ratedMatchId: MATCH_ID,
    status: "active", winner: "light", winReason: "forged" // и status, и winner противоречат replay
  } };

  const result = await settleMatch(env, deps, "alice", "ABC123", null);
  assert.equal(result.result, "dark", "Elo следует ИСКЛЮЧИТЕЛЬНО verified replay, независимо от расхождения ЛЮБОГО room-поля");
});

test("settleMatch (replayVersion=undefined, room exists) STILL requires room.status === 'finished' -- legacy gate unchanged", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const legacyCard = card({ replayVersion: undefined });
  rtdb.store.data = {};
  rtdb.store.data.matches = { [MATCH_ID]: legacyCard };
  rtdb.store.data.rooms = { ABC123: {
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    createdAt: legacyCard.createdAt, matchNumber: legacyCard.matchNumber, ratedMatchId: MATCH_ID,
    status: "active", winner: "light"
  } };
  await assert.rejects(
    settleMatch(env, deps, "alice", "ABC123", null),
    /match_not_finished/,
    "legacy generation без replayVersion по-прежнему требует room.status==='finished' -- фикс не расширился на неё"
  );
});

test("settleMatch (replayVersion>=1) fails closed for a technical result (no protected terminal event at all)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", {
    requestId: "r1", type: "turn", path: [{ row: 5, col: 0 }, { row: 4, col: 1 }]
  }); // не terminal

  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = { ABC123: {
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    createdAt: c.createdAt, matchNumber: c.matchNumber, ratedMatchId: MATCH_ID,
    status: "finished",
    winner: "light", winReason: "disconnect",
    result: { winnerColor: "light", loserColor: "dark", winnerId: "alice", loserId: "bob",
      winReason: "disconnect", status: "finished", decidedAt: 1_700_000_020_000 }
  } };

  await assert.rejects(
    settleMatch(env, deps, "alice", "ABC123", null),
    /match_not_finished/,
    "technical result (room.result) без protected terminal event должен fail-closed, не settle'иться как light"
  );
});

// ===== Blocker 3 fix: room deleted BEFORE the very first settlement =====

test("settleMatch (replayVersion>=1) settles for the FIRST time purely from matches/ratedEvents when the room is already gone", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  // resign -> dark выигрывает; room затем удаляется ДО единственного вызова
  // /rated/settle — ровно ради этого сценария лог физически лежит вне
  // rooms/$room (§14 архитектуры).
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });
  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = {}; // room отсутствует вовсе — не просто finished, а физически удалена
  // matchIndex переживает удаление room отдельным top-level узлом --
  // подтверждает, что MATCH_ID всё ещё самая последняя generation для
  // ABC123 (round-11 fix: без этого room-missing settlement был бы
  // отклонён как stale_generation).
  rtdb.store.data.matchIndex = { ABC123: { matchId: MATCH_ID, createdAt: c.createdAt, lastMatchNumber: c.matchNumber } };
  assert.equal(rtdb.store.data.rooms.ABC123, undefined);

  const result = await settleMatch(env, deps, "alice", "ABC123", MATCH_ID);
  assert.equal(result.result, "dark", "первое settlement выведено из protected log, а не потеряно из-за удаления room");
  assert.ok(rtdb.store.data.eloMatches && rtdb.store.data.eloMatches[MATCH_ID], "receipt реально создан");
  assert.equal(rtdb.store.data.eloMatches[MATCH_ID].settledBy, "worker");
});

test("settleMatch (replayVersion>=1) rejects a non-participant even when settling purely from matches/ratedEvents", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });
  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = {};

  await assert.rejects(
    settleMatch(env, deps, "mallory", "ABC123", MATCH_ID),
    /not_a_participant/
  );
});

test("settleMatch (replayVersion>=1, room missing) rejects settling a SUPERSEDED matchId -- matchIndex proves a newer generation now exists for this roomCode (found on review: without this, a technical/unrated match's stale card+log could be converted to a rated outcome long after a rematch)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const c = card();
  // OLD_MATCH заканчивается через artificial resign (append прошёл, пока
  // room ещё была жива и указывала на OLD_MATCH -- т.е. ДО реванша).
  await commitRatedEvent(env, deps, token, MATCH_ID, c, "alice", { requestId: "r1", type: "resign" });
  rtdb.store.data.matches = { [MATCH_ID]: c };
  rtdb.store.data.rooms = {}; // room впоследствии удалена (или ушла на реванш и была удалена)
  const NEW_MATCH_ID = "elo_ABC123_1700000000000_1";
  // matchIndex УЖЕ указывает на НОВУЮ generation -- OLD_MATCH_ID больше не
  // самая последняя регистрация для этого roomCode.
  rtdb.store.data.matchIndex = { ABC123: { matchId: NEW_MATCH_ID, createdAt: c.createdAt, lastMatchNumber: c.matchNumber + 1 } };

  await assert.rejects(
    settleMatch(env, deps, "alice", "ABC123", MATCH_ID),
    /stale_generation/,
    "settlement старой, суперседнутой generation должен быть отклонён -- иначе technical/unrated исход мог бы конвертироваться в Elo задним числом"
  );
});

test("settleMatch (replayVersion=undefined, room missing) still requires an existing receipt -- legacy behavior unchanged", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const token = await getToken(env, deps);
  const legacyCard = card({ replayVersion: undefined });
  rtdb.store.data = {};
  rtdb.store.data.matches = { [MATCH_ID]: legacyCard };
  rtdb.store.data.rooms = {};

  await assert.rejects(
    settleMatch(env, deps, "alice", "ABC123", MATCH_ID),
    /nothing_to_resume/,
    "legacy (pre-№23) generation без room и без existing receipt по-прежнему не settle'ится в обход"
  );
});

// ===== №23: pristine guard, clock origin, permission_denied repair =====

const MID_0 = "elo_ABC123_1700000000000_0";

function joinRoom(overrides = {}) {
  return {
    players: { light: { id: "tg_111", name: "Alice" }, dark: { id: "tg_222", name: "Bob" } },
    status: "active", createdAt: 1_700_000_000_000, matchNumber: 0,
    pieces: createInitialPieces(), turn: "light", moveCount: 0,
    ...overrides
  };
}

function joinStore(room) {
  return {
    rooms: { ABC123: room },
    stats: { tg_111: { rating: 1210, wins: 1, losses: 0, name: "Alice" },
             tg_222: { rating: 1190, wins: 0, losses: 1, name: "Bob" } }
  };
}

test("№23: early pristine отклоняет начатую комнату ДО первого write-side-effect (stats не тронуты)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  rtdb.store.data = joinStore(joinRoom({ moveCount: 3, turn: "dark" }));
  const statsBefore = JSON.stringify(rtdb.store.data.stats);

  await assert.rejects(() => joinRatedMatch(env, deps, "tg_111", "ABC123"),
    /room_already_started/, "начатая комната не регистрируется");
  assert.equal(JSON.stringify(rtdb.store.data.stats), statsBefore,
    "ensureStatsInitialized не выполнялся — проверка стоит ДО первого write");
  assert.equal(rtdb.store.data.matches, undefined, "карточка матча не создана");
  assert.equal(rtdb.store.data.rooms.ABC123.ratedMatchId, undefined, "pointer не опубликован");
});

test("№23: полное несовпадение доски отклоняется, даже если moveCount=0 и turn=light", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  const tampered = createInitialPieces();
  delete tampered[Object.keys(tampered)[0]];
  rtdb.store.data = joinStore(joinRoom({ pieces: tampered }));

  await assert.rejects(() => joinRatedMatch(env, deps, "tg_111", "ABC123"),
    /room_already_started/, "подменённая доска не проходит полную проверку Worker'а");
});

test("№23: первичная регистрация публикует pointer И ставит turnStartedAt (clock origin)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  rtdb.store.data = joinStore(joinRoom());

  const res = await joinRatedMatch(env, deps, "tg_111", "ABC123");
  const room = rtdb.store.data.rooms.ABC123;
  assert.equal(room.ratedMatchId, res.matchId, "pointer опубликован");
  assert.equal(typeof room.ratingsAtStart.light, "number", "снимок рейтингов опубликован");
  assert.ok(room.turnStartedAt, "turnStartedAt установлен при первичной регистрации");
});

test("№23: повторный join уже зарегистрированной сыгранной партии — idempotent, часы НЕ сдвигаются", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  const CLOCK = 1_700_000_055_555;
  rtdb.store.data = joinStore(joinRoom({
    moveCount: 12, turn: "dark",
    pieces: { d4: { color: "light", king: false } },
    ratedMatchId: MID_0,
    ratingsAtStart: { light: 1210, dark: 1190 },
    ratedReplay: { matchId: MID_0, acceptedSeq: 7, boardSeq: 7 },
    turnStartedAt: CLOCK
  }));
  rtdb.store.data.matchIndex = { ABC123: { matchId: MID_0, createdAt: 1_700_000_000_000, lastMatchNumber: 0 } };
  rtdb.store.data.matches = { [MID_0]: card({ participants: {
    tg_111: { color: "light", ratingAtJoin: 1210, name: "Alice" },
    tg_222: { color: "dark", ratingAtJoin: 1190, name: "Bob" }
  } }) };

  const res = await joinRatedMatch(env, deps, "tg_111", "ABC123");
  const room = rtdb.store.data.rooms.ABC123;
  assert.equal(res.matchId, MID_0, "тот же matchId — idempotent success");
  assert.equal(room.turnStartedAt, CLOCK, "часы НЕ сдвинуты повторным join");
  assert.deepEqual(room.ratedReplay, { matchId: MID_0, acceptedSeq: 7, boardSeq: 7 },
    "прогресс ratedReplay не откачен stale join'ом");
});

test("№23: permission_denied + наш pointer уже опубликован -> idempotent success (проигравший гонку)", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  rtdb.store.data = joinStore(joinRoom());

  // Гонка: победитель публикует pointer и успевает сделать ход, наш PATCH
  // отклоняется Rules; после re-read регистрация фактически наша.
  const origFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH") {
      const r = rtdb.store.data.rooms.ABC123;
      r.ratedMatchId = MID_0;
      r.ratingsAtStart = { light: 1210, dark: 1190 };
      r.moveCount = 1; r.turn = "dark";
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return origFetch(url, options);
  };
  const res = await joinRatedMatch(env, deps, "tg_111", "ABC123");
  assert.equal(res.matchId, MID_0, "признано idempotent success, а не terminal failure");
});

test("№23: permission_denied + pointer НЕ наш и комната начата -> terminal room_already_started", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  rtdb.store.data = joinStore(joinRoom());

  const origFetch2 = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH") {
      const r = rtdb.store.data.rooms.ABC123;
      r.moveCount = 4; r.turn = "dark";
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return origFetch2(url, options);
  };
  await assert.rejects(() => joinRatedMatch(env, deps, "tg_111", "ABC123"),
    /room_already_started/, "без нашего pointer'а это честная terminal failure");
});

test("№23 (CHAR-1): permission_denied + pointer ЧУЖОГО поколения -> stale_generation, НЕ room_already_started", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  const FOREIGN = "elo_ABC123_1700000000000_9";
  rtdb.store.data = joinStore(joinRoom());

  // Гонка с ДРУГИМ поколением (например реванш со второго устройства):
  // Rules отклоняют наш PATCH, а в комнате оказывается чужой pointer.
  const origFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH") {
      const r = rtdb.store.data.rooms.ABC123;
      r.ratedMatchId = FOREIGN;
      r.ratingsAtStart = { light: 1210, dark: 1190 };
      r.moveCount = 5; r.turn = "dark";
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return origFetch(url, options);
  };
  await assert.rejects(() => joinRatedMatch(env, deps, "tg_111", "ABC123"),
    /stale_generation/,
    "чужой pointer — это устаревшее поколение, а не начатая комната");
});

test("№23 (CHAR-3): permission_denied + комната уже generation N+1 -> stale_generation, НЕ room_already_started", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  rtdb.store.data = joinStore(joinRoom());   // card строится для generation N (matchNumber 0)

  // Пока PATCH летел, комната ушла в СЛЕДУЮЩЕЕ поколение (реванш): pointer
  // ещё не опубликован, ходы уже сделаны. Без проверки поколения это
  // выглядело бы как "просто начатая комната" того же поколения.
  const origFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH") {
      const r = rtdb.store.data.rooms.ABC123;
      r.matchNumber = 1;
      delete r.ratedMatchId;
      r.moveCount = 1; r.turn = "dark";
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return origFetch(url, options);
  };
  await assert.rejects(() => joinRatedMatch(env, deps, "tg_111", "ABC123"),
    /stale_generation/,
    "card построена для поколения N, комната уже N+1 — это устаревшее поколение");
});

test("№23 (CHAR-1 negative control): pointer ОТСУТСТВУЕТ + комната начата -> по-прежнему room_already_started", async () => {
  const { env, deps, rtdb } = makeEnvDeps();
  const { joinRatedMatch } = await import("../../worker/index.mjs");
  rtdb.store.data = joinStore(joinRoom());

  const origFetch = deps.fetch;
  deps.fetch = async (url, options) => {
    if (options && options.method === "PATCH") {
      const r = rtdb.store.data.rooms.ABC123;
      r.moveCount = 4; r.turn = "dark";   // pointer НЕ появился
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    return origFetch(url, options);
  };
  await assert.rejects(() => joinRatedMatch(env, deps, "tg_111", "ABC123"),
    /room_already_started/,
    "новая ветка stale_generation не должна перехватывать этот случай");
});

test("№23: room_already_started входит в публичный allowlist кодов", async () => {
  const src = createRequire(import.meta.url)("node:fs")
    .readFileSync(new URL("../../worker/index.mjs", import.meta.url), "utf8");
  assert.ok(src.includes('"room_already_started"'),
    "код должен доходить до клиента, иначе фронтенд не сможет классифицировать его как terminal");
});

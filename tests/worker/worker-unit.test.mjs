import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCanonicalMatchId,
  callerColor,
  decideRegistration,
  eloDeltas,
  roomOutcome,
  sameGeneration,
  validateReceiptAgainstCard
} from "../../worker/index.mjs";

test("canonical match id is stable and rejects non-finite generation numbers", () => {
  assert.equal(buildCanonicalMatchId("ROOM42", 123456, 7), "elo_ROOM42_123456_7");
  assert.equal(buildCanonicalMatchId("ROOM42", Number.NaN, Number.POSITIVE_INFINITY), "elo_ROOM42_0_0");
});

test("callerColor resolves only actual room participants", () => {
  const room = { players: { light: { id: "tg_1" }, dark: { id: "tg_2" } } };
  assert.equal(callerColor(room, "tg_1"), "light");
  assert.equal(callerColor(room, "tg_2"), "dark");
  assert.equal(callerColor(room, "tg_3"), null);
  assert.equal(callerColor(null, "tg_1"), null);
});

test("decideRegistration enforces first match, idempotency and sequential generations", () => {
  assert.deepEqual(decideRegistration(null, { createdAt: 10, matchNumber: 0 }), { ok: true, matchNumber: 0 });
  assert.deepEqual(decideRegistration(null, { createdAt: 10, matchNumber: 1 }), { ok: false, reason: "not_first_match" });

  const index = { createdAt: 10, lastMatchNumber: 2 };
  assert.deepEqual(decideRegistration(index, { createdAt: 10, matchNumber: 2 }), {
    ok: true, matchNumber: 2, already: true
  });
  assert.deepEqual(decideRegistration(index, { createdAt: 10, matchNumber: 3 }), { ok: true, matchNumber: 3 });
  assert.deepEqual(decideRegistration(index, { createdAt: 10, matchNumber: 4 }), {
    ok: false, reason: "match_number_jump"
  });
  assert.deepEqual(decideRegistration(index, { createdAt: 11, matchNumber: 0 }), {
    ok: true, matchNumber: 0, fresh: true
  });
});

test("eloDeltas is zero-sum for equal ratings", () => {
  assert.deepEqual(eloDeltas(1000, 1000, "light"), { light: 16, dark: -16 });
  assert.deepEqual(eloDeltas(1000, 1000, "dark"), { light: -16, dark: 16 });
  assert.deepEqual(eloDeltas(1000, 1000, "draw"), { light: 0, dark: 0 });
});

test("roomOutcome accepts only final result values", () => {
  assert.equal(roomOutcome({ winner: "light" }), "light");
  assert.equal(roomOutcome({ winner: "dark" }), "dark");
  assert.equal(roomOutcome({ winner: "draw" }), "draw");
  assert.equal(roomOutcome({ winner: "pending" }), null);
  assert.equal(roomOutcome(null), null);
});

test("sameGeneration binds settlement card to room code, createdAt and match number", () => {
  const card = { roomCode: "R1", createdAt: 123, matchNumber: 2 };
  assert.equal(sameGeneration(card, "R1", { createdAt: 123, matchNumber: 2 }), true);
  assert.equal(sameGeneration(card, "R2", { createdAt: 123, matchNumber: 2 }), false);
  assert.equal(sameGeneration(card, "R1", { createdAt: 124, matchNumber: 2 }), false);
  assert.equal(sameGeneration(card, "R1", { createdAt: 123, matchNumber: 3 }), false);
});

test("validateReceiptAgainstCard accepts exact Worker receipt and rejects forged delta", () => {
  const card = {
    participants: {
      tg_1: { color: "light", ratingAtJoin: 1000 },
      tg_2: { color: "dark", ratingAtJoin: 1000 }
    }
  };
  const receipt = {
    lightId: "tg_1",
    darkId: "tg_2",
    result: "light",
    lightRatingBefore: 1000,
    darkRatingBefore: 1000,
    lightDelta: 16,
    darkDelta: -16,
    settledBy: "worker"
  };

  assert.deepEqual(validateReceiptAgainstCard(receipt, card, "light"), {
    light: "tg_1",
    dark: "tg_2"
  });
  assert.throws(
    () => validateReceiptAgainstCard({ ...receipt, lightDelta: 15 }, card, "light"),
    /receipt_mismatch/
  );
  assert.throws(
    () => validateReceiptAgainstCard(receipt, card, "dark"),
    /receipt_mismatch/
  );
});

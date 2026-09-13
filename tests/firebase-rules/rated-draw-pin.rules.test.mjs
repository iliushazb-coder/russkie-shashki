// P0 characterization: rated draw offer/accept/cancel broken in production,
// PLUS the corrected security invariant after an independent review caught
// a real hole in the first fix attempt.
//
// ЧЕСТНО: Firebase Database Emulator недоступен в текущей sandbox-среде
// (storage.googleapis.com вне allowlist сети, .jar скачать невозможно —
// проверено непосредственно перед написанием этого файла, дважды, в двух
// раундах этой же работы). Этот файл НЕ был запущен и не дал фактического
// RED/GREEN эмуляторного результата в этой сессии. Все шесть сценариев
// проверены статически, построчным чтением текста Rules против фактических
// значений newData/data, а не выполнением. Первый настоящий прогон —
// в GitHub Actions CI при публикации.
//
// ROOT CAUSE (round 1): rooms/$room/.write, единственная srv_settlement-
// ветка, содержала composite-сравнение
//   newData.child('drawProposal').val() === data.child('drawProposal').val()
// — тот же паттерн, что уже был доказан сломанным для presence
// (96eedfde...). .val() на узле с детьми возвращает специальный маркер
// (официальная документация Firebase), сравнение которого не гарантированно
// даёт true даже при побайтово идентичном содержимом.
//
// ROUND 1 FIX MISTAKE (пойман независимым review, НЕ мной): первая попытка
// вынесла защиту в child-level drawProposal/.validate. Это НЕ работает по
// двум причинам:
//   1) .validate НЕ выполняется, когда newData на ЭТОМ узле становится null
//      (удаление) — значит srv_settlement мог удалить весь узел целиком,
//      и никакая проверка не сработала бы;
//   2) ветка "!data.exists()" внутри child-validate разрешала бы
//      srv_settlement создать НОВЫЙ drawProposal с нуля, чего быть не
//      должно вообще — только участник может ЗАВЕСТИ предложение.
//
// ROUND 2 FIX (проверяется здесь): защита перенесена в СУЩЕСТВУЮЩИЙ
// $room/.validate (родительский уровень) — тот же узел, где уже корректно
// защищены ratedReplay/turnStartedAt от удаления тем же srv_settlement
// (тот факт, что .validate не пропускает delete, относится ТОЛЬКО к
// validate САМОГО удаляемого узла; родительский $room не удаляется в этом
// коммите — он лишь обновляется, — поэтому его собственный .validate
// выполняется всегда, включая коммиты, которые удаляют его потомка).
// Инвариант выражен через EXISTENCE EQUALITY (newData.exists() ===
// data.exists()), а не одностороннее "нельзя удалить" — это одним и тем же
// условием ловит и удаление (C3), и создание с нуля (C4).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import { ref, set, update } from "firebase/database";

const PROJECT_ID = "demo-russkie-shashki";
const RULES_PATH = new URL("../../firebase/database.rules.json", import.meta.url);

const SERVER_UID = "srv_settlement";
const MATCH_ID = "elo_ABC123_1700000000000_0";
const CREATED_AT = 1_700_000_000_000;

let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    database: {
      host: "127.0.0.1",
      port: 9000,
      rules: await readFile(RULES_PATH, "utf8")
    }
  });
});

beforeEach(async () => {
  await testEnv.clearDatabase();
});

after(async () => {
  if (testEnv) await testEnv.cleanup();
});

function databaseFor(uid = null) {
  return uid === null
    ? testEnv.unauthenticatedContext().database()
    : testEnv.authenticatedContext(uid).database();
}

async function seed(path, value) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await set(ref(context.database(), path), value);
  });
}

function activeRoomWithDrawProposal(overrides = {}) {
  return {
    players: { light: { id: "tg_111", name: "Ilyusha" }, dark: { id: "tg_222", name: "Tatiana" } },
    status: "active",
    createdAt: CREATED_AT,
    matchNumber: 0,
    groupId: "g1",
    timeControlSeconds: 0,
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 },
    turn: "dark",
    moveCount: 3,
    pieces: { "5_0": { color: "light", king: false } },
    drawProposal: { by: "light", name: "Tatiana" },
    ...overrides
  };
}

function activeRoomWithoutDrawProposal(overrides = {}) {
  const room = activeRoomWithDrawProposal(overrides);
  delete room.drawProposal;
  return room;
}

// --- A/B: legitimate projection writes must remain ALLOWED ---

test("A: srv_settlement non-terminal projection (draw_cancel) ALLOWED while an existing drawProposal is left untouched", async () => {
  await seed("rooms/ABC123", activeRoomWithDrawProposal());
  const result = update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4
  });
  await assertSucceeds(result);
});

test("B: srv_settlement terminal draw_accept projection ALLOWED while an existing drawProposal is left untouched", async () => {
  await seed("rooms/ABC123", activeRoomWithDrawProposal());
  const result = update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    winner: "draw",
    winReason: "draw",
    status: "finished"
  });
  await assertSucceeds(result);
});

// --- C1-C4: mandatory security controls (added after independent review) ---

test("C1: existing drawProposal -> srv_settlement changes /by -> DENY", async () => {
  await seed("rooms/ABC123", activeRoomWithDrawProposal());
  const result = update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    "drawProposal/by": "dark"
  });
  await assertFails(result);
});

test("C2: existing drawProposal -> srv_settlement changes /name -> DENY", async () => {
  await seed("rooms/ABC123", activeRoomWithDrawProposal());
  const result = update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    "drawProposal/name": "Someone Else"
  });
  await assertFails(result);
});

test("C3: existing drawProposal -> srv_settlement deletes the whole node -> DENY (the exact hole a child-level .validate would have missed)", async () => {
  await seed("rooms/ABC123", activeRoomWithDrawProposal());
  const result = update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    "drawProposal": null
  });
  await assertFails(result);
});

test("C4: absent drawProposal -> srv_settlement creates one from scratch -> DENY", async () => {
  await seed("rooms/ABC123", activeRoomWithoutDrawProposal());
  const result = update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    "drawProposal": { by: "dark", name: "Ilyusha" }
  });
  await assertFails(result);
});

// --- regression: normal projection writes on a room with NO drawProposal
// at all must remain unaffected (the overwhelming majority of turns) ---

test("D: srv_settlement projection ALLOWED on a room with no drawProposal at all (regression, most common case)", async () => {
  await seed("rooms/ABC123", activeRoomWithoutDrawProposal());
  const result = update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4
  });
  await assertSucceeds(result);
});

// --- C5: the exact bypass an independent review caught in round 2 ---
// The drawProposal invariant was first nested INSIDE the SAME disjunction
// as "ratedMatchId is changing" -- meaning a commit that legitimately
// changes ratedMatchId (registration/rematch) short-circuited that whole
// disjunction to true WITHOUT ever evaluating drawProposal at all. This
// test proves the fix: drawProposal protection is now a SEPARATE,
// independently-ANDed conjunct that applies regardless of what else the
// same commit does to ratedMatchId.
//
// ROUND 3 REVIEW CAUGHT A SECOND MISTAKE, in THIS test itself (not in the
// fix): the first version of C5 used a non-pristine room (moveCount: 3,
// turn: "dark") and never seeded matchIndex/$room at all. That fixture was
// ALREADY denied by ratedMatchId/.validate's own pristine-guard --
// completely independently of the new G2 conjunct being tested. A DENY
// from the wrong rule proves nothing about G2. Traced precisely below is
// the one case where pristine-guard itself does NOT block the attempt --
// deleting an EXISTING drawProposal during an otherwise-fully-valid
// registration transition -- because pristine-guard's own requirement is
// "!newData.parent().child('drawProposal').exists()", which a DELETE
// satisfies. G2 is the only remaining rule that can catch it.

const ROOM_CODE = "ABC123";

function pristineRoomExceptDrawProposal(overrides = {}) {
  return {
    players: { light: { id: "tg_111", name: "Ilyusha" }, dark: { id: "tg_222", name: "Tatiana" } },
    status: "active",
    createdAt: CREATED_AT,
    matchNumber: 0,
    groupId: "g1",
    timeControlSeconds: 0,
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 },
    turn: "light",
    moveCount: 0,
    pieces: { "5_0": { color: "light", king: false } },
    drawProposal: { by: "light", name: "Tatiana" },
    ...overrides
  };
}

test("C5 (bypass regression, diagnostic-isolated): otherwise-fully-pristine ratedMatchId transition that ALSO deletes an existing drawProposal -> DENY, caused specifically by G2 and not by ratedMatchId/.validate's own pristine-guard", async () => {
  const NEXT_MATCH_ID = "elo_ABC123_1700000000000_1";

  await seed(`rooms/${ROOM_CODE}`, pristineRoomExceptDrawProposal());
  await seed(`matchIndex/${ROOM_CODE}`, {
    matchId: NEXT_MATCH_ID,
    createdAt: CREATED_AT,
    lastMatchNumber: 0
  });

  // Prerequisite sanity check, run FIRST: the exact same transition with
  // drawProposal left untouched (still existing) must ALSO deny, because
  // pristine-guard's own "!drawProposal.exists()" requirement is violated
  // whenever the proposal is simply left in place -- confirming the
  // fixture is otherwise pristine-valid and the ONLY variable is what
  // happens to drawProposal in this specific attempt.
  await seed(`rooms/${ROOM_CODE}`, pristineRoomExceptDrawProposal());
  const leftInPlace = update(ref(databaseFor(SERVER_UID), `rooms/${ROOM_CODE}`), {
    ratedMatchId: NEXT_MATCH_ID
    // drawProposal intentionally NOT touched -- still exists afterward.
  });
  await assertFails(leftInPlace);

  // The actual scenario under test: registration transition that ALSO
  // deletes the existing drawProposal in the same commit.
  await seed(`rooms/${ROOM_CODE}`, pristineRoomExceptDrawProposal());
  const deletedDuringTransition = update(ref(databaseFor(SERVER_UID), `rooms/${ROOM_CODE}`), {
    ratedMatchId: NEXT_MATCH_ID,
    drawProposal: null
  });
  await assertFails(deletedDuringTransition);
});

test("C5 diagnostic proof: the SAME fixture and SAME update, run against the rules with G2 mechanically stripped out, is ALLOWED -- proving G2 (not pristine-guard, not .write) is what denies it above", async () => {
  const rulesText = await readFile(RULES_PATH, "utf8");
  const g2 = " && (auth == null || auth.uid !== 'srv_settlement' || !data.exists() || (newData.child('drawProposal').exists() === data.child('drawProposal').exists() && (!data.child('drawProposal').exists() || (newData.child('drawProposal/by').val() === data.child('drawProposal/by').val() && newData.child('drawProposal/name').val() === data.child('drawProposal/name').val()))))";
  assert.equal(rulesText.split(g2).length - 1, 1, "G2 conjunct text not found exactly once in the current rules -- diagnostic proof cannot run against a rules file that has drifted from what this test expects");
  const rulesWithoutG2 = rulesText.replace(g2, "");
  assert.notEqual(rulesWithoutG2, rulesText);

  const strippedEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID + "-c5-diagnostic",
    database: { host: "127.0.0.1", port: 9000, rules: rulesWithoutG2 }
  });
  try {
    await strippedEnv.withSecurityRulesDisabled(async (context) => {
      await set(ref(context.database(), `rooms/${ROOM_CODE}`), pristineRoomExceptDrawProposal());
      await set(ref(context.database(), `matchIndex/${ROOM_CODE}`), {
        matchId: "elo_ABC123_1700000000000_1",
        createdAt: CREATED_AT,
        lastMatchNumber: 0
      });
    });
    const withoutG2 = update(
      ref(strippedEnv.authenticatedContext(SERVER_UID).database(), `rooms/${ROOM_CODE}`),
      { ratedMatchId: "elo_ABC123_1700000000000_1", drawProposal: null }
    );
    await assertSucceeds(withoutG2);
  } finally {
    await strippedEnv.cleanup();
  }
});

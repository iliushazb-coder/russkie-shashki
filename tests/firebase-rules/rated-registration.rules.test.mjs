// №23 (Rules-слой): атомарные guard'ы вокруг канонической регистрации
// рейтингового поколения.
//
// Что доказывается здесь и НЕ доказывается нигде больше:
//   1. pristine guard — pointer публикуется только в нетронутую комнату,
//      на ЛЮБОМ реальном переходе ratedMatchId (включая реванш
//      oldMatchId -> newMatchId), а не только при первой публикации;
//   2. stale/повторный srv_settlement join НЕ может удалить уже созданный
//      ratedReplay (RTDB не вычисляет .validate при удалении дочернего
//      узла, поэтому защита живёт в rooms/$room/.validate);
//   3. stale/повторный srv_settlement join НЕ может удалить или сдвинуть
//      turnStartedAt — разрешены ровно два перехода: коммит, меняющий
//      ratedMatchId, и коммит, продвигающий ratedReplay/boardSeq;
//   4. законные participant-записи (waiting->active join и обычное
//      обновление turnStartedAt на завершённом ходу) НЕ сломаны;
//   5. идемпотентная перезапись того же ratedMatchId в УЖЕ СЫГРАННОЙ
//      партии остаётся разрешённой (reconnect не ломается).

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
const NEXT_MATCH_ID = "elo_ABC123_1700000000000_1";
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

// Комната БЕЗ pointer'а: готова к первичной регистрации.
function pristineRoom(overrides = {}) {
  return {
    pieces: { b6: { color: "light", king: false }, c3: { color: "dark", king: false } },
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    turn: "light",
    status: "active",
    createdAt: CREATED_AT,
    matchNumber: 0,
    moveCount: 0,
    turnStartedAt: CREATED_AT,
    ...overrides
  };
}

// matchIndex обязателен: существующая ветка .validate сверяет pointer с ним.
async function seedIndex({ matchId = MATCH_ID, lastMatchNumber = 0 } = {}) {
  await seed("matchIndex/ABC123", {
    matchId,
    createdAt: CREATED_AT,
    lastMatchNumber
  });
}

async function publishPointer(db, { matchId = MATCH_ID, extra = {} } = {}) {
  return update(ref(db, "rooms/ABC123"), {
    ratedMatchId: matchId,
    "ratingsAtStart/light": 1200,
    "ratingsAtStart/dark": 1180,
    ...extra
  });
}

// ---------------------------------------------------------------------------
// 1. PRISTINE GUARD
// ---------------------------------------------------------------------------

test("pristine room: srv_settlement публикует pointer", async () => {
  await seed("rooms/ABC123", pristineRoom());
  await seedIndex();
  await assertSucceeds(publishPointer(databaseFor(SERVER_UID)));
});

test("moveCount > 0: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({ moveCount: 1 }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("turn !== light: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({ turn: "dark" }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("mustContinueFrom присутствует: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({ mustContinueFrom: "c3" }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("ненулевые captured counters: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({ capturedDark: 1 }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("capturedLight > 0: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({ capturedLight: 1 }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("winner присутствует: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({ winner: "light" }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("result присутствует: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({
    status: "finished",
    winner: "light",
    winReason: "disconnect",
    result: {
      winnerColor: "light",
      loserColor: "dark",
      winnerId: "alice",
      loserId: "bob",
      winReason: "disconnect",
      status: "finished",
      decidedAt: CREATED_AT + 1000
    }
  }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("drawProposal присутствует: публикация pointer отклонена", async () => {
  await seed("rooms/ABC123", pristineRoom({ drawProposal: { by: "light", name: "Alice" } }));
  await seedIndex();
  await assertFails(publishPointer(databaseFor(SERVER_UID)));
});

test("rematch: реальный переход oldMatchId -> newMatchId в pristine комнате разрешён", async () => {
  await seed("rooms/ABC123", pristineRoom({
    matchNumber: 1,
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 }
  }));
  await seedIndex({ matchId: NEXT_MATCH_ID, lastMatchNumber: 1 });
  await assertSucceeds(publishPointer(databaseFor(SERVER_UID), { matchId: NEXT_MATCH_ID }));
});

test("rematch в УЖЕ НАЧАВШЕЙСЯ комнате отклонён (pristine guard ловит и переход, не только первую публикацию)", async () => {
  await seed("rooms/ABC123", pristineRoom({
    matchNumber: 1,
    moveCount: 3,
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 }
  }));
  await seedIndex({ matchId: NEXT_MATCH_ID, lastMatchNumber: 1 });
  await assertFails(publishPointer(databaseFor(SERVER_UID), { matchId: NEXT_MATCH_ID }));
});

test("идемпотентная перезапись того же matchId в СЫГРАННОЙ партии разрешена (reconnect)", async () => {
  await seed("rooms/ABC123", pristineRoom({
    moveCount: 7,
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 },
    ratedReplay: { matchId: MATCH_ID, acceptedSeq: 5, boardSeq: 5 }
  }));
  await seedIndex();
  await assertSucceeds(publishPointer(databaseFor(SERVER_UID)));
});

// ---------------------------------------------------------------------------
// 2. ratedReplay: защита от удаления stale join'ом
// ---------------------------------------------------------------------------

test("stale srv_settlement join НЕ может удалить существующий ratedReplay", async () => {
  await seed("rooms/ABC123", pristineRoom({
    moveCount: 1,
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 },
    ratedReplay: { matchId: MATCH_ID, acceptedSeq: 1, boardSeq: 1 }
  }));
  await seedIndex();
  await assertFails(update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    ratedMatchId: MATCH_ID,
    "ratingsAtStart/light": 1200,
    "ratingsAtStart/dark": 1180,
    ratedReplay: null
  }));
});

test("очистка ratedReplay РАЗРЕШЕНА в коммите, реально меняющем ratedMatchId (реванш)", async () => {
  await seed("rooms/ABC123", pristineRoom({
    matchNumber: 1,
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 },
    ratedReplay: { matchId: MATCH_ID, acceptedSeq: 4, boardSeq: 4 }
  }));
  await seedIndex({ matchId: NEXT_MATCH_ID, lastMatchNumber: 1 });
  await assertSucceeds(update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    ratedMatchId: NEXT_MATCH_ID,
    "ratingsAtStart/light": 1200,
    "ratingsAtStart/dark": 1180,
    ratedReplay: null
  }));
});

// ---------------------------------------------------------------------------
// 3. turnStartedAt: пин против сдвига/удаления stale join'ом
// ---------------------------------------------------------------------------

test("stale srv_settlement join НЕ может сдвинуть turnStartedAt", async () => {
  await seed("rooms/ABC123", pristineRoom({
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 },
    ratedReplay: { matchId: MATCH_ID, acceptedSeq: 1, boardSeq: 1 }
  }));
  await seedIndex();
  await assertFails(update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    ratedMatchId: MATCH_ID,
    turnStartedAt: CREATED_AT + 60_000
  }));
});

test("stale srv_settlement join НЕ может удалить turnStartedAt (иначе снимается лимит времени)", async () => {
  await seed("rooms/ABC123", pristineRoom({
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 }
  }));
  await seedIndex();
  await assertFails(update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    ratedMatchId: MATCH_ID,
    turnStartedAt: null
  }));
});

test("turnStartedAt МОЖЕТ быть установлен в коммите первичной регистрации (clock origin)", async () => {
  await seed("rooms/ABC123", pristineRoom());
  await seedIndex();
  await assertSucceeds(publishPointer(databaseFor(SERVER_UID), {
    extra: { turnStartedAt: CREATED_AT + 5_000 }
  }));
});

test("turnStartedAt МОЖЕТ сдвигаться при реальном продвижении ratedReplay/boardSeq (projection)", async () => {
  await seed("rooms/ABC123", pristineRoom({
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 },
    ratedReplay: { matchId: MATCH_ID, acceptedSeq: 1, boardSeq: 1 }
  }));
  await seedIndex();
  await assertSucceeds(update(ref(databaseFor(SERVER_UID), "rooms/ABC123"), {
    "ratedReplay/acceptedSeq": 2,
    "ratedReplay/boardSeq": 2,
    turnStartedAt: CREATED_AT + 30_000
  }));
});

// ---------------------------------------------------------------------------
// 4. Participant legacy writes НЕ сломаны
// ---------------------------------------------------------------------------

test("participant по-прежнему обновляет turnStartedAt на завершённом ходу", async () => {
  await seed("rooms/ABC123", pristineRoom({
    ratedMatchId: MATCH_ID,
    ratingsAtStart: { light: 1200, dark: 1180 }
  }));
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ABC123"), {
    turn: "dark",
    moveCount: 1,
    turnStartedAt: CREATED_AT + 10_000
  }));
});

test("participant НЕ может опубликовать pointer сам", async () => {
  await seed("rooms/ABC123", pristineRoom());
  await seedIndex();
  await assertFails(publishPointer(databaseFor("alice")));
});

test("srv_settlement publishes first rated pointer when presence is populated", async () => {
  await seed("rooms/ABC123", pristineRoom({
    presence: {
      light: {
        lastSeen: CREATED_AT + 1000,
        online: true,
        onlineSince: CREATED_AT + 500
      },
      dark: {
        lastSeen: CREATED_AT + 1000,
        online: true,
        onlineSince: CREATED_AT + 500
      }
    }
  }));
  await seedIndex();

  const { serverTimestamp } = await import("firebase/database");

  await assertSucceeds(update(ref(databaseFor(SERVER_UID)), {
    "rooms/ABC123/ratedMatchId": MATCH_ID,
    "rooms/ABC123/ratingsAtStart/light": 1200,
    "rooms/ABC123/ratingsAtStart/dark": 1180,
    "rooms/ABC123/ratedReplay": null,
    "rooms/ABC123/turnStartedAt": serverTimestamp()
  }));
});

test("srv_settlement cannot mutate presence while publishing rated pointer", async () => {
  await seed("rooms/ABC123", pristineRoom({
    presence: {
      light: {
        online: true,
        lastSeen: CREATED_AT + 1000,
        onlineSince: CREATED_AT + 500
      },
      dark: {
        online: true,
        lastSeen: CREATED_AT + 1000,
        onlineSince: CREATED_AT + 500
      }
    }
  }));
  await seedIndex();

  const { serverTimestamp } = await import("firebase/database");

  await assertFails(update(ref(databaseFor(SERVER_UID)), {
    "rooms/ABC123/ratedMatchId": MATCH_ID,
    "rooms/ABC123/ratingsAtStart/light": 1200,
    "rooms/ABC123/ratingsAtStart/dark": 1180,
    "rooms/ABC123/ratedReplay": null,
    "rooms/ABC123/turnStartedAt": serverTimestamp(),
    "rooms/ABC123/presence/light/online": false
  }));
});

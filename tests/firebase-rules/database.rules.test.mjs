import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  get,
  increment,
  limitToLast,
  orderByChild,
  query,
  ref,
  remove,
  serverTimestamp,
  set,
  update
} from "firebase/database";

const PROJECT_ID = "demo-russkie-shashki";
const RULES_PATH = new URL("../../firebase/database.rules.json", import.meta.url);

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

function stats(overrides = {}) {
  return {
    wins: 2,
    losses: 1,
    name: "Alice",
    rating: 1216,
    draws: 3,
    ...overrides
  };
}

function statsBot(overrides = {}) {
  return {
    wins: 2,
    losses: 1,
    name: "Alice",
    byLevel: {
      medium: { wins: 1, losses: 0 },
      hard: { wins: 1, losses: 1 }
    },
    recentMatchIds: { 0: "bot-match-1" },
    ...overrides
  };
}

function receipt(overrides = {}) {
  return {
    lightId: "alice",
    darkId: "bob",
    result: "light",
    lightRatingBefore: 1200,
    darkRatingBefore: 1200,
    lightDelta: 16,
    darkDelta: -16,
    createdAt: 1_700_000_000_000,
    ...overrides
  };
}

function room({ status = "active", dark = true, presence = null } = {}) {
  const value = {
    pieces: {
      b6: { color: "light", king: false },
      c3: { color: "dark", king: false }
    },
    players: {
      light: { id: "alice", name: "Alice" }
    },
    turn: "light",
    status,
    createdAt: 1_700_000_000_000,
    matchNumber: 0
  };

  if (dark) value.players.dark = { id: "bob", name: "Bob" };
  if (presence) value.presence = presence;
  return value;
}

function botSession(overrides = {}) {
  return {
    status: "active",
    matchId: "bot-match-1",
    revision: 0,
    botDifficulty: "medium",
    botColor: "dark",
    myColor: "light",
    spectateRoomCode: "BOTROOM",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    state: {
      pieces: { b6: { color: "light", king: false } },
      turn: "light",
      capturedDark: 0,
      capturedLight: 0,
      moveCount: 0,
      players: { light: { id: "alice", name: "Alice" } }
    },
    ...overrides
  };
}

function economy(overrides = {}) {
  return {
    name: "Alice",
    balance: 10,
    lifetimeEarned: 20,
    lifetimeSpent: 10,
    lastDailyClaim: "2026-09-03",
    welcomeClaimed: true,
    ...overrides
  };
}

function queueEntry(overrides = {}) {
  return {
    name: "Alice",
    timestamp: 1_700_000_000_000,
    roomCode: "ROOM1",
    ...overrides
  };
}

test("root: unauthenticated read stays denied", async () => {
  await assertFails(get(ref(databaseFor(), "/")));
});

test("stats: public leaderboard read is allowed", async () => {
  await assertSucceeds(get(ref(databaseFor(), "stats")));
});

test("stats: settlement identity can create a full node", async () => {
  await assertSucceeds(set(
    ref(databaseFor("srv_settlement"), "stats/tg_1001"),
    stats()
  ));
});

test("stats: settlement identity can apply atomic root increments", async () => {
  await seed("stats/tg_1001", stats({ name: "Light", rating: 1200, wins: 2, losses: 1, draws: 3 }));
  await seed("stats/tg_1002", stats({ name: "Dark", rating: 1200, wins: 4, losses: 2, draws: 1 }));

  await assertSucceeds(update(ref(databaseFor("srv_settlement")), {
    "stats/tg_1001/rating": increment(16),
    "stats/tg_1002/rating": increment(-16),
    "stats/tg_1001/wins": increment(1),
    "stats/tg_1002/losses": increment(1)
  }));

  const light = await get(ref(databaseFor(), "stats/tg_1001"));
  const dark = await get(ref(databaseFor(), "stats/tg_1002"));
  assert.equal(light.child("rating").val(), 1216);
  assert.equal(light.child("wins").val(), 3);
  assert.equal(dark.child("rating").val(), 1184);
  assert.equal(dark.child("losses").val(), 3);
});

test("stats: legacy authenticated client cannot update own node", async () => {
  await seed("stats/tg_1001", stats());
  await assertFails(update(ref(databaseFor("tg_1001")), {
    "stats/tg_1001/rating": increment(16),
    "stats/tg_1001/wins": increment(1)
  }));
});

test("stats: authenticated cross-user write is denied", async () => {
  await assertFails(set(
    ref(databaseFor("tg_1001"), "stats/tg_1002"),
    stats()
  ));
});

test("stats: unauthenticated write is denied", async () => {
  await assertFails(set(ref(databaseFor(), "stats/tg_1001"), stats()));
});

test("stats: missing required fields are denied for settlement identity", async () => {
  await assertFails(set(
    ref(databaseFor("srv_settlement"), "stats/tg_1001"),
    { wins: 1, losses: 0 }
  ));
});

test("stats: unknown fields are denied for settlement identity", async () => {
  await assertFails(set(
    ref(databaseFor("srv_settlement"), "stats/tg_1001"),
    stats({ admin: true })
  ));
});

test("stats: deletion is denied for settlement identity", async () => {
  await seed("stats/tg_1001", stats());
  await assertFails(remove(ref(databaseFor("srv_settlement"), "stats/tg_1001")));
});

test("statsBot: public leaderboard read is allowed", async () => {
  await seed("statsBot/alice", statsBot());
  await assertSucceeds(get(ref(databaseFor(), "statsBot")));
});

test("statsBot: owner can create own node", async () => {
  await assertSucceeds(set(ref(databaseFor("alice"), "statsBot/alice"), statsBot()));
});

test("statsBot: owner can update own node", async () => {
  await seed("statsBot/alice", statsBot());
  await assertSucceeds(update(ref(databaseFor("alice"), "statsBot/alice"), { wins: 3 }));
});

test("statsBot: authenticated cross-user write is denied", async () => {
  await assertFails(set(ref(databaseFor("alice"), "statsBot/bob"), statsBot()));
});

test("statsBot: unauthenticated write is denied", async () => {
  await assertFails(set(ref(databaseFor(), "statsBot/alice"), statsBot()));
});

test("statsBot: invalid counters are denied for owner", async () => {
  await assertFails(set(ref(databaseFor("alice"), "statsBot/alice"), statsBot({ wins: -1 })));
});

test("statsBot: malformed recent match ids are denied for owner", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "statsBot/alice"),
    statsBot({ recentMatchIds: { 10: "outside-allowed-index" } })
  ));
});

test("statsBot: owner deletion is denied", async () => {
  await seed("statsBot/alice", statsBot());
  await assertFails(remove(ref(databaseFor("alice"), "statsBot/alice")));
});

test("eloMatches: public read is denied", async () => {
  await assertFails(get(ref(databaseFor(), "eloMatches/match-1")));
});

test("eloMatches: authenticated non-settlement read is denied", async () => {
  await assertFails(get(ref(databaseFor("tg_1001"), "eloMatches/match-1")));
});

test("eloMatches: settlement identity can read", async () => {
  await assertSucceeds(get(ref(databaseFor("srv_settlement"), "eloMatches/match-1")));
});

test("eloMatches: settlement identity can create a worker receipt", async () => {
  await assertSucceeds(set(
    ref(databaseFor("srv_settlement"), "eloMatches/match-1"),
    receipt({ settledBy: "worker" })
  ));
});

test("eloMatches: unauthenticated create is denied even with a fully valid receipt", async () => {
  await assertFails(set(ref(databaseFor(), "eloMatches/match-1"), receipt()));
});

test("eloMatches: authenticated non-settlement create is denied even with a fully valid receipt", async () => {
  await assertFails(set(ref(databaseFor("tg_1001"), "eloMatches/match-1"), receipt()));
});

test("eloMatches: unauthenticated settledBy spoof is denied", async () => {
  await assertFails(set(
    ref(databaseFor(), "eloMatches/match-1"),
    receipt({ settledBy: "worker" })
  ));
});

test("eloMatches: an invalid delta sum is denied for settlement identity", async () => {
  await assertFails(set(
    ref(databaseFor("srv_settlement"), "eloMatches/match-1"),
    receipt({ lightDelta: 1, darkDelta: -16 })
  ));
});

test("eloMatches: a positive non-zero delta sum is allowed for settlement identity", async () => {
  await assertSucceeds(set(
    ref(databaseFor("srv_settlement"), "eloMatches/match-1"),
    receipt({ lightDelta: 16, darkDelta: -1 })
  ));
});

test("eloMatches: duplicate settlement is denied", async () => {
  await seed("eloMatches/match-1", receipt());
  await assertFails(set(ref(databaseFor("srv_settlement"), "eloMatches/match-1"), receipt()));
});

test("eloMatches: overwrite of an existing receipt is denied even for settlement identity", async () => {
  await seed("eloMatches/match-1", receipt());
  await assertFails(set(
    ref(databaseFor("srv_settlement"), "eloMatches/match-1"),
    receipt({ lightDelta: 1, darkDelta: -1 })
  ));
});

test("eloMatches: deletion is denied", async () => {
  await seed("eloMatches/match-1", receipt());
  await assertFails(remove(ref(databaseFor("srv_settlement"), "eloMatches/match-1")));
});

test("eloMatches: atomic root PATCH creates the receipt and updates both stats nodes", async () => {
  await seed("stats/alice", stats({ name: "Alice", rating: 1200, wins: 2, losses: 1, draws: 3 }));
  await seed("stats/bob", stats({ name: "Bob", rating: 1200, wins: 4, losses: 2, draws: 1 }));

  await assertSucceeds(update(ref(databaseFor("srv_settlement")), {
    "eloMatches/match-1": receipt({ lightId: "alice", darkId: "bob", settledBy: "worker" }),
    "stats/alice/rating": increment(16),
    "stats/bob/rating": increment(-16),
    "stats/alice/wins": increment(1),
    "stats/bob/losses": increment(1)
  }));

  const light = await get(ref(databaseFor(), "stats/alice"));
  const dark = await get(ref(databaseFor(), "stats/bob"));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const raw = await get(ref(context.database(), "eloMatches/match-1"));
    assert.equal(raw.exists(), true);
    assert.equal(raw.child("lightId").val(), "alice");
    assert.equal(raw.child("darkId").val(), "bob");
  });
  assert.equal(light.child("rating").val(), 1216);
  assert.equal(light.child("wins").val(), 3);
  assert.equal(dark.child("rating").val(), 1184);
  assert.equal(dark.child("losses").val(), 3);
});

test("matches: unauthenticated create is denied", async () => {
  await assertFails(set(ref(databaseFor(), "matches/match-1"), { roomCode: "ROOM1" }));
});

test("matches: settlement identity can create once", async () => {
  await assertSucceeds(set(
    ref(databaseFor("srv_settlement"), "matches/match-1"),
    { roomCode: "ROOM1" }
  ));
});

test("matches: update and delete after create are denied", async () => {
  await seed("matches/match-1", { roomCode: "ROOM1" });
  const server = databaseFor("srv_settlement");
  await assertFails(update(ref(server, "matches/match-1"), { roomCode: "ROOM2" }));
  await assertFails(remove(ref(server, "matches/match-1")));
});

test("matches: only settlement identity can read", async () => {
  await seed("matches/match-1", { roomCode: "ROOM1" });
  await assertFails(get(ref(databaseFor("alice"), "matches/match-1")));
  await assertSucceeds(get(ref(databaseFor("srv_settlement"), "matches/match-1")));
});

test("matchIndex: only settlement identity can write", async () => {
  const value = { matchId: "match-1", createdAt: 1, lastMatchNumber: 0 };
  await assertFails(set(ref(databaseFor(), "matchIndex/ROOM1"), value));
  await assertSucceeds(set(ref(databaseFor("srv_settlement"), "matchIndex/ROOM1"), value));
});

test("matchIndex: only settlement identity can read", async () => {
  await seed("matchIndex/ROOM1", { matchId: "match-1" });
  await assertFails(get(ref(databaseFor(), "matchIndex/ROOM1")));
  await assertSucceeds(get(ref(databaseFor("srv_settlement"), "matchIndex/ROOM1")));
});

test("rooms: public read is allowed", async () => {
  await assertSucceeds(get(ref(databaseFor(), "rooms")));
});

test("rooms: a valid waiting room can be created", async () => {
  await assertSucceeds(set(
    ref(databaseFor("alice"), "rooms/ROOM1"),
    room({ status: "waiting", dark: false })
  ));
});

test("rooms: a partial room create is denied", async () => {
  await assertFails(set(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: {},
    turn: "light",
    status: "waiting"
  }));
});

test("rooms: a dark player can join a waiting room (full join: dark+status+fresh turnStartedAt)", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertSucceeds(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: Date.now()
  }));
});

test("rooms: players/dark alone, without status or turnStartedAt, is denied", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertFails(set(
    ref(databaseFor("bob"), "rooms/ROOM1/players/dark"),
    { id: "bob", name: "Bob" }
  ));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const stillWaiting = await get(ref(context.database(), "rooms/ROOM1"));
    assert.equal(stillWaiting.child("status").val(), "waiting");
    assert.equal(stillWaiting.child("players/dark").exists(), false);
  });
});

test("rooms: players/dark + turnStartedAt without flipping status to active is denied (two-step escalation attempt)", async () => {
  // Ровно найденная двухшаговая эскалация: если бы это прошло, room
  // осталась бы waiting, но auth.uid уже сидел бы в players/dark — а
  // participant-ветка $room/.write смотрит только на неизменность light/dark
  // id, не на status. Доказано только это: "dark" нельзя записать отдельно
  // и получить participant-доступ. dark и status обязаны меняться вместе —
  // это НЕ то же самое, что "все три поля взаимно требуют друг друга":
  // turnStartedAt при свежем creation timestamp может остаться нетронутым
  // (см. KNOWN LIMITATION ниже) без последствий для этой гарантии.
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertFails(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    turnStartedAt: Date.now()
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const stillWaiting = await get(ref(context.database(), "rooms/ROOM1"));
    assert.equal(stillWaiting.child("status").val(), "waiting");
    assert.equal(stillWaiting.child("players/dark").exists(), false);
  });
});


test("rooms: join with a stale turnStartedAt (reusing the room-creation timestamp) is denied", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertFails(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: 1_700_000_000_000
  }));
});

test("rooms: KNOWN LIMITATION — joining within 10s of room creation does not require turnStartedAt to be touched", async () => {
  // Найдено на независимой проверке (моя собственная ошибка): пытался
  // закрыть это через newData.val() > data.val(), но реальный Firebase
  // Rules Emulator показал, что это ломает ЛЕГИТИМНЫЕ join'ы — фикстура
  // room() никогда не задаёт turnStartedAt (data.val()===null), а
  // сравнение ">" против отсутствующего значения в RTDB Rules не ведёт
  // себя как JS-коэрсия null->0 (задокументированный класс проблем с
  // операторами сравнения против null/отсутствующих полей). Откатил
  // newData>data полностью, оставил только freshness-окно "<=now &&
  // >now-10000".
  //
  // Следствие: если join происходит МЕНЕЕ чем через 10с после создания
  // комнаты, dark+status без явного нового turnStartedAt проходит, потому
  // что старое (созданное недавно) значение само по себе укладывается в
  // окно. Это НЕ авторизационная дыра — dark+status по-прежнему обязаны
  // переходить ВМЕСТЕ (см. остальные join-тесты), реальная эскалация №18
  // закрыта. Единственное следствие — таймер первого хода в этом узком
  // окне может отсчитываться от момента создания комнаты, а не от join'а
  // (fairness-нюанс для 10-секундного окна, не security).
  const realistic = room({ status: "waiting", dark: false });
  realistic.turnStartedAt = Date.now() - 1000; // комната создана ~1с назад
  await seed("rooms/ROOM1", realistic);
  await assertSucceeds(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active"
  }));
});

test("rooms: a production-shaped join using the real SDK server-timestamp placeholder is allowed", async () => {
  // Тот же механизм, что claimDarkSeatAndActivate реально использует в
  // script.js (firebase.database.ServerValue.TIMESTAMP) — не литеральный
  // Date.now(), а настоящий serverTimestamp()-плейсхолдер модульного SDK.
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertSucceeds(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: serverTimestamp()
  }));
});

test("rooms: after any partial/failed join attempt, the attacker still cannot reach participant broad-write", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  // Шаг 1: неполная попытка (только players/dark) — уже DENY сама по себе.
  await assertFails(set(
    ref(databaseFor("bob"), "rooms/ROOM1/players/dark"),
    { id: "bob", name: "Bob" }
  ));
  // Шаг 2: раз players/dark не записался, bob не участник — broad
  // participant-ветка $room/.write ("unchanged players") его не пропустит.
  await assertFails(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    pieces: { a1: { color: "dark", king: true } },
    turn: "dark"
  }));
});

test("rooms: join bundled with a pieces change is denied entirely", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertFails(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: Date.now(),
    pieces: { a1: { color: "dark", king: true } }
  }));
});

test("rooms: join bundled with a turn change is denied entirely", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertFails(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: Date.now(),
    turn: "dark"
  }));
});

test("rooms: join bundled with a winner change is denied entirely", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertFails(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: Date.now(),
    winner: "dark"
  }));
});

test("rooms: join bundled with tampering the light player's own data is denied entirely", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertFails(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    "players/light/name": "Hacked",
    status: "active",
    turnStartedAt: Date.now()
  }));
});

test("rooms: two joiners racing for the same seat — the second cannot replace the first", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertSucceeds(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: Date.now()
  }));
  await assertFails(update(ref(databaseFor("carol"), "rooms/ROOM1"), {
    "players/dark": { id: "carol", name: "Carol" },
    status: "active",
    turnStartedAt: Date.now()
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const finalDark = await get(ref(context.database(), "rooms/ROOM1/players/dark"));
    assert.equal(finalDark.child("id").val(), "bob");
  });
});

test("rooms: a repeat by the same already-joined dark player succeeds as ordinary participant gameplay, not via the narrow join grant", async () => {
  // Найдено при разборе честного emulator-провала: bob уже реальный dark
  // участник этой комнаты. Его повтор с тем же (неизменным) players/dark +
  // тем же status=active + свежим turnStartedAt проходит НЕ через узкий
  // join-grant (players/dark/.write требует !data.exists(), значит для
  // повтора он честно отклоняет) — а через СОВЕРШЕННО ОТДЕЛЬНУЮ ветку
  // "$room/.write" — participant с неизменными players. turnStartedAt не
  // входит в защищённые/делегированные поля, поэтому участник волен его
  // обновлять как обычный игровой момент. Это не дыра: bob уже легитимно
  // владеет местом dark, здесь нечего эскалировать.
  await seed("rooms/ROOM1", room({ status: "active", dark: true }));
  await assertSucceeds(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: Date.now()
  }));
});

test("rooms: an outsider cannot use the idempotent-looking shape to fake participant status", async () => {
  // Контрастный тест: то же самое "повторное" players/dark+status от
  // ПОСТОРОННЕГО (carol, реально не dark) должно быть DENY — ни узкий
  // join-grant (dark занят, !data.exists() ложно), ни participant-ветка
  // (carol.uid не совпадает ни с light, ни с текущим dark) её не пропускают.
  await seed("rooms/ROOM1", room({ status: "active", dark: true }));
  await assertFails(update(ref(databaseFor("carol"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active",
    turnStartedAt: Date.now()
  }));
});

test("rooms: an outsider replacing an occupied dark seat is denied", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(
    ref(databaseFor("carol"), "rooms/ROOM1/players/dark"),
    { id: "carol", name: "Carol" }
  ));
});

test("rooms: an outsider cannot move pieces in someone else's active game", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(update(ref(databaseFor("mallory"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    turn: "dark"
  }));
});

test("rooms: a participant can move pieces even when a populated ratingsAtStart subtree is otherwise untouched", async () => {
  const withDelegated = room();
  withDelegated.ratingsAtStart = { light: 1000, dark: 1000 };
  await seed("rooms/ROOM1", withDelegated);
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    turn: "dark"
  }));
});

test("rooms: invalid turn values are denied", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("alice"), "rooms/ROOM1/turn"), "blue"));
});

test("rooms: an unauthenticated caller cannot delete a room", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(remove(ref(databaseFor(), "rooms/ROOM1")));
});

test("rooms: an outsider cannot delete a live room", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(remove(ref(databaseFor("mallory"), "rooms/ROOM1")));
});

test("rooms: a current participant can delete their own room", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(remove(ref(databaseFor("alice"), "rooms/ROOM1")));
});

test("rooms: the other participant can also delete their own room", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(remove(ref(databaseFor("bob"), "rooms/ROOM1")));
});

test("rooms: forging a seat then deleting as that forged identity is denied", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(
    ref(databaseFor("mallory"), "rooms/ROOM1/players/dark"),
    { id: "mallory", name: "Mallory" }
  ));
  await assertFails(remove(ref(databaseFor("mallory"), "rooms/ROOM1")));
});

test("rooms: a bot room can be created with the human as light", async () => {
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/BOTROOM"), {
    pieces: { b6: { color: "light", king: false } },
    turn: "light",
    status: "active",
    players: {
      light: { id: "alice", name: "Alice" },
      dark: { id: "bot", name: "Bot" }
    }
  }));
});

test("rooms: a bot room can be created with the human as dark", async () => {
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/BOTROOM"), {
    pieces: { b6: { color: "light", king: false } },
    turn: "light",
    status: "active",
    players: {
      light: { id: "bot", name: "Bot" },
      dark: { id: "alice", name: "Alice" }
    }
  }));
});

test("rooms: a rematch can swap the two existing participants' seats", async () => {
  await seed("rooms/ROOM1", room({ status: "finished" }));
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null
  }));
});

test("rooms: a legal rated rematch is allowed once the settlement receipt exists", async () => {
  const rated = room({ status: "finished" });
  rated.ratedMatchId = "elo_ROOM1_1700000000000_0";
  rated.matchNumber = 0;
  await seed("rooms/ROOM1", rated);
  await seed("eloMatches/elo_ROOM1_1700000000000_0", { settledBy: "worker" });
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    matchNumber: 1,
    ratingsAtStart: null
  }));
});

test("rooms: the same rated rematch is denied before the settlement receipt exists", async () => {
  const rated = room({ status: "finished" });
  rated.ratedMatchId = "elo_ROOM1_1700000000000_0";
  rated.matchNumber = 0;
  await seed("rooms/ROOM1", rated);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    matchNumber: 1,
    ratingsAtStart: null
  }));
});

test("rooms: a legacy (pre-#15) non-worker receipt does not authorize a rated rematch", async () => {
  // Worker сам не доверяет такой receipt (worker/index.mjs: "Under BRIDGE-A
  // a legacy receipt is not authoritative proof... ratingConfirmed: false") —
  // Rules обязаны требовать тот же маркер settledBy==='worker', а не голое
  // .exists(), иначе forged pre-#15 receipt даёт то же самое обход, что и
  // не проверять settlement вовсе.
  const rated = room({ status: "finished" });
  rated.ratedMatchId = "elo_ROOM1_1700000000000_0";
  rated.matchNumber = 0;
  await seed("rooms/ROOM1", rated);
  await seed("eloMatches/elo_ROOM1_1700000000000_0", { source: "legacy" });
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    matchNumber: 1,
    ratingsAtStart: null
  }));
});

test("rooms: an active rated room cannot swap seats and wipe the rating snapshot", async () => {
  const rated = room({ status: "active" });
  rated.ratedMatchId = "elo_ROOM1_1700000000000_0";
  rated.matchNumber = 0;
  rated.ratingsAtStart = { light: 1000, dark: 1000 };
  await seed("rooms/ROOM1", rated);
  await seed("eloMatches/elo_ROOM1_1700000000000_0", { settledBy: "worker" });
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    matchNumber: 1,
    ratingsAtStart: null
  }));
});

test("rooms: a non-rated active room also cannot swap seats mid-game (finished->active is universal, not just for rated)", async () => {
  await seed("rooms/ROOM1", room({ status: "active" }));
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice"
  }));
});

test("rooms: an outsider joining an active dark-absent room is denied", async () => {
  const active = room({ status: "waiting", dark: false });
  active.status = "active";
  await seed("rooms/ROOM1", active);
  await assertFails(update(ref(databaseFor("mallory"), "rooms/ROOM1"), {
    "players/dark": { id: "mallory", name: "Mallory" },
    status: "active"
  }));
});

test("rooms: a participant cannot smuggle a ratingsAtStart change into a gameplay update", async () => {
  const withSnapshot = room();
  withSnapshot.ratingsAtStart = { light: 1000, dark: 1000 };
  await seed("rooms/ROOM1", withSnapshot);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    "ratingsAtStart/light": 9999
  }));
});

test("rooms: a participant cannot add an unknown key under ratingsAtStart", async () => {
  const withSnapshot = room();
  withSnapshot.ratingsAtStart = { light: 1000, dark: 1000 };
  await seed("rooms/ROOM1", withSnapshot);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    "ratingsAtStart/extra": 1
  }));
});

test("rooms: an outsider still cannot write into the legacy spectators path", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(
    ref(databaseFor("mallory"), "rooms/ROOM1/spectators/carol"),
    "Carol"
  ));
});

test("rooms: a participant cannot create a new legacy spectator entry", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(
    ref(databaseFor("alice"), "rooms/ROOM1/spectators/carol"),
    "Carol"
  ));
});

test("rooms: a participant cannot modify an existing legacy spectator entry", async () => {
  const withLegacy = room();
  withLegacy.spectators = { carol: "Carol" };
  await seed("rooms/ROOM1", withLegacy);
  await assertFails(set(
    ref(databaseFor("alice"), "rooms/ROOM1/spectators/carol"),
    "Mallory"
  ));
});

test("rooms: a participant can delete an existing legacy spectator entry", async () => {
  const withLegacy = room();
  withLegacy.spectators = { carol: "Carol" };
  await seed("rooms/ROOM1", withLegacy);
  await assertSucceeds(remove(ref(databaseFor("alice"), "rooms/ROOM1/spectators/carol")));
});

test("rooms: a whole-room write carrying forward pre-existing legacy spectators data is not rejected", async () => {
  // Это ровно тот сценарий, который сломала бы spectators/.validate:false на
  // уровне узла целиком: whole-room transaction читает всю комнату, меняет
  // несколько полей и возвращает ОБЪЕКТ ЦЕЛИКОМ — включая старое значение
  // spectators БЕЗ ИЗМЕНЕНИЙ. Такой паттерн реально используется в script.js
  // (8 мест). Guard теперь стоит per-$uid и требует точного равенства
  // значения, а не запрещает узел целиком — carry-forward unchanged проходит.
  const withLegacy = room();
  withLegacy.spectators = { carol: "Carol" };
  await seed("rooms/ROOM1", withLegacy);
  const fullRoom = { ...withLegacy, turn: "dark" };
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/ROOM1"), fullRoom));
});

test("rooms: settlement identity can atomically publish ratedMatchId and ratingsAtStart", async () => {
  await seed("rooms/ROOM1", room());
  await seed("matchIndex/ROOM1", { matchId: "elo_ROOM1_0_0", createdAt: 1_700_000_000_000, lastMatchNumber: 0 });
  await assertSucceeds(update(ref(databaseFor("srv_settlement")), {
    "rooms/ROOM1/ratedMatchId": "elo_ROOM1_0_0",
    "rooms/ROOM1/ratingsAtStart/light": 1000,
    "rooms/ROOM1/ratingsAtStart/dark": 1000
  }));
});

test("rooms: settlement identity can replace the pointer with the next generation's canonical matchId after a legal rematch", async () => {
  // Точная последовательность: первая партия зарегистрирована (M0), rematch
  // легально прошёл (matchNumber 0->1, ratedMatchId НЕ тронут rematch'ем —
  // остаётся M0 на этом шаге), Worker регистрирует ВТОРУЮ партию и заменяет
  // pointer M0 -> M1 вместе с новым снимком рейтингов.
  const afterRematch = room({ status: "active" });
  afterRematch.ratedMatchId = "elo_ROOM1_1700000000000_0"; // M0, ещё не заменён
  afterRematch.matchNumber = 1;
  afterRematch.createdAt = 1_700_000_000_000;
  await seed("rooms/ROOM1", afterRematch);
  await seed("matchIndex/ROOM1", {
    matchId: "elo_ROOM1_1700000000000_1", // Worker уже обновил matchIndex до M1
    createdAt: 1_700_000_000_000,
    lastMatchNumber: 1
  });
  await assertSucceeds(update(ref(databaseFor("srv_settlement")), {
    "rooms/ROOM1/ratedMatchId": "elo_ROOM1_1700000000000_1",
    "rooms/ROOM1/ratingsAtStart/light": 1000,
    "rooms/ROOM1/ratingsAtStart/dark": 1000
  }));
});

test("rooms: an ordinary participant cannot replace an existing ratedMatchId pointer", async () => {
  const rated = room();
  rated.ratedMatchId = "elo_ROOM1_1700000000000_0";
  await seed("rooms/ROOM1", rated);
  await assertFails(set(
    ref(databaseFor("alice"), "rooms/ROOM1/ratedMatchId"),
    "elo_ROOM1_1700000000000_1"
  ));
});

test("rooms: settlement identity writing a non-canonical pointer is denied", async () => {
  const rated = room();
  rated.ratedMatchId = "elo_ROOM1_1700000000000_0";
  await seed("rooms/ROOM1", rated);
  await seed("matchIndex/ROOM1", {
    matchId: "elo_ROOM1_1700000000000_1",
    createdAt: 1_700_000_000_000,
    lastMatchNumber: 1
  });
  await assertFails(set(
    ref(databaseFor("srv_settlement"), "rooms/ROOM1/ratedMatchId"),
    "elo_SOME_OTHER_VALUE"
  ));
});

test("rooms: a full legal rematch cycle replaces the old pointer with the new one atomically", async () => {
  // Сквозной сценарий: (1) старая партия settled, (2) rematch проходит и
  // оставляет старый pointer нетронутым, (3) Worker атомарно заменяет
  // pointer и публикует новый снимок рейтингов для поколения 1.
  const rated = room({ status: "finished" });
  rated.ratedMatchId = "elo_ROOM1_1700000000000_0";
  rated.matchNumber = 0;
  rated.createdAt = 1_700_000_000_000;
  await seed("rooms/ROOM1", rated);
  await seed("eloMatches/elo_ROOM1_1700000000000_0", { settledBy: "worker" });

  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    matchNumber: 1,
    ratingsAtStart: null
  }));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const stillOldPointer = await get(ref(context.database(), "rooms/ROOM1/ratedMatchId"));
    assert.equal(stillOldPointer.val(), "elo_ROOM1_1700000000000_0");
  });

  await seed("matchIndex/ROOM1", {
    matchId: "elo_ROOM1_1700000000000_1",
    createdAt: 1_700_000_000_000,
    lastMatchNumber: 1
  });
  await assertSucceeds(update(ref(databaseFor("srv_settlement")), {
    "rooms/ROOM1/ratedMatchId": "elo_ROOM1_1700000000000_1",
    "rooms/ROOM1/ratingsAtStart/light": 1000,
    "rooms/ROOM1/ratingsAtStart/dark": 1000
  }));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const finalPointer = await get(ref(context.database(), "rooms/ROOM1/ratedMatchId"));
    assert.equal(finalPointer.val(), "elo_ROOM1_1700000000000_1");
    const snapshot = await get(ref(context.database(), "rooms/ROOM1/ratingsAtStart"));
    assert.deepStrictEqual(snapshot.val(), { light: 1000, dark: 1000 });
  });
});

test("roomSpectators: a spectator can create their own entry in a live room", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(set(
    ref(databaseFor("carol"), "roomSpectators/ROOM1/carol"),
    "Carol"
  ));
});

test("roomSpectators: cannot create an entry for someone else's room while it does not exist", async () => {
  await assertFails(set(
    ref(databaseFor("carol"), "roomSpectators/GHOST/carol"),
    "Carol"
  ));
});

test("roomSpectators: a participant cannot write another user's spectator entry", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(
    ref(databaseFor("alice"), "roomSpectators/ROOM1/carol"),
    "Carol"
  ));
});

test("roomSpectators: public read is allowed, so an ordinary player sees the spectator list", async () => {
  await seed("rooms/ROOM1", room());
  await seed("roomSpectators/ROOM1/carol", "Carol");
  await assertSucceeds(get(ref(databaseFor("alice"), "roomSpectators/ROOM1")));
});

test("roomSpectators: a spectator leaving removes only their own entry, siblings remain", async () => {
  await seed("rooms/ROOM1", room());
  await seed("roomSpectators/ROOM1/carol", "Carol");
  await seed("roomSpectators/ROOM1/dave", "Dave");
  await assertSucceeds(remove(ref(databaseFor("carol"), "roomSpectators/ROOM1/carol")));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const rest = await get(ref(context.database(), "roomSpectators/ROOM1"));
    assert.deepStrictEqual(rest.val(), { dave: "Dave" });
  });
});

test("roomSpectators: a spectator can delete their own orphaned entry after the room itself is gone", async () => {
  await seed("roomSpectators/ROOM1/carol", "Carol");
  await assertSucceeds(remove(ref(databaseFor("carol"), "roomSpectators/ROOM1/carol")));
});

test("roomSpectators: a bot-mirror owner sees the same authoritative list as any other room", async () => {
  await seed("rooms/BOTROOM", room());
  await seed("roomSpectators/BOTROOM/carol", "Carol");
  await assertSucceeds(get(ref(databaseFor("alice"), "roomSpectators/BOTROOM")));
});

test("roomSpectators: a rematch cannot bundle a write into someone else's spectator entry", async () => {
  const finished = room({ status: "finished" });
  await seed("rooms/ROOM1", finished);
  await seed("roomSpectators/ROOM1/carol", "Carol");
  await assertFails(update(ref(databaseFor("alice")), {
    "rooms/ROOM1/players/light/id": "bob",
    "rooms/ROOM1/players/light/name": "Bob",
    "rooms/ROOM1/players/dark/id": "alice",
    "rooms/ROOM1/players/dark/name": "Alice",
    "rooms/ROOM1/status": "active",
    "rooms/ROOM1/winner": null,
    "roomSpectators/ROOM1/carol": null
  }));
});

test("roomSpectators: spectators survive a bot rematch that reuses the same room code", async () => {
  await seed("rooms/BOTROOM", room({ status: "finished" }));
  await seed("roomSpectators/BOTROOM/carol", "Carol");
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/BOTROOM"), {
    pieces: { b6: { color: "light", king: false } },
    turn: "light",
    status: "active",
    winner: null
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const stillThere = await get(ref(context.database(), "roomSpectators/BOTROOM/carol"));
    assert.equal(stillThere.val(), "Carol");
  });
});

test("rooms: an outsider cannot write presence at all (#19)", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("mallory"), "rooms/ROOM1/presence/light"), {
    online: true,
    onlineSince: 1_700_000_000_000,
    lastSeen: 1_700_000_000_500
  }));
});

test("rooms: an outsider cannot smuggle a pieces change bundled with a presence write", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(update(ref(databaseFor("mallory"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    "presence/light": { online: true, onlineSince: 1_700_000_000_000, lastSeen: 1_700_000_000_500 }
  }));
});

test("rooms: a room missing pieces stays denied for an unrelated presence write", async () => {
  const malformed = room();
  delete malformed.pieces;
  await seed("rooms/ROOM1", malformed);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "presence/light": { online: true, onlineSince: 1_700_000_000_000, lastSeen: 1_700_000_000_500 }
  }));
});

test("rooms: a room missing pieces stays denied for an unrelated drawProposal write", async () => {
  const malformed = room();
  delete malformed.pieces;
  await seed("rooms/ROOM1", malformed);
  await assertFails(set(
    ref(databaseFor("alice"), "rooms/ROOM1/drawProposal"),
    { by: "light", name: "Alice" }
  ));
});

test("rooms: an invalid status value stays denied for an unrelated presence write", async () => {
  const malformed = room();
  malformed.status = "corrupted";
  await seed("rooms/ROOM1", malformed);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "presence/light": { online: true, onlineSince: 1_700_000_000_000, lastSeen: 1_700_000_000_500 }
  }));
});

test("rooms: a malformed players shape stays denied for an unrelated presence write", async () => {
  const malformed = room();
  malformed.players = { light: { id: "alice" } };
  await seed("rooms/ROOM1", malformed);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "presence/light": { online: true, onlineSince: 1_700_000_000_000, lastSeen: 1_700_000_000_500 }
  }));
});

test("cleanup: an outsider cannot multi-location delete someone else's room", async () => {
  await seed("rooms/ROOM1", room());
  await seed("users/alice/rooms/ROOM1", { status: "active" });
  await assertFails(update(ref(databaseFor("mallory")), {
    "rooms/ROOM1": null,
    "users/alice/rooms/ROOM1": null
  }));
});


test("presence: a player can publish their own presence", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    online: true,
    onlineSince: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000
  }));
});

test("presence: a player cannot write the other color's presence", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/dark"), {
    online: false,
    absentSince: 1_700_000_000_000
  }));
});

test("presence: the opponent (not an outsider, but the OTHER real participant) cannot write my presence", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("bob"), "rooms/ROOM1/presence/light"), {
    online: false,
    absentSince: 1_700_000_000_000
  }));
});

test("presence: a spectator cannot write either color's presence", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("carol"), "rooms/ROOM1/presence/light"), {
    online: true,
    lastSeen: 1_700_000_000_000
  }));
});

test("presence: own presence bundled with the other color's presence in one request is denied entirely (human room)", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "presence/light": { online: true, lastSeen: 1_700_000_000_000 },
    "presence/dark": { online: false, absentSince: 1_700_000_000_000 }
  }));
});

test("presence: own heartbeat (lastSeen only, partial update) is allowed", async () => {
  await seed("rooms/ROOM1", room({
    presence: { light: { online: true, onlineSince: 1_700_000_000_000, lastSeen: 1_700_000_000_000 } }
  }));
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    lastSeen: 1_700_000_000_500
  }));
});

test("presence: hidden (going offline, partial update without onlineSince) is allowed", async () => {
  await seed("rooms/ROOM1", room({
    presence: { light: { online: true, onlineSince: 1_700_000_000_000, lastSeen: 1_700_000_000_000 } }
  }));
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    online: false,
    absentSince: 1_700_000_000_500,
    lastSeen: 1_700_000_000_500
  }));
});

test("presence: reconnect (full 4-field refresh) is allowed", async () => {
  await seed("rooms/ROOM1", room({
    presence: { light: { online: false, absentSince: 1_700_000_000_000 } }
  }));
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    online: true,
    absentSince: null,
    onlineSince: 1_700_000_000_600,
    lastSeen: 1_700_000_000_600
  }));
});

test("presence: onDisconnect-shaped partial write (online:false + absentSince only) is allowed", async () => {
  // ГРАНИЦА ТЕСТА: @firebase/rules-unit-testing проверяет только Rules-
  // оценку для данного payload+auth, не реальный SDK-механизм разрыва
  // соединения. Этот тест доказывает, что ПРАВИЛА пропускают payload формы
  // onDisconnect ("online:false, absentSince" — 2 поля) от auth'а,
  // зарегистрировавшего его, — НЕ то, что настоящий обрыв соединения
  // сработает end-to-end (это свойство самого Firebase SDK, официально
  // документированное как использующее auth регистрирующего клиента, а не
  // то, что можно проверить этим harness'ом).
  await seed("rooms/ROOM1", room({
    presence: { light: { online: true, onlineSince: 1_700_000_000_000, lastSeen: 1_700_000_000_000 } }
  }));
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    online: false,
    absentSince: 1_700_000_000_500
  }));
});

test("presence: an unknown field on a presence write is denied", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    somethingElse: true
  }));
});

test("presence: normal waiting-room creation has no presence at all (createOnlineRoom path)", async () => {
  const initialState = room({ status: "waiting", dark: false });
  delete initialState.presence;
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/ROOM1"), initialState));
});

test("presence: production friend-invite create with initial presence.light and no presence.dark is allowed (createRoomAndShowWaiting path)", async () => {
  // Найдено на независимой проверке: createRoomAndShowWaiting() реально
  // создаёт комнату ОДНИМ set() с presence.light уже внутри (не отдельным
  // запросом, как createOnlineRoom) -- это ВТОРАЯ легитимная форма normal
  // create, а не синтетическое удобство теста.
  const initialState = room({ status: "waiting", dark: false });
  initialState.presence = { light: { online: true, lastSeen: 1_700_000_000_000 } };
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/ROOM1"), initialState));
});

test("presence: a fake dark presence smuggled into a normal create is denied", async () => {
  const initialState = room({ status: "waiting", dark: false });
  initialState.presence = { dark: { online: false, absentSince: 1 } };
  await assertFails(set(ref(databaseFor("alice"), "rooms/GHOST"), initialState));
});

test("presence: after a rematch swap, the new dark (former light) can publish presence for their new color", async () => {
  await seed("rooms/ROOM1", room({ status: "finished" }));
  await update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null
  });
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/dark"), {
    online: true,
    onlineSince: 1_700_000_000_700,
    lastSeen: 1_700_000_000_700
  }));
});

test("presence: after a rematch swap, writing the OLD color as the new identity is denied", async () => {
  await seed("rooms/ROOM1", room({ status: "finished" }));
  await update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null
  });
  await assertFails(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    online: true,
    lastSeen: 1_700_000_000_700
  }));
});

test("presence: a rematch write cannot bundle a presence change in the same request", async () => {
  const finished = room({ status: "finished" });
  finished.presence = { light: { online: true, lastSeen: 1_700_000_000_000 } };
  await seed("rooms/ROOM1", finished);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    "presence/light": { online: false, lastSeen: 1_700_000_000_999 }
  }));
});

test("presence: a genuine bot-mirror rematch (exact seat swap + gameplay + presence refresh for both colors) is allowed", async () => {
  // Найдено на независимой проверке: applyRematchViaSession() реально
  // меняет botColor местами, и последующий mirrorCommittedStateToSpectateRoom()
  // одним room-level update меняет players (точный swap human<->bot),
  // переводит finished->active, обновляет gameplay И освежает presence
  // ОБОИХ цветов новыми ServerValue.TIMESTAMP -- всё в одном запросе.
  const botFinished = room({ status: "finished" });
  botFinished.players = { light: { id: "alice", name: "Alice" }, dark: { id: "bot", name: "Bot" } };
  botFinished.presence = {
    light: { online: true, lastSeen: 1_700_000_000_000 },
    dark: { online: true, lastSeen: 1_700_000_000_000 }
  };
  await seed("rooms/ROOM1", botFinished);
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bot",
    "players/light/name": "Bot",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    pieces: { b6: { color: "light", king: false } },
    turn: "light",
    presence: {
      light: { online: true, lastSeen: 1_700_000_000_900 },
      dark: { online: true, lastSeen: 1_700_000_000_900 }
    }
  }));
});

test("presence: an outsider (not part of an existing bot pairing) cannot exploit the bot-rematch exception even with a correctly-shaped swap payload", async () => {
  // Уточнение после независимой проверки собственной первой версии этого
  // теста: swap-условие ("newData.light.id===data.dark.id" и наоборот)
  // физически не даёт подставить произвольный НОВЫЙ id вроде 'bot' в уже
  // человеческую пару -- сам swap развалился бы первым. Реально
  // достижимая граница другая: в НАСТОЯЩЕЙ bot-комнате caller обязан быть
  // тем самым human-owner'ом (auth.uid совпадает с ОДНИМ из старых seats);
  // посторонний carol, даже зная точную легитимную форму swap+presence,
  // не проходит именно по этому условию.
  const botFinished = room({ status: "finished" });
  botFinished.players = { light: { id: "alice", name: "Alice" }, dark: { id: "bot", name: "Bot" } };
  botFinished.presence = {
    light: { online: true, lastSeen: 1_700_000_000_000 },
    dark: { online: true, lastSeen: 1_700_000_000_000 }
  };
  await seed("rooms/ROOM1", botFinished);
  await assertFails(update(ref(databaseFor("carol"), "rooms/ROOM1"), {
    "players/light/id": "bot",
    "players/light/name": "Bot",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    presence: {
      light: { online: true, lastSeen: 1_700_000_000_900 },
      dark: { online: true, lastSeen: 1_700_000_000_900 }
    }
  }));
});

test("rooms: a bot room can be created with no presence in the initial payload", async () => {
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/BOTROOM"), {
    pieces: { b6: { color: "light", king: false } },
    turn: "light",
    status: "active",
    players: {
      light: { id: "alice", name: "Alice" },
      dark: { id: "bot", name: "Bot" }
    }
  }));
});

test("rooms: production bot-create/resurrection with presence for both colors is allowed (startBotSpectateRoom / stale-sweep resurrection path)", async () => {
  // Найдено на независимой проверке: startBotSpectateRoom() и resurrection
  // через onOwnerSessionUpdate()->mirrorCommittedStateToSpectateRoom()
  // (когда lobby stale-sweep удалил комнату, пока владелец был offline)
  // реально пишут presence ОБОИХ цветов ВНУТРИ initial payload через
  // update(), не отдельным запросом.
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/BOTROOM2"), {
    pieces: { b6: { color: "light", king: false } },
    turn: "light",
    status: "active",
    players: {
      light: { id: "alice", name: "Alice" },
      dark: { id: "bot", name: "Bot" }
    },
    presence: {
      light: { online: true, lastSeen: 1_700_000_000_000 },
      dark: { online: true, lastSeen: 1_700_000_000_000 }
    }
  }));
});

test("bot-mirror: owner heartbeat updating both colors' presence in one request is allowed", async () => {
  const botRoom = room({ status: "active" });
  botRoom.players = { light: { id: "alice", name: "Alice" }, dark: { id: "bot", name: "Bot" } };
  await seed("rooms/ROOM1", botRoom);
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1/presence"), {
    light: { online: true, lastSeen: 1_700_000_000_500 },
    dark: { online: true, lastSeen: 1_700_000_000_500 }
  }));
});

test("bot-mirror: a per-move gameplay update can legitimately bundle a presence refresh for both colors", async () => {
  const botRoom = room({ status: "active" });
  botRoom.players = { light: { id: "alice", name: "Alice" }, dark: { id: "bot", name: "Bot" } };
  await seed("rooms/ROOM1", botRoom);
  await assertSucceeds(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    turn: "dark",
    "presence/light": { online: true, lastSeen: 1_700_000_000_500 },
    "presence/dark": { online: true, lastSeen: 1_700_000_000_500 }
  }));
});

test("bot-mirror: the bot exception is unreachable in a genuine human-vs-human room", async () => {
  // Ни при create, ни при join ни один из players/*/id никогда не может
  // стать литералом "bot" в человеческой комнате (проверено по коду:
  // normal-create/join грант требуют newData id === auth.uid). Здесь
  // явно проверяем, что даже ЕСЛИ бы кто-то попытался это подделать
  // (искусственно засеянная комната), обычный человек не получает через
  // это доступ к чужому presence -- он не является ни auth.uid дальней
  // стороны, ни легитимным "владельцем bot-пары".
  const fake = room();
  fake.players.dark = { id: "bot", name: "Bot" }; // искусственно, не через настоящий runtime
  await seed("rooms/ROOM1", fake);
  await assertFails(set(ref(databaseFor("mallory"), "rooms/ROOM1/presence/dark"), {
    online: true,
    lastSeen: 1_700_000_000_500
  }));
});

test("rooms: a participant can still delete their own room after presence lockdown", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(remove(ref(databaseFor("alice"), "rooms/ROOM1")));
});

test("presence: attempting to delete a presence node (set to null) is denied", async () => {
  await seed("rooms/ROOM1", room({
    presence: { light: { online: true, lastSeen: 1_700_000_000_000 } }
  }));
  await assertFails(remove(ref(databaseFor("alice"), "rooms/ROOM1/presence/light")));
});

test("presence: smuggling an unknown color node ('presence/evil') through an otherwise-legitimate gameplay update is denied", async () => {
  // Найдено на независимой проверке: без presence/$other:false участник
  // мог бы добавить совершенно новый sibling-узел под presence, никак не
  // задевая восемь сравниваемых light/dark scalar-полей -- ancestor-freeze
  // их не видит, потому что не про них.
  await seed("rooms/ROOM1", room());
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    "presence/evil": { foo: "bar" }
  }));
});

test("presence: a bare scalar value instead of an object at presence/light is denied", async () => {
  // Найдено на независимой проверке: старый .validate проверял только
  // "если поле online/absentSince/... существует -- тип верный", поэтому
  // presence/light=true проходил (ни одно known-поле не .exists() на
  // скаляре, все optional-проверки становятся вакуально true).
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), true));
});

test("presence: an object missing the mandatory 'online' field is denied", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    lastSeen: 1_700_000_000_000
  }));
});

test("presence: a scalar 'presence: true' smuggled through an otherwise-legitimate gameplay update on a presence-less room is denied", async () => {
  // Найдено на независимой проверке: ни один из восьми сравниваемых
  // light/dark scalar-полей, ни existence-проверка на них не отличают
  // "presence отсутствует" от "presence существует как посторонний
  // скаляр" -- оба случая дают null/false по всем восьми путям.
  // "$other:false" тоже не защищает: он матчит ДОЧЕРНИЕ ключи, а у скаляра
  // детей нет вовсе (подтверждено официальной документацией Firebase:
  // $other описан именно как "no other CHILD paths").
  const initialState = room({ status: "waiting", dark: false });
  delete initialState.presence;
  await seed("rooms/ROOM1", initialState);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    presence: true
  }));
});

test("presence: a string value at 'presence' is also denied", async () => {
  const initialState = room({ status: "waiting", dark: false });
  delete initialState.presence;
  await seed("rooms/ROOM1", initialState);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    presence: "online"
  }));
});

test("presence: normal presence/light creation still succeeds after starting from a presence-less room", async () => {
  const initialState = room({ status: "waiting", dark: false });
  delete initialState.presence;
  await seed("rooms/ROOM1", initialState);
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    online: true,
    onlineSince: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000
  }));
});

test("presence: a bot-room owner cannot delete either color's presence via the ancestor bot-exception", async () => {
  // Найдено на независимой проверке: bot-exception в unchanged-participant
  // ветке разрешала "presence unchanged || room содержит bot" -- ancestor
  // allow каскадно перекрывал child ".write" (newData.exists()), потому
  // что validate не выполняется на delete. Exception теперь ДОПОЛНИТЕЛЬНО
  // требует newData.child('presence/light').exists() &&
  // newData.child('presence/dark').exists(), что production bot-mirror
  // всегда и так пишет (оба узла как объекты, никогда null).
  const botRoom = room({ status: "active" });
  botRoom.players = { light: { id: "alice", name: "Alice" }, dark: { id: "bot", name: "Bot" } };
  botRoom.presence = {
    light: { online: true, lastSeen: 1_700_000_000_000 },
    dark: { online: true, lastSeen: 1_700_000_000_000 }
  };
  await seed("rooms/ROOM1", botRoom);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    "presence/light": null
  }));
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const stillThere = await get(ref(context.database(), "rooms/ROOM1/presence/light"));
    assert.equal(stillThere.exists(), true);
  });
});

test("technical result: an outsider cannot claim a disconnect result for someone else's game", async () => {
  const now = Date.now();
  await seed("rooms/ROOM1", room({
    presence: {
      light: { online: true, onlineSince: now - 70_000 },
      dark: { online: false, absentSince: now - 70_000 }
    }
  }));

  await assertFails(update(ref(databaseFor("mallory"), "rooms/ROOM1"), {
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
      decidedAt: now - 1_000
    }
  }));
});


test("technical result: an early disconnect claim is denied", async () => {
  const now = Date.now();
  await seed("rooms/ROOM1", room({
    presence: {
      light: { online: true, onlineSince: now - 30_000 },
      dark: { online: false, absentSince: now - 30_000 }
    }
  }));

  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
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
      decidedAt: now - 1_000
    }
  }));
});

test("technical result: spoofed participant attribution is denied", async () => {
  const now = Date.now();
  await seed("rooms/ROOM1", room({
    presence: {
      light: { online: true, onlineSince: now - 70_000 },
      dark: { online: false, absentSince: now - 70_000 }
    }
  }));

  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    status: "finished",
    winner: "light",
    winReason: "disconnect",
    result: {
      winnerColor: "light",
      loserColor: "dark",
      winnerId: "mallory",
      loserId: "bob",
      winReason: "disconnect",
      status: "finished",
      decidedAt: now - 1_000
    }
  }));
});

test("technical result: an existing result is immutable", async () => {
  const decidedAt = Date.now() - 1_000;
  const finished = room({
    status: "finished",
    presence: {
      light: { online: true, onlineSince: decidedAt - 70_000 },
      dark: { online: false, absentSince: decidedAt - 70_000 }
    }
  });
  finished.winner = "light";
  finished.winReason = "disconnect";
  finished.result = {
    winnerColor: "light",
    loserColor: "dark",
    winnerId: "alice",
    loserId: "bob",
    winReason: "disconnect",
    status: "finished",
    decidedAt
  };
  await seed("rooms/ROOM1", finished);

  await assertFails(set(
    ref(databaseFor("mallory"), "rooms/ROOM1/result/winnerId"),
    "mallory"
  ));
});

test("draw: proposal creation and removal are allowed", async () => {
  await seed("rooms/ROOM1", room());
  const proposal = ref(databaseFor("alice"), "rooms/ROOM1/drawProposal");
  await assertSucceeds(set(proposal, { by: "light", name: "Alice" }));
  await assertSucceeds(remove(ref(databaseFor("bob"), "rooms/ROOM1/drawProposal")));
});

test("draw: an agreed draw transition is allowed", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    status: "finished",
    winner: "draw",
    winReason: "agreement",
    drawProposal: null
  }));
});

test("rematch and reaction fields are writable", async () => {
  await seed("rooms/ROOM1", room());
  const db = databaseFor("alice");
  await assertSucceeds(set(
    ref(db, "rooms/ROOM1/rematchProposal"),
    { by: "light", name: "Alice" }
  ));
  await assertSucceeds(set(
    ref(db, "rooms/ROOM1/reaction"),
    { by: "light", emoji: "👍", at: 1 }
  ));
});

test("users: owner reads own users subtree", async () => {
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  const snap = await assertSucceeds(get(ref(databaseFor("alice"), "users/alice")));
  assert.equal(snap.child("rooms/ROOM01/myColor").val(), "light");
});

test("users: foreign user root read is denied", async () => {
  await seed("users/bob/rooms/ROOM01", { opponentName: "Alice", myColor: "dark" });
  await assertFails(get(ref(databaseFor("alice"), "users/bob")));
});

test("users: unauthenticated root read is denied", async () => {
  await assertFails(get(ref(databaseFor(), "users")));
});

test("users rooms: owner can create legal own room index", async () => {
  await seed("rooms/ROOM01", room());
  await assertSucceeds(set(
    ref(databaseFor("alice"), "users/alice/rooms/ROOM01"),
    { opponentName: "Bob", myColor: "light" }
  ));
});

test("users rooms: owner can delete own room index", async () => {
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  await assertSucceeds(remove(ref(databaseFor("alice"), "users/alice/rooms/ROOM01")));
});

test("users rooms: real dark joiner can create canonical creator metadata", async () => {
  await seed("rooms/ROOM01", room());
  await assertSucceeds(set(
    ref(databaseFor("bob"), "users/alice/rooms/ROOM01"),
    { opponentName: "Bob", myColor: "light" }
  ));
});

test("users rooms: real dark joiner can update canonical creator metadata", async () => {
  await seed("rooms/ROOM01", room());
  await seed("users/alice/rooms/ROOM01", { opponentName: "Waiting", myColor: "light" });
  await assertSucceeds(update(
    ref(databaseFor("bob"), "users/alice/rooms/ROOM01"),
    { opponentName: "Bob" }
  ));
});

test("users rooms: foreign arbitrary create is denied", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(
    ref(databaseFor("charlie"), "users/alice/rooms/ROOM01"),
    { opponentName: "Charlie", myColor: "light" }
  ));
});

test("users rooms: joiner cannot spoof creator opponentName", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(
    ref(databaseFor("bob"), "users/alice/rooms/ROOM01"),
    { opponentName: "Mallory", myColor: "light" }
  ));
});

test("users rooms: joiner cannot write creator metadata with wrong myColor", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(
    ref(databaseFor("bob"), "users/alice/rooms/ROOM01"),
    { opponentName: "Bob", myColor: "dark" }
  ));
});

test("users rooms: foreign arbitrary update is denied", async () => {
  await seed("rooms/ROOM01", room());
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  await assertFails(update(
    ref(databaseFor("charlie"), "users/alice/rooms/ROOM01"),
    { opponentName: "Charlie" }
  ));
});

test("users rooms: foreign arbitrary delete is denied", async () => {
  await seed("rooms/ROOM01", room());
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  await assertFails(remove(ref(databaseFor("charlie"), "users/alice/rooms/ROOM01")));
});

test("users rooms: finished participant can delete opponent room index", async () => {
  await seed("rooms/ROOM01", room({ status: "finished" }));
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  await assertSucceeds(remove(ref(databaseFor("bob"), "users/alice/rooms/ROOM01")));
});

test("users rooms: finished outsider cannot delete player room index", async () => {
  await seed("rooms/ROOM01", room({ status: "finished" }));
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  await assertFails(remove(ref(databaseFor("charlie"), "users/alice/rooms/ROOM01")));
});

test("users rooms: bystander can clean proven stale waiting owner index", async () => {
  const old = Date.now() - 120000;
  await seed("rooms/ROOM01", room({
    status: "waiting",
    dark: false,
    presence: { light: { online: true, lastSeen: old } }
  }));
  await seed("users/alice/rooms/ROOM01", { opponentName: "Waiting", myColor: "light" });
  await assertSucceeds(remove(ref(databaseFor("charlie"), "users/alice/rooms/ROOM01")));
});

test("users rooms: missing waiting presence is not cleanup proof", async () => {
  await seed("rooms/ROOM01", room({ status: "waiting", dark: false }));
  await seed("users/alice/rooms/ROOM01", { opponentName: "Waiting", myColor: "light" });
  await assertFails(remove(ref(databaseFor("charlie"), "users/alice/rooms/ROOM01")));
});

test("users rooms: fresh waiting lastSeen is not cleanup proof", async () => {
  await seed("rooms/ROOM01", room({
    status: "waiting",
    dark: false,
    presence: { light: { online: true, lastSeen: Date.now() } }
  }));
  await seed("users/alice/rooms/ROOM01", { opponentName: "Waiting", myColor: "light" });
  await assertFails(remove(ref(databaseFor("charlie"), "users/alice/rooms/ROOM01")));
});

test("users rooms: bystander can clean active room when both lastSeen timestamps are stale", async () => {
  const old = Date.now() - 120000;
  await seed("rooms/ROOM01", room({
    presence: {
      light: { online: true, lastSeen: old },
      dark: { online: true, lastSeen: old }
    }
  }));
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  await assertSucceeds(remove(ref(databaseFor("charlie"), "users/alice/rooms/ROOM01")));
});

test("users rooms: bystander can clean active room via both stale absentSince timestamps", async () => {
  const old = Date.now() - 120000;
  const fresh = Date.now();
  await seed("rooms/ROOM01", room({
    presence: {
      light: { online: false, absentSince: old, lastSeen: fresh },
      dark: { online: false, absentSince: old, lastSeen: fresh }
    }
  }));
  await seed("users/bob/rooms/ROOM01", { opponentName: "Alice", myColor: "dark" });
  await assertSucceeds(remove(ref(databaseFor("charlie"), "users/bob/rooms/ROOM01")));
});

test("users rooms: one fresh active player blocks bystander cleanup", async () => {
  const old = Date.now() - 120000;
  await seed("rooms/ROOM01", room({
    presence: {
      light: { online: true, lastSeen: old },
      dark: { online: true, lastSeen: Date.now() }
    }
  }));
  await seed("users/alice/rooms/ROOM01", { opponentName: "Bob", myColor: "light" });
  await assertFails(remove(ref(databaseFor("charlie"), "users/alice/rooms/ROOM01")));
});

test("users rooms: stale proof cannot delete an index for a non-player target", async () => {
  const old = Date.now() - 120000;
  await seed("rooms/ROOM01", room({
    presence: {
      light: { online: true, lastSeen: old },
      dark: { online: true, lastSeen: old }
    }
  }));
  await seed("users/charlie/rooms/ROOM01", { opponentName: "Nobody", myColor: "light" });
  await assertFails(remove(ref(databaseFor("dave"), "users/charlie/rooms/ROOM01")));
});

test("users rooms: malformed room code is denied", async () => {
  await seed("rooms/SHORT", room());
  await assertFails(set(
    ref(databaseFor("alice"), "users/alice/rooms/SHORT"),
    { opponentName: "Bob", myColor: "light" }
  ));
});

test("users rooms: extra field is denied", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(
    ref(databaseFor("alice"), "users/alice/rooms/ROOM01"),
    { opponentName: "Bob", myColor: "light", admin: true }
  ));
});

test("users rooms: nested opponentName object is denied", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(
    ref(databaseFor("alice"), "users/alice/rooms/ROOM01"),
    { opponentName: { text: "Bob" }, myColor: "light" }
  ));
});

test("users rooms: long opponentName is denied", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(
    ref(databaseFor("alice"), "users/alice/rooms/ROOM01"),
    { opponentName: "x".repeat(50), myColor: "light" }
  ));
});

test("users rooms: invalid myColor is denied", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(
    ref(databaseFor("alice"), "users/alice/rooms/ROOM01"),
    { opponentName: "Bob", myColor: "blue" }
  ));
});

test("users rooms: scalar instead of object is denied", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(ref(databaseFor("alice"), "users/alice/rooms/ROOM01"), "ROOM01"));
});

test("users: owner arbitrary child is denied", async () => {
  await assertFails(set(ref(databaseFor("alice"), "users/alice/admin"), true));
});

test("users: no broad ancestor write permits whole-user replacement", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(ref(databaseFor("alice"), "users/alice"), {
    rooms: {
      ROOM01: { opponentName: "Bob", myColor: "light" }
    },
    admin: true
  }));
});

test("users activeMatch: real dark joiner can set creator activeMatch", async () => {
  await seed("rooms/ROOM01", room());
  await assertSucceeds(set(ref(databaseFor("bob"), "users/alice/activeMatch"), "ROOM01"));
});

test("users activeMatch: fake joiner is denied", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(ref(databaseFor("charlie"), "users/alice/activeMatch"), "ROOM01"));
});

test("users activeMatch: real joiner cannot redirect to another room", async () => {
  const other = room();
  other.players.dark = { id: "charlie", name: "Charlie" };
  await seed("rooms/ROOM02", other);
  await assertFails(set(ref(databaseFor("bob"), "users/alice/activeMatch"), "ROOM02"));
});

test("users activeMatch: outsider cannot target another uid", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(ref(databaseFor("bob"), "users/charlie/activeMatch"), "ROOM01"));
});

test("users activeMatch: waiting room cannot authorize cross-user set", async () => {
  await seed("rooms/ROOM01", room({ status: "waiting", dark: false }));
  await assertFails(set(ref(databaseFor("bob"), "users/alice/activeMatch"), "ROOM01"));
});

test("users activeMatch: owner can remove own activeMatch", async () => {
  await seed("users/alice/activeMatch", "ROOM01");
  await assertSucceeds(remove(ref(databaseFor("alice"), "users/alice/activeMatch")));
});

test("users activeMatch: cross-user deletion is denied", async () => {
  await seed("users/alice/activeMatch", "ROOM01");
  await assertFails(remove(ref(databaseFor("bob"), "users/alice/activeMatch")));
});

test("users activeMatch: owner cannot arbitrarily set own activeMatch", async () => {
  await seed("rooms/ROOM01", room());
  await assertFails(set(ref(databaseFor("alice"), "users/alice/activeMatch"), "ROOM01"));
});

test("botSessions: owner can read own node", async () => {
  await seed("botSessions/alice", botSession());
  await assertSucceeds(get(ref(databaseFor("alice"), "botSessions/alice")));
});

test("botSessions: authenticated cross-user read is denied", async () => {
  await seed("botSessions/bob", botSession());
  await assertFails(get(ref(databaseFor("alice"), "botSessions/bob")));
});

test("botSessions: unauthenticated read is denied", async () => {
  await seed("botSessions/alice", botSession());
  await assertFails(get(ref(databaseFor(), "botSessions/alice")));
});

test("botSessions: owner can create own node", async () => {
  await assertSucceeds(set(
    ref(databaseFor("alice"), "botSessions/alice"),
    botSession()
  ));
});

test("botSessions: owner can update own node", async () => {
  await seed("botSessions/alice", botSession());
  await assertSucceeds(update(ref(databaseFor("alice"), "botSessions/alice"), {
    revision: 1,
    updatedAt: 1_700_000_000_001
  }));
});

test("botSessions: authenticated cross-user write is denied", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "botSessions/bob"),
    botSession()
  ));
});

test("botSessions: unauthenticated write is denied", async () => {
  await assertFails(set(ref(databaseFor(), "botSessions/alice"), botSession()));
});

test("botSessions: equal player and bot colors are denied for owner", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "botSessions/alice"),
    botSession({ botColor: "light", myColor: "light" })
  ));
});

test("botSessions: unknown fields are denied for owner", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "botSessions/alice"),
    botSession({ admin: true })
  ));
});

test("botSessions: malformed state is denied for owner", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "botSessions/alice"),
    botSession({ state: { turn: "light" } })
  ));
});

test("botSessions: owner deletion is denied", async () => {
  await seed("botSessions/alice", botSession());
  await assertFails(remove(ref(databaseFor("alice"), "botSessions/alice")));
});

test("economy: unauthenticated user-node read is denied", async () => {
  await seed("economy/alice", economy());
  await assertFails(get(ref(databaseFor(), "economy/alice")));
});

test("economy: authenticated user-node read is denied", async () => {
  await seed("economy/alice", economy());
  await assertFails(get(ref(databaseFor("alice"), "economy/alice")));
});

test("economy: former top-ten leaderboard query is denied", async () => {
  await seed("economy/alice", economy());
  const leaderboard = query(
    ref(databaseFor(), "economy"),
    orderByChild("lifetimeEarned"),
    limitToLast(10)
  );
  await assertFails(get(leaderboard));
});

test("economy: owner create is denied", async () => {
  await assertFails(set(ref(databaseFor("alice"), "economy/alice"), economy()));
});

test("economy: cross-user write is denied", async () => {
  await assertFails(set(ref(databaseFor("alice"), "economy/bob"), economy()));
});

test("economy: unauthenticated write is denied", async () => {
  await assertFails(set(ref(databaseFor(), "economy/alice"), economy()));
});

test("economy: owner update is denied", async () => {
  await seed("economy/alice", economy());
  await assertFails(update(ref(databaseFor("alice"), "economy/alice"), { balance: 11 }));
});

test("economy: owner deletion is denied and seeded data is preserved", async () => {
  const original = economy();
  await seed("economy/alice", original);
  await assertFails(remove(ref(databaseFor("alice"), "economy/alice")));

  await testEnv.withSecurityRulesDisabled(async (context) => {
    const snapshot = await get(ref(context.database(), "economy/alice"));
    if (!snapshot.exists()) throw new Error("seeded economy data was removed");
    assert.deepStrictEqual(snapshot.val(), original);
  });
});

test("matchmakingQueue: public read is allowed", async () => {
  await assertSucceeds(get(ref(databaseFor(), "matchmakingQueue")));
});

test("matchmakingQueue: BRIDGE-A allows cross-user writes", async () => {
  await assertSucceeds(set(
    ref(databaseFor("alice"), "matchmakingQueue/bob"),
    queueEntry()
  ));
});

test("matchmakingQueue: oversized room codes are denied", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "matchmakingQueue/alice"),
    queueEntry({ roomCode: "TOO-LONG-ROOM" })
  ));
});

test("matchmakingQueue: cross-user cleanup is allowed", async () => {
  await seed("matchmakingQueue/bob", queueEntry());
  await assertSucceeds(remove(ref(databaseFor("alice"), "matchmakingQueue/bob")));
});

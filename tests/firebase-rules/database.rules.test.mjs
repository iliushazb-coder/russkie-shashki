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

test("rooms: a dark player can join a waiting room", async () => {
  await seed("rooms/ROOM1", room({ status: "waiting", dark: false }));
  await assertSucceeds(update(ref(databaseFor("bob"), "rooms/ROOM1"), {
    "players/dark": { id: "bob", name: "Bob" },
    status: "active"
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

test("rooms: a participant can move pieces even when a populated ratingsAtStart and spectators subtree is otherwise untouched", async () => {
  const withDelegated = room();
  withDelegated.ratingsAtStart = { light: 1000, dark: 1000 };
  withDelegated.spectators = { victim: "Victim", keep: "Keep" };
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

test("rooms: a participant cannot smuggle a foreign spectator removal into a gameplay update, even alongside an untouched sibling spectator", async () => {
  const withSpectators = room();
  withSpectators.spectators = { victim: "Victim", keep: "Keep" };
  await seed("rooms/ROOM1", withSpectators);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    "spectators/victim": null
  }));
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

test("rooms: a spectator can write their own spectator entry", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(set(
    ref(databaseFor("carol"), "rooms/ROOM1/spectators/carol"),
    "Carol"
  ));
});

test("rooms: a participant cannot write another user's spectator entry", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(
    ref(databaseFor("alice"), "rooms/ROOM1/spectators/carol"),
    "Carol"
  ));
});

test("rooms: an outsider can still write presence (deferred to #19)", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(set(ref(databaseFor("mallory"), "rooms/ROOM1/presence/light"), {
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

test("rooms: a rematch cannot bundle a foreign spectator deletion, even alongside an untouched sibling spectator", async () => {
  const finished = room({ status: "finished" });
  finished.spectators = { victim: "Victim", keep: "Keep" };
  await seed("rooms/ROOM1", finished);
  await assertFails(update(ref(databaseFor("alice"), "rooms/ROOM1"), {
    "players/light/id": "bob",
    "players/light/name": "Bob",
    "players/dark/id": "alice",
    "players/dark/name": "Alice",
    status: "active",
    winner: null,
    "spectators/victim": null
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


test("presence: a player can publish presence", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(set(ref(databaseFor("alice"), "rooms/ROOM1/presence/light"), {
    online: true,
    onlineSince: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000
  }));
});

test("presence: BRIDGE-A allows an outsider to overwrite another player's presence", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(set(ref(databaseFor("mallory"), "rooms/ROOM1/presence/light"), {
    online: false,
    absentSince: 1
  }));
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

test("users: public read is allowed", async () => {
  await assertSucceeds(get(ref(databaseFor(), "users")));
});

test("users: BRIDGE-A allows cross-user writes", async () => {
  await assertSucceeds(set(
    ref(databaseFor("alice"), "users/bob/activeMatch"),
    "ROOM1"
  ));
});

test("users: BRIDGE-A allows cross-user deletion", async () => {
  await seed("users/bob/activeMatch", "ROOM1");
  await assertSucceeds(remove(ref(databaseFor("alice"), "users/bob/activeMatch")));
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

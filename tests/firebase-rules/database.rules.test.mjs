import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import {
  get,
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

test("stats: BRIDGE-A allows an unauthenticated cross-user write", async () => {
  await assertSucceeds(set(ref(databaseFor(), "stats/bob"), stats()));
});

test("stats: missing required fields are denied", async () => {
  await assertFails(set(ref(databaseFor(), "stats/alice"), { wins: 1, losses: 0 }));
});

test("stats: unknown fields are denied", async () => {
  await assertFails(set(ref(databaseFor(), "stats/alice"), stats({ admin: true })));
});

test("stats: deletion is denied", async () => {
  await seed("stats/alice", stats());
  await assertFails(remove(ref(databaseFor(), "stats/alice")));
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

test("eloMatches: settlement identity can read", async () => {
  await assertSucceeds(get(ref(databaseFor("srv_settlement"), "eloMatches/match-1")));
});

test("eloMatches: BRIDGE-A allows unauthenticated create without settledBy", async () => {
  await assertSucceeds(set(ref(databaseFor(), "eloMatches/match-1"), receipt()));
});

test("eloMatches: settlement identity can create a worker receipt", async () => {
  await assertSucceeds(set(
    ref(databaseFor("srv_settlement"), "eloMatches/match-1"),
    receipt({ settledBy: "worker" })
  ));
});

test("eloMatches: unauthenticated settledBy spoof is denied", async () => {
  await assertFails(set(
    ref(databaseFor(), "eloMatches/match-1"),
    receipt({ settledBy: "worker" })
  ));
});

test("eloMatches: an invalid delta sum is denied", async () => {
  await assertFails(set(
    ref(databaseFor(), "eloMatches/match-1"),
    receipt({ lightDelta: 1, darkDelta: -16 })
  ));
});

test("eloMatches: BRIDGE-A still allows a positive non-zero delta sum", async () => {
  await assertSucceeds(set(
    ref(databaseFor(), "eloMatches/match-1"),
    receipt({ lightDelta: 16, darkDelta: -1 })
  ));
});

test("eloMatches: duplicate settlement is denied", async () => {
  await seed("eloMatches/match-1", receipt());
  await assertFails(set(ref(databaseFor("srv_settlement"), "eloMatches/match-1"), receipt()));
});

test("eloMatches: deletion is denied", async () => {
  await seed("eloMatches/match-1", receipt());
  await assertFails(remove(ref(databaseFor("srv_settlement"), "eloMatches/match-1")));
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

test("rooms: BRIDGE-A allows a second joiner to replace the dark player", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(set(
    ref(databaseFor("carol"), "rooms/ROOM1/players/dark"),
    { id: "carol", name: "Carol" }
  ));
});

test("rooms: BRIDGE-A allows an outsider to move pieces", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(update(ref(databaseFor("mallory"), "rooms/ROOM1"), {
    pieces: { a1: { color: "light", king: true } },
    turn: "dark"
  }));
});

test("rooms: invalid turn values are denied", async () => {
  await seed("rooms/ROOM1", room());
  await assertFails(set(ref(databaseFor("alice"), "rooms/ROOM1/turn"), "blue"));
});

test("rooms: BRIDGE-A allows an outsider to delete a room", async () => {
  await seed("rooms/ROOM1", room());
  await assertSucceeds(remove(ref(databaseFor("mallory"), "rooms/ROOM1")));
});

test("cleanup: BRIDGE-A allows cross-user multi-location cleanup", async () => {
  await seed("rooms/ROOM1", room());
  await seed("users/alice/rooms/ROOM1", { status: "active" });
  await assertSucceeds(update(ref(databaseFor("mallory")), {
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

test("technical result: BRIDGE-A allows an outsider's mature disconnect result", async () => {
  const now = Date.now();
  await seed("rooms/ROOM1", room({
    presence: {
      light: { online: true, onlineSince: now - 70_000 },
      dark: { online: false, absentSince: now - 70_000 }
    }
  }));

  await assertSucceeds(update(ref(databaseFor("mallory"), "rooms/ROOM1"), {
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

test("botSessions: public read is allowed", async () => {
  await assertSucceeds(get(ref(databaseFor(), "botSessions/alice")));
});

test("botSessions: BRIDGE-A allows cross-user create", async () => {
  await assertSucceeds(set(
    ref(databaseFor("alice"), "botSessions/bob"),
    botSession()
  ));
});

test("botSessions: equal player and bot colors are denied", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "botSessions/alice"),
    botSession({ botColor: "light", myColor: "light" })
  ));
});

test("botSessions: unknown fields are denied", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "botSessions/alice"),
    botSession({ admin: true })
  ));
});

test("botSessions: BRIDGE-A allows cross-user deletion", async () => {
  await seed("botSessions/bob", botSession());
  await assertSucceeds(remove(ref(databaseFor("alice"), "botSessions/bob")));
});

test("economy: a user node is publicly readable", async () => {
  await assertSucceeds(get(ref(databaseFor(), "economy/alice")));
});

test("economy: unrestricted collection read is denied", async () => {
  await assertFails(get(ref(databaseFor(), "economy")));
});

test("economy: top-ten leaderboard query is allowed", async () => {
  const leaderboard = query(
    ref(databaseFor(), "economy"),
    orderByChild("lifetimeEarned"),
    limitToLast(10)
  );
  await assertSucceeds(get(leaderboard));
});

test("economy: leaderboard query over the limit is denied", async () => {
  const leaderboard = query(
    ref(databaseFor(), "economy"),
    orderByChild("lifetimeEarned"),
    limitToLast(11)
  );
  await assertFails(get(leaderboard));
});

test("economy: BRIDGE-A allows cross-user writes", async () => {
  await assertSucceeds(set(ref(databaseFor("alice"), "economy/bob"), economy()));
});

test("economy: negative balances are denied", async () => {
  await assertFails(set(
    ref(databaseFor("alice"), "economy/alice"),
    economy({ balance: -1 })
  ));
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

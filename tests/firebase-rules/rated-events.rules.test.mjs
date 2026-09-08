// №23: "Protected append-only event log + Worker replay" — Rules Emulator
// tests specific to this feature. Extends the same conventions as
// database.rules.test.mjs (real @firebase/rules-unit-testing emulator, not
// a simulation) rather than duplicating its harness.
//
// Covers exactly what Rules are actually responsible for in this
// architecture:
//   - rooms/$room/ratedReplay: participant cannot create/change/delete it;
//     srv_settlement can create it once and advance acceptedSeq strictly
//     monotonically, bound to the room's own registered ratedMatchId.
//   - ratedEvents/$matchId/events/$seq: only srv_settlement may write;
//     create-only (no rewrite, no delete, even for srv_settlement); fixed-
//     width numeric keys; closed schema.
// Sequence CONTIGUITY (no gaps) is a Worker-side invariant (fetchAllEvents'
// own validateContiguous check), not something these Rules claim to
// enforce on their own — not tested here for that reason.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} from "@firebase/rules-unit-testing";
import { get, ref, remove, set, update } from "firebase/database";

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

const MATCH_ID = "elo_ABC123_1700000000000_0";

function ratedRoom({ acceptedSeq, boardSeq, matchId = MATCH_ID, matchNumber = 0 } = {}) {
  const value = {
    pieces: { b6: { color: "light", king: false }, c3: { color: "dark", king: false } },
    players: { light: { id: "alice", name: "Alice" }, dark: { id: "bob", name: "Bob" } },
    turn: "light",
    status: "active",
    createdAt: 1_700_000_000_000,
    matchNumber,
    ratedMatchId: matchId,
    ratingsAtStart: { light: 1200, dark: 1180 }
  };
  if (acceptedSeq !== undefined) {
    value.ratedReplay = { matchId, acceptedSeq };
    if (boardSeq !== undefined) value.ratedReplay.boardSeq = boardSeq;
  }
  return value;
}

function persistedEvent(overrides = {}) {
  return {
    requestId: "light_0_2-1_0-3",
    type: "turn",
    actorUid: "alice",
    color: "light",
    matchId: MATCH_ID,
    roomCode: "ABC123",
    createdAt: 1_700_000_000_000,
    matchNumber: 0,
    ts: 1_700_000_001_000,
    path: [{ row: 2, col: 1 }, { row: 0, col: 3 }],
    ...overrides
  };
}

// ===== rooms/$room/ratedReplay — participant cannot touch =====

test("participant cannot CREATE ratedReplay via ordinary move update", async () => {
  await seed("rooms/ABC123", ratedRoom());
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    moveCount: 1,
    ratedReplay: { matchId: MATCH_ID, acceptedSeq: 0 }
  }));
});

test("participant cannot change ratedReplay.matchId", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    moveCount: 1,
    "ratedReplay/matchId": "elo_FORGED_1_0"
  }));
});

test("participant cannot INCREASE ratedReplay.acceptedSeq", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    moveCount: 1,
    "ratedReplay/acceptedSeq": 4
  }));
});

test("participant cannot DECREASE ratedReplay.acceptedSeq", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    moveCount: 1,
    "ratedReplay/acceptedSeq": 2
  }));
});

test("participant cannot DELETE ratedReplay", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("alice");
  await assertFails(remove(ref(db, "rooms/ABC123/ratedReplay")));
});

test("participant whole-room set changing ratedReplay alongside a normal move is DENIED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("alice");
  const current = ratedRoom({ acceptedSeq: 3 });
  const forged = { ...current, moveCount: 1, ratedReplay: { matchId: MATCH_ID, acceptedSeq: 4 } };
  await assertFails(set(ref(db, "rooms/ABC123"), forged));
});

test("ordinary participant gameplay write with UNCHANGED ratedReplay is ALLOWED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("alice");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    drawProposal: { by: "light", name: "Alice" }
  }));
});

// ===== rooms/$room/ratedReplay — Worker (srv_settlement) =====

test("Worker initial ratedReplay creation is ALLOWED", async () => {
  await seed("rooms/ABC123", ratedRoom());
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 0,
    pieces: { d4: { color: "light", king: false } },
    turn: "dark"
  }));
});

test("Worker monotonic advance (acceptedSeq N -> N+1) is ALLOWED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    turn: "light"
  }));
});

test("Worker stale/equal projection write (acceptedSeq unchanged) is DENIED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 3,
    turn: "light"
  }));
});

test("Worker rollback (acceptedSeq goes backward) is DENIED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 5 }));
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 3,
    turn: "light"
  }));
});

test("Worker projection write with WRONG matchId (not the room's registered ratedMatchId) is DENIED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": "elo_OTHER_1_0",
    "ratedReplay/acceptedSeq": 4,
    turn: "light"
  }));
});

test("Worker projection write that also touches players is DENIED (out of Worker's allowed field scope)", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3 }));
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    "players/light/id": "mallory"
  }));
});

// ===== v9: boardSeq monotonic protection =====

// ===== v10 fix (review Blocker 1): boardSeq must be protected from participant tampering too =====

test("participant cannot create ratedReplay.boardSeq (whole-room write, other fields unchanged)", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    moveCount: 1,
    "ratedReplay/boardSeq": 499
  }));
});

test("participant cannot increase ratedReplay.boardSeq while matchId/acceptedSeq stay unchanged", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/boardSeq": 499
  }));
});

test("participant cannot decrease ratedReplay.boardSeq while matchId/acceptedSeq stay unchanged", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/boardSeq": 0
  }));
});

test("participant cannot delete ratedReplay.boardSeq alone (matchId/acceptedSeq unchanged)", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("alice");
  const before = ratedRoom({ acceptedSeq: 3, boardSeq: 2 });
  const after = { ...before, ratedReplay: { matchId: MATCH_ID, acceptedSeq: 3 } }; // boardSeq removed
  await assertFails(set(ref(db, "rooms/ABC123"), after));
});

test("ordinary participant move with boardSeq unchanged remains ALLOWED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("alice");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    drawProposal: { by: "light", name: "Alice" }
  }));
});

test("invariant boardSeq <= acceptedSeq is DENIED even for srv_settlement", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    "ratedReplay/boardSeq": 10
  }));
});

test("initial non-turn projection (resign/draw_offer as the very FIRST event) with boardSeq absent entirely is ALLOWED (found on review: boardSeq<=acceptedSeq invariant incorrectly rejected the absent-boardSeq case)", async () => {
  await seed("rooms/ABC123", ratedRoom()); // ratedReplay отсутствует вовсе -- ни одного события ещё не было
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 0
    // boardSeq намеренно НЕ включён -- первое событие non-turn (resign/draw_offer)
  }));
});

test("Worker boardSeq rollback is DENIED even when acceptedSeq advances", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 5, boardSeq: 4 }));
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 6,
    "ratedReplay/boardSeq": 2,
    turn: "light"
  }));
});

test("Worker boardSeq advance alongside acceptedSeq advance is ALLOWED", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4,
    "ratedReplay/boardSeq": 3,
    turn: "light"
  }));
});

test("Worker advancing acceptedSeq WITHOUT touching boardSeq (non-turn latest event) is ALLOWED and leaves boardSeq unchanged", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 3, boardSeq: 2 }));
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 4
  }));
});

// ===== v9 (B2 fix): rematch/new-generation may reset a leftover ratedReplay =====

test("Worker rebinding ratedMatchId to a NEW value may reset ratedReplay fresh, even with lower numbers than the old generation's leftover", async () => {
  const OLD_MATCH_ID = "elo_ABC123_1700000000000_0";
  const NEW_MATCH_ID = "elo_ABC123_1700000000000_1";
  await seed("rooms/ABC123", ratedRoom({ matchId: OLD_MATCH_ID, acceptedSeq: 6, boardSeq: 5, matchNumber: 1 }));
  await seed("matchIndex/ABC123", { matchId: NEW_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 1 });
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    ratedMatchId: NEW_MATCH_ID,
    "ratedReplay/matchId": NEW_MATCH_ID,
    "ratedReplay/acceptedSeq": 0,
    "ratedReplay/boardSeq": 0
  }));
});

test("Worker rebinding ratedMatchId may instead just clear ratedReplay entirely (finalizePointer's real shape)", async () => {
  const OLD_MATCH_ID = "elo_ABC123_1700000000000_0";
  const NEW_MATCH_ID = "elo_ABC123_1700000000000_1";
  await seed("rooms/ABC123", ratedRoom({ matchId: OLD_MATCH_ID, acceptedSeq: 6, boardSeq: 5, matchNumber: 1 }));
  await seed("matchIndex/ABC123", { matchId: NEW_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 1 });
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    ratedMatchId: NEW_MATCH_ID,
    "ratingsAtStart/light": 1210,
    "ratingsAtStart/dark": 1190,
    ratedReplay: null
  }));
});

// ===== v17 (real Emulator on v16: tests at lines ~184/~204 FAILED) =====
// v13's consolidated ratedReplay/.validate had dropped two invariants that
// the original room-level Worker branches enforced: (a) strict monotonic
// acceptedSeq (equal was re-allowed), and (b) ratedReplay.matchId must equal
// the room's (new) ratedMatchId. Restored in v17. A third instance of (b)
// found via targaryen while investigating: Worker rebinds ratedMatchId but
// leaves ratedReplay.matchId at the OLD value while advancing acceptedSeq.

test("Worker rebinding ratedMatchId while leaving ratedReplay.matchId at the OLD value is DENIED", async () => {
  const OLD_MATCH_ID = "elo_ABC123_1700000000000_0";
  const NEW_MATCH_ID = "elo_ABC123_1700000000000_1";
  await seed("rooms/ABC123", ratedRoom({ matchId: OLD_MATCH_ID, acceptedSeq: 6, boardSeq: 5, matchNumber: 1 }));
  await seed("matchIndex/ABC123", { matchId: NEW_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 1 });
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    ratedMatchId: NEW_MATCH_ID,
    "ratedReplay/acceptedSeq": 7
  }));
});

test("Worker initial ratedReplay creation at acceptedSeq>0 (first successful sync after earlier failed syncs) is ALLOWED", async () => {
  await seed("rooms/ABC123", ratedRoom());
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 5,
    "ratedReplay/boardSeq": 4
  }));
});

test("Worker rebinding ratedMatchId is DENIED if it ALSO touches players/createdAt/matchNumber (generation-reset branch is not a general room-rewrite path)", async () => {
  const OLD_MATCH_ID = "elo_ABC123_1700000000000_0";
  const NEW_MATCH_ID = "elo_ABC123_1700000000000_1";
  await seed("rooms/ABC123", ratedRoom({ matchId: OLD_MATCH_ID, acceptedSeq: 6, boardSeq: 5, matchNumber: 1 }));
  await seed("matchIndex/ABC123", { matchId: NEW_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 1 });
  const db = databaseFor("srv_settlement");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    ratedMatchId: NEW_MATCH_ID,
    "ratedReplay/matchId": NEW_MATCH_ID,
    "ratedReplay/acceptedSeq": 0,
    "players/light/id": "mallory"
  }));
});

test("participant CANNOT rebind ratedMatchId (generation-reset branch is srv_settlement-only)", async () => {
  const OLD_MATCH_ID = "elo_ABC123_1700000000000_0";
  const NEW_MATCH_ID = "elo_ABC123_1700000000000_1";
  await seed("rooms/ABC123", ratedRoom({ matchId: OLD_MATCH_ID, acceptedSeq: 6, boardSeq: 5, matchNumber: 1 }));
  await seed("matchIndex/ABC123", { matchId: NEW_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 1 });
  const db = databaseFor("alice");
  await assertFails(update(ref(db, "rooms/ABC123"), {
    ratedMatchId: NEW_MATCH_ID,
    ratedReplay: null
  }));
});

// ===== ratedEvents/$matchId/events/$seq =====

test("unauthenticated write to ratedEvents is DENIED", async () => {
  const db = databaseFor(null);
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent()));
});

test("participant direct write to ratedEvents is DENIED", async () => {
  await seed(`matches/${MATCH_ID}`, { roomCode: "ABC123", participants: { alice: { color: "light" } } });
  const db = databaseFor("alice");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent()));
});

test("srv_settlement create of a new event is ALLOWED", async () => {
  await seed("rooms/ABC123", ratedRoom()); // status='active', ratedMatchId===MATCH_ID -- round-12 atomic requirement
  const db = databaseFor("srv_settlement");
  await assertSucceeds(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent()));
});

// ===== v12/v15: atomic lifecycle lock on event create -- room must exist, be this generation, have no genuine technical result yet =====

test("event create is DENIED if a GENUINE technical/disconnect result was committed to room FIRST (validated result, not just bare status)", async () => {
  await seed("rooms/ABC123", { ...ratedRoom(), status: "finished", winner: "dark", winReason: "disconnect",
    result: { winnerColor: "dark", loserColor: "light", winnerId: "bob", loserId: "alice",
      winReason: "disconnect", status: "finished", decidedAt: 1_700_000_005_000 } });
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent({ type: "resign" })));
});

test("event create is DENIED if the room points to a DIFFERENT (superseded/rematch) generation", async () => {
  await seed("rooms/ABC123", { ...ratedRoom(), ratedMatchId: "elo_ABC123_1700000000000_1" });
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent()));
});

test("event create is DENIED if the room is missing entirely (cleanup)", async () => {
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent()));
});

test("event create is NOT denied by a forged bare room.status='finished' with no genuine result (found on review: status alone is participant-controlled -- a losing participant could otherwise forge this to permanently deny the match a rated outcome)", async () => {
  await seed("rooms/ABC123", { ...ratedRoom(), status: "finished" }); // no winner/winReason/result at all
  const db = databaseFor("srv_settlement");
  await assertSucceeds(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent({ type: "resign" })));
});

// ===== v16 fix (review of v15): once room.result is the lifecycle gate, participants must not be able to remove it in a rated room =====
// The room-level .validate has a legacy "rematch reset" escape hatch that
// allowed an existing result to be dropped if the same write also set
// status:'active' and removed winner/winReason. For a rated room
// (ratedMatchId present) that let a participant erase a genuine
// technical-disconnect result, after which the v15 gate
// (!room.hasChild('result')) passed and a protected resign could be
// appended -- converting an intentionally-unrated technical outcome into a
// rated one. The escape hatch is now limited to non-rated rooms.

const GENUINE_RESULT = { winnerColor: "dark", loserColor: "light", winnerId: "bob", loserId: "alice",
  winReason: "disconnect", status: "finished", decidedAt: 1_700_000_005_000 };

test("participant CANNOT remove an existing technical result from a RATED room (even with status->active and winner/winReason removed)", async () => {
  const before = { ...ratedRoom({ acceptedSeq: 3, boardSeq: 2 }), status: "finished", winner: "dark", winReason: "disconnect", result: GENUINE_RESULT };
  await seed("rooms/ABC123", before);
  const after = { ...before, status: "active" };
  delete after.result; delete after.winner; delete after.winReason;
  const db = databaseFor("alice");
  await assertFails(set(ref(db, "rooms/ABC123"), after));
});

test("participant CAN still clear a technical result via rematch in a NON-rated room (legacy behavior preserved)", async () => {
  const before = { ...ratedRoom(), status: "finished", winner: "dark", winReason: "disconnect", result: GENUINE_RESULT };
  delete before.ratedMatchId; delete before.ratingsAtStart;
  await seed("rooms/ABC123", before);
  const after = {
    pieces: before.pieces, turn: "light", status: "active", createdAt: before.createdAt, matchNumber: 1,
    players: { light: { id: "bob", name: "Bob" }, dark: { id: "alice", name: "Alice" } }
  };
  const db = databaseFor("alice");
  await assertSucceeds(set(ref(db, "rooms/ABC123"), after));
});

test("legitimate RATED rematch after a protected resign (no result present, settled by worker) is still ALLOWED", async () => {
  const before = { ...ratedRoom({ acceptedSeq: 3, boardSeq: 2 }), status: "finished", winner: "dark", winReason: "resign" };
  await seed("rooms/ABC123", before);
  await seed(`eloMatches/${MATCH_ID}`, { settledBy: "worker", result: "dark", lightId: "alice", darkId: "bob",
    lightRatingBefore: 1200, darkRatingBefore: 1180, lightDelta: -16, darkDelta: 16, createdAt: 1_700_000_006_000 });
  const after = {
    pieces: before.pieces, turn: "light", status: "active", createdAt: before.createdAt, matchNumber: 1,
    players: { light: { id: "bob", name: "Bob" }, dark: { id: "alice", name: "Alice" } },
    ratedMatchId: MATCH_ID, ratedReplay: before.ratedReplay
  };
  const db = databaseFor("alice");
  await assertSucceeds(set(ref(db, "rooms/ABC123"), after));
});

test("srv_settlement REWRITE of an existing event is DENIED (create-only, even for srv_settlement)", async () => {
  await seed(`ratedEvents/${MATCH_ID}/events/000000`, persistedEvent());
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent({ path: [{ row: 0, col: 0 }, { row: 1, col: 1 }] })));
});

test("srv_settlement DELETE of an existing event is DENIED", async () => {
  await seed(`ratedEvents/${MATCH_ID}/events/000000`, persistedEvent());
  const db = databaseFor("srv_settlement");
  await assertFails(remove(ref(db, `ratedEvents/${MATCH_ID}/events/000000`)));
});

// ===== v14 fix (round 13/14 review): confirmed by real Firebase Rules Emulator =====
// Independent CI run (GitHub Actions run 34145773229 / job 101817395663,
// Firebase Database Emulator v4.11.2) found the test above genuinely
// FAILING on exact v12/v13 content: ratedEvents/$matchId/events/$seq's
// create-only immutability check lived ONLY in .validate
// (!data.exists() && newData.exists()), and Firebase does not run
// .validate at all on delete operations -- so DELETE passed the
// unconditional srv_settlement .write and skipped the check entirely.
// Fixed by moving the same requirement into .write itself (matching the
// already-correct pattern already used by eloMatches/$matchId and
// matches/$matchId, which is why they were never vulnerable to this).

test("srv_settlement can still CREATE a genuinely new event after the DELETE fix (unaffected)", async () => {
  await seed("rooms/ABC123", ratedRoom());
  const db = databaseFor("srv_settlement");
  await assertSucceeds(set(ref(db, `ratedEvents/${MATCH_ID}/events/000001`), persistedEvent()));
});

test("srv_settlement REWRITE of an existing event is still DENIED after the DELETE fix (unaffected)", async () => {
  await seed(`ratedEvents/${MATCH_ID}/events/000000`, persistedEvent());
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent({ type: "draw_offer" })));
});

// ===== v14 fix: participant deleting the WHOLE ratedReplay node (not just tampering with a field) =====
// Found on independent review of round 13's ratedReplay refactor: moving
// the participant "must stay unchanged" requirement out of the room-level
// .write and into a child-level ratedReplay/.validate left a gap, because
// .validate does not run when the CHILD ITSELF is being deleted (e.g. a
// participant's whole-room write that simply omits ratedReplay entirely).
// Fixed by restoring a SHORT existence-only guard to the 4 participant
// branches in the room-level .write (not the full per-field comparison,
// which stays in the child .validate for the non-delete case) -- deletion
// specifically is only ever gated by .write, never by .validate.

test("participant CANNOT delete the whole ratedReplay node via an otherwise-valid room write", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 5, boardSeq: 4 }));
  const db = databaseFor("alice");
  const before = ratedRoom({ acceptedSeq: 5, boardSeq: 4 });
  const after = { ...before };
  delete after.ratedReplay;
  after.drawProposal = { by: "light", name: "Alice" };
  await assertFails(set(ref(db, "rooms/ABC123"), after));
});

test("participant deleting only boardSeq (leaving matchId/acceptedSeq) is still DENIED (existing per-field validate, confirmed still working)", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 5, boardSeq: 4 }));
  const db = databaseFor("alice");
  const before = ratedRoom({ acceptedSeq: 5, boardSeq: 4 });
  const after = { ...before, ratedReplay: { matchId: MATCH_ID, acceptedSeq: 5 } }; // boardSeq removed only
  await assertFails(set(ref(db, "rooms/ABC123"), after));
});

test("ordinary participant room write with ratedReplay fully unchanged remains ALLOWED after the fix", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 5, boardSeq: 4 }));
  const db = databaseFor("alice");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    drawProposal: { by: "light", name: "Alice" }
  }));
});

test("Worker legitimate monotonic advance of ratedReplay remains ALLOWED after the fix", async () => {
  await seed("rooms/ABC123", ratedRoom({ acceptedSeq: 5, boardSeq: 4 }));
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    "ratedReplay/matchId": MATCH_ID,
    "ratedReplay/acceptedSeq": 6,
    "ratedReplay/boardSeq": 5
  }));
});

test("Worker legitimate generation-reset (rebinding ratedMatchId) may still delete/reset ratedReplay after the fix", async () => {
  const OLD_MATCH_ID = "elo_ABC123_1700000000000_0";
  const NEW_MATCH_ID = "elo_ABC123_1700000000000_1";
  await seed("rooms/ABC123", ratedRoom({ matchId: OLD_MATCH_ID, acceptedSeq: 6, boardSeq: 5, matchNumber: 1 }));
  await seed("matchIndex/ABC123", { matchId: NEW_MATCH_ID, createdAt: 1_700_000_000_000, lastMatchNumber: 1 });
  const db = databaseFor("srv_settlement");
  await assertSucceeds(update(ref(db, "rooms/ABC123"), {
    ratedMatchId: NEW_MATCH_ID,
    "ratingsAtStart/light": 1210,
    "ratingsAtStart/dark": 1190,
    ratedReplay: null
  }));
});

test("malformed (non-6-digit) seq key is DENIED", async () => {
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/7`), persistedEvent()));
});

test("event with matchId mismatched to its own path is DENIED", async () => {
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent({ matchId: "elo_OTHER_1_0" })));
});

test("event with unknown extra field is DENIED", async () => {
  const db = databaseFor("srv_settlement");
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), { ...persistedEvent(), forgedWinner: "light" }));
});

test("event path exceeding 16 points is DENIED", async () => {
  const db = databaseFor("srv_settlement");
  const longPath = [];
  for (let i = 0; i <= 16; i++) longPath.push({ row: i % 8, col: (i * 3) % 8 });
  await assertFails(set(ref(db, `ratedEvents/${MATCH_ID}/events/000000`), persistedEvent({ path: longPath })));
});

test("participant (own match) CAN read ratedEvents", async () => {
  await seed(`matches/${MATCH_ID}`, { roomCode: "ABC123", participants: { alice: { color: "light" } } });
  await seed(`ratedEvents/${MATCH_ID}/events/000000`, persistedEvent());
  const db = databaseFor("alice");
  await assertSucceeds(get(ref(db, `ratedEvents/${MATCH_ID}/events/000000`)));
});

test("non-participant CANNOT read ratedEvents", async () => {
  await seed(`matches/${MATCH_ID}`, { roomCode: "ABC123", participants: { alice: { color: "light" } } });
  await seed(`ratedEvents/${MATCH_ID}/events/000000`, persistedEvent());
  const db = databaseFor("mallory");
  await assertFails(get(ref(db, `ratedEvents/${MATCH_ID}/events/000000`)));
});

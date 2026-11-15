(function (global) {
  "use strict";
  const codePattern = /^[A-F0-9]{24}$/;
  const ownerPattern = /^tg_[0-9]+$/;
  function validCode(value) {
    return typeof value === "string" && codePattern.test(value);
  }
  function generateCode(rng) {
    const cryptoSource = rng || global.crypto;
    if (!cryptoSource || typeof cryptoSource.getRandomValues !== "function") {
      throw new Error("italian_secure_rng_unavailable");
    }
    const bytes = new Uint8Array(12);
    cryptoSource.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  function inviteParam(code) {
    if (!validCode(code)) throw new Error("invalid_italian_invite_code");
    return "it_" + code;
  }
  function isItalianInviteParam(param) {
    return typeof param === "string" && param.startsWith("it_");
  }
  function parseInviteParam(param) {
    if (typeof param !== "string" || !param.startsWith("it_")) return null;
    const code = param.slice(3);
    return validCode(code) ? code : null;
  }
  function validInitialPieces(pieces) {
    if (!Array.isArray(pieces) || pieces.length !== 24) return false;
    const seen = new Set();
    for (const p of pieces) {
      if (!p || !Number.isInteger(p.row) || !Number.isInteger(p.col) ||
          p.row < 0 || p.row > 7 || p.col < 0 || p.col > 7 ||
          (p.row+p.col)%2 !== 1 || p.king !== false ||
          Object.keys(p).length !== 4) return false;
      const expected = p.row < 3 ? "dark" : p.row > 4 ? "light" : null;
      const key = p.row + "_" + p.col;
      if (!expected || p.color !== expected || seen.has(key)) return false;
      seen.add(key);
    }
    return seen.size === 24;
  }
  // STEP K3: the same six choices as the Russian #time-control-screen (0 = no limit). The creator writes the choice once, at creation
  // (the STAGING Rules keep it immutable); 0 means "no field at all", exactly the room an older client creates.
  const TIME_CONTROL_VALUES = Object.freeze([0, 30, 60, 120, 180, 300]);
  function validTimeControl(v) { return TIME_CONTROL_VALUES.indexOf(v) !== -1; }
  function createWaitingRoom(input) {
    if (!input || !validCode(input.code) || !ownerPattern.test(input.ownerId) ||
        typeof input.ownerName !== "string" || !input.ownerName.trim() ||
        !input.serverTimestamp || input.serverTimestamp[".sv"] !== "timestamp" ||
        (input.timeControlSeconds !== undefined && !validTimeControl(input.timeControlSeconds))) {
      throw new Error("invalid_italian_room_request");
    }
    if (!global.LocalRulesetAdapter || !global.LocalRulesetAdapter.has("italian")) {
      throw new Error("italian_adapter_missing");
    }
    const initial = global.LocalRulesetAdapter.get("italian").createInitialState();
    if (initial.turn !== "light" || !validInitialPieces(initial.pieces)) {
      throw new Error("invalid_italian_initial_state");
    }
    const room = {
      ruleset: "italian", status: "waiting", turn: "light",
      // RTDB Rules validate all 24 fixed playable-square keys independently.
      // No array indices or client-controlled extra squares are accepted.
      pieces: Object.fromEntries(initial.pieces.map(p =>
        [p.row + "_" + p.col, {row:p.row,col:p.col,color:p.color,king:false}])),
      players: {light:{id:input.ownerId,name:input.ownerName.trim().slice(0,80)}},
      createdAt: input.serverTimestamp, matchNumber: 0, moveCount: 0,
      capturedLight: 0, capturedDark: 0
    };
    if (input.timeControlSeconds > 0) room.timeControlSeconds = input.timeControlSeconds;
    return room;
  }
  global.ItalianOnlineInviteContract = Object.freeze({
    validCode,generateCode,inviteParam,parseInviteParam,isItalianInviteParam,
    validInitialPieces,createWaitingRoom,TIME_CONTROL_VALUES,validTimeControl
  });
})(typeof window !== "undefined" ? window : globalThis);

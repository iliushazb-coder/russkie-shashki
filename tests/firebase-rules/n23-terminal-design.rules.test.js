// №23 RED/TDD: characterization против ТЕКУЩЕГО main (dfbb2472...).
// Harness (rule-eval-harness.js) валидирован против уже задеплоенного,
// production-proven drawProposal G2 guard -- см. отдельный лог валидации.
//
// Эти правила НЕ существуют в текущем firebase/database.rules.json --
// тесты ниже проверяют ПРЕДЛОЖЕННЫЕ строки (из design-review) как
// standalone-выражения, не производственный файл. Цель: доказать, что
// (а) без них искомая security-дыра действительно открыта на
// production-эквивалентных фикстурах, и (б) сами строки логически
// корректно ведут себя на required сценариях, ПЕРЕД тем как их вносить
// в production Rules.
//
// НЕ тестирует: RTDB multi-path atomicity, реальный commit-порядок при
// гонках, реальную сетевую доставку .sv:timestamp. Это ограничение
// честно повторяется во всех предыдущих раундах -- emulator недоступен
// в песочнице.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { evalRule } = require('./rule-eval-harness.js');

const NOW = 1_700_000_100_000;

// ---------- RED against CURRENT, unmodified main Rules (the actual gap) ----------
const fs = require('node:fs');
const path = require('node:path');
const CURRENT_RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'firebase', 'database.rules.json'), 'utf8'));
const CURRENT_ROOM_WRITE = CURRENT_RULES.rules.rooms['$room']['.write'];
// Заморожено буквально до фикса -- $room/.validate в файле теперь ИЗМЕНЁН
// этим же production-patch'ем, поэтому читать presence/light/.validate
// динамически из ТЕКУЩЕГО файла для "RED против исходного main" уже
// некорректно: он покажет уже исправленный текст, а не исторический.
const HISTORICAL_PRESENCE_VALIDATE_BEFORE_FIX = "newData.hasChildren(['online'])";

test('RED-CURRENT-MAIN 1: TODAY, a participant can flip status active->finished and set winner directly via the ordinary $room/.write branch', () => {
  const before = {
    players: { light: { id: 'tg_111', name: 'A' }, dark: { id: 'tg_222', name: 'B' } },
    status: 'active', createdAt: 1_700_000_000_000, matchNumber: 0, groupId: 'g1',
    timeControlSeconds: 0, ratedMatchId: 'elo_ABC123_1700000000000_0',
    ratingsAtStart: { light: 1200, dark: 1180 },
    presence: { light: { online: true }, dark: { online: true } }
  };
  const after = Object.assign({}, before, { status: 'finished', winner: 'light' });
  const allowedToday = evalRule(CURRENT_ROOM_WRITE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowedToday, true, 'this IS the confirmed gap this design closes -- current main allows it');
});

test('RED-CURRENT-MAIN 2: TODAY, a participant can backdate their own onlineSince arbitrarily via presence/light/.validate', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000 };
  const after = { online: true, absentSince: null, onlineSince: NOW - 500000 };
  const allowedToday = evalRule(HISTORICAL_PRESENCE_VALIDATE_BEFORE_FIX, { rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowedToday, true, 'this IS the confirmed gap this design closes -- current main allows it');
});

test('GREEN-PRODUCTION-FIX 1: the SAME attack from RED-CURRENT-MAIN 1, evaluated against .write AND the NEW real production .validate together -- RTDB requires ALLOW from both, and the new .validate now denies it', () => {
  const before = {
    players: { light: { id: 'tg_111', name: 'A' }, dark: { id: 'tg_222', name: 'B' } },
    status: 'active', createdAt: 1_700_000_000_000, matchNumber: 0, groupId: 'g1',
    timeControlSeconds: 0, ratedMatchId: 'elo_ABC123_1700000000000_0',
    ratingsAtStart: { light: 1200, dark: 1180 },
    presence: { light: { online: true }, dark: { online: true } }
  };
  const after = Object.assign({}, before, { status: 'finished', winner: 'light' });
  const writeAllows = evalRule(CURRENT_ROOM_WRITE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW });
  const validateAllows = evalRule(REAL_ROOM_VALIDATE, {
    authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' }
  });
  assert.equal(writeAllows, true, '.write itself is unchanged, still permissive on its own');
  assert.equal(validateAllows, false, 'the new .validate conjunct now blocks it -- RTDB requires BOTH to allow');
});

test('GREEN-PRODUCTION-FIX 2: the SAME onlineSince forgery from RED-CURRENT-MAIN 2, evaluated against the real production presence/light/.validate -- now denied', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000 };
  const after = { online: true, absentSince: null, onlineSince: NOW - 500000 };
  const allowedNow = evalRule(REAL_PRESENCE_VALIDATE, { rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowedNow, false);
});

test('GREEN-PRODUCTION-FIX 3: ratedTerminal/$matchId now exists in the real Rules file with create-only .write', () => {
  const allowedFirst = evalRule(REAL_RT_WRITE, { authUid: 'srv_settlement', rootTree: null, rootTree2: { requestId: 'r1' }, now: NOW });
  const deniedSecond = evalRule(REAL_RT_WRITE, { authUid: 'srv_settlement', rootTree: { requestId: 'r1' }, rootTree2: { requestId: 'r2' }, now: NOW });
  const deniedDelete = evalRule(REAL_RT_WRITE, { authUid: 'srv_settlement', rootTree: { requestId: 'r1' }, rootTree2: null, now: NOW });
  assert.equal(allowedFirst, true);
  assert.equal(deniedSecond, false);
  assert.equal(deniedDelete, false);
});

const REAL_RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'firebase', 'database.rules.json'), 'utf8'));
const REAL_ROOM_VALIDATE = REAL_RULES.rules.rooms['$room']['.validate'];
const REAL_PRESENCE_VALIDATE = REAL_RULES.rules.rooms['$room'].presence.light['.validate'];
const REAL_RT_WRITE = REAL_RULES.rules.ratedTerminal['$matchId']['.write'];

// ---------- Late protected event after a technical win (found in independent review) ----------
// Технический исход больше НЕ пишет room.result (унифицирован с protected:
// только winner/winReason/status) -- старый !hasChild('result') guard в
// events/$seq/.validate больше не защищает этот конкретный случай. Новый
// независимый conjunct в events/$seq/.write ссылается на ratedTerminal.
const REAL_EVENT_WRITE = REAL_RULES.rules.ratedEvents['$matchId'].events['$seq']['.write'];

test('GREEN-PRODUCTION-FIX 4: a late NON-technical event append is DENIED once ratedTerminal already exists for this matchId', () => {
  const before = {
    ratedTerminal: { M1: { requestId: 'tech-r' } },
    rooms: { ABC123: { ratedMatchId: 'M1', winner: 'light', winReason: 'disconnect', status: 'finished' } },
    ratedEvents: { M1: { events: {} } }
  };
  const after = JSON.parse(JSON.stringify(before));
  after.ratedEvents.M1.events['000005'] = { type: 'resign', requestId: 'late-resign' };
  const allowed = evalRule(REAL_EVENT_WRITE, {
    authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW,
    dataPath: ['ratedEvents', 'M1', 'events', '000005'], wildcards: { $matchId: 'M1' }
  });
  assert.equal(allowed, false);
});

test('GREEN-PRODUCTION-FIX 5: the technical_result event ITSELF is exempt from its own ratedTerminal guard', () => {
  const before = { ratedTerminal: { M1: { requestId: 'tech-r' } }, ratedEvents: { M1: { events: {} } } };
  const after = JSON.parse(JSON.stringify(before));
  after.ratedEvents.M1.events['000005'] = { type: 'technical_result', requestId: 'tech-r' };
  const allowed = evalRule(REAL_EVENT_WRITE, {
    authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW,
    dataPath: ['ratedEvents', 'M1', 'events', '000005'], wildcards: { $matchId: 'M1' }
  });
  assert.equal(allowed, true);
});

test('GREEN-PRODUCTION-FIX 6: regression -- a normal event append with NO ratedTerminal at all remains ALLOWED', () => {
  const before = { ratedEvents: { M1: { events: {} } }, rooms: { ABC123: {} } };
  const after = JSON.parse(JSON.stringify(before));
  after.ratedEvents.M1.events['000001'] = { type: 'turn', requestId: 'r1' };
  const allowed = evalRule(REAL_EVENT_WRITE, {
    authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW,
    dataPath: ['ratedEvents', 'M1', 'events', '000001'], wildcards: { $matchId: 'M1' }
  });
  assert.equal(allowed, true);
});



const GUARD_A = "auth != null && auth.uid === 'srv_settlement' || !data.exists() || (data.child('status').val() === 'finished' && newData.child('status').val() === 'active') || !(data.child('ratedMatchId').exists() || (root.child('matchIndex').child($room).child('createdAt').val() === data.child('createdAt').val() && root.child('matchIndex').child($room).child('lastMatchNumber').val() === data.child('matchNumber').val())) || (newData.child('status').val() === data.child('status').val() && newData.child('winner').val() === data.child('winner').val() && newData.child('winReason').val() === data.child('winReason').val() && newData.hasChild('result') === data.hasChild('result'))";

function baseRoom(overrides) {
  return Object.assign({
    status: 'active',
    createdAt: 1_700_000_000_000,
    matchNumber: 0,
    ratedMatchId: 'elo_ABC123_1700000000000_0'
  }, overrides);
}

test('RED 1: registered rated active room -- participant flips status active->finished, winner/winReason/result untouched -- CURRENT DESIGN (no Guard A) has no check for this at all -> demonstrate the gap is real by evaluating Guard A itself and confirming it DENIES', () => {
  const before = baseRoom();
  const after = Object.assign({}, before, { status: 'finished' });
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, false, 'Guard A must DENY a bare status flip by a participant');
});

test('RED 2: registered rated active room -- participant changes winner value (light->dark), both existed before/after -- Guard A must DENY', () => {
  const before = baseRoom({ winner: 'light', status: 'finished' });
  const after = Object.assign({}, before, { winner: 'dark' });
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, false);
});

test('RED 3: registered rated active room -- participant changes winReason value -- Guard A must DENY', () => {
  const before = baseRoom({ winner: 'light', winReason: 'resign', status: 'finished' });
  const after = Object.assign({}, before, { winReason: 'timeout' });
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, false);
});

test('GREEN (regression): unrated room, same status flip -- Guard A must ALLOW', () => {
  const before = { status: 'active', createdAt: 1_700_000_000_000, matchNumber: 0 };
  const after = Object.assign({}, before, { status: 'finished', winner: 'light' });
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, true, 'unrated legacy path must remain unaffected');
});

test('GREEN (regression): rematch, status finished->active -- Guard A must ALLOW (rematch exception)', () => {
  const before = baseRoom({ status: 'finished', winner: 'light' });
  const after = Object.assign({}, before, { status: 'active', winner: null, matchNumber: 1 });
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, true);
});

test('DOCUMENTED DESIGN FLAW (v1, now fixed): the earlier, broader exemption "data.status !== \'active\'" wrongly also exempted an already-finished room from re-writing winner while STAYING finished (not a genuine rematch transition) -- proven by re-running the exact v1 text', () => {
  const GUARD_A_V1_BROKEN = "auth != null && auth.uid === 'srv_settlement' || !data.exists() || data.child('status').val() !== 'active' || !(data.child('ratedMatchId').exists() || (root.child('matchIndex').child($room).child('createdAt').val() === data.child('createdAt').val() && root.child('matchIndex').child($room).child('lastMatchNumber').val() === data.child('matchNumber').val())) || (newData.child('status').val() === data.child('status').val() && newData.child('winner').val() === data.child('winner').val() && newData.child('winReason').val() === data.child('winReason').val() && newData.hasChild('result') === data.hasChild('result'))";
  const before = baseRoom({ winner: 'light', status: 'finished' });
  const after = Object.assign({}, before, { winner: 'dark' }); // status stays 'finished', NOT a rematch
  const v1Allowed = evalRule(GUARD_A_V1_BROKEN, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  const v2Allowed = evalRule(GUARD_A, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  assert.equal(v1Allowed, true, 'v1 incorrectly allowed this -- this is the bug the RED phase caught');
  assert.equal(v2Allowed, false, 'v2 correctly denies it: status stays finished, not a genuine active->finished->active rematch');
});

test('RED 4: registration-in-flight (matchIndex matches createdAt+lastMatchNumber, ratedMatchId NOT yet published) -- participant terminal write must DENY', () => {
  const before = { status: 'active', createdAt: 1_700_000_000_000, matchNumber: 0 }; // no ratedMatchId yet
  const after = Object.assign({}, before, { status: 'finished', winner: 'light' });
  const root = { matchIndex: { ABC123: { createdAt: 1_700_000_000_000, lastMatchNumber: 0, matchId: 'elo_ABC123_1700000000000_0' } } };
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111',
    rootTree: Object.assign({ rooms: { ABC123: before } }, root),
    rootTree2: Object.assign({ rooms: { ABC123: after } }, root),
    dataPath: ['rooms', 'ABC123'],
    now: NOW,
    wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, false, 'registration-in-flight must be treated as rated-intent, not legacy-unrated');
});

test('GREEN: stale matchIndex (createdAt matches, lastMatchNumber does NOT) -- NOT current generation rated-intent -> ALLOW (legacy behaviour)', () => {
  const before = { status: 'active', createdAt: 1_700_000_000_000, matchNumber: 0 };
  const after = Object.assign({}, before, { status: 'finished', winner: 'light' });
  const root = { matchIndex: { ABC123: { createdAt: 1_700_000_000_000, lastMatchNumber: 5, matchId: 'elo_ABC123_1700000000000_5' } } };
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111',
    rootTree: Object.assign({ rooms: { ABC123: before } }, root),
    rootTree2: Object.assign({ rooms: { ABC123: after } }, root),
    dataPath: ['rooms', 'ABC123'],
    now: NOW,
    wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, true, 'stale index for a different generation must not gate this one');
});

test('GREEN: true unrated (no matchIndex at all) -- ALLOW', () => {
  const before = { status: 'active', createdAt: 1_700_000_000_000, matchNumber: 0 };
  const after = Object.assign({}, before, { status: 'finished', winner: 'light' });
  const allowed = evalRule(GUARD_A, {
    authUid: 'tg_111',
    rootTree: { rooms: { ABC123: before }, matchIndex: {} },
    rootTree2: { rooms: { ABC123: after }, matchIndex: {} },
    dataPath: ['rooms', 'ABC123'],
    now: NOW,
    wildcards: { $room: 'ABC123' }
  });
  assert.equal(allowed, true);
});

// ---------- Guard B: turnStartedAt pin ----------
const GUARD_B = "auth != null && auth.uid === 'srv_settlement' || !data.exists() || !data.child('ratedMatchId').exists() || (newData.child('turnStartedAt').exists() === data.child('turnStartedAt').exists() && newData.child('turnStartedAt').val() === data.child('turnStartedAt').val())";

test('RED 5: rated active room, participant sets arbitrary turnStartedAt -- Guard B must DENY', () => {
  const before = baseRoom({ turnStartedAt: 1_700_000_050_000 });
  const after = Object.assign({}, before, { turnStartedAt: 1_699_999_000_000 });
  const allowed = evalRule(GUARD_B, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowed, false);
});

test('GREEN: rated active room, srv_settlement sets a fresh turnStartedAt -- Guard B must ALLOW', () => {
  const before = baseRoom({ turnStartedAt: 1_700_000_050_000 });
  const after = Object.assign({}, before, { turnStartedAt: NOW });
  const allowed = evalRule(GUARD_B, { authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowed, true);
});

test('GREEN (regression): unrated room, participant sets any turnStartedAt -- Guard B must ALLOW', () => {
  const before = { status: 'active', createdAt: 1, matchNumber: 0, turnStartedAt: 1 };
  const after = Object.assign({}, before, { turnStartedAt: NOW });
  const allowed = evalRule(GUARD_B, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowed, true);
});

// ---------- Presence parent-guard ----------
const PRESENCE_GUARD = "newData.hasChildren(['online']) && ((newData.child('online').val() === true && newData.child('onlineSince').isNumber() && newData.child('onlineSince').val() <= now && newData.child('onlineSince').val() > now - 10000 && newData.child('absentSince').val() === null) || (newData.child('online').val() === false && newData.child('absentSince').isNumber() && newData.child('absentSince').val() <= now && newData.child('absentSince').val() > now - 10000 && newData.child('onlineSince').val() === data.child('onlineSince').val()) || (newData.child('online').val() === data.child('online').val() && newData.child('onlineSince').val() === data.child('onlineSince').val() && newData.child('absentSince').val() === data.child('absentSince').val()))";

test('A. offline->online: absentSince cleared + online=true, fresh onlineSince -> ALLOW', () => {
  const before = { online: false, absentSince: NOW - 70000, onlineSince: NOW - 200000, lastSeen: NOW - 70000 };
  const after = { online: true, absentSince: null, onlineSince: NOW, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, { rootTree: before, rootTree2: after, now: NOW }), true);
});

test('B. absentSince cleared while online=false -> DENY', () => {
  const before = { online: false, absentSince: NOW - 70000, onlineSince: NOW - 200000 };
  const after = { online: false, absentSince: null, onlineSince: NOW - 200000 };
  assert.equal(evalRule(PRESENCE_GUARD, { rootTree: before, rootTree2: after, now: NOW }), false);
});

test('C. onlineSince deleted -> DENY', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000 };
  const after = { online: true, absentSince: null };
  assert.equal(evalRule(PRESENCE_GUARD, { rootTree: before, rootTree2: after, now: NOW }), false);
});

test('D. long-lived onlineSince unchanged (heartbeat touches only lastSeen) -> ALLOW', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000, lastSeen: NOW - 4000 };
  const after = { online: true, absentSince: null, onlineSince: NOW - 200000, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, { rootTree: before, rootTree2: after, now: NOW }), true);
});

test('E. forged historical onlineSince replacement (online stays true, value outside now-window) -> DENY', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000 };
  const after = { online: true, absentSince: null, onlineSince: NOW - 500000 };
  assert.equal(evalRule(PRESENCE_GUARD, { rootTree: before, rootTree2: after, now: NOW }), false);
});

test('F. regression: real setupPresence() payload (all four fields fresh together) -> ALLOW', () => {
  const before = { online: false, absentSince: NOW - 300000, onlineSince: NOW - 900000, lastSeen: NOW - 300000 };
  const after = { online: true, absentSince: null, onlineSince: NOW, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, { rootTree: before, rootTree2: after, now: NOW }), true);
});

test('H. regression: real onDisconnect payload (online:false + absentSince fresh, onlineSince untouched) -> ALLOW', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 900000, lastSeen: NOW - 4000 };
  const after = { online: false, absentSince: NOW, onlineSince: NOW - 900000, lastSeen: NOW - 4000 };
  assert.equal(evalRule(PRESENCE_GUARD, { rootTree: before, rootTree2: after, now: NOW }), true);
});

// ---------- ratedTerminal create-only ----------
const RT_WRITE = "auth != null && auth.uid === 'srv_settlement' && !data.exists() && newData.exists()";

test('ratedTerminal: first create -> ALLOW', () => {
  const allowed = evalRule(RT_WRITE, { authUid: 'srv_settlement', rootTree: null, rootTree2: { requestId: 'r1' }, now: NOW });
  assert.equal(allowed, true);
});

test('ratedTerminal: overwrite with different content -> DENY', () => {
  const allowed = evalRule(RT_WRITE, { authUid: 'srv_settlement', rootTree: { requestId: 'r1' }, rootTree2: { requestId: 'r2' }, now: NOW });
  assert.equal(allowed, false);
});

test('ratedTerminal: overwrite with IDENTICAL content -> still DENY (Rules-level is strict; idempotency lives in Worker)', () => {
  const allowed = evalRule(RT_WRITE, { authUid: 'srv_settlement', rootTree: { requestId: 'r1' }, rootTree2: { requestId: 'r1' }, now: NOW });
  assert.equal(allowed, false);
});

test('ratedTerminal: delete existing claim -> DENY', () => {
  const allowed = evalRule(RT_WRITE, { authUid: 'srv_settlement', rootTree: { requestId: 'r1' }, rootTree2: null, now: NOW });
  assert.equal(allowed, false);
});

test('ratedTerminal: non-srv_settlement caller, first create attempt -> DENY', () => {
  const allowed = evalRule(RT_WRITE, { authUid: 'tg_111', rootTree: null, rootTree2: { requestId: 'r1' }, now: NOW });
  assert.equal(allowed, false);
});

test('ratedTerminal schema now requires winnerId/loserId/seq (found missing before commit, fixed): a real claimTechnicalOutcome-shaped claim satisfies it, an old-shaped one does not', () => {
  const rtValidate = REAL_RULES.rules.ratedTerminal['$matchId']['.validate'];
  const fullClaim = {
    matchId: 'M1', roomCode: 'ABC123', source: 'technical', kind: 'disconnect',
    requestId: 'r1', winnerId: 'tg_111', loserId: 'tg_222', seq: '000005', createdAt: 1700000000000
  };
  const incompleteClaim = { matchId: 'M1', roomCode: 'ABC123', source: 'technical', kind: 'disconnect', requestId: 'r1', createdAt: 1700000000000 };
  const allowedFull = evalRule(rtValidate, { rootTree: null, rootTree2: fullClaim, now: NOW });
  const allowedIncomplete = evalRule(rtValidate, { rootTree: null, rootTree2: incompleteClaim, now: NOW });
  assert.equal(allowedFull, true);
  assert.equal(allowedIncomplete, false);
});

test('HARNESS REGRESSION (found on PR #6 real Firebase Emulator CI): calling .matches() directly on a RuleDataSnapshot (no .val()) must THROW in this harness, exactly like the real emulator rejects it with "No such method/property \'matches\'" -- proves the harness can no longer give a false GREEN for this class of mistake', () => {
  const brokenPattern = "newData.child('seq').matches(/^[0-9]{6}$/)";
  assert.throws(() => {
    evalRule(brokenPattern, { rootTree: null, rootTree2: { seq: '000005' }, now: NOW });
  }, /is not a function/, 'FakeSnapshot must NOT expose .matches() -- it does not exist on real RuleDataSnapshot');
});

test('HARNESS REGRESSION: the two REAL, valid .matches() forms both still work -- $wildcard.matches(...) directly, and newData.child(...).val().matches(...) after unwrapping', () => {
  const wildcardForm = evalRule('$seq.matches(/^[0-9]{6}$/)', { rootTree: null, rootTree2: {}, now: NOW, wildcards: { $seq: '000005' } });
  const valForm = evalRule("newData.child('seq').val().matches(/^[0-9]{6}$/)", { rootTree: null, rootTree2: { seq: '000005' }, now: NOW });
  assert.equal(wildcardForm, true);
  assert.equal(valForm, true);
});

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
const { createInitialPieces } = require('../../shared/game-engine.js');

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

test('GREEN-PRODUCTION-FIX 2: the SAME onlineSince forgery from RED-CURRENT-MAIN 2, evaluated against the real production presence/light/.validate in a RATED room -- now denied', () => {
  const before = { ratedMatchId: 'M1', presence: { light: { online: true, absentSince: null, onlineSince: NOW - 200000 } } };
  const after = { ratedMatchId: 'M1', presence: { light: { online: true, absentSince: null, onlineSince: NOW - 500000 } } };
  const allowedNow = evalRule(REAL_PRESENCE_VALIDATE, { rootTree: before, rootTree2: after, now: NOW, dataPath: ['presence', 'light'] });
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

// ---------- PRODUCTION REGRESSION (found via live human-vs-human test after deploy) ----------
// Root cause: finalizePointer()'s presence-refresh (this session, closing the
// pre-registration presence-forge gap) writes presence/light|dark/onlineSince
// as PART of the SAME combined PATCH that publishes ratedMatchId. But the
// PRE-EXISTING (pre-#23) srv_settlement branch of $room/.write required ALL
// presence fields to remain byte-identical unchanged for ANY srv_settlement
// write to $room to be permitted -- with an exemption already present for
// ratingsAtStart when ratedMatchId genuinely changes, but NOT for presence.
// This meant the registration PATCH was denied wholesale, ratedMatchId never
// published, and the client's canMutateRatedGameplay() gate then permanently
// blocked move/resign/draw for the whole room -- exactly the reported symptom.
// Fix: move presence-unchanged inside the SAME "ratedMatchId changing"
// exemption already used for ratingsAtStart (0 character length change --
// restructured, not added, given $room/.write's tight budget).
const REAL_ROOM_WRITE = REAL_RULES.rules.rooms['$room']['.write'];

test('PRODUCTION REGRESSION FIX: srv_settlement registration PATCH (ratedMatchId publish + presence onlineSince refresh together) is now ALLOWED', () => {
  const NOW = 1_789_398_366_564;
  const MATCH_ID = 'elo_ABC123_' + NOW + '_0';
  const before = {
    players: { light: { id: 'tg_111', name: 'Ilyusha' }, dark: { id: 'tg_222', name: 'Tatiana' } },
    createdAt: NOW, matchNumber: 0, groupId: 'g1', timeControlSeconds: 0,
    presence: { light: { online: true, lastSeen: NOW }, dark: { online: true, lastSeen: NOW } }
  };
  const after = JSON.parse(JSON.stringify(before));
  after.ratedMatchId = MATCH_ID;
  after.ratingsAtStart = { light: 1200, dark: 1180 };
  after.presence.light.onlineSince = NOW;
  after.presence.dark.onlineSince = NOW;
  const allowed = evalRule(REAL_ROOM_WRITE, { authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowed, true, 'this exact combined PATCH is what a real registration performs -- must be allowed');
});

test('PRODUCTION REGRESSION FIX: security preserved -- srv_settlement CANNOT tamper with presence when ratedMatchId is NOT changing (ordinary move)', () => {
  const NOW = 1_789_398_366_564;
  const before = {
    players: { light: { id: 'tg_111', name: 'A' }, dark: { id: 'tg_222', name: 'B' } },
    createdAt: NOW, matchNumber: 0, groupId: 'g1', timeControlSeconds: 0,
    ratedMatchId: 'M1', ratingsAtStart: { light: 1200, dark: 1180 },
    presence: { light: { online: true, onlineSince: NOW - 200000 }, dark: { online: true, onlineSince: NOW - 200000 } }
  };
  const after = JSON.parse(JSON.stringify(before));
  after.presence.light.onlineSince = NOW; // ratedMatchId unchanged, but presence tampered with
  const allowed = evalRule(REAL_ROOM_WRITE, { authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowed, false);
});

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

// ---------- Guard B: turnStartedAt pin (unchanged OR fresh -- found on review: bare "unchanged" broke a pre-existing, intentionally-legitimate "participant completes an ordinary move" case) ----------
const GUARD_B = "auth != null && auth.uid === 'srv_settlement' || !data.exists() || !data.child('ratedMatchId').exists() || (newData.child('turnStartedAt').exists() === data.child('turnStartedAt').exists() && newData.child('turnStartedAt').val() === data.child('turnStartedAt').val()) || (newData.child('turnStartedAt').isNumber() && newData.child('turnStartedAt').val() <= now && newData.child('turnStartedAt').val() > now - 10000)";

test('RED 5: rated active room, participant backdates turnStartedAt far outside the fresh window -- Guard B must DENY (the actual attack this guard exists for)', () => {
  const before = baseRoom({ turnStartedAt: 1_700_000_050_000 });
  const after = Object.assign({}, before, { turnStartedAt: 1_699_999_000_000 });
  const allowed = evalRule(GUARD_B, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowed, false);
});

test('GREEN: rated active room, participant sets a genuinely FRESH turnStartedAt (ordinary move completion) -- Guard B must ALLOW (found missing before commit, fixed)', () => {
  const before = baseRoom({ turnStartedAt: 1_700_000_050_000 });
  const after = Object.assign({}, before, { turnStartedAt: NOW });
  const allowed = evalRule(GUARD_B, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW });
  assert.equal(allowed, true);
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

// ---------- Presence parent-guard (scoped to rated rooms only) ----------
// Найдено на review (PR #6 не про это, но каскадом): бот-spectate,
// friend-invite room creation и их heartbeat-интервалы реально пишут
// online:true БЕЗ onlineSince -- ни один из них никогда не имеет
// ratedMatchId в этот момент (бот-игры не рейтинговые; ожидание друга
// начинается ДО публикации ratedMatchId). Строгий now-window нужен
// ТОЛЬКО там, где решает Elo-исход технического дисконнекта -- то есть
// в рейтинговых комнатах. Тот же паттерн, что уже применён к Guard A/B/
// turnStartedAt.
const PRESENCE_GUARD = "newData.hasChildren(['online']) && (!newData.parent().parent().child('ratedMatchId').exists() || ((newData.child('online').val() === true && newData.child('onlineSince').isNumber() && newData.child('onlineSince').val() <= now && newData.child('onlineSince').val() > now - 10000 && newData.child('absentSince').val() === null) || (newData.child('online').val() === false && newData.child('absentSince').isNumber() && newData.child('absentSince').val() <= now && newData.child('absentSince').val() > now - 10000 && newData.child('onlineSince').val() === data.child('onlineSince').val()) || (newData.child('online').val() === data.child('online').val() && newData.child('onlineSince').val() === data.child('onlineSince').val() && newData.child('absentSince').val() === data.child('absentSince').val())))";

function presenceFixture(ratedMatchId, beforeLight, afterLight) {
  const before = ratedMatchId === undefined ? { presence: { light: beforeLight } } : { ratedMatchId, presence: { light: beforeLight } };
  const after = ratedMatchId === undefined ? { presence: { light: afterLight } } : { ratedMatchId, presence: { light: afterLight } };
  return { rootTree: before, rootTree2: after, now: NOW, dataPath: ['presence', 'light'] };
}

test('A. RATED room, offline->online: absentSince cleared + online=true, fresh onlineSince -> ALLOW', () => {
  const before = { online: false, absentSince: NOW - 70000, onlineSince: NOW - 200000, lastSeen: NOW - 70000 };
  const after = { online: true, absentSince: null, onlineSince: NOW, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), true);
});

test('B. RATED room, absentSince cleared while online=false -> DENY', () => {
  const before = { online: false, absentSince: NOW - 70000, onlineSince: NOW - 200000 };
  const after = { online: false, absentSince: null, onlineSince: NOW - 200000 };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), false);
});

test('C. RATED room, onlineSince deleted -> DENY', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000 };
  const after = { online: true, absentSince: null };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), false);
});

test('D. RATED room, long-lived onlineSince unchanged (heartbeat touches only lastSeen) -> ALLOW', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000, lastSeen: NOW - 4000 };
  const after = { online: true, absentSince: null, onlineSince: NOW - 200000, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), true);
});

test('E. RATED room, forged historical onlineSince replacement (online stays true, value outside now-window) -> DENY -- the security property this guard exists for', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 200000 };
  const after = { online: true, absentSince: null, onlineSince: NOW - 500000 };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), false);
});

test('F. RATED room, regression: real setupPresence() payload (all four fields fresh together) -> ALLOW', () => {
  const before = { online: false, absentSince: NOW - 300000, onlineSince: NOW - 900000, lastSeen: NOW - 300000 };
  const after = { online: true, absentSince: null, onlineSince: NOW, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), true);
});

test('H. RATED room, regression: real onDisconnect payload (online:false + absentSince fresh, onlineSince untouched) -> ALLOW', () => {
  const before = { online: true, absentSince: null, onlineSince: NOW - 900000, lastSeen: NOW - 4000 };
  const after = { online: false, absentSince: NOW, onlineSince: NOW - 900000, lastSeen: NOW - 4000 };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), true);
});

// ---------- Production incompatibility found on review: unrated exemption ----------

test('PRODUCTION-FIX: bot-spectate/mirrorCommittedStateToSpectateRoom shape (online:true + lastSeen only, NO onlineSince, NO ratedMatchId) -> ALLOW', () => {
  const after = { online: true, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture(undefined, undefined, after)), true);
});

test('PRODUCTION-FIX: createRoomAndShowWaiting (friend-invite) shape (online:true + lastSeen only, room not yet rated) -> ALLOW', () => {
  const after = { online: true, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture(undefined, undefined, after)), true);
});

test('PRODUCTION-FIX: botSpectatePresenceInterval/startOwnerPresenceHeartbeat heartbeat (wholesale online:true+lastSeen replace, erasing a previously-set onlineSince, unrated) -> ALLOW', () => {
  const before = { online: true, onlineSince: NOW - 900000, lastSeen: NOW - 4000 };
  const after = { online: true, lastSeen: NOW }; // .update() replaces this sub-object wholesale, onlineSince disappears
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture(undefined, before, after)), true);
});

test('SECURITY REGRESSION: the SAME onlineSince-erasing heartbeat shape, but the room IS rated -> DENY (unrated exemption must not leak into rated rooms)', () => {
  const before = { online: true, onlineSince: NOW - 900000, lastSeen: NOW - 4000 };
  const after = { online: true, lastSeen: NOW };
  assert.equal(evalRule(PRESENCE_GUARD, presenceFixture('M1', before, after)), false);
});

// ---------- CORE INVARIANT (found on review): pre-registration forge must not survive ----------
// Closing the gap requires TWO things together, tested end-to-end below:
//   1. srv_settlement, and ONLY srv_settlement, may refresh onlineSince/absentSince
//      to a fresh value SPECIFICALLY when ratedMatchId is genuinely transitioning
//      (registration/rematch) -- finalizePointer() does this as part of its own
//      atomic PATCH, so there is no window where ratedMatchId is visible without
//      the refresh having already applied (same commit).
//   2. Once ratedMatchId exists, the already-established strict now-window (tested
//      above) prevents ANY further forging by a participant.
const REAL_PRESENCE_WRITE = REAL_RULES.rules.rooms['$room'].presence.light['.write'];

function fullPresenceCheck(authUid, before, after, dataPath) {
  const w = evalRule(REAL_PRESENCE_WRITE, { authUid, rootTree: before, rootTree2: after, now: NOW, dataPath });
  const v = evalRule(REAL_PRESENCE_VALIDATE, { authUid, rootTree: before, rootTree2: after, now: NOW, dataPath });
  return w && v;
}

test('CORE INVARIANT 1: srv_settlement CAN refresh onlineSince to a fresh value specifically during a genuine ratedMatchId transition (registration/rematch)', () => {
  const before = { ratedMatchId: null, presence: { light: { online: true, onlineSince: NOW - 999999999, absentSince: null, lastSeen: NOW - 500 } } };
  const after = { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW, absentSince: null, lastSeen: NOW - 500 } } };
  assert.equal(fullPresenceCheck('srv_settlement', before, after, ['presence', 'light']), true);
});

test('CORE INVARIANT 2: srv_settlement CANNOT touch presence at all outside a genuine ratedMatchId transition (no standing write right)', () => {
  const before = { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW - 200000, absentSince: null, lastSeen: NOW - 500 } } };
  const after = { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW, absentSince: null, lastSeen: NOW - 500 } } };
  assert.equal(fullPresenceCheck('srv_settlement', before, after, ['presence', 'light']), false);
});

test('CORE INVARIANT 3: srv_settlement cannot flip online, or touch lastSeen, while refreshing during registration (narrowest possible grant)', () => {
  const flipOnline = fullPresenceCheck('srv_settlement',
    { ratedMatchId: null, presence: { light: { online: false, absentSince: NOW - 500, onlineSince: NOW - 999999999, lastSeen: NOW - 500 } } },
    { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW, absentSince: null, lastSeen: NOW - 500 } } },
    ['presence', 'light']);
  const touchLastSeen = fullPresenceCheck('srv_settlement',
    { ratedMatchId: null, presence: { light: { online: true, onlineSince: NOW - 999999999, absentSince: null, lastSeen: NOW - 999999999 } } },
    { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW, absentSince: null, lastSeen: NOW } } },
    ['presence', 'light']);
  const staleTimestamp = fullPresenceCheck('srv_settlement',
    { ratedMatchId: null, presence: { light: { online: true, onlineSince: NOW - 999999999, absentSince: null, lastSeen: NOW - 500 } } },
    { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW - 999999999, absentSince: null, lastSeen: NOW - 500 } } },
    ['presence', 'light']);
  assert.equal(flipOnline, false);
  assert.equal(touchLastSeen, false);
  assert.equal(staleTimestamp, false);
});

test('CORE INVARIANT 4 (regression): a genuine participant reconnect still works exactly as before -- srv_settlement grant does not interfere with the ordinary path', () => {
  const before = { ratedMatchId: 'M1', players: { light: { id: 'tg_111' }, dark: { id: 'tg_222' } }, presence: { light: { online: false, absentSince: NOW - 70000, onlineSince: NOW - 200000 } } };
  const after = { ratedMatchId: 'M1', players: { light: { id: 'tg_111' }, dark: { id: 'tg_222' } }, presence: { light: { online: true, absentSince: null, onlineSince: NOW } } };
  assert.equal(fullPresenceCheck('tg_111', before, after, ['presence', 'light']), true);
});

test('CORE INVARIANT 5 (end-to-end, the exact scenario the review described): pre-seeded ancient onlineSince survives untouched by finalizePointer -- UNLESS the refresh is also applied -- proving the refresh is what closes the gap, not a side effect', () => {
  // Модель: room до регистрации содержит forged-значение (записанное
  // участником, пока ratedMatchId ещё отсутствовал -- разрешено, доказано
  // отдельно в PRODUCTION-FIX тестах выше).
  const forgedRoom = { ratedMatchId: null, presence: { light: { online: true, onlineSince: NOW - 999999999, absentSince: null, lastSeen: NOW - 500 } } };

  // Вариант A: finalizePointer публикует ratedMatchId БЕЗ refresh presence
  // (гипотетическая "старая" реализация без исправления) -- forged-значение
  // остаётся, и room становится rated с этим значением нетронутым.
  const publishedWithoutRefresh = { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW - 999999999, absentSince: null, lastSeen: NOW - 500 } } };
  assert.equal(publishedWithoutRefresh.presence.light.onlineSince, forgedRoom.presence.light.onlineSince,
    'confirms the vulnerability shape: without a refresh, the forged value would survive registration untouched');

  // Вариант B: finalizePointer публикует ratedMatchId С refresh presence
  // (реализованное исправление) -- ОДИН atomic PATCH срабатывает как единое
  // целое: если бы кто-то попытался опубликовать ratedMatchId БЕЗ
  // одновременного refresh (то есть воспроизвести "старую" уязвимую форму
  // через сегодняшние Rules), это должно быть невозможно для не-фреш
  // значения -- но т.к. Rules это единый .validate на КОНКРЕТНОМ пути
  // presence/light, а не кросс-путевая проверка "ratedMatchId изменился,
  // значит presence обязан быть фреш" -- проверяем именно то, что worker
  // ОБЯЗАН включить refresh в тот же PATCH, и что PRESENCE САМ ПО СЕБЕ
  // (после регистрации) корректно требует свежести для любых ПОСЛЕДУЮЩИХ
  // попыток -- см. CORE INVARIANT 6.
  const refreshedAfterRegistration = fullPresenceCheck('srv_settlement', forgedRoom,
    { ratedMatchId: 'M1', presence: { light: { online: true, onlineSince: NOW, absentSince: null, lastSeen: NOW - 500 } } },
    ['presence', 'light']);
  assert.equal(refreshedAfterRegistration, true, 'srv_settlement refresh overwrites the forged value atomically with registration');
});

test('CORE INVARIANT 6: once rated (post-registration), the ALREADY-established strict window means even an untouched pre-registration forge can never again be freshly re-asserted by a participant -- claimTechnicalOutcome evidence is only ever as trustworthy as the LAST accepted write, which after this fix is always either a genuine participant reconnect or the registration-time refresh', () => {
  // Симулирует: worker правильно сделал refresh при регистрации (см. Invariant 1/5).
  // Теперь participant пытается СНОВА подменить onlineSince на forged-значение,
  // уже находясь в rated-комнате -- уже доказано отдельно (Attack E выше), но
  // повторяем здесь как часть цельного invariant-набора для полноты.
  const before = { ratedMatchId: 'M1', players: { light: { id: 'tg_111' }, dark: { id: 'tg_222' } }, presence: { light: { online: true, onlineSince: NOW, absentSince: null } } };
  const after = { ratedMatchId: 'M1', players: { light: { id: 'tg_111' }, dark: { id: 'tg_222' } }, presence: { light: { online: true, onlineSince: NOW - 999999999, absentSince: null } } };
  assert.equal(fullPresenceCheck('tg_111', before, after, ['presence', 'light']), false);
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

// ---------- disconnect-specific $room/.validate schema conflict (found via live production test) ----------
// Root cause: a pre-#23 (commit 2a9e296) schema conjunct in $room/.validate
// required newData.hasChild('result') === (winReason==='disconnect') -- i.e.
// whenever winReason is 'disconnect', a matching room.result object MUST
// also exist. This protected the LEGACY unrated participant-direct-write
// disconnect path (which does write result, verified against live presence
// by the separate `result` node's own .validate). #23's rated technical
// path (commit 0955d96, claimTechnicalOutcome/commitTerminalOutcome) was
// deliberately designed to skip result entirely -- unified with the plain
// protected-outcome shape (winner/winReason/status only), matching every
// OTHER protected terminal outcome (resign, draw). This was a documented,
// intentional design choice (see the comment above REAL_EVENT_WRITE) but
// this ONE schema conjunct was never updated to match it, silently denying
// every rated technical DISCONNECT commit since #23's very first commit.
// timeout is a distinct winReason value, so it was never subject to this
// conjunct at all (verified separately below).
//
// Fix: exempt srv_settlement from this legacy schema requirement -- same
// trust-boundary pattern used by every other #23 guard. Does not touch the
// `result` node's own .validate (unaffected), Guard A/B, G1/G2, or any
// other room-write conjunct.

function ratedRoomFixture(overrides = {}) {
  const MATCH_ID = 'elo_ABC123_1700000000000_0';
  return Object.assign({
    players: { light: { id: 'tg_111', name: 'Ilyusha' }, dark: { id: 'tg_222', name: 'Tatiana' } },
    status: 'active', createdAt: NOW - 500000, matchNumber: 0, groupId: 'g1', timeControlSeconds: 0,
    pieces: createInitialPieces(), turn: 'dark', moveCount: 5,
    ratedMatchId: MATCH_ID, ratingsAtStart: { light: 1200, dark: 1180 },
    turnStartedAt: NOW - 70000,
    ratedReplay: { matchId: MATCH_ID, acceptedSeq: 5, boardSeq: 5 },
    presence: {
      light: { online: true, onlineSince: NOW - 400000, absentSince: null, lastSeen: NOW - 500 },
      dark: { online: false, onlineSince: NOW - 400000, absentSince: NOW - 70000, lastSeen: NOW - 70000 }
    }
  }, overrides);
}

function combinedRoomAllowed(before, after) {
  const w = evalRule(REAL_ROOM_WRITE, { authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  const v = evalRule(REAL_ROOM_VALIDATE, { authUid: 'srv_settlement', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  return w && v;
}

test('DISCONNECT REGRESSION FIX: rated technical DISCONNECT commit (winner+winReason+status, no result) is now ALLOWED -- the exact PATCH commitTerminalOutcome() performs', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, { winner: 'light', winReason: 'disconnect', status: 'finished' });
  assert.equal(combinedRoomAllowed(before, after), true,
    'this is the real combined write commitTerminalOutcome() makes for a genuine disconnect -- was silently denied since #23\'s first commit');
});

test('DISCONNECT REGRESSION: rated TIMEOUT commit was already ALLOWED before this fix and remains so -- distinct winReason value, never subject to this conjunct', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, { winner: 'light', winReason: 'timeout', status: 'finished' });
  assert.equal(combinedRoomAllowed(before, after), true);
});

test('DISCONNECT REGRESSION FIX: normal move (srv_settlement) unaffected', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, {
    pieces: { c3: { color: 'dark', king: false } }, turn: 'light', moveCount: 6, turnStartedAt: NOW,
    ratedReplay: { matchId: before.ratedMatchId, acceptedSeq: 6, boardSeq: 6 }
  });
  assert.equal(combinedRoomAllowed(before, after), true);
});

test('DISCONNECT REGRESSION FIX: draw accept (terminal, srv_settlement) unaffected', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, { winner: null, winReason: 'draw', status: 'finished' });
  assert.equal(combinedRoomAllowed(before, after), true);
});

test('DISCONNECT REGRESSION FIX: draw offer (direct participant write) unaffected', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, { drawProposal: { by: 'light', name: 'Ilyusha' } });
  const w = evalRule(REAL_ROOM_WRITE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  const v = evalRule(REAL_ROOM_VALIDATE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  assert.equal(w && v, true);
});

test('DISCONNECT REGRESSION FIX: resign (terminal, srv_settlement) unaffected', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, { winner: 'dark', winReason: 'resign', status: 'finished' });
  assert.equal(combinedRoomAllowed(before, after), true);
});

test('DISCONNECT REGRESSION FIX: rated registration (finalizePointer, incl. presence refresh) unaffected', () => {
  const MATCH_ID = 'elo_ABC123_1700000000000_0';
  const before = {
    players: { light: { id: 'tg_111', name: 'Ilyusha' }, dark: { id: 'tg_222', name: 'Tatiana' } },
    createdAt: NOW, matchNumber: 0, groupId: 'g1', timeControlSeconds: 0,
    status: 'active', turn: 'light', pieces: createInitialPieces(), moveCount: 0,
    presence: { light: { online: true, lastSeen: NOW }, dark: { online: true, lastSeen: NOW } }
  };
  const after = Object.assign({}, before, {
    ratedMatchId: MATCH_ID, ratingsAtStart: { light: 1200, dark: 1180 },
    presence: {
      light: Object.assign({}, before.presence.light, { onlineSince: NOW }),
      dark: Object.assign({}, before.presence.dark, { onlineSince: NOW })
    }
  });
  assert.equal(combinedRoomAllowed(before, after), true);
});

test('DISCONNECT REGRESSION FIX: legacy unrated disconnect WITHOUT result is still DENIED (participant, not srv_settlement -- exemption does not leak)', () => {
  const before = {
    players: { light: { id: 'tg_111', name: 'A' }, dark: { id: 'tg_222', name: 'B' } },
    status: 'active', createdAt: NOW - 500000, matchNumber: 0, turn: 'light',
    pieces: createInitialPieces(),
    presence: { light: { online: true, lastSeen: NOW - 500 }, dark: { online: false, lastSeen: NOW - 70000 } }
  };
  const after = Object.assign({}, before, { winner: 'light', winReason: 'disconnect', status: 'finished' });
  const w = evalRule(REAL_ROOM_WRITE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  const v = evalRule(REAL_ROOM_VALIDATE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  assert.equal(w && v, false);
});

test('DISCONNECT REGRESSION FIX: malicious srv_settlement tampering an unrelated room field (players/light/id) in the same commit is still DENIED', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, {
    players: { light: { id: 'tg_999', name: 'Ilyusha' }, dark: before.players.dark },
    pieces: { c3: { color: 'dark', king: false } }, turn: 'light', moveCount: 6, turnStartedAt: NOW,
    ratedReplay: { matchId: before.ratedMatchId, acceptedSeq: 6, boardSeq: 6 }
  });
  assert.equal(combinedRoomAllowed(before, after), false);
});

test('DISCONNECT REGRESSION FIX: a participant impersonating the server (faking a technical disconnect outcome themselves) is still DENIED', () => {
  const before = ratedRoomFixture();
  const after = Object.assign({}, before, { winner: 'light', winReason: 'disconnect', status: 'finished' });
  const w = evalRule(REAL_ROOM_WRITE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  const v = evalRule(REAL_ROOM_VALIDATE, { authUid: 'tg_111', rootTree: before, rootTree2: after, now: NOW, wildcards: { $room: 'ABC123' } });
  assert.equal(w && v, false);
});

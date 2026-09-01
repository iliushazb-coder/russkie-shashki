// Independent ChatGPT R3 review tests for CLIENT-C1-v194-R2 -> R3.
// Focus: failures not covered by Claude R2 suites.
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
  if (cond) { passed++; console.log('  ✅ ' + name); }
  else { failed++; console.log('  ❌ ' + name + (info ? ' — ' + info : '')); }
}
function grab(name) {
  const m = new RegExp('^(?:async )?function ' + name + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
  if (!m) throw new Error('missing function ' + name);
  return m[0];
}
function sliceBetween(a,b) {
  const i=SRC.indexOf(a), j=SRC.indexOf(b,i+1);
  if(i<0||j<0) throw new Error('slice markers missing: '+a+' / '+b);
  return SRC.slice(i,j);
}

(async function main(){
  console.log('=== R3.1 rating snapshot must rerender immediately ===');
  eval(grab('computeGameSignature'));
  const base = { moveCount:0, winner:null, winReason:null, players:{light:{id:'tg_1'},dark:{id:'tg_2'}}, rematchProposal:null, drawProposal:null, turnStartedAt:1, matchNumber:0, ratedMatchId:null, ratingsAtStart:null, status:'active' };
  const withRatings = JSON.parse(JSON.stringify(base));
  withRatings.ratedMatchId='elo_R_1_0'; withRatings.ratingsAtStart={light:1000,dark:1000};
  check('1.1 signature changes when Worker publishes ratingsAtStart/ratedMatchId', computeGameSignature(base) !== computeGameSignature(withRatings));
  check('1.2 signature explicitly contains ratingsAtStart', /ratingsAtStartPart/.test(grab('computeGameSignature')));

  console.log('\n=== R3.2 legacy/stale snapshot cannot fake Worker join success ===');
  eval(grab('buildEloMatchId'));
  eval(grab('ratedGenerationKey'));
  eval(grab('expectedRatedMatchIdForState'));
  eval(grab('registeredMatchIdForState'));
  global.roomCode='R'; global.isSpectator=false; global.currentState=null;
  global.ratedJoinState={}; global.canUseFirebase=()=>true; global.renderPlayerPanels=()=>{};
  global.RATED_JOIN_BACKOFF_MS=[1]; global.RATED_JOIN_BACKOFF_MAX_MS=1;
  global.roomOutcomeFinished=()=>false; global.isRatedJoinTerminalError=()=>false;
  let calls=0;
  global.callWorker=()=>{ calls++; return Promise.resolve({ok:true,matchId:'elo_R_123_1'}); };
  eval(grab('requestRatedJoin'));
  const staleRoom={matchNumber:1,createdAt:123,ratedMatchId:'elo_R_123_0',ratingsAtStart:{light:1000,dark:1000}};
  requestRatedJoin(staleRoom);
  await Promise.resolve(); await Promise.resolve();
  check('2.1 stale previous-generation ratedMatchId still calls Worker', calls===1, 'calls='+calls);
  calls=0; global.ratedJoinState={};
  const goodRoom={matchNumber:1,createdAt:123,ratedMatchId:'elo_R_123_1',ratingsAtStart:{light:1000,dark:1000}};
  requestRatedJoin(goodRoom);
  await Promise.resolve();
  check('2.2 exact canonical pointer + full snapshot shortcuts safely', calls===0);

  console.log('\n=== R3.3 settle contract/recovery ===');
  const freeze=grab('freezeSettlementContext');
  const settle=grab('requestSettlement');
  check('3.1 frozen context carries ratedMatchId', /ratedMatchId: ratedMatchId/.test(freeze));
  check('3.2 settle sends matchId to live Worker', /matchId: ctx\.ratedMatchId/.test(settle));
  check('3.3 settle and join use separate terminal classifiers', /isSettlementTerminalError\(error\)/.test(settle) && /isRatedJoinTerminalError\(error\)/.test(grab('requestRatedJoin')));
  const settleErrors=sliceBetween('const SETTLEMENT_TERMINAL_ERRORS = [','];\n\nfunction isSettlementTerminalError');
  check('3.4 receipt_mismatch is terminal', settleErrors.includes('receipt_mismatch'));
  check('3.5 match_not_finished is NOT terminal', !settleErrors.includes('match_not_finished'));
  check('3.6 successful/terminal settle consumes only same-generation UI marker', /finishOnlineResultMarkerForGeneration\(key\)/.test(settle));

  console.log('\n=== R3.4 no silent rating loss on destructive transition ===');
  const wait=grab('waitForSettlementBeforeRoomMutation');
  check('4.1 no 60-second forced reset/delete timeout', !/60000|Date\.now\(\) - started/.test(wait));
  check('4.2 generation change resolves changed (do not mutate N+1)', /resolve\("changed"\)/.test(wait));
  const accept=sliceBetween('btnRematchAccept.addEventListener','btnRematchDecline.addEventListener');
  check('4.3 rematch distinguishes blocked/changed before performRematchReset', /outcome === "blocked"/.test(accept) && /outcome === "changed"/.test(accept) && /performRematchReset\(generationAtAccept\)/.test(accept));
  const close=sliceBetween('btnCloseGame.addEventListener','function cleanupFinishedRoom');
  check('4.4 Close also waits before deleting finished room', /waitForSettlementBeforeRoomMutation\(\)[\s\S]*?if \(stillSameFinished\) \{[\s\S]*?cleanupFinishedRoom\(\)/.test(close));
  check('4.5 Close rechecks exact generation before cleanup', /stillSameFinished/.test(close) && /generationAtClick/.test(close));

  // Behavioral: if another device already changed generation while waiting,
  // common gate must resolve false rather than authorize another reset.
  global.isOnlineGame=true; global.isSpectator=false; global.roomCode='R';
  global.currentState={matchNumber:0,createdAt:123,ratingsAtStart:{light:1000,dark:1000},ratedMatchId:'elo_R_123_0'}; global.getRatedJoinPhase=()=> 'success';
  global.isSettlementSettled=()=>false; global.isSettlementTerminalFailed=()=>false;
  global.requestSettlement=()=>{}; global.rematchWaitNote={textContent:''}; global.t=(x)=>x;
  global.getSettlePhase=()=> 'retryWait';
  const realSetInterval=global.setInterval, realClearInterval=global.clearInterval;
  global.setInterval=(fn)=>{ setTimeout(()=>{ global.currentState={matchNumber:1}; fn(); },0); return 1; };
  global.clearInterval=()=>{};
  eval(grab('waitForSettlementBeforeRoomMutation'));
  const mayMutate = await waitForSettlementBeforeRoomMutation();
  check('4.6 behavior: changed generation returns changed', mayMutate==='changed');
  global.setInterval=realSetInterval; global.clearInterval=realClearInterval;

  console.log('\n=== R3.5 rating UI state cannot leak into rematch ===');
  check('5.1 startOnlineGame resets last settlement display', /resetSettlementDisplay\(\)/.test(grab('startOnlineGame')));
  const listenerArea=sliceBetween('const newSignature = computeGameSignature(newState);','// ELO: доложить свою половину');
  check('5.2 listener resets display when finished -> rematch generation', /currentState && currentState\.winner[\s\S]*resetSettlementDisplay\(\)/.test(listenerArea));

  console.log('\n=== R3.6 spectator and full room state carry rating generation ===');
  const spectator=sliceBetween('function watchGroupRoomAsSpectator','// ===== ВХОД ЧЕРЕЗ TELEGRAM =====');
  check('6.1 spectator receives matchNumber', /matchNumber: room\.matchNumber/.test(spectator));
  check('6.2 spectator receives ratedMatchId', /ratedMatchId:/.test(spectator));
  check('6.3 spectator receives ratingsAtStart', /ratingsAtStart: room\.ratingsAtStart/.test(spectator));

  console.log('\n=== R3.7 C1 contains no direct online stats/economy write residue ===');
  check('7.1 no direct stats/<uid> write helper remains', !/database\.ref\("stats\/"/.test(SRC));
  const runtimeish=SRC.split('\n').filter(l=>!l.trim().startsWith('//')).join('\n');
  check('7.2 no economy path in executable code', !/economy\//.test(runtimeish));
  check('7.3 no client eloMatches write', !/eloMatches\//.test(runtimeish));

  console.log('\n=== R3.8 rank state is cleared on each modal open ===');
  check('8.1 old rank cannot remain while new stats load', /function openStatsModal\(\)[\s\S]{0,180}statsYourRank\.textContent = ""/.test(SRC));

  console.log('\nИТОГ: '+passed+'/'+(passed+failed));
  process.exit(failed ? 1 : 0);
})().catch(e=>{ console.error(e); process.exit(1); });

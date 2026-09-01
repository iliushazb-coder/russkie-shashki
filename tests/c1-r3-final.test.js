// ChatGPT independent final review tests for C1 v194 R3.
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
let pass=0, fail=0;
function check(name, cond, info='') { if(cond){pass++; console.log('✅ '+name)} else {fail++; console.log('❌ '+name+(info?' — '+info:''))} }
function grab(name){ const m=new RegExp('^(?:async )?function '+name+'\\([\\s\\S]*?\\n\\}','m').exec(SRC); if(!m) throw new Error('missing '+name); return m[0]; }
function between(a,b){ const i=SRC.indexOf(a),j=SRC.indexOf(b,i+1); if(i<0||j<0) throw new Error('markers '+a+' / '+b); return SRC.slice(i,j); }

(async()=>{
console.log('=== AUTH STARTUP RACE ===');
{
  let ready=false, shown=0;
  global.canUseFirebase=()=>ready;
  global.authPhase='pending';
  global.authPromise=Promise.resolve().then(()=>{ready=true;});
  global.showInfoModal=()=>{shown++}; global.t=x=>x;
  eval(grab('requireFirebaseAuthAsync'));
  const ok=await requireFirebaseAuthAsync();
  check('A1 pending waits and continues automatically', ok===true && shown===0);
  ready=false; shown=0; global.authPhase='failed'; global.authPromise=null;
  const bad=await requireFirebaseAuthAsync();
  check('A2 real auth failure shows error', bad===false && shown===1);
  const boot=grab('bootstrapApp');
  check('A3 authPromise assigned before await', boot.indexOf('authPromise = (async')>=0 && boot.indexOf('authPromise = (async') < boot.indexOf('await authPromise'));
}

console.log('\n=== REGISTRATION GENERATION ===');
{
  eval(grab('buildEloMatchId'));
  eval(grab('expectedRatedMatchIdForState'));
  eval(grab('registeredMatchIdForState'));
  const good={createdAt:123,matchNumber:2,ratedMatchId:'elo_R_123_2',ratingsAtStart:{light:1000,dark:1001}};
  const stale={...good,ratedMatchId:'elo_R_123_1'};
  check('R1 canonical pointer + full snapshot registers', registeredMatchIdForState(good,'R')==='elo_R_123_2');
  check('R2 stale pointer rejected', registeredMatchIdForState(stale,'R')===null);
  check('R3 incomplete snapshot rejected', registeredMatchIdForState({...good,ratingsAtStart:{light:1000}},'R')===null);
  const gen=grab('ratedGenerationKey');
  check('R3a local generation key includes createdAt against room-code reuse', /createdAt/.test(gen) && /stamp/.test(gen));
  const ratingSeg=grab('ratingSegmentForColor');
  check('R3b rating segment is keyed by registered generation, not bare legacy snapshot', /registeredMatchIdForState/.test(ratingSeg));
  const sig=grab('computeGameSignature');
  check('R4 room signature includes pointer + snapshot + matchNumber', /ratedMatchIdPart/.test(sig)&&/ratingsAtStartPart/.test(sig)&&/matchNumberPart/.test(sig));
}

console.log('\n=== SERVER-ONLY RESULT PATH ===');
{
  const rec=grab('recordGameResult');
  check('S1 no direct online stats write', !/database\.ref\("stats\//.test(rec) && !/database\.ref\(statsPath/.test(rec));
  check('S2 bot stats path preserved', /recordBotGameResultIdempotent/.test(rec));
  check('S3 settle called for rated online result', /requestSettlement\(\)/.test(rec));
  const settle=grab('requestSettlement');
  check('S4 settle sends frozen matchId', /matchId: ctx\.ratedMatchId/.test(settle));
  const freeze=grab('freezeSettlementContext');
  check('S4b frozen color derives from room UID, not raw myColor', /lightId === myTelegramId/.test(freeze) && /darkId === myTelegramId/.test(freeze) && /myColor: frozenMyColor/.test(freeze));
  // Behavioral guard: createdAt must be initialized before it is used to build
  // the generation key. A previous review version passed node --check but threw
  // ReferenceError at runtime because const createdAt was referenced in its TDZ.
  eval(grab('ratedGenerationKey'));
  eval(grab('buildEloMatchId'));
  const runFreeze = new Function('currentState','roomCode','ratedJoinState','myTelegramId','ratedGenerationKey','buildEloMatchId',
      freeze + '; return freezeSettlementContext();');
  const frozen = runFreeze({createdAt:123,matchNumber:2,ratedMatchId:'elo_R_123_2',ratingsAtStart:{light:1100,dark:900},players:{light:{id:'tg_1'},dark:{id:'tg_2'}}},
      'R', {'R_123_2':{phase:'success',matchId:'elo_R_123_2'}}, 'tg_1', ratedGenerationKey, buildEloMatchId);
  check('S4c freezeSettlementContext executes without TDZ and freezes exact generation', frozen && frozen.createdAt===123 && frozen.matchNumber===2 && frozen.ratedMatchId==='elo_R_123_2' && frozen.myColor==='light');
  check('S5 room pointer can reconstruct lost local join-state', /registeredMatchIdForState\(currentState, roomCode\)/.test(settle));
  check('S6 transient settle has retryWait/backoff', /phase: "retryWait"/.test(settle) && /SETTLE_BACKOFF_MS/.test(settle));
  check('S7 match_not_finished is not terminal', !between('const SETTLEMENT_TERMINAL_ERRORS = [','];\n\nfunction isSettlementTerminalError').includes('match_not_finished'));
  const finishMarker = grab('finishOnlineResultMarkerForGeneration');
  check('S8 settlement marker finalizer is generation-scoped', /currentKey !== key/.test(finishMarker));
  const runFinish = new Function('currentState','roomCode','statsInFlightOnlineMarker','statsRecordedForRoom','ratedGenerationKey',
      finishMarker + '; finishOnlineResultMarkerForGeneration("R_111_0"); return {inFlight:statsInFlightOnlineMarker, recorded:statsRecordedForRoom};');
  const markerRace = runFinish({createdAt:111,matchNumber:1}, 'R', 'marker_N1', null, ratedGenerationKey);
  check('S9 late N response cannot consume N+1 marker', markerRace.inFlight==='marker_N1' && markerRace.recorded===null);
}

console.log('\n=== DESTRUCTIVE MUTATION SAFETY ===');
{
  const safe=grab('isFinishedGenerationSafeToDestroy');
  check('D1 registered match requires completed settlement', /return isSettlementSettled\(key\)/.test(safe));
  check('D2 terminal failure is NOT treated as safe', !/isSettlementTerminalFailed/.test(safe));
  const wait=grab('waitForSettlementBeforeRoomMutation');
  check('D3 terminal settle returns blocked', /isSettlementTerminalFailed\(key\)[\s\S]*?"blocked"/.test(wait));
  check('D4 no forced 60s destructive timeout', !/60000|Date\.now\(\) - started/.test(wait));
  check('D5 generation change is distinct from success', /resolve\("changed"\)/.test(wait));
  const reset=grab('performRematchReset');
  check('D6 performRematchReset has defense-in-depth settlement guard', /isFinishedGenerationSafeToDestroy\(\)/.test(reset));
  const cleanup=grab('cleanupFinishedRoom');
  check('D7 cleanupFinishedRoom has defense-in-depth settlement guard', /isFinishedGenerationSafeToDestroy\(\)/.test(cleanup));
  const absence=grab('checkOpponentAbsence');
  check('D8 rematch-timeout cleanup also preserves unsettled outcome', /isFinishedGenerationSafeToDestroy\(\)/.test(absence));
  check('D9 cleanup invalidates room locally after remove to prevent ghost writes', /isOnlineGame = false;[\s\S]*roomCode = null;/.test(cleanup));
}

console.log('\n=== MIXED C1 <-> v193 REMATCH ===');
{
  const proposal=between('btnNewGame.addEventListener','function performRematchReset');
  check('M1 C1 proposer waits BEFORE publishing rematchProposal', proposal.indexOf('waitForSettlementBeforeRoomMutation()') < proposal.indexOf('/rematchProposal'));
  check('M2 blocked settlement does not publish proposal', /outcome === "blocked"[\s\S]*?return;/.test(proposal));
  const accept=between('btnRematchAccept.addEventListener','btnRematchDecline.addEventListener');
  check('M3 C1 acceptor waits before reset', accept.indexOf('waitForSettlementBeforeRematch()') < accept.indexOf('performRematchReset('));
  check('M3b accept rechecks captured generation before reset', /generationAtAccept/.test(accept) && /stillOurFinishedGeneration/.test(accept) && /performRematchReset\(generationAtAccept\)/.test(accept));
  check('M4 blocked settlement does not enter/reset rematch', /outcome === "blocked"[\s\S]*?return "blocked"/.test(accept) && /if \(outcome === "blocked" \|\| !roomCode\) return;/.test(accept));
  const reset=grab('performRematchReset');
  check('M4b reset itself rejects active/stale generation to prevent N+2', /!currentState \|\| !currentState\.winner \|\| !roomCode/.test(reset) && /expectedGenerationKey/.test(reset));
  const close=between('btnCloseGame.addEventListener','function cleanupFinishedRoom');
  check('M5 Close deletes only on safe settlement', /outcome === "safe"/.test(close) && /if \(stillSameFinished\)[\s\S]*cleanupFinishedRoom/.test(close));
}

console.log('\n=== RATING UI ===');
{
  const apply=grab('applySettlementResult');
  check('U1 unconfirmed response preserves before rating', /confirmed: false[\s\S]*before:/.test(apply));
  const render=grab('renderEndGameModal');
  check('U2 unconfirmed UI shows ⭐before and honest text', /beforeLine/.test(render) && /rating_change_unconfirmed/.test(render) && /rating_check_in_stats/.test(render));
  check('U3 spectator/bot cannot inherit stale rating result', /!isOnlineGame \|\| isBotGame \|\| isSpectator/.test(render));
  check('U4 multiline result has CSS support', /\.end-game-rating[\s\S]*white-space:\s*pre-line/.test(CSS));
  check('U5 rank wording localized as “of/из/su”', (SRC.match(/stats_rank_of:/g)||[]).length===3);
  check('U6 stats modal uses localized rank separator', /t\("stats_rank_of"\)/.test(grab('openStatsModal')));
}

console.log('\n=== REMOVED ECONOMY / PRESERVED SAFETY ===');
{
  const runtime=SRC.split('\n').filter(x=>!x.trim().startsWith('//')).join('\n');
  check('C1 no economy path in executable client', !/economy\//.test(runtime));
  check('C2 no eloMatches direct client path', !/eloMatches\//.test(runtime));
  check('C3 getOnlineSessionMs remains', /function getOnlineSessionMs/.test(SRC) && /getOnlineSessionMs\(presence\[winnerColor\]\)/.test(SRC));
  check('C4 coin DOM is gone', !/coin-balance|coin-popup/.test(HTML));
  check('C5 cache bust v194/v15', /script\.js\?v=194/.test(HTML) && /style\.css\?v=15/.test(HTML));
  check('C6 no COIN_REWARDS executable residue', !/COIN_REWARDS/.test(SRC));
}

console.log(`\nFINAL ${pass}/${pass+fail}`);
process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});

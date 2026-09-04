const fs = require('fs');
const path = require('path');
const scriptPath = fs.existsSync(path.join(__dirname, 'script.js')) ? path.join(__dirname, 'script.js') : path.join(__dirname, '..', 'script.js');
const SRC = fs.readFileSync(scriptPath, 'utf8');
let passed = 0, failed = 0;
function check(n,c,d){ if(c){passed++;console.log('  ✅ '+n);}else{failed++;console.log('  ❌ '+n+(d?' — '+d:''));}}
function grab(name){
  const start = SRC.indexOf('function '+name+'(');
  if(start<0) throw new Error('missing '+name);
  let brace = SRC.indexOf('{', start), depth=0, str=null, esc=false;
  for(let i=brace;i<SRC.length;i++){
    const ch=SRC[i];
    if(str){ if(esc){esc=false;continue;} if(ch==='\\'){esc=true;continue;} if(ch===str)str=null; continue; }
    if(ch==='"'||ch==="'"||ch==='`'){str=ch;continue;}
    if(ch==='{') depth++; else if(ch==='}' && --depth===0) return SRC.slice(start,i+1);
  }
  throw new Error('unclosed '+name);
}
let dbCalls=[];
global.database={ref:function(p){dbCalls.push(String(p||'')); return {
  set:()=>Promise.resolve(), update:()=>Promise.resolve(), remove:()=>Promise.resolve(),
  once:()=>Promise.resolve({val:()=>null}), on:()=>{}, off:()=>{},
  transaction:()=>Promise.resolve({committed:true,snapshot:{val:()=>null}}),
  onDisconnect:()=>({update:()=>Promise.resolve(),remove:()=>Promise.resolve(),cancel:()=>Promise.resolve()})
};}};
global.firebase={database:{ServerValue:{TIMESTAMP:'TS',increment:d=>({inc:d})}}};
global.auth={currentUser:null,onIdTokenChanged:function(cb){global.__authCb=cb;}};
global.showInfoModal=()=>{}; global.t=k=>k;

eval(grab('canUseFirebase'));
console.log('=== AUTH GATE ===');
global.firebaseAuthReady=true; global.localOnlyBotGame=false; global.myTelegramId='tg_1';
auth.currentUser={uid:'tg_1'};
check('1. valid current Firebase uid opens gate', canUseFirebase()===true);
auth.currentUser=null;
check('2. currentUser null closes gate immediately', canUseFirebase()===false);
auth.currentUser={uid:'tg_2'};
check('3. uid mismatch closes gate immediately', canUseFirebase()===false);
auth.currentUser={uid:'tg_1'}; global.localOnlyBotGame=true;
check('4. local-only match keeps gate closed even after auth appears', canUseFirebase()===false);

localOnlyBotGame=false; firebaseAuthReady=true;
myTelegramId='test_abc'; auth.currentUser={uid:'test_abc'};
check('4a. test_* identity never opens gate', canUseFirebase()===false);
myTelegramId='123'; auth.currentUser={uid:'123'};
check('4b. raw numeric Telegram id never opens gate', canUseFirebase()===false);
myTelegramId='srv_settlement'; auth.currentUser={uid:'srv_settlement'};
check('4c. server settlement uid never opens client gate', canUseFirebase()===false);
myTelegramId='tg_abc'; auth.currentUser={uid:'tg_abc'};
check('4d. malformed tg_ uid never opens gate', canUseFirebase()===false);
myTelegramId='tg_123'; auth.currentUser={uid:'tg_123'};
check('4e. canonical tg_<digits> opens gate', canUseFirebase()===true);


console.log('\n=== LOCAL-ONLY BOT START ===');
global.pendingExistingSessionForResume={x:1}; global.pendingReplaceExistingSession={x:1}; global.pendingOldSpectateCodeForCleanup='OLD';
global.ownerSessionAttached=false; global.botDifficulty=null; global.isOnlineGame=true; global.isSpectator=true; global.isBotGame=false;
global.gameScreen={}; let shown=0, offlineStarts=0;
global.showScreen=()=>{shown++;}; global.startOfflineGame=()=>{offlineStarts++;};
global.localOnlyBotGame=false; global.firebaseAuthReady=false; auth.currentUser=null;
eval(grab('startOwnerBotGameWithDifficulty'));
dbCalls=[]; startOwnerBotGameWithDifficulty('hard');
check('5. no-auth difficulty starts local game', offlineStarts===1 && shown===1);
check('6. local-only flag fixed at start', localOnlyBotGame===true && isBotGame===true && isOnlineGame===false);
check('7. owner Firebase session is not attached', ownerSessionAttached===false);
check('8. start path made zero Firebase calls', dbCalls.length===0, JSON.stringify(dbCalls));

console.log('\n=== LOCAL-ONLY NEVER MIRRORS ===');
global.botSpectateRoomCode=null; global.currentState={pieces:{},turn:'light'};
global.generateRoomCode=()=> 'ABC'; global.createInitialPieces=()=>({}); global.GROUP_ID='G';
global.botColor='dark'; global.myTelegramName='P'; global.botSpectatePresenceInterval=null; global.botSpectateListenerRef=null;
global.setInterval=()=>1; global.renderSpectatorsList=()=>{};
eval(grab('startBotSpectateRoom')); eval(grab('syncBotStateToFirebase'));
dbCalls=[]; startBotSpectateRoom(); syncBotStateToFirebase();
check('9. local-only spectate mirror makes zero Firebase calls', dbCalls.length===0, JSON.stringify(dbCalls));



console.log('\n=== REAL LOCAL-ONLY BOT BOOTSTRAP ===');
// В v192 именно реальная связка startOwnerBotGameWithDifficulty ->
// startOfflineGame была сломана: тест подменял startOfflineGame заглушкой и
// не видел падение на result.committed. Здесь запускаем ОБЕ production-функции.
global.localStorage = {
  _v: { shashki_last_bot_color: 'light' },
  getItem: function (k) { return this._v[k] || null; },
  setItem: function (k, v) { this._v[k] = String(v); }
};
global.currentState = null;
global.currentBotMatchId = null;
global.coinRewardAttemptForMatch = null;
global.botColor = null; global.myColor = null; global.flipped = false;
global.selectedFrom = null; global.lastAnimatedMoveCount = null; global.endGameShownForRoom = null;
global.opponentAbsenceHandled = false; global.lastRenderedSignature = null; global.boardBuilt = true;
global.pendingSyncChain = Promise.resolve(); global.pendingMoveStartedAt = 123;
global.syncRecoveryInFlight = true; global.syncRecoveryFailed = true;
global.opponentGraceTimer = null; global.mustCaptureHintTimer = null; global.botMoveTimer = null;
global.roomListenerRef = null; global.reactionsRow = { classList: { add: function () {} } };
global.stopPresenceHeartbeat = function () {};
global.getDrawPositionKey = function () { return 'initial'; };
let realRenderCount = 0;
global.renderBoard = function () { realRenderCount++; };
global.triggerBotMove = function () {};
eval(grab('createInitialPieces'));
eval(grab('startOfflineGame'));
// startOwnerBotGameWithDifficulty уже загружена выше и теперь найдёт реальную
// startOfflineGame в текущем scope.
global.localOnlyBotGame = false; global.firebaseAuthReady = false; auth.currentUser = null;
global.ownerSessionAttached = false; global.myTelegramId = null; global.myTelegramName = null;
dbCalls=[]; shown=0;
startOwnerBotGameWithDifficulty('medium');
check('9a. real local bootstrap создаёт игровое состояние', !!currentState && currentState.turn === 'light');
check('9b. real local bootstrap создаёт 24 шашки', currentState && Object.keys(currentState.pieces || {}).length === 24);
check('9c. real local bootstrap реально вызывает renderBoard', realRenderCount === 1);
check('9d. real local bootstrap не обращается к Firebase', dbCalls.length === 0, JSON.stringify(dbCalls));
check('9e. real local bootstrap остаётся local-only', localOnlyBotGame === true && ownerSessionAttached === false && isBotGame === true);

console.log('\n=== AUTH ARRIVES MID-MATCH ===');
auth.currentUser={uid:'tg_1'}; global.firebaseAuthReady=true; global.myTelegramId='tg_1'; global.localOnlyBotGame=true;
check('10. late auth still cannot open current match gate', canUseFirebase()===false);
dbCalls=[]; syncBotStateToFirebase();
check('11. late auth still cannot mirror current match', dbCalls.length===0);

console.log('\n=== DEFERRED FIREBASE START ===');
global.pendingFirebaseIdentity=null; global.firebaseFlowsStarted=false; global.myTelegramId=null; global.myTelegramName=null;
let economy=0, active=0; global.initializeEconomy=()=>{economy++;}; global.checkForInviteLink=()=>false; global.loadActiveRooms=()=>{active++;};
global.document={getElementById:()=>null};
eval(grab('startFirebaseFlows')); eval(grab('queueOrStartFirebaseFlows')); eval(grab('activatePendingFirebaseFlows'));
global.localOnlyBotGame=true; global.firebaseAuthReady=false; auth.currentUser={uid:'tg_77'};
check('12. verified identity is deferred during local-only', queueOrStartFirebaseFlows({id:'tg_77',name:'N'})===false && pendingFirebaseIdentity.id==='tg_77');
// v194: экономики больше нет, остаётся лобби.
check('13. deferred auth does not start lobby', active===0 && firebaseAuthReady===false);
global.localOnlyBotGame=false;
check('14. exiting local-only activates pending identity', activatePendingFirebaseFlows()===true);
check('15. deferred flows start once after exit', active===1 && myTelegramId==='tg_77' && firebaseAuthReady===true);

console.log('\n=== TOKEN WATCHER FAIL-CLOSED ===');
let stopped=0, revived=0;
global.stopPresenceHeartbeat=()=>{stopped++;}; global.stopOwnerPresenceHeartbeat=()=>{stopped++;}; global.stopOwnerBotMoveRetryTimer=()=>{stopped++;}; global.revivePresenceAfterReconnect=()=>{revived++;};
global.isOnlineGame=true; global.roomCode='R'; global.isSpectator=false; global.localOnlyBotGame=false; global.firebaseFlowsStarted=true; global.myTelegramId='tg_77'; global.firebaseAuthReady=true; auth.currentUser={uid:'tg_77'};
eval(grab('armPresenceReauthWatcher')); armPresenceReauthWatcher();
__authCb(null);
check('16. onIdTokenChanged(null) closes gate', firebaseAuthReady===false && stopped===3);

global.localOnlyBotGame=false; global.botSpectateRoomCode='BOTROOM'; global.currentState={pieces:{},turn:'light'};
dbCalls=[]; syncBotStateToFirebase();
check('16a. auth loss stops an actual mid-game Firebase write', dbCalls.length===0, JSON.stringify(dbCalls));

global.firebaseAuthReady=true; auth.currentUser={uid:'tg_88'}; __authCb({uid:'tg_88'});
check('17. other uid closes gate', firebaseAuthReady===false);
global.firebaseAuthReady=false; auth.currentUser={uid:'tg_77'}; __authCb({uid:'tg_77'});
check('18. same uid restores ready state for started flows', firebaseAuthReady===true);
check('19. same uid re-arms presence through v184 path', revived===1);

console.log('\n=== STATIC SECURITY INVARIANTS ===');
const authFn=grab('authenticateTelegramUser');
check('20. identity uses signed initData', /tg\.initData/.test(authFn) && !/initDataUnsafe/.test(authFn));
check('21. Firebase uid compared with Worker uid', /credential\.user\.uid !== payload\.uid/.test(authFn));
check('22. no secret material embedded', !/BEGIN PRIVATE KEY/.test(SRC) && !/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/.test(SRC));
const offline=grab('startOfflineGame');
check('23. startOfflineGame skips mirror for local-only', /!localOnlyBotGame && canUseFirebase\(\)/.test(offline));
const rec=grab('recordGameResult');
check('24. local-only bot result never enters stats write path', /isBotGame && localOnlyBotGame/.test(rec));
const setup=grab('setupPresence'), revive=grab('revivePresenceAfterReconnect');
check('25. presence setup/revive both require top-level auth gate',
  /^function setupPresence\(\) \{\s*if \(!canUseFirebase\(\)\) return;/.test(setup) &&
  /^function revivePresenceAfterReconnect\(\) \{\s*if \(!canUseFirebase\(\)\) return;/.test(revive));

const sweep=grab('runLobbyStaleSweep');
check('26. stale sweep stops before destructive writes without auth', /if \(!canUseFirebase\(\)\)/.test(sweep));
check('27. auth persistence is NONE', /Auth\.Persistence\.NONE/.test(authFn));
const html=fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
check('28. firebase-auth compat SDK is loaded before app script', /firebase-auth-compat\.js/.test(html) && html.indexOf('firebase-auth-compat.js') < html.indexOf('script.js?v='));


console.log('\nИТОГ: '+passed+'/'+(passed+failed));
process.exit(failed?1:0);

const fs = require('fs');
const FILE = process.env.TARGET || 'script.js';
const src = fs.readFileSync(process.env.TARGET_SCRIPT || require('path').join(__dirname,'..','script.js'), 'utf8');
function ex(n){const re=new RegExp('function '+n+'\\([^)]*\\) \\{','g');const m=re.exec(src);
if(!m)throw new Error('нет '+n);let s=m.index,i=src.indexOf('{',s),d=1;i++;
while(d>0){if(src[i]==='{')d++;else if(src[i]==='}')d--;i++;}return src.slice(s,i);}

let passed=0, failed=0;
function check(n,c,d){console.log((c?'✅ ':'❌ ')+n+(!c&&d?' — '+d:''));c?passed++:failed++;}

// ---- состояние, общее для обеих функций (как module-level let в script.js) ----
let statsRecordedForRoom = null;
let statsInFlightForRoom = null;
let statsInFlightOnlineMarker = null;
let endGameShownForRoom = null;

// ---- моки окружения ----
let STORE = {};            // stats/<id> -> {wins,losses,name}
let FAIL_NEXT = 0;         // сколько ближайших transaction провалить
let TX_CALLS = 0;
global.database = { ref: function(path){ return {
  transaction: function(fn){
    TX_CALLS++;
    if (FAIL_NEXT > 0) { FAIL_NEXT--; return Promise.reject(new Error('network')); }
    STORE[path] = fn(STORE[path]);
    return Promise.resolve({committed:true, snapshot:{val:()=>STORE[path]}});
  }
};}};
global.myTelegramId='me'; global.myTelegramName='Me';
global.isSpectator=false; global.isOnlineGame=true; global.isBotGame=false;
global.isLocalStateOptimistic=false; global.botDifficulty='hard';
global.currentBotMatchId=null; global.roomCode='ROOM1'; global.myColor='light';
global.currentState=null;
global.playWinSound=function(){}; global.recordCoinResultOnce=function(){};
global.t=function(k){return k;}; global.buildDrawResultText=function(){return{header:'',subtext:''};};
global.endGameText={textContent:''}; global.endGameSubtext={textContent:''};
global.endGameModal={classList:{add:function(){},remove:function(){}},
  querySelector:function(){return {classList:{add:function(){},remove:function(){}},style:{},appendChild:function(){}};}};
global.btnNewGame={classList:{add:function(){},remove:function(){}},textContent:'',style:{}};
global.btnCloseGame={classList:{add:function(){},remove:function(){}},textContent:'',style:{}};
global.recordGameResultCalls=0;
global.document={createElement:function(){return {classList:{add:function(){}},style:{},appendChild:function(){},setAttribute:function(){}};},
  getElementById:function(){return null;}};
global.recordBotGameResultIdempotent=function(){ return Promise.resolve(); };
global.recordGameResultBotCalls=0;

// ---- ELO (Этап 1): recordGameResult теперь спрашивает getEloMatchContext(),
// поэтому харнесс обязан загрузить и его. Константы берём ИЗ ИСХОДНИКА, а не
// хардкодим: иначе тест разошёлся бы с продакшеном незаметно.
// В этом файле у currentState никогда нет ratingsAtStart, поэтому контекст
// всегда null и проверяется именно СТАРЫЙ путь (переходная совместимость).
global.ELO_START_RATING = Number(/const ELO_START_RATING = (\d+);/.exec(src)[1]);
global.ELO_K = Number(/const ELO_K = (\d+);/.exec(src)[1]);
eval(ex('normalizeEloRating'));
eval(ex('computeEloDeltas'));
eval(ex('buildEloMatchId'));
eval(ex('getEloMatchContext'));
global.recordEloMatchResult = function () { throw new Error('Elo-путь не должен вызываться без ratingsAtStart'); };

eval(ex('recordGameResult'));
eval(ex('renderEndGameModal'));

function reset(){ STORE={}; FAIL_NEXT=0; TX_CALLS=0;
  statsRecordedForRoom=null; statsInFlightForRoom=null; statsInFlightOnlineMarker=null;
  endGameShownForRoom=null; global.isLocalStateOptimistic=false;
  global.isSpectator=false; global.isOnlineGame=true; global.isBotGame=false;
  global.myColor='light'; global.roomCode='ROOM1'; }
function st(winner, moveCount){ return {winner:winner, winReason:winner, moveCount:moveCount||10,
  players:{light:{name:'Me'},dark:{name:'Opp'}}, pieces:{}}; }
const wins  = ()=> (STORE['stats/me']||{}).wins  || 0;
const losses= ()=> (STORE['stats/me']||{}).losses|| 0;
const tick = ()=> new Promise(r=>setImmediate(()=>setImmediate(r)));

(async function(){
console.log('=== ЦЕЛЬ: ' + FILE + ' ===\n');

// 1. committed win -> +1 ровно один раз
reset(); global.currentState = st('light');
renderEndGameModal(); await tick();
check('1. online committed win -> wins=1', wins()===1, 'wins='+wins());
renderEndGameModal(); renderEndGameModal(); await tick();
check('1b. повторные render -> всё ещё 1', wins()===1, 'wins='+wins());

// 2. committed loss -> +1 ровно один раз
reset(); global.currentState = st('dark');
renderEndGameModal(); await tick();
check('2. online committed loss -> losses=1', losses()===1, 'losses='+losses());
renderEndGameModal(); await tick();
check('2b. повторный render -> всё ещё 1', losses()===1, 'losses='+losses());

// 3. optimistic win ДО commit -> статистика НЕ пишется   [ЛОВИТ БАГ 1]
reset(); global.currentState = st('light'); global.isLocalStateOptimistic = true;
renderEndGameModal(); await tick();
check('3. optimistic win -> stats НЕ записаны', wins()===0 && TX_CALLS===0, 'wins='+wins()+' tx='+TX_CALLS);

// 4. отклонённый optimistic win -> откат, статистика не появилась   [ЛОВИТ БАГ 1]
reset(); global.currentState = st('light'); global.isLocalStateOptimistic = true;
renderEndGameModal(); await tick();
global.currentState = st(null);          // forceResync откатил
global.isLocalStateOptimistic = false;
renderEndGameModal(); await tick();
check('4. отклонённая ложная победа -> stats пусты', wins()===0 && losses()===0, 'w='+wins()+' l='+losses());

// 5-7. reject -> retry -> success   [ЛОВИТ БАГ 2]
reset(); global.currentState = st('light'); FAIL_NEXT = 1;
renderEndGameModal(); await tick();
check('5. первый transaction reject -> stats пусты', wins()===0, 'wins='+wins());
check('5b. маркер НЕ считается завершённым', statsRecordedForRoom === null, 'marker='+statsRecordedForRoom);
renderEndGameModal(); await tick();
check('6. следующий render -> повторная попытка сделана', TX_CALLS===2, 'tx='+TX_CALLS);
check('7. retry success -> wins=1 ровно один раз', wins()===1, 'wins='+wins());

// 8. после success ещё 5 render -> второго +1 нет
for(let i=0;i<5;i++){ renderEndGameModal(); }
await tick();
check('8. 5 повторных render после success -> всё ещё 1', wins()===1, 'wins='+wins());

// 9. spectator не пишет
reset(); global.currentState = st('light'); global.isSpectator = true;
renderEndGameModal(); await tick();
check('9. spectator -> stats не пишет', TX_CALLS===0 && wins()===0);

// 10. bot medium/hard -> старое поведение (идёт через recordBotGameResultIdempotent)
reset(); global.isBotGame=true; global.isOnlineGame=false; global.botDifficulty='hard';
global.currentBotMatchId='bot_1'; global.currentState = st('light');
let botCalled=0; global.recordBotGameResultIdempotent=function(){botCalled++;return Promise.resolve();};
renderEndGameModal(); await tick();
check('10. bot hard -> использован bot-путь, stats/ не тронут', botCalled===1 && TX_CALLS===0, 'bot='+botCalled+' tx='+TX_CALLS);

// 11. Easy bot -> не пишет
reset(); global.isBotGame=true; global.isOnlineGame=false; global.botDifficulty='easy';
global.currentBotMatchId='bot_2'; global.currentState = st('light');
botCalled=0; renderEndGameModal(); await tick();
check('11. bot easy -> статистика не пишется', botCalled===0 && TX_CALLS===0, 'bot='+botCalled);

// 12. draw -> не пишет
reset(); global.currentState = st('draw');
renderEndGameModal(); await tick();
check('12. ничья -> статистика не пишется', TX_CALLS===0 && wins()===0 && losses()===0);


// ===== 13-16. РЕВАНШ В ТОЙ ЖЕ КОМНАТЕ =====
// Сценарий предложившего реванш: startOnlineGame() НЕ вызывается (listener-путь),
// маркер не сбрасывается -> обе партии должны различаться по matchNumber.
reset(); global.roomCode='ABC';
global.currentState = Object.assign(st('light', 40), {matchNumber:0});
renderEndGameModal(); await tick();
check('13. партия #1 (matchNumber=0, moveCount=40) -> wins=1', wins()===1, 'wins='+wins());

// реванш БЕЗ startOnlineGame: та же комната, matchNumber+1, moveCount снова 40
global.currentState = Object.assign(st('light', 40), {matchNumber:1});
renderEndGameModal(); await tick();
check('14. партия #2 (matchNumber=1, тот же moveCount=40) -> wins=2', wins()===2, 'wins='+wins());

// повторные render каждой партии не дают дубля
renderEndGameModal(); renderEndGameModal(); await tick();
check('15. повторный render партии #2 -> дубля нет, всё ещё 2', wins()===2, 'wins='+wins());

// reconnect во время второй партии: listener переприсылает то же состояние
global.currentState = Object.assign(st('light', 40), {matchNumber:1});
renderEndGameModal(); await tick();
check('16. reconnect во 2-й партии -> дубля нет', wins()===2, 'wins='+wins());

// 17. третий реванш тоже учитывается
global.currentState = Object.assign(st('dark', 40), {matchNumber:2});
renderEndGameModal(); await tick();
check('17. партия #3 (matchNumber=2) -> losses=1', losses()===1, 'losses='+losses());

// 18. bot-маркер не изменился (matchNumber в него не попал)
reset(); global.isBotGame=true; global.isOnlineGame=false; global.botDifficulty='hard';
global.currentBotMatchId='bot_x'; global.currentState=st('light',40);
let bc=0; global.recordBotGameResultIdempotent=function(){bc++;return Promise.resolve();};
renderEndGameModal(); await tick();
check('18. bot-ветка не затронута изменением маркера', bc===1 && TX_CALLS===0, 'bot='+bc);

console.log('\nИТОГ: '+passed+'/'+(passed+failed));
process.exit(failed>0?1:0);
})();

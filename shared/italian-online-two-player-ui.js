// PR-86 PRIVATE DRAFT. Italian-only screen; Russian /rooms is never written.
// Authenticated REST room reads; one-shot join; Worker-only moves.
// Nothing happens on import. Opening an Italian invite link (Telegram start_param it_<code>) is the player's own
// action: a valid WAITING room created by someone else is joined automatically, exactly once, through the same
// guarded path as the manual button (access preflight, one SDK attempt, one read-only confirmation).
// Stage 5: after a FINISHED game the two players can agree on a rematch (shared/italian-online-rematch.js). A rematch is always a NEW room
// (created by the former dark player, who therefore plays light); the finished room, the Worker and the Russian mode are never touched.
(function(global){
"use strict";
const HOST="russkie-shashki-online-default-rtdb.europe-west1.firebasedatabase.app";
const WORKER="https://russkie-shashki-auth.iliushazb.workers.dev";
// STEP I phase 2: STAGING-only read-only diagnostics (shared/italian-online-diag.js). arm() turns it on ONLY for a staging database host; in production it stays inert.
// dg(tag, fn): fn builds the data lazily, so nothing is computed when diagnostics are off; it can never throw into the game.
const Diag=global.ItalianOnlineDiag;try{if(Diag&&typeof Diag.arm==="function")Diag.arm(HOST);}catch(_){}
function dg(tag,f){try{if(Diag&&Diag.on)Diag.note(tag,typeof f==="function"?f():f);}catch(_){}}
let lastHttp=null;   // diagnostics only: the HTTP status of the last room read
const BOT="russkie_shashki_bot",CODE=/^[A-F0-9]{24}$/,UID=/^tg_[0-9]+$/;
const nativeFetch=global.fetch,nativeURL=global.URL,nativeAbort=global.AbortController;
const Invite=global.ItalianOnlineInviteContract,Join=global.ItalianOnlineJoinUIOrchestrator;
const Opening=global.ItalianOnlineJoinContract,Preflight=global.ItalianOnlineAccessPreflight,Timer=global.ItalianOnlineTimer;
const State=global.OnlineRulesetState,Engine=global.ItalianCheckersEngine,Presence=global.ItalianOnlinePresence,Rematch=global.ItalianOnlineRematch,Sound=global.ItalianOnlineSound,BT=global.BoardTransition,BE=global.BoardEffects,PN=global.PlayerDisplayName,
  Actions=global.ItalianOnlineActions,Sweep=global.ItalianOnlineSweep;
// C-1: texts only. Missing module -> keys are shown instead of words; no game/network logic (incl. classification of Worker refusals) depends on it.
const I18N=global.ItalianOnlineI18n||{msg:(k,p)=>({k,p:p||null}),render:m=>typeof m==="string"?m:(m&&m.k)||"",applyStatic:()=>0,onLanguageChange:()=>{}},M=I18N.msg;
const KEY="it86.lastRoom",POLL_MS=5000,READ_DEADLINE_MS=12000,MOVE_DEADLINE_MS=15000;
// Stage F-A transitions: the loading cover (the two turning draughts of the Russian #startup-cover) never stays longer than this: the screen below with its message and «Назад» comes back.
const COVER_MAX_MS=20000;
let openGen=0;   // generation of the "game opened for viewing" attempt (a late end of an old one must not clear the flag of a newer one)
const s={epoch:0,visible:false,code:null,room:null,view:null,pendingJoin:null,
  selected:null,busy:false,token:null,uncertain:false,ref:null,listener:null,
  readPending:false,readAgain:false,poll:null,
  gen:0,applied:0,acc:null,
  pc:null,presRef:null,presListener:null,pres:null,absTick:null,claiming:false,lastClaim:0,claimStage:"idle",claimRefusedAt:0,exitKey:null,seatDiagKey:null,superseded:null,
  spectator:false,spRef:null,spListener:null,mySp:null,msg:null,opp:null,spn:0,autoJoin:null,rm:null,rmView:null,
  entering:false,recover:false,fx:null,chain:null,nm:null,loc:null,holdUntil:0,paintSig:null,paintPos:null,paintCells:null,pend:null,
  tmr:null,claimingTm:null,tmAt:0,   // K3: the 1-second timer tick, a running "time is up" request, the time of the last one
  opening:false,rmJoin:null,cover:null,coverTimer:null,coverGaveUp:false,   // Stage F-A transitions: opening = a game is being opened for viewing, rmJoin = code of the rematch room the other player is still joining, cover = "normal"|"invite"|null
  ac:null,prof:{},profLoading:{},clk:null,lastVoid:0,voiding:false,sweepAt:0,hold:null,holdSpent:-1,spList:[],spFail:{}};   // Stage K1A: hold = the creator's short «friend connected» picture (see holdOn); holdSpent = the epoch in which it already ran (never twice)   // Stage F-A: ac = draw/reaction controller, prof = verified usernames of the players, clk = server clock for a spectator   // Stage 6C: entering = the «Играть с другом» entry is running; recover = a remembered room exists but could not be read
const $=id=>global.document.getElementById("it86-"+id);
// Stage 6B: sounds. The decision module reuses shared/audio-effects.js; a missing module = silence. Nothing is played while the screen is hidden / the page is in the background.
const SND=Sound&&typeof Sound.create==="function"?Sound.create({isActive:()=>s.visible&&(!global.document||global.document.visibilityState!=="hidden"),
  kingDelayMs:()=>{const f=fx();return f?f.kingSoundDelayMs():0;}}):null;
// Stage 6E: board effects (shared/board-transition.js + shared/board-effects.js, the Russian classes / timings). A missing module = no effects, the board is the same.
// Presentation only: nothing here reads or writes the network, the rules or the moves.
let FX;
function fx(){
  if(FX!==undefined)return FX;
  FX=null;
  try{
    const d=global.document;
    if(BE&&typeof BE.create==="function"&&d&&typeof d.createElement==="function")
      FX=BE.create({doc:d,
        cell:(r,c)=>{const b=d.getElementById("it86-board");return b&&b.querySelector?b.querySelector('[data-it86-cell="'+r+"_"+c+'"]'):null;},
        pieceIn:sq=>sq&&sq.querySelector?sq.querySelector(".it86-piece"):null,
        board:()=>d.getElementById("it86-board"),
        reduced:()=>!!(global.matchMedia&&global.matchMedia("(prefers-reduced-motion: reduce)").matches)});
  }catch(_){FX=null;}
  return FX;
}
function fxStop(){const f=fx();if(f){try{f.cancel();f.hintOff();}catch(_){}}s.fx=null;s.chain=null;}
// What just happened on the board (from the two consecutive confirmed views) and the path of the capture chain for the arrow.
function noteTransition(before,v){
  if(!BT){s.fx=null;return;}
  const t=BT.between(before,v),m=t&&t.ok?t.move:null;
  s.fx=m?t:null;
  if(m){
    const c=s.chain;
    if(c&&c.open&&c.mover===m.mover&&c.code===s.code){c.path.push({row:m.to.row,col:m.to.col});c.captured.push(...m.captured);c.open=m.continues;}
    else s.chain={code:s.code,mover:m.mover,path:[m.from,m.to],captured:m.captured.slice(),open:m.continues};
  }else if(!t||(!t.ok&&(t.reason==="no_baseline"||t.reason==="other_game"||t.reason==="catch_up"||t.reason==="unrecognized")))s.chain=null;
}
// ---- Optimistic display of OUR OWN move (the Russian performMove order: show first, the server confirms afterwards) ----
// s.loc is a TEMPORARY picture, kept apart from the server state: s.room / s.view / s.acc and every revision stay exactly as the server last
// confirmed them. The picture is built from the same engine and the same State.applyGameState the Worker uses, so it can be compared with the room
// the Worker writes. It ends in exactly one of three ways: confirmed (adopt: same move found in the room -> no second sound, no second animation),
// refused / not current (dropLocal: the server position is drawn again) or unknown (it stays, the move stays locked, the next read decides).
// It never contains a result: a finished game is shown only after the room itself says so.
const cloneChain=c=>c?{code:c.code,mover:c.mover,path:c.path.map(p=>({row:p.row,col:p.col})),captured:c.captured.slice(),open:c.open}:null;
function boardSig(game,turn){
  const f=game&&game.mustContinueFrom;
  return (game&&Array.isArray(game.pieces)?game.pieces.map(p=>p.row+"_"+p.col+p.color+(p.king?"k":"")).sort().join(","):"")+"|"+turn+"|"+(f?f.row+"_"+f.col:"");
}
function prepareLocal(v,fr,fc,tr,tc,res,requestId,uid){
  try{
    if(!res||res.ok!==true||!res.state||!BT)return false;
    const base=v.room.revision||0;
    // the result of the game is never shown before the server says it: only the position
    const room=State.applyGameState(v.room,Object.assign({},res.state,{winner:null,winReason:null}));
    room.revision=base+1;room.status="active";
    room.lastMoveReceipt={requestId,actorUid:uid,color:v.color,revision:base+1,expectedRevision:base,fromRow:fr,fromCol:fc,toRow:tr,toCol:tc};
    const lv={room,color:v.color,game:gameOf(room)};
    const t=BT.between(v,lv);
    if(!t||!t.ok||!t.move)return false;   // not recognised as ONE jump: no local picture, the old (wait for the server) behaviour
    s.loc={code:s.code,epoch:s.epoch,requestId,view:lv,chain:cloneChain(s.chain)};
    s.holdUntil=Date.now()+(t.move.becameKing?1300:450);   // the king turning is not cut by the redraw that follows the confirmation
    if(SND){try{SND.observe(v,lv);}catch(_){}}
    try{noteTransition(v,lv);}catch(_){s.fx=null;s.chain=null;}
    return true;
  }catch(_){s.loc=null;return false;}
}
function dropLocal(){
  const L=s.loc;if(!L)return;
  s.loc=null;s.fx=null;s.chain=L.chain;s.holdUntil=0;
  const f=fx();if(f){try{f.cancel();}catch(_){}}
  if(SND&&typeof SND.forget==="function"){try{SND.forget();}catch(_){}}   // the next move with this revision must sound again
}
// Does the room the server just sent contain exactly the move that is shown? (same request, same revision, same position)
function confirms(L,raw,nv){
  const m=L.view.room.lastMoveReceipt,r=raw&&raw.lastMoveReceipt;
  return !!(r&&L.code===s.code&&L.epoch===s.epoch&&r.requestId===m.requestId&&r.actorUid===m.actorUid&&r.revision===m.revision&&
    (raw.revision||0)===m.revision&&(raw.moveCount||0)===(L.view.room.moveCount||0)&&
    boardSig(nv.game,raw.turn)===boardSig(L.view.game,L.view.room.turn));
}
// The fate of a move that was SENT (s.pend = the request the Worker may still be processing). One room snapshot with the old position proves nothing: the
// request can still be in flight at the Worker and be written later. It is settled only by the room itself: it carries the receipt of THIS request
// ("confirmed"), or its revision / status has moved on (the Worker writes only at the revision the request names, so it can never be written any more:
// "settled"). Otherwise it is "open" and the board stays locked; the only way out is the player's «Проверить», which repeats the SAME request (same
// requestId, same revision, same squares): the Worker answers "already done" or does it now, never a second move.
function fate(P,raw){
  const r=raw&&raw.lastMoveReceipt;
  if(r&&r.requestId===P.requestId&&r.actorUid===P.uid)return "confirmed";
  if((raw.revision||0)!==P.base||raw.status!=="active")return "settled";
  return "open";
}
// After the cells are drawn: the arrow of the last move, the 5 s hint, then the one-time move animation.
function paintEffects(v,room,legal){
  const f=fx();if(!f)return;
  try{
    const jump=BT?BT.lastJump(room):null;let path=null,caps=null;
    if(jump){
      const c=s.chain,end=c&&c.path[c.path.length-1];
      if(c&&c.code===s.code&&c.path.length>=2&&end.row===jump.to.row&&end.col===jump.to.col){path=c.path;caps=c.captured;}
      else{path=[jump.from,jump.to];caps=[];}
    }
    f.drawLastMove(path,caps,{svg:"it86-last-move-svg",glow:"it86-last-move-glow"});
    const mine=!v.spectator&&room.status==="active"&&room.turn===v.color&&!s.busy&&!s.uncertain&&!s.selected;
    const sq=[],seen={};
    if(mine)for(const m of legal){const k=m.fromRow+"_"+m.fromCol;if(m.capture&&!seen[k]){seen[k]=1;sq.push({row:m.fromRow,col:m.fromCol});}}
    f.hintSync(sq.length?[s.code,room.revision||0,room.turn].join("|"):null,sq);
    const t=s.fx;s.fx=null;if(t)f.play(t);
  }catch(_){}
}
// Stage F-A: a game is OVER when it is finished (a result) or void («Партия не состоялась»: no result at all).
const over=r=>!!r&&(r.status==="finished"||r.status==="void");
const auth=()=>global.firebase.auth(),db=()=>global.firebase.database();
function currentUser(){try{const u=auth().currentUser;return u&&UID.test(u.uid)?u:null;}catch(_){return null;}}
function same(u){return !!u&&auth().currentUser===u&&UID.test(u.uid);}
function say(m){s.msg=m;if($("status")){$("status").textContent=I18N.render(m);paintStatus();}}   // m is a message descriptor: it is rendered again when the language changes
function setOpp(m){s.opp=m;const o=$("opponent");if(o)o.textContent=m?I18N.render(m):"";const pt=$("panel-top");if(pt)pt.classList.toggle("player-faded",!!m&&!pt.hidden);}
// Stage K1B: the two PLAYERS see the names of the viewers (the Russian «👁 Зрители: …» line); a viewer sees only the count, as before. s.spList = [{uid, raw}], ONE entry per viewer
// (uid), built from the same snapshot as the counter. The text is only ever set through textContent; every name is untrusted data (spectatorLabel).
const SP_NAMES_MAX=8,SP_NAME_LEN=24,SP_LOAD_MAX=12,SP_RETRY_MS=60000,PROF_CAP=120;
function spectatorLabel(uid,raw){
  const v=UID.test(uid)&&typeof s.prof[uid]==="string"?s.prof[uid]:"";   // telegramProfiles/<uid>: written by that viewer only when it equals the username of his sign-in token
  const un=PN&&v?PN.username(v):"";
  if(un)return "@"+un;
  // a name the viewer's own client wrote is NEVER shown as a verified @username: leading «@» (also fullwidth, after NFKC) is dropped
  const chars=Array.from(displayName(raw).replace(/^@+/,"").trim());
  const text=(chars.length>SP_NAME_LEN?chars.slice(0,SP_NAME_LEN-1).concat("…"):chars).join("").trim();
  return text||I18N.render(M("spectators.anonymous"));
}
function paintSpectators(){
  const e=$("spectators");if(!e)return;
  const n=s.spn,list=s.spectator?[]:s.spList;
  if(!(n>0)){e.textContent="";e.removeAttribute("title");return;}
  if(!list.length){e.textContent=I18N.render(M("spectators.count",{n}));e.removeAttribute("title");return;}   // a viewer, or no list: the reliable counter
  const names=list.slice(0,SP_NAMES_MAX).map(x=>spectatorLabel(x.uid,x.raw));
  let line=names.join(", ");
  if(list.length>SP_NAMES_MAX)line+=" "+I18N.render(M("spectators.more",{n:list.length-SP_NAMES_MAX}));
  e.textContent=I18N.render(M("spectators.names",{names:line}));
  e.title=e.textContent;
}
function setSpectators(n,list){s.spn=n;s.spList=Array.isArray(list)?list:[];paintSpectators();}
// Verified usernames of the viewers: telegramProfiles/<uid>, read ONCE per uid (cache s.prof, shared with the players' names). A failed read is retried at most once per
// SP_RETRY_MS and only when the viewer list changes (never by a timer, never by a heartbeat). A late answer only fills the cache; it repaints only if the same room is still open.
function loadSpectatorProfiles(code){
  const u=currentUser();if(!u||s.spectator||!PN)return;
  let started=0;const epoch=s.epoch,now=Date.now();
  for(const e of s.spList){
    const id=e.uid;
    if(started>=SP_LOAD_MAX)break;
    if(!UID.test(id)||id===u.uid||s.profLoading[id]||Object.prototype.hasOwnProperty.call(s.prof,id))continue;
    if(s.spFail[id]&&now-s.spFail[id]<SP_RETRY_MS)continue;
    started++;s.profLoading[id]=true;
    try{
      db().ref("telegramProfiles/"+id).once("value").then(snap=>{
        const v=snap&&snap.val?snap.val():null;s.prof[id]=typeof v==="string"?PN.username(v):"";delete s.spFail[id];
      },()=>{s.spFail[id]=Date.now();}).then(()=>{
        delete s.profLoading[id];
        trimProfiles();   // the cache grew only NOW (after the answer): keep the cap here; players' and visible viewers' entries are never dropped
        if(epoch===s.epoch&&s.visible&&s.code===code&&!s.spectator)paintSpectators();
      });
    }catch(_){delete s.profLoading[id];s.spFail[id]=Date.now();}
  }
}
// Keeps s.prof (and the failure marks) within PROF_CAP: only entries of the two players of the open room and of the viewers in the CURRENT list are protected (and entries still being
// loaded); the others are dropped. Called after every answer, so the cap holds after the cache has grown. A dropped viewer who comes back is read once again (not per heartbeat).
function trimProfiles(){
  const keys=Object.keys(s.prof);
  if(keys.length>PROF_CAP){
    const keep=new Set(),pl=s.room&&s.room.players;
    if(pl)for(const c of ["light","dark"])if(pl[c]&&pl[c].id)keep.add(pl[c].id);
    for(const e of s.spList)keep.add(e.uid);
    for(const k of Object.keys(s.profLoading))keep.add(k);
    for(const k of keys)if(!keep.has(k))delete s.prof[k];
  }
  const fk=Object.keys(s.spFail);
  if(fk.length>PROF_CAP){const keep=new Set(s.spList.map(e=>e.uid));for(const k of fk)if(!keep.has(k))delete s.spFail[k];}
}
// Language switch: only the WORDS are rendered again; game state, selection, timers and network are untouched.
function relang(){
  I18N.applyStatic(global.document);
  if(s.msg)say(s.msg);
  setOpp(s.opp);paintSpectators();rmPaint();if(s.ac)drawPaint(s.ac.ctl.view());
  if(s.visible)render();
}
function secureId(){
  if(!global.crypto||typeof global.crypto.getRandomValues!=="function")
    throw Error("secure_rng_unavailable");
  const b=new Uint8Array(16);global.crypto.getRandomValues(b);
  return Array.from(b,x=>x.toString(16).padStart(2,"0")).join("");
}
// Stage 6E-2: the name of a player in a room (shared/player-display-name.js): the VERIFIED Telegram username "@username" (the claim the server put into the
// sign-in token), else first name, else last name, else the localized fallback. The id, the sign-in and the shape of the room are untouched.
function telegramUser(){
  const info=global.Telegram&&global.Telegram.WebApp&&global.Telegram.WebApp.initDataUnsafe;
  return info&&info.user&&typeof info.user==="object"?info.user:null;
}
function chooseName(u,verified){
  const fallback=I18N.render(M("player.fallback"));
  if(PN&&typeof PN.choose==="function")
    return PN.choose({verifiedUsername:verified,telegramUser:telegramUser(),accountName:u&&u.displayName,fallback});
  const p=telegramUser();   // the module is missing: the old behaviour (first name), never a crash
  return ((u&&typeof u.displayName==="string"&&u.displayName.trim())||(p&&typeof p.first_name==="string"&&p.first_name.trim())||"Игрок").trim().slice(0,80);
}
async function verifiedUsername(u){
  try{
    if(!u||typeof u.getIdTokenResult!=="function")return "";
    const r=await u.getIdTokenResult(),c=r&&r.claims&&r.claims.telegram_username;
    return PN&&typeof c==="string"?PN.username(c):"";
  }catch(_){return "";}
}
// The verified username is read once per sign-in (asynchronously); name(u) never waits and never throws.
async function ensureName(u){
  if(!u)return;
  if(s.nm&&s.nm.uid===u.uid)return;
  const v=await verifiedUsername(u);
  if(same(u)){s.nm={uid:u.uid,verified:v};if(v&&s.visible&&s.room&&s.view)try{renderPanels(s.view,s.room);paintEnd();}catch(_){}}   // F-A: the panel/result name follows the verified username as soon as it is known
}
function name(u){
  return chooseName(u,s.nm&&u&&s.nm.uid===u.uid?s.nm.verified:"");
}
// Stage F-A: the name of a player SEAT. A verified Telegram username (own: the sign-in claim; the opponent: telegramProfiles/<uid>, the node the
// Russian screen reads for the same purpose) wins over the name stored in the room; otherwise the stored name (first name ...) is shown. Display only.
function seatName(room,color){
  const p=room&&room.players&&room.players[color];if(!p)return "";
  const u=currentUser(),mine=u&&p.id===u.uid;
  const v=mine?(s.nm&&s.nm.uid===u.uid?s.nm.verified:""):(typeof s.prof[p.id]==="string"?s.prof[p.id]:"");
  const un=PN&&v?PN.username(v):"";
  return un?"@"+un:displayName(p.name);
}
function loadProfiles(room){
  const pl=room&&room.players,u=currentUser();if(!pl||!u)return;
  if(!(s.nm&&s.nm.uid===u.uid)&&!s.nmBusy){s.nmBusy=true;ensureName(u).then(()=>{s.nmBusy=false;},()=>{s.nmBusy=false;});}   // own verified username (also on the restore-by-link path)
  for(const c of ["light","dark"]){
    const p=pl[c];
    if(!p||!UID.test(p.id)||p.id===u.uid||s.profLoading[p.id]||Object.prototype.hasOwnProperty.call(s.prof,p.id))continue;
    s.profLoading[p.id]=true;
    try{
      db().ref("telegramProfiles/"+p.id).once("value").then(snap=>{
        const v=snap&&snap.val?snap.val():null;s.prof[p.id]=typeof v==="string"&&PN?PN.username(v):"";
      },()=>{}).then(()=>{delete s.profLoading[p.id];if(s.visible&&s.room)renderPanels(s.view,s.room);});
    }catch(_){delete s.profLoading[p.id];}
  }
}
function deps(){
  return !!Invite&&!!Join&&!!Opening&&!!Preflight&&!!State&&!!Engine&&
    typeof nativeFetch==="function"&&typeof nativeURL==="function"&&
    typeof nativeAbort==="function"&&global.fetch===nativeFetch&&
    global.URL===nativeURL&&global.AbortController===nativeAbort;
}
function pinned(){
  try{
    const a=new nativeURL(db().app.options.databaseURL),b=new nativeURL(db().ref().toString());
    return a.origin==="https://"+HOST&&a.origin===b.origin&&
      (a.pathname==="/"||a.pathname==="")&&(b.pathname==="/"||b.pathname==="")&&
      !a.search&&!a.hash&&!b.search&&!b.hash&&
      auth().app.options.projectId==="russkie-shashki-online";
  }catch(_){return false;}
}
async function tokens(u){
  if(!same(u)||!deps()||!pinned())throw Error("identity_unavailable");
  const id=await u.getIdToken();
  if(!same(u))throw Error("auth_changed");
  const a=await global.firebase.appCheck().getToken();
  const app=typeof a==="string"?a:a&&a.token;
  if(!same(u)||!pinned()||!deps()||typeof id!=="string"||
     typeof app!=="string"||id.length<20||app.length<20||
     id.length>10000||app.length>10000||/\s/.test(id)||/\s/.test(app))
    throw Error("authorization_unavailable");
  return {id,app};
}
// One shared deadline covers tokens, HTTP and body reading. Promise.race also
// ends a stalled non-abortable step (token APIs, body stream) with a rejection.
function deadline(ms,work){
  const abort=new nativeAbort();let timer;
  const limit=new Promise((_,reject)=>{
    timer=setTimeout(()=>{abort.abort();reject(Error("deadline_exceeded"));},ms);});
  let job;try{job=Promise.resolve(work(abort.signal));}catch(e){job=Promise.reject(e);}
  job.catch(()=>{}); // a late failure after the deadline must not surface
  return Promise.race([job,limit]).finally(()=>clearTimeout(timer));
}
function request(url,opts,signal){
  return nativeFetch(url,{...opts,signal,redirect:"error",
    credentials:"omit",cache:"no-store",referrerPolicy:"no-referrer"});
}
async function readRoom(code,u){
  if(!CODE.test(code))throw Error("invalid_code");
  const room=await deadline(READ_DEADLINE_MS,async signal=>{
    const t=await tokens(u);
    const url=new nativeURL("roomsItalian/"+code+".json","https://"+HOST+"/");
    url.searchParams.set("auth",t.id);
    const r=await request(url.toString(),{method:"GET",
      headers:{Accept:"application/json","X-Firebase-AppCheck":t.app}},signal);
    lastHttp=r?{status:r.status,ok:r.ok,redirected:!!r.redirected}:{status:"no-response"};   // diagnostics only
    if(!r||r.ok!==true||r.status!==200||r.redirected)throw Error("server_unavailable");
    return r.json();
  });
  if(!same(u)||!pinned())throw Error("auth_changed");
  if(!room)throw Error("not_found");
  return room;
}
function project(room,uid){
  if(!room||typeof room!=="object"||Array.isArray(room)||room.ruleset!=="italian"||
     !["waiting","active","finished","void"].includes(room.status)||room.matchNumber!==0||
     !room.players||!room.players.light||!UID.test(room.players.light.id))
    throw Error("invalid_italian_room");
  const light=room.players.light,dark=room.players.dark;
  if(light.id!==uid&&(!dark||dark.id!==uid))throw Error("not_a_player");
  if(room.status==="waiting"&&(!Opening.validOpening(room)||light.id!==uid))
    throw Error("invalid_waiting_room");
  if(room.status!=="waiting"&&(!dark||!UID.test(dark.id)||dark.id===light.id||
     !Number.isSafeInteger(room.revision===undefined?0:room.revision)))
    throw Error("invalid_active_room");
  return {room,color:light.id===uid?"light":"dark",game:gameOf(room)};
}
function gameOf(room){
  const game=State.projectRoom(room).state;
  if(!Array.isArray(game.pieces)||game.pieces.length<1||
     game.pieces.filter(p=>p.color==="light").length+room.capturedLight!==12||
     game.pieces.filter(p=>p.color==="dark").length+room.capturedDark!==12)
    throw Error("invalid_board");
  return game;
}
// Read-only view of a FOREIGN game (spectator). Same board validation, no seat required, never "waiting".
// The viewer's orientation is fixed (light); nothing in this view can produce a move.
function projectSpectator(room){
  if(!room||typeof room!=="object"||Array.isArray(room)||room.ruleset!=="italian"||
     !["active","finished","void"].includes(room.status)||room.matchNumber!==0||
     !room.players||!room.players.light||!UID.test(room.players.light.id)||
     !room.players.dark||!UID.test(room.players.dark.id)||room.players.dark.id===room.players.light.id||
     !Number.isSafeInteger(room.revision===undefined?0:room.revision))
    throw Error("invalid_italian_room");
  return {room,color:"light",game:gameOf(room),spectator:true};
}
function link(code){return "https://t.me/"+BOT+"?startapp=it_"+code;}

// ---- Stage 3 / Step B: presence (separate node, see shared/italian-online-presence.js) and the
// server-confirmed technical win. Presence never writes inside roomsItalian/<code> (that would change
// the room ETag and make the next Worker move fail with italian_stale_revision).
const ABSENCE_RETRY_MS=10000;
function presenceCtl(){
  if(s.pc||!Presence)return s.pc;
  try{
    s.pc=Presence.create({database:db(),TIMESTAMP:global.firebase.database.ServerValue.TIMESTAMP,
      doc:global.document,setInterval:(f,m)=>global.setInterval(f,m),clearInterval:t=>global.clearInterval(t),
      makeSid:()=>Presence.randomSid(global),onEvent:presenceEvent});
  }catch(_){s.pc=null;}
  return s.pc;
}
function presenceEvent(e){
  if(!e)return;
  if(e.type==="abandoned")voidFlow();
  else if(e.type==="superseded"){s.superseded=s.code;stopPresence(false);
    say(M("presence.superseded"));}
}
function syncPresence(){
  // Stage F-A: a spectator never writes presence; he only WATCHES it (statuses of both seats, «Игра прервана», and the void request for a dead game).
  const sp=!!(s.visible&&s.code&&s.room&&s.room.status==="active"&&s.view&&s.view.spectator);
  if(sp){if(!s.presRef)watchPresence();return;}
  const ctl=presenceCtl();if(!ctl)return;
  const on=s.visible&&s.code&&s.room&&s.room.status==="active"&&s.view&&!s.view.spectator&&s.superseded!==s.code;
  if(!on){stopPresence(false);return;}
  try{if(ctl.start(s.code,s.view.color))watchPresence();}catch(_){}
}
function watchPresence(){
  unwatchPresence();
  const code=s.code,ref=db().ref("roomsItalianPresence/"+code);
  const listener=snap=>{if(s.code===code){s.pres=snap.val();presenceTick();}};
  s.presRef=ref;s.presListener=listener;s.pres=null;
  ref.on("value",listener,()=>{});
  s.absTick=global.setInterval(presenceTick,1000);
  if(s.view&&s.view.spectator)clockStart();
}
function unwatchPresence(){
  if(s.presRef&&s.presListener)try{s.presRef.off("value",s.presListener);}catch(_){}
  if(s.absTick!==null){global.clearInterval(s.absTick);s.absTick=null;}
  s.presRef=null;s.presListener=null;s.pres=null;
  clockStop();
}
function stopPresence(explicit){
  if(s.pc)try{s.pc.stop({explicit:!!explicit});}catch(_){}
  unwatchPresence();
  setOpp(null);
}
// Server time for the statuses: the presence controller of a player has it; a spectator keeps his own .info/serverTimeOffset listener.
function clockStart(){
  if(s.clk)return;
  try{
    const ref=db().ref(".info/serverTimeOffset"),c={ref,offset:0,ready:false,l:null};
    c.l=snap=>{const x=snap&&snap.val?snap.val():null;if(typeof x==="number"&&isFinite(x)){c.offset=x;c.ready=true;}};
    ref.on("value",c.l);s.clk=c;
  }catch(_){s.clk=null;}
}
function clockStop(){const c=s.clk;s.clk=null;if(c&&c.ref&&c.l)try{c.ref.off("value",c.l);}catch(_){}}
function srv(){
  const ctl=s.pc,c=s.clk;
  if(s.view&&!s.view.spectator&&ctl)return {ms:ctl.serverNow(),ready:ctl.serverReady(),connected:ctl.isConnected()};
  return c?{ms:Date.now()+c.offset,ready:c.ready,connected:true}:{ms:Date.now(),ready:false,connected:true};
}
function presenceTick(){
  const ctl=s.pc,v=s.view;
  if(v&&v.spectator&&s.room&&s.room.status==="active"){
    setOpp(null);paintPanelStatus();
    const n=srv();
    if(Presence&&Presence.isAbandoned(s.room,s.pres,n.ms,n.ready))voidFlow();   // a dead game seen by a spectator is cleaned up the same way (the Worker decides)
    return;
  }
  if(!ctl||!v||v.spectator||!s.room||s.room.status!=="active"){setOpp(null);return;}
  const st=Presence.opponentState(s.pres,v.color,ctl.serverNow(),ctl.serverReady());
  setOpp(st.state==="countdown"?M("presence.countdown",{sec:Math.ceil(st.remainingMs/1000)}):
    st.state==="expired"?M("presence.expired"):null);
  paintPanelStatus();
  exitPromptTick(v);
  // The Worker re-verifies everything (participant, 60 s, both clocks); "unknown" never claims.
  if(st.state==="expired"&&st.canClaim)claimAbsence();
}
// F1: «Нет связи» always has a way out (shared prompt, once per episode). Leaving writes NO result: leave() marks my session away like a minimise.
function exitPromptTick(v){
  const PS=global.OnlinePresenceStatus;if(!PS||!global.document)return;
  const room=s.room;
  if(!v||v.spectator||!room||room.status!=="active"||room.winner){if(s.exitKey!==null){s.exitKey=null;PS.closeLinkLost(global.document);}return;}
  const n=srv(),opp=v.color==="light"?"dark":"light";
  if(!n.connected||!n.ready||!Presence)return;
  const q=PS.classifySeat(seatFacts(opp,n));
  {const dk=q.state+"|"+claimStageNow()+"|"+Math.floor(((q.awayMs!==undefined?q.awayMs:q.silentMs)||0)/10000);   // one diagnostic line per change / per 10 s, not per second
   if(dk!==s.seatDiagKey){s.seatDiagKey=dk;dg("seat",()=>({opp:q.state,marked:q.marked,away:q.awayMs!==undefined?Math.round(q.awayMs/1000):null,silent:q.silentMs!==undefined?Math.round(q.silentMs/1000):null,claim:claimStageNow()}));}}
  if(!PS.needsExit(q)){if(s.exitKey!==null){s.exitKey=null;PS.closeLinkLost(global.document);}return;}
  const key=s.code+":"+(room.matchNumber||0);if(s.exitKey===key)return;s.exitKey=key;
  PS.promptLinkLost({doc:global.document,text:I18N.render(M("link.lost")),waitLabel:I18N.render(M("link.wait")),leaveLabel:I18N.render(M("end.to_menu")),onLeave:()=>leave()});
}
async function claimAbsence(){
  const t0=Date.now();
  if(s.claiming||t0-s.lastClaim<ABSENCE_RETRY_MS)return;
  const u=currentUser(),epoch=s.epoch,code=s.code;
  if(!u||!code||!s.visible)return;
  s.claiming=true;s.lastClaim=t0;s.claimStage="sending";dg("claim.send",{});
  try{
    const reply=await deadline(MOVE_DEADLINE_MS,async signal=>{
      const t=await tokens(u);
      const response=await request(WORKER+"/italian/absence",{method:"POST",
        headers:{"Content-Type":"application/json",Authorization:"Bearer "+t.id,"X-Firebase-AppCheck":t.app},
        body:JSON.stringify({roomCode:code})},signal);
      let result=null;try{result=await response.json();}catch(_){result=null;}
      return {ok:response.ok===true,status:response.status,result};
    });
    if(epoch!==s.epoch)return;
    const errCode=reply.result&&reply.result.error?String(reply.result.error):null;
    dg("claim.reply",()=>({status:reply.status,ok:reply.ok,error:errCode}));
    if(!(reply.ok&&reply.status===200)&&reply.status>=400&&reply.status<500&&errCode!=="italian_stale_revision"){s.claimStage="refused";s.claimRefusedAt=Date.now();}
    if(reply.ok&&reply.status===200&&reply.result&&reply.result.ok===true){
      const raw=await readRoom(code,u),nv=project(raw,u.uid);
      if(epoch===s.epoch&&admit(code,raw)){adopt(raw,nv);say(statusFor(raw,nv));render();}
    }else if(reply.result&&reply.result.error==="italian_stale_revision"){refresh();}
  }catch(_){s.claimStage="idle";dg("claim.error",{});/* outcome unknown: the request is idempotent, the next tick may repeat it after the spacing */}
  finally{s.claiming=false;}
}
function stopWatch(){
  if(s.ref&&s.listener)s.ref.off("value",s.listener);
  if(s.poll!==null){clearInterval(s.poll);s.poll=null;}
  if(s.tmr!==null){clearInterval(s.tmr);s.tmr=null;}
  s.ref=null;s.listener=null;s.readPending=false;s.readAgain=false;
}
// Drops the room view only. A running operation keeps its busy token, so
// entering a room from inside create/join/check can still release the buttons.
function resetRoom(){
  stopHold();rmStop();actionsStop();stopPresence(false);s.superseded=null;leaveSpectating();
  stopWatch();fxStop();s.loc=null;s.pend=null;s.holdUntil=0;s.paintSig=null;s.paintPos=null;s.paintCells=null;s.epoch++;s.code=null;s.room=null;s.view=null;s.claimingTm=null;s.tmAt=0;   // K3: a time-is-up request belongs to ONE room visit (epoch): the next room never inherits it
  s.pendingJoin=null;s.selected=null;s.uncertain=false;s.spectator=false;s.recover=false;s.tp=null;
  if(copyTimer){global.clearTimeout(copyTimer);copyTimer=null;}const cb=$("copy");if(cb)cb.textContent=I18N.render(M("waiting.copy"));
}
function setBusy(v){
  s.busy=v;
  for(const id of ["create","join","check"]){const b=$(id);if(b)b.disabled=v;}
  render();
}
function begin(){const t={};s.token=t;setBusy(true);return t;}
function end(t){if(s.token===t){s.token=null;setBusy(false);}}
function remember(code){try{global.localStorage.setItem(KEY,code);}catch(_){}}
function forget(){try{global.localStorage.removeItem(KEY);}catch(_){}}
function remembered(){
  try{const c=global.localStorage.getItem(KEY);return typeof c==="string"&&CODE.test(c)?c:null;}
  catch(_){return null;}
}
// Documented Worker refusals. Only these exact "HTTP status:error" pairs are
// definitive (the Worker answered BEFORE any write, or the ETag CAS rejected the
// write). Anything else - including 409+italian_write_uncertain, any 5xx and
// every unlisted status/error combination - is UNKNOWN.
const DEFINITIVE={
  "400:italian_invalid_intent":"err.invalid_request",
  "400:invalid_json":"err.invalid_request",
  "401:firebase_auth_invalid":"err.login_again",
  "401:italian_auth_invalid":"err.login_again",
  "403:origin_denied":"err.origin",
  "403:italian_app_check_invalid":"err.app_check",
  "403:italian_tester_denied":"err.tester",
  "403:italian_not_a_player":"err.not_player",
  "404:not_found":"err.moves_off",
  "409:italian_illegal_move":"err.illegal",
  "409:italian_wrong_turn":"err.wrong_turn",
  "409:italian_stale_revision":"err.stale",
  "409:italian_room_not_active":"err.not_active",
  "409:italian_game_abandoned":"err.abandoned",
  "409:italian_time_expired":"err.time_expired",       // K3: a move that came after the limit (the database decided)
  "409:italian_room_invalid":"err.room_invalid",
  "409:italian_room_not_found":"err.room_missing",
  "409:italian_idempotency_conflict":"err.idem",
  "413:request_body_too_large":"err.invalid_request"
};   // value = dictionary key (words only); the CLASSIFICATION (the key set) lives here and does not depend on the translation module
function definitive(status,result){
  if(!result||typeof result!=="object"||result.ok!==false||typeof result.error!=="string")return null;
  const key=status+":"+result.error;
  return Object.prototype.hasOwnProperty.call(DEFINITIVE,key)?M(DEFINITIVE[key]):null;
}
function describeGate(gate){
  return gate&&gate.reason==="server_gate_closed"?M("gate.closed"):M("gate.unverified");
}
function ownMovable(v){
  if(!v||v.spectator||v.room.status!=="active"||v.room.turn!==v.color)return [];
  try{return Engine.getLegalMoves(v.game,v.color)||[];}catch(_){return [];}
}
// ---- Stage 6A2: the layout of the Russian game screen ------------------------------------------------------------------
// Only the CLASSES of the Russian screen are reused (style.css draws .square / .piece / .labels / .player-panel / .captured-icons /
// .move-hint); every element keeps its own it86-* id. Presentation only: nothing here reads or writes the network, the rules or the moves.
const CAPTURED_ICONS_MAX=6, INITIAL_PIECES=12;   // same stack limit as the Russian panel; 12 pieces per side in Italian draughts
const FILES="abcdefgh";
function put(id,list){const n=$(id);if(!n)return;n.replaceChildren();for(const t of list){const d=global.document.createElement("div");d.className="label";d.textContent=String(t);n.appendChild(d);}}
// Coordinates exactly as on the Russian board (a-h left to right / 8-1 top to bottom for the light side, the whole board turned by 180 degrees for the dark side).
function renderCoordinates(color){
  const files=[],ranks=[];
  for(let i=0;i<8;i++){files.push(color==="dark"?FILES[7-i]:FILES[i]);ranks.push(color==="dark"?i+1:8-i);}
  put("labels-top",files);put("labels-bottom",files);put("labels-left",ranks);put("labels-right",ranks);
}
function clearCoordinates(){for(const id of ["labels-top","labels-bottom","labels-left","labels-right"]){const n=$(id);if(n)n.replaceChildren();}}
// Stage 6D: how a player name is SHOWN (display only: the name in the room, in the database and in the sign-in is never changed - name(u) above is not touched).
// Telegram names may be decorated: mathematical / fullwidth / circled / superscript letters (NFKC turns them into plain letters), invisible and direction characters,
// stacks of combining marks. The Russian panel shows the first 4 characters and a dot (script.js: compactGamePlayerName); the same rule is used here.
const INVISIBLE=/[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF9-\uFFFB]/g;
function displayName(raw){
  let v=typeof raw==="string"?raw:"";
  try{v=v.normalize("NFKC");}catch(_){}
  v=v.replace(/\s+/g," ").replace(INVISIBLE,"");
  try{v=v.replace(/(\p{M})\p{M}+/gu,"$1");}catch(_){}   // a stack of combining marks ("zalgo") keeps its first mark
  return v.replace(/\s+/g," ").trim();
}
function compactName(raw){
  const clean=displayName(raw),noAt=clean.charAt(0)==="@"?clean.slice(1):clean,chars=Array.from(noAt);
  return chars.length>4?chars.slice(0,4).join("")+".":noAt;
}
function identity(name,color){
  const wrap=global.document.createElement("span");wrap.className="game-player-identity";
  const text=displayName(name);wrap.title=text;
  const avatar=global.document.createElement("span");avatar.className="game-player-avatar";avatar.setAttribute("aria-hidden","true");
  const fb=global.document.createElement("span");fb.className="game-player-avatar-fallback";
  const cleaned=text.replace(/^@/,"");fb.textContent=cleaned?Array.from(cleaned)[0].toUpperCase():"\u25CF";
  const dot=global.document.createElement("span");dot.className="player-color-dot "+(color==="light"?"light-dot":"dark-dot");
  avatar.appendChild(fb);avatar.appendChild(dot);
  const label=global.document.createElement("span");label.className="player-name-label";label.textContent=compactName(name);
  wrap.appendChild(avatar);wrap.appendChild(label);return wrap;
}
function capturedStack(box,count,iconClass){
  if(!box)return;box.textContent="";
  const total=Number.isSafeInteger(count)&&count>0?count:0;if(!total)return;
  const shown=Math.min(total,CAPTURED_ICONS_MAX),utils=global.RussianCheckersCapturedStackUtils;
  for(let i=0;i<shown;i++){
    const icon=global.document.createElement("div");icon.className="captured-icon "+iconClass;
    const depth=utils&&typeof utils.capturedDepthOpacity==="function"?utils.capturedDepthOpacity(shown-1-i):1;
    icon.style.setProperty("--depth-opacity",String(depth));icon.style.setProperty("--depth-order",String(i+1));box.appendChild(icon);
  }
  const badge=global.document.createElement("span");badge.className="captured-count";badge.textContent=String(total);box.appendChild(badge);
}
function renderPanels(v,room){
  if(holdOn(s)){v=null;room=null;}   // K1A: while the creator's «friend connected» picture runs no panel is drawn, whoever asks (profile / name callbacks included)
  const top=$("panel-top"),bottom=$("panel-bottom"),screen=$("screen");
  const playing=!!(v&&room&&v.game&&Array.isArray(v.game.pieces)&&(room.status==="active"||over(room))&&room.players&&room.players.light&&room.players.dark);
  if(screen)screen.setAttribute("data-it86-playing",playing?"1":"0");
  if(top)top.hidden=!playing;if(bottom)bottom.hidden=!playing;
  if(!playing){clearCoordinates();return;}
  const mine=v.color==="dark"?"dark":"light",other=mine==="light"?"dark":"light";   // a spectator watches from the light side, like the Russian screen
  renderCoordinates(mine);
  const left=c=>v.game.pieces.filter(p=>p.color===c).length;
  const seats=[["top",other],["bottom",mine]];
  for(const [pos,color] of seats){
    const nm=$(pos+"-name");if(nm){nm.replaceChildren();nm.appendChild(identity(seatName(room,color),color));}
    // a panel shows the opponent pieces its player has taken (the Russian panel does the same)
    const taken=Math.max(0,INITIAL_PIECES-left(color==="light"?"dark":"light"));
    capturedStack($(pos+"-captured"),taken,color==="light"?"dark-icon":"light-icon");
    const panel=pos==="top"?top:bottom,live=room.status==="active"&&(room.turn==="light"||room.turn==="dark");
    if(panel){
      panel.classList.toggle("turn-active",live&&room.turn===color);
      panel.classList.toggle("turn-inactive",live&&room.turn!==color);
      panel.classList.toggle("player-faded",pos==="top"&&!!s.opp);   // the opponent is away (countdown / expired): the panel fades like on the Russian screen
    }
  }
  turnCue(room,room.status==="active"&&(room.turn==="light"||room.turn==="dark")?room.turn:null,seats,top,bottom);
  paintPanelStatus();
}
// The one-off pulse of the panel that gets the move: the Russian screen's turn cue (script.js renderTurnPanelPresentation), the SAME class `turn-cue` and the SAME rules:
// only a REAL change of side inside one game (first draw of a game, reload / reconnect, rematch and a repeated draw of the same state never pulse). Presentation only:
// it reads the turn the server already confirmed and never decides anything.
function turnCue(room,turn,seats,top,bottom){
  const clear=()=>{if(top)top.classList.remove("turn-cue");if(bottom)bottom.classList.remove("turn-cue");};
  if(!turn){clear();s.tp=null;return;}
  const gen=s.code+"|"+(room.matchNumber||0)+"|"+(room.createdAt||0),mc=typeof room.moveCount==="number"?room.moveCount:0,prev=s.tp;
  s.tp={gen,turn,mc};
  if(!prev||prev.gen!==gen){clear();return;}
  if(prev.turn===turn)return;
  if(mc<=prev.mc){clear();return;}
  const seat=seats.find(x=>x[1]===turn),target=seat?(seat[0]==="top"?top:bottom):null;
  if(!target)return;
  clear();void target.offsetWidth;target.classList.add("turn-cue");
}
// Stage 6E-2: the status under each player name, drawn like the Russian panel (script.js: statusForColor / applyStatusToElement): a dot + a word.
//   own panel: «В игре» (green) - «Подключение…» (grey) while the server state is unknown;
//   the opponent: «Подключение…» until his presence is known, «В игре», «Оффлайн 45с» (the minute he has to come back), «Подтверждение…» (the server confirms the result).
// Presentation only: it reads the presence the screen already watches; it never writes anything and never decides anything.
// F1: a technical end (disconnect / timeout) has no rematch: ONE button «Закрыть» (same rule as the Russian screen, shared predicate).
function isTechEnd(w){const PS=global.OnlinePresenceStatus;return PS&&typeof PS.isTechnicalEnd==="function"?PS.isTechnicalEnd(w):(w==="disconnect"||w==="timeout");}
function claimStageNow(){return s.claimRefusedAt&&Date.now()-s.claimRefusedAt<30000?"refused":(s.claimStage==="sending"?"sending":"idle");}
// The facts about ONE seat for the shared classifier (server time basis, both numbers from the SAME aggregated record).
function seatFacts(color,n){
  let a=null;try{a=Presence.aggregate(s.pres);}catch(_){a=null;}
  const c=a&&a[color];
  const num=x=>typeof x==="number"&&isFinite(x);
  return {ready:!!n.ready,connected:!!n.connected,known:!!c,
    awayMs:c&&c.online===false&&num(c.absentSince)?n.ms-c.absentSince:null,
    silentMs:c&&num(c.lastSeen)?n.ms-c.lastSeen:null,claim:claimStageNow()};
}
function panelStatusFor(pos){
  const v=s.view,room=s.room;
  if(!v||!room||room.status!=="active")return null;
  const mine=v.color==="dark"?"dark":"light",other=mine==="light"?"dark":"light";
  const color=pos==="top"?other:mine;
  if(!v.spectator&&pos==="bottom"){   // my own seat: never a countdown/verdict about MYSELF; no link of my own = «Подключение…»
    const own=srv();return s.uncertain||!own.connected?{m:M("panel.connecting"),cls:"status-neutral"}:{m:M("panel.in_game"),cls:"status-online"};
  }
  if(!Presence||(!v.spectator&&!s.pc))return {m:M("panel.connecting"),cls:"status-neutral"};
  const n=srv();
  if(!n.connected)return {m:M("panel.connecting"),cls:"status-neutral"};   // no link of my own: the other seat cannot be judged (Russian: «Соединение…»)
  const PS=global.OnlinePresenceStatus;
  if(PS){   // F1: the same classification as the Russian panel (shared/online-presence-status.js)
    const cs=seatFacts(color,n);
    const q=PS.classifySeat(cs);
    if(q.state==="present")return {m:M("panel.in_game"),cls:"status-online"};
    if(q.state==="countdown")return {m:M("panel.offline",{sec:Math.ceil(q.remainingMs/1000)}),cls:"status-countdown"};
    if(q.state==="confirming")return {m:M(v.spectator?"panel.interrupted":"panel.confirming"),cls:"status-left"};
    if(q.state==="no_link"||q.state==="away_unresolved")return {m:M(v.spectator?"panel.interrupted":"panel.no_link"),cls:"status-left"};
    return {m:M("panel.connecting"),cls:"status-neutral"};
  }
  let st;try{st=Presence.seatState(s.pres,color,n.ms,n.ready);}catch(_){st={state:"unknown"};}
  if(st.state==="present")return {m:M("panel.in_game"),cls:"status-online"};
  if(st.state==="countdown")return {m:M("panel.offline",{sec:Math.ceil(st.remainingMs/1000)}),cls:"status-countdown"};
  if(st.state==="expired")return {m:M(v.spectator?"panel.interrupted":"panel.confirming"),cls:"status-left"};
  return {m:M("panel.connecting"),cls:"status-neutral"};
}
function paintPanelStatus(){
  for(const pos of ["top","bottom"]){
    const el=$(pos+"-status"),panel=$("panel-"+pos);if(!el)continue;
    const st=panelStatusFor(pos);
    if(!st){el.className="player-status";el.replaceChildren();continue;}
    el.className="player-status "+st.cls;
    let t=el.querySelector(".player-status-text");
    if(!t){el.replaceChildren();t=global.document.createElement("span");t.className="player-status-text";el.appendChild(t);}
    t.textContent=I18N.render(st.m);
    if(panel&&(pos==="top"||(s.view&&s.view.spectator)))panel.classList.toggle("player-faded",st.cls==="status-left"||st.cls==="status-countdown"||(pos==="top"&&!!s.opp));
  }
}
// ---- Stage 6E-3: the result window (the Russian #end-game-modal) and the exit confirmation (#back-confirm-modal) ----
// Presentation only: it reads the room the screen already holds. The rematch (shared/italian-online-rematch.js) is the same one, its controls just live inside the window.
const END_MOODS=["win","loss","draw","neutral"];
// A drawn game stores winner "draw" (the Worker, Stage F-A) or no winner at all (older finished rooms): neither is a colour.
const winColor=r=>r&&(r.winner==="light"||r.winner==="dark")?r.winner:null;
function endInfo(v,room){
  const nm=c=>{const n=seatName(room,c);return n||I18N.render(M(c==="light"?"end.whites":"end.blacks"));};
  // «Партия не состоялась»: neither a win, a loss nor a draw. Same window, neutral mood, no rematch (the old game can never be resumed; a new one can be started).
  if(room.status==="void")return {mood:"neutral",head:I18N.render(M("void.header")),sub:I18N.render(M(v.spectator?"void.text_spectator":"void.text"))};
  const wc=winColor(room),mood=v.spectator?"neutral":!wc?"draw":wc===v.color?"win":"loss";
  let head,sub="";
  if(!wc){
    const manual=room.winReason==="draw";
    head=I18N.render(M(manual?"end.draw_manual_header":"end.draw_rule_header"));
    sub=I18N.render(M(manual?"end.draw_manual_text":room.winReason==="repetition"?"end.draw_repetition":room.winReason==="forty_moves"?"end.draw_forty":"end.draw_unknown"));
  }else{
    const w=wc,l=w==="light"?"dark":"light";
    head="✅ "+nm(w)+"\n❌ "+nm(l);
    if(room.winReason==="disconnect"){
      // F1: the same finish screen as the Russian one: «Партия завершена» + the reason from MY side; a spectator keeps the old wording
      if(v.spectator)sub=I18N.render(M("end.reason_disconnect"));
      else{head=I18N.render(M("end.head_finished"));sub=I18N.render(M(w===v.color?"end.reason_disconnect_win":"end.reason_disconnect_loss"));}
    }
    else if(room.winReason==="timeout")sub=v.spectator?I18N.render(M("end.timeout_label"))+": "+nm(l)+". "+I18N.render(M("end.winner_label"))+": "+nm(w)+".":
      I18N.render(M(w===v.color?"end.reason_timeout_win":"end.reason_timeout_loss"));
    else if(room.winReason==="resign")sub=v.spectator?I18N.render(M("end.resign_label"))+": "+nm(l)+". "+I18N.render(M("end.winner_label"))+": "+nm(w)+".":
      I18N.render(M(w===v.color?"end.reason_resign_win":"end.reason_resign_loss"));
  }
  return {mood,head,sub};
}
function backAsk(open){
  const m=$("back-confirm");if(!m)return;
  m.classList.toggle("hidden",!open);
  if(open){const n=$("back-no");if(n)try{n.focus({preventScroll:true});}catch(_){}}
}
// B2R34: statistics of a FINISHED italian online game are recorded by the Worker (it settles right after the finishing write). This is the safety net:
// a player's client asks POST /italian/settle once per finished game (idempotent on the server: one receipt per game), and repeats a few times when the
// answer is lost / the server was busy. The browser never sends a result: the Worker reads the room itself.
const SETTLE_DELAYS_MS=[3000,8000,20000];
const settledGames=new Set();
function settleStats(code,createdAt,attempt){
  if(!code||!Number.isSafeInteger(createdAt))return;
  const key=code+"_"+createdAt;
  if(attempt===0){if(settledGames.has(key))return;settledGames.add(key);}
  let p;try{p=workerPost("/italian/settle",{roomCode:code});}catch(_){p=Promise.resolve({ok:false,status:0});}
  Promise.resolve(p).then(r=>{
    if(r&&r.ok===true)return;
    const st=r&&r.status;   // 4xx other than 409 are final answers (not a player, not found); 0 / 5xx / 409 are retried a few times
    if(st&&st>=400&&st<500&&st!==409&&st!==429)return;
    if(attempt<SETTLE_DELAYS_MS.length)global.setTimeout(()=>settleStats(code,createdAt,attempt+1),SETTLE_DELAYS_MS[attempt]);
  },()=>{if(attempt<SETTLE_DELAYS_MS.length)global.setTimeout(()=>settleStats(code,createdAt,attempt+1),SETTLE_DELAYS_MS[attempt]);});
}
function paintEnd(){
  const box=$("end");if(!box)return;
  const v=s.view,room=s.room;
  if(!(s.visible&&room&&room.status==="active"))backAsk(false);
  const show=!!(s.visible&&v&&room&&over(room)&&room.players&&room.players.light&&room.players.dark);
  const was=!box.classList.contains("hidden");
  box.classList.toggle("hidden",!show);
  if(!show)return;
  if(!v.spectator&&room.status==='finished')settleStats(s.code,room.createdAt,0);
  const info=endInfo(v,room);
  for(const m of END_MOODS)box.classList.remove("end-game-mood-"+m);
  box.classList.add("end-game-mood-"+info.mood);
  const t=$("end-text"),sub=$("end-subtext"),c=$("end-close");
  if(t)t.textContent=info.head;if(sub)sub.textContent=info.sub;
  if(c)c.textContent=I18N.render(M(v.spectator?"end.to_menu":"end.close"));
  if(!was&&c)try{c.focus({preventScroll:true});}catch(_){}
}
// «👈 Назад»: a player of a RUNNING game confirms the exit (like the Russian bot game); a spectator and a finished game leave at once.
function exitPressed(){
  const v=s.view,room=s.room;
  if(v&&!v.spectator&&room&&room.status==="active"){backAsk(true);return;}
  leave();
}
// Stage 6C: which service controls the player needs NOW (presentation only; every handler keeps its own guards).
//   entering / room open and healthy -> no «Создать комнату», «Присоединиться», code field, «Проверить комнату»;
//   recovery (create/join unconfirmed, a remembered room could not be read) -> only «Проверить комнату» (never a second create);
//   nothing open and nothing running (auto-create refused or failed) -> create (retry), code, join, check: the manual way out.
// Stage K1A: the CREATOR of a room sees the Russian «Друг подключился! Начинаем игру.» picture (green bridge + text) for CONNECT_HOLD_MS after the server confirmed
// that the friend joined (waiting -> active), then the board. This is presentation ONLY: the room view, the presence, the heartbeat and every game event are processed at once;
// only the drawing of the board waits. It starts only from a card that was on screen (never for a guest, a restored game, a spectator or a rematch), runs once per room
// and ends by its own timer, by a different room / epoch, by closing the panel, or when the room is no longer active.
const CONNECT_HOLD_MS=1000;
function holdOn(st){const h=st.hold;return !!h&&h.epoch===st.epoch&&h.code===st.code&&!st.spectator&&!!st.room&&st.room.status==="active";}
function stopHold(){const h=s.hold;s.hold=null;if(h&&h.timer){global.clearTimeout(h.timer);h.timer=null;}}
function startHold(){
  if(s.hold||s.holdSpent===s.epoch)return;
  s.holdSpent=s.epoch;
  const h={epoch:s.epoch,code:s.code,timer:null};
  h.timer=global.setTimeout(()=>{
    h.timer=null;
    if(s.hold!==h)return;
    s.hold=null;
    if(h.epoch!==s.epoch||h.code!==s.code||!s.visible)return;   // another room / closed meanwhile: nothing to repaint here
    render();
  },CONNECT_HOLD_MS);
  s.hold=h;
}
function controlsFor(st){
  const spec=!!st.spectator,has=!!st.code,room=st.view&&st.view.room,waiting=!room||room.status==="waiting";
  const idle=!spec&&!has&&!st.recover&&!st.entering&&!st.autoJoin;   // autoJoin = an invitation link is being handled: the guest sees no manual controls flash by
  // Stage 6D: the invitation card (the Russian «Приглашение готово / Ожидание подключения друга») is shown only for a room the server CONFIRMED as waiting;
  // it carries «Отправить другу», «Скопировать ссылку» and «Назад». The raw link text is no longer drawn (the Russian screen does not draw it either).
  const card=!spec&&has&&!!room&&(room.status==="waiting"||holdOn(st))&&!!st.view&&!st.view.spectator;
  return {
    create:false,join:false,code:false,   // the old test controls (manual create / join / code) are not part of the real game: the invitation is created automatically, a guest comes by the link
    check:!spec&&!st.entering&&!st.autoJoin&&(!has||st.uncertain||!!st.pendingJoin||st.recover),
    card,share:card,copy:card,back:card,credit:card,
    link:false
  };
}
// Stage F-A transitions: ONE rule decides when a screen is "not ready yet". While a screen is opened (the entry «Играть с другом», an invitation link,
// a remembered game, a game opened for viewing) and no room is on screen, or while the other player of a REMATCH is still joining the new room,
// the Russian loading cover is the ONLY thing painted: the two turning draughts and «Загрузка…» / «Подключение к столу…» (the Russian #startup-cover texts).
// The «Назад» button, the status line, the manual service controls and the invitation card never flash by. The cover is bound to real states (never a timer):
// it ends when the target screen is ready, when the step fails (the message and the way out are painted), or after COVER_MAX_MS at the latest.
// Stage K1C: the board and the pieces are CSS background pictures (assets/board.png, piece_*.png, king_*.png) that the browser fetches only when the first
// board is painted. The cover used to end the moment the room arrived, so for a moment the board and the pieces were drawn WITHOUT their pictures and the
// pictures popped in a few hundred ms later (a second «flash» after the turning draughts). The pictures are now requested and decoded as soon as the screen
// is opened (in parallel with the room read) and the cover stays until they are ready: the board appears as one finished picture. This is a check of
// readiness, not a delay: it ends the moment the pictures are decoded (or failed to load - the screen is then drawn as before) and, like every cover,
// never lasts longer than COVER_MAX_MS. The URLs are the ones of style.css / italian-online.css (same strings = the same cache entries).
const ART_URLS=["assets/board.png?v=1","assets/piece_dark.png?v=2","assets/piece_light.png?v=2","assets/king_dark.png?v=2","assets/king_light.png?v=2"];
let artReady=typeof global.Image!=="function",artStarted=false;   // no Image constructor (tests / very old WebView): nothing to wait for
function warmArt(){
  if(artReady||artStarted)return;
  artStarted=true;
  const one=u=>new Promise(res=>{
    try{
      const im=new global.Image();
      if(typeof im.decode==="function"){im.src=u;im.decode().then(()=>res(),()=>res());}   // decode() also waits for the download
      else{im.onload=()=>res();im.onerror=()=>res();im.src=u;}
    }catch(_){res();}
  });
  Promise.all(ART_URLS.map(one)).then(()=>{artReady=true;if(s.visible)paintCover();});
}
function coverFor(st){
  if(!st.visible||st.spectator)return null;
  const room=st.view&&st.view.room;
  if(!room){
    if(st.autoJoin)return "invite";
    if(st.entering||st.opening)return "normal";
    return null;
  }
  if(st.rmJoin&&st.code===st.rmJoin&&room.status==="waiting")return "invite";   // the creator of a rematch room: no invitation card, the other player joins within seconds
  if(!artReady&&room.status!=="waiting"&&!holdOn(st))return st.cover||(st.autoJoin?"invite":"normal");   // K1C: a board is about to be drawn but its pictures are not ready: keep the SAME cover (same text)
  return null;
}
function paintCover(){
  const want=coverFor(s);
  if(!want){if(s.coverTimer){global.clearTimeout(s.coverTimer);s.coverTimer=null;}s.coverGaveUp=false;}
  else if(!s.coverGaveUp&&!s.coverTimer)s.coverTimer=global.setTimeout(()=>{s.coverTimer=null;s.coverGaveUp=true;paintControls();},COVER_MAX_MS);
  const kind=want&&!s.coverGaveUp?want:null;
  s.cover=kind;
  const cv=$("cover");
  if(cv){cv.classList.toggle("hidden",!kind);cv.setAttribute("data-kind",kind||"normal");cv.setAttribute("aria-hidden",kind?"false":"true");}
  const screen=$("screen");if(screen)screen.setAttribute("data-it86-loading",kind?"1":"0");
}
// Messages that only repeat what the invitation card already says: they are not drawn next to the card (errors and uncertain states always are).
const QUIET_WITH_CARD=new Set(["msg.room_created","msg.restored_server","msg.game_restored","msg.test_mode","msg.looking_unfinished","msg.reading_room",
  "msg.checking_create","msg.checking_join","msg.joined","msg.room_confirmed","msg.join_confirmed","msg.server_refreshed","status.waiting"]);
// Messages that only report that everything is fine (whose move it is, the server confirmed a move, the game was restored / joined...). While a game is ACTIVE the Russian screen
// draws none of them: the turn is the lit panel. They are kept in the DOM for screen readers (visually hidden, see italian-online.css) and come back in full when the game
// ends. Errors, warnings, «not confirmed», reconnect and the hints of the rules are never in this list.
const QUIET_IN_GAME=new Set(["status.my_turn","status.opp_turn","status.sp_turn_light","status.sp_turn_dark","msg.move_confirmed","msg.restored_server","msg.game_restored",
  "msg.room_confirmed","msg.join_confirmed","msg.joined","msg.server_refreshed","msg.looking_unfinished","msg.reading_room","msg.checking_create","msg.checking_join","msg.test_mode","msg.room_created",
  "msg.move_invalid",   // IT C5: a tap on an empty / wrong square while a piece is selected is an ordinary local miss: the selection is dropped silently (the Russian screen draws no text); still read aloud
  "msg.waiting_server",   // «Ждём подтверждения сервера…» during a NORMAL move: the answer comes within a moment; a missing answer ends in «ход НЕ подтверждён» (visible)
  "msg.cannot_move_piece"]);   // «Этой шашкой ходить нельзя…» under the board shifted the screen; the Russian screen draws no text for this tap (the movable pieces are lit instead). Still read aloud; errors stay visible
function paintStatus(c){
  const st=$("status");if(!st)return;
  const k=c||controlsFor(s);
  st.hidden=!!(k.card&&(holdOn(s)||!s.msg||typeof s.msg!=="object"||QUIET_WITH_CARD.has(s.msg.k)));
  if(s.room&&s.room.status==="active"&&s.msg&&typeof s.msg==="object"&&QUIET_IN_GAME.has(s.msg.k))st.setAttribute("data-it86-quiet","1");else st.removeAttribute("data-it86-quiet");
}
// A player's running, confirmed game: «Назад» is not drawn (the Russian screen has none; the player leaves with Telegram's own controls and returns through «Кто играет?»).
// It is drawn again in the states where the way out is needed: the invitation card (own «Назад»), a spectator, a finished game, loading with no active room, and when no room is open (B2R33: NOT during an active game, even unconfirmed). The handler (exitPressed -> confirmation -> leave) is untouched.
function liveGame(){
  const v=s.view,r=s.room;
  return !!(v&&!v.spectator&&r&&r.status==="active"&&!holdOn(s));   // B2R33 (owner): an ACTIVE game of a player never shows «Назад», also while the result is unconfirmed (s.uncertain / s.recover / s.pendingJoin): «Проверить комнату» stays
}
function paintControls(){
  const c=controlsFor(s);
  for(const id of ["create","join","check","code","share","link","copy","back","waiting","credit"]){const n=$(id);if(n)n.hidden=!(id==="waiting"?c.card:c[id]);}
  const hold=holdOn(s),wt=$("waiting-text"),wc=$("waiting");
  if(wc)wc.classList.toggle("it86-connected",hold);
  if(wt){const key=hold?"waiting.connected":"waiting.text";const txt=I18N.render(M(key));if(wt.getAttribute("data-it86-i18n")!==key)wt.setAttribute("data-it86-i18n",key);if(wt.textContent!==txt)wt.textContent=txt;}   // no rewrite of an unchanged text: the live region announces only a real change
  const exit=$("exit");if(exit)exit.hidden=c.card||liveGame();   // the card has its own «Назад»; a running game has none (the Russian game screen has no such button)
  const box=$("controls");   // the row of manual controls: not drawn at all when none of them is shown (no empty row, no extra gap)
  if(box)box.hidden=!(c.create||c.join||c.code||c.check);
  paintStatus(c);
  const screen=$("screen");if(screen)screen.setAttribute("data-it86-wait",c.card?"1":"0");
  paintCover();
}
function render(){
  const board=$("board");if(!board)return;
  paintControls();
  const v=(s.loc&&s.loc.view)||s.view,room=v&&v.room,linkText=$("link"),players=$("players");
  if(linkText)linkText.textContent=s.code?link(s.code):"";
  if(players)players.textContent=room?I18N.render(M("players.line",{light:seatName(room,"light"),
    dark:room.players.dark?seatName(room,"dark"):M("players.waiting")})):"";
  const held=holdOn(s);   // the friend has joined, the card is still shown for a moment: no panels, no board yet
  renderPanels(v,room);paintEnd();paintActions();paintTimer();
  if(!room||room.status==="waiting"||held){board.replaceChildren();s.paintSig=null;s.paintPos=null;s.paintCells=null;fxStop();return;}
  const legal=s.busy||s.uncertain?[]:ownMovable(v);
  // Stage 6E: the two squares of the last jump are marked like the Russian .last-move (the stored receipt of the room is enough after a reload too)
  const lj=BT?BT.lastJump(room):null,lastKeys=lj?new Set([lj.from.row+"_"+lj.from.col,lj.to.row+"_"+lj.to.col]):null;
  const from=new Set(legal.map(m=>m.fromRow+"_"+m.fromCol));
  const to=new Set(legal.filter(m=>s.selected&&m.fromRow===s.selected.row&&
    m.fromCol===s.selected.col).map(m=>m.toRow+"_"+m.toCol));
  // While the animation of OUR move still runs and the POSITION is the one already drawn (pieces, side to move, forced piece, last-move marks, colour, room),
  // the cells are KEPT: a redraw would cut the flight / the turning king. Only the marks that the confirmation changes (selected piece, hints, click lock)
  // are corrected in place - e.g. the capturing piece is preselected after a confirmed intermediate jump. Any other change of the position, a refusal
  // (dropLocal) or leaving the room (resetRoom) ends the hold, and the board is drawn from scratch as before.
  const dis=!!v.spectator||s.busy||s.uncertain||room.status!=="active"||room.turn!==v.color;
  const pos=[v.color,lastKeys?[...lastKeys].sort().join(","):"",boardSig(v.game,room.turn),s.code].join("#");
  const marks=[dis?1:0,s.selected?s.selected.row+"_"+s.selected.col:"",[...from].sort().join(","),[...to].sort().join(",")].join("#");
  const cellsKept=()=>!!s.paintCells&&s.paintCells.length===64&&Array.prototype.every.call(s.paintCells,c=>Array.prototype.indexOf.call(board.children||[],c.b)>=0);   // our 64 cells are still the board's (the arrow svg and the effects are extra children)
  const flag=(el,name,on)=>{const l=String(el.className||"").split(/\s+/).filter(x=>x&&x!==name);if(on)l.push(name);el.className=l.join(" ");};
  if(Date.now()<s.holdUntil&&s.paintPos===pos&&cellsKept()){
    if(s.paintSig!==marks)for(const c of s.paintCells){
      const isSel=!!(s.selected&&s.selected.row===c.row&&s.selected.col===c.col);
      flag(c.b,"selected",isSel);flag(c.b,"target",to.has(c.key));flag(c.b,"move-hint",to.has(c.key));flag(c.b,"movable",from.has(c.key));
      c.b.disabled=dis;if(c.tok)flag(c.tok,"selected",isSel);
    }
    s.paintSig=marks;
  }else{
  s.paintPos=pos;s.paintSig=marks;s.paintCells=[];board.replaceChildren();
  // Official orientation: each player has a dark corner square on the right.
  // Light sees columns mirrored, dark sees the board rotated by 180 degrees.
  // Italian draughts are mirror-symmetric, so rules and stored data are unchanged.
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
    const row=v.color==="dark"?7-y:y,col=v.color==="dark"?x:7-x;
    const piece=v.game.pieces.find(p=>p.row===row&&p.col===col);
    const key=row+"_"+col;
    const b=global.document.createElement("button");b.type="button";
    const isSel=!!(s.selected&&s.selected.row===row&&s.selected.col===col);
    b.className="it86-cell square "+((row+col)%2?"dark":"light")+(isSel?" selected":"")+
      (to.has(key)?" target move-hint":"")+(from.has(key)?" movable":"")+(lastKeys&&lastKeys.has(key)?" last-move":"");
    b.setAttribute("data-it86-cell",key);
    b.setAttribute("aria-label",I18N.render(M(piece?(piece.color==="light"?"cell.light":"cell.dark"):"cell.empty",{row:row+1,col:col+1})));
    b.disabled=dis;
    let token=null;
    if(piece){
      token=global.document.createElement("span");
      token.className="it86-piece piece piece-"+piece.color+" "+piece.color+(piece.king?" king":"")+(isSel?" selected":"");
      token.textContent=piece.king?"♛":"●";b.appendChild(token);
    }
    b.addEventListener("click",()=>select(row,col));
    board.appendChild(b);s.paintCells.push({b,row,col,key,tok:token});
  }}
  paintEffects(v,room,legal);
}
function statusFor(raw,v){
  if(raw.status==="void")return M("status.void");
  if(v&&v.spectator){
    const dc=raw.winReason==="disconnect";
    if(raw.status==="finished")return winColor(raw)?M(raw.winner==="light"?(dc?"status.sp_won_light_dc":"status.sp_won_light"):
      (dc?"status.sp_won_dark_dc":"status.sp_won_dark")):M("status.finished");
    return M(raw.turn==="light"?"status.sp_turn_light":"status.sp_turn_dark");
  }
  if(raw.status==="waiting")return M("status.waiting");
  if(raw.status==="finished"&&raw.winReason==="disconnect")
    return raw.winner===v.color?M("status.won_dc"):M("status.lost_dc");
  if(raw.status==="finished")
    return raw.winner===v.color?M("status.won"):
      winColor(raw)?M("status.lost"):M("status.finished");
  return M(raw.turn===v.color?"status.my_turn":"status.opp_turn");
}
function unchanged(raw){
  const r=s.room;
  return !!r&&!s.uncertain&&(r.revision||0)===(raw.revision||0)&&r.status===raw.status&&
    r.turn===raw.turn&&r.winner===raw.winner&&!!r.players.dark===!!raw.players.dark&&
    (r.moveCount||0)===(raw.moveCount||0);
}
// Stale-response guard. A server revision never decreases, so an answer older
// than the state already accepted (or from an older request generation, or from
// another game session) must not touch board, turn or selection.
function stamp(raw){
  const p=raw.players||{};
  return {createdAt:raw.createdAt,light:p.light&&p.light.id,dark:(p.dark&&p.dark.id)||null,
    mn:raw.matchNumber,rev:raw.revision||0,
    rank:over(raw)?2:raw.status==="active"?1:0};
}
function admit(code,raw,gen){
  const n=stamp(raw),a=s.acc&&s.acc.code===code?s.acc:null;
  if(a){
    if(a.createdAt!==n.createdAt||a.light!==n.light||a.mn!==n.mn||
       (a.dark&&n.dark&&a.dark!==n.dark))throw Error("session_changed");
    if(n.rev<a.rev||(n.rev===a.rev&&n.rank<a.rank))return false;
  }
  if(gen!==undefined){if(gen<s.applied)return false;s.applied=gen;}
  s.acc={code,createdAt:n.createdAt,light:n.light,dark:n.dark||(a&&a.dark)||null,
    mn:n.mn,rev:n.rev,rank:n.rank};
  return true;
}
function adopt(raw,v){
  let before=s.view;   // the earlier accepted view of THIS room (null after resetRoom: opening, restoring, invite, rematch room -> silent)
  const L=s.loc,P=s.pend;
  const wasCard=controlsFor(s).card;   // the invitation card of a confirmed waiting room was on screen (creator only)
  const open=!!P&&P.code===s.code&&fate(P,raw)==="open";   // a sent request whose fate this room does not settle
  if(P&&!open)s.pend=null;
  // Our own move was already shown (sound + animation played): the room that confirms it is compared with THAT picture, so nothing is played twice.
  // Any other room wins over the temporary picture: it is dropped and the server position is drawn (not while the sent request is still open).
  if(L){if(confirms(L,raw,v)){s.loc=null;before=L.view;}else if(!open)dropLocal();}
  s.room=raw;s.view=v;s.uncertain=open&&P.unknown===true;
  if(wasCard&&s.visible&&raw.status==="active"&&!v.spectator&&!s.spectator&&!(s.rmJoin&&s.rmJoin===s.code))startHold();
  if(SND){try{SND.observe(before,v);}catch(_){}}
  try{noteTransition(before,v);}catch(_){s.fx=null;s.chain=null;}
  // A multi-capture must be continued by the same piece: preselect it.
  const f=v.game.mustContinueFrom;
  s.selected=raw.status==="active"&&raw.turn===v.color&&f?{row:f.row,col:f.col}:null;
  if(over(raw)&&!v.spectator)forget();
  syncPresence();rmSync();actionsSync();loadProfiles(raw);
}
async function refresh(){
  if(!s.visible||!s.code)return false;
  if(s.readPending){s.readAgain=true;return false;}
  const epoch=s.epoch,code=s.code,u=currentUser(),gen=++s.gen;
  if(!u){say(M("msg.login_confirmed"));return false;}
  s.readPending=true;
  try{
    const raw=await readRoom(code,u),v=s.spectator?projectSpectator(raw):project(raw,u.uid);
    if(epoch!==s.epoch||!s.visible||!same(u))return false;
    if(!admit(code,raw,gen))return false; // late/older answer: ignore completely
    // Same server state: keep the DOM and the player's selection untouched.
    if(unchanged(raw))return true;
    adopt(raw,v);say(s.pend&&s.uncertain?M("msg.move_uncertain"):statusFor(raw,v));   // a sent move whose fate is still open keeps its warning
    render();return true;
  }catch(_){
    if(epoch===s.epoch){s.uncertain=true;render();
      say(M("msg.server_unknown"));}
    return false;
  }finally{
    if(epoch===s.epoch){
      s.readPending=false;
      if(s.readAgain){s.readAgain=false;refresh();}
    }
  }
}
function enter(code,raw){
  const u=currentUser();if(!u)throw Error("auth_required");
  const v=project(raw,u.uid);
  if(!admit(code,raw))throw Error("stale_response");
  resetRoom();s.code=code;if(s.rmJoin&&s.rmJoin!==code)s.rmJoin=null;adopt(raw,v);
  if(createDoubt&&createDoubt.code===code)createDoubt=null;   // the room is on the server: the doubt about its creation is over
  if($("code"))$("code").value=code;
  if(!over(raw))remember(code);
  if(!over(raw))watchRoom(code);
  watchSpectators(code);
  render();
}
function watchRoom(code){
  const epoch=s.epoch;
  s.ref=db().ref("roomsItalian/"+code);
  s.listener=()=>{if(epoch===s.epoch)refresh();};
  s.ref.on("value",s.listener,()=>{if(epoch===s.epoch){
    s.uncertain=true;render();say(M("msg.listener_down"));}});
  // Read-only polling fallback: a silent SDK listener must not freeze the game.
  s.poll=setInterval(()=>{
    if(epoch===s.epoch&&s.visible&&!s.busy&&!s.readPending)refresh();
  },POLL_MS);
  s.tmr=setInterval(()=>{if(epoch===s.epoch)timerTick();},1000);   // K3: the Russian one-second timer tick
}
// ---- Stage 3 / Step B: spectators (roomSpectatorsItalian/<code>/<uid>), read-only ----
function watchSpectators(code){
  unwatchSpectators();
  const ref=db().ref("roomSpectatorsItalian/"+code);
  const listener=snap=>{
    if(s.code!==code)return;
    // roomSpectatorsItalian/<code>/<uid>/<sid>: one entry per TAB; the counter counts distinct viewers (uids) that still have a tab.
    const v=snap.val();let n=0;const list=[];
    if(v&&typeof v==="object")for(const k of Object.keys(v).sort()){
      const t=v[k];
      if(t&&typeof t==="object"&&Object.keys(t).length>0){
        n++;
        const sid=Object.keys(t).sort().find(x=>typeof t[x]==="string");   // one name per viewer: the first tab's (a second tab of the same viewer adds nothing)
        list.push({uid:k,raw:sid===undefined?"":t[sid]});
      }
    }
    setSpectators(n,list);loadSpectatorProfiles(code);
  };
  s.spRef=ref;s.spListener=listener;ref.on("value",listener,()=>{});
}
function unwatchSpectators(){
  if(s.spRef&&s.spListener)try{s.spRef.off("value",s.spListener);}catch(_){}
  s.spRef=null;s.spListener=null;
  setSpectators(0,[]);
}
// Registration of THIS tab: roomSpectatorsItalian/<code>/<uid>/<sid> (own sid per tab). Closing one tab only removes ITS sid, so a
// second tab of the same viewer stays counted. The server-side removal is armed FIRST and only then the entry is written;
// it is re-armed after every reconnect (`.info/connected`), because the server drops our onDisconnect registrations and has
// already removed the entry when the connection is lost. Every async step checks that this registration is still current,
// so the completion order of the promises never decides the state.
function registerSpectator(code,u){
  const sid=Presence?Presence.randomSid(global):null;if(!sid)return;
  const ref=db().ref("roomSpectatorsItalian/"+code+"/"+u.uid+"/"+sid);
  const h={ref,code,sid,conn:null,connListener:null,gen:0};
  s.mySp=h;
  const current=()=>s.mySp===h&&s.spectator&&s.code===code;
  const arm=()=>{
    const g=++h.gen;
    try{
      ref.onDisconnect().remove().then(()=>{
        if(!current()||h.gen!==g)return;
        return ref.set(name(u));
      }).catch(()=>{});
    }catch(_){}
  };
  try{
    const conn=db().ref(".info/connected");
    h.conn=conn;h.connListener=snap=>{if(snap&&snap.val()===true&&current())arm();};
    conn.on("value",h.connListener,()=>{});
  }catch(_){arm();}
}
function leaveSpectating(){
  const h=s.mySp;s.mySp=null;
  if(h){
    h.gen++; // late ACKs of an in-flight registration must not write the entry back
    if(h.conn&&h.connListener)try{h.conn.off("value",h.connListener);}catch(_){}
    try{h.ref.onDisconnect().cancel();}catch(_){}try{h.ref.remove();}catch(_){}
  }
  unwatchSpectators();
}
// Open a FOREIGN active/finished Italian game read-only (lobby «Смотреть»). A seated player is routed to the normal
// player view instead (the lobby shows «Продолжить» for those). Nothing is written except the viewer's own entry.
async function spectate(code){
  try{
    show();
    if(!CODE.test(code)){say(M("msg.bad_code"));return false;}
    const u=currentUser();if(!u){say(M("msg.login_first"));return false;}
    const og=++openGen;s.opening=true;const epoch=s.epoch,tk=begin();say(M("msg.opening_spectate"));
    try{
      const raw=await readRoom(code,u);
      await ensureName(u);   // Stage 6E-2
      if(epoch!==s.epoch||!s.visible)return false;
      const pl=raw&&raw.players;
      if(pl&&((pl.light&&pl.light.id===u.uid)||(pl.dark&&pl.dark.id===u.uid))){enter(code,raw);say(statusFor(raw,s.view));return true;}
      const v=projectSpectator(raw);
      if(!admit(code,raw))throw Error("stale_response");
      resetRoom();s.code=code;s.spectator=true;
      adopt(raw,v);
      if($("code"))$("code").value="";
      if(!over(raw))watchRoom(code);
      watchSpectators(code);registerSpectator(code,u);
      say(statusFor(raw,v));render();return true;
    }catch(_){if(epoch===s.epoch&&openGen===og&&s.visible)say(M("msg.spectate_unavailable"));return false;}   // a LATE error of a left/replaced operation is silent
    finally{if(openGen===og)s.opening=false;end(tk);}
  }catch(_){return false;}
}
function show(){
  veilReset();   // an ordinary opening never starts veiled; openInvite veils right AFTER this call, in the same task (no frame in between)
  s.visible=true;warmArt();const screen=$("screen");
  if(screen){screen.classList.remove("hidden");screen.removeAttribute("aria-hidden");}
  say(M("msg.test_mode"));
  syncPresence();render();return true;
}
function close(){
  veilReset();   // the guard never outlives the panel
  resetRoom();s.acc=null;s.token=null;s.autoJoin=null;s.opening=false;openGen++;s.rmJoin=null;entryReset();setBusy(false);s.visible=false;pendingTc=0;entryTc=0;
  paintEnd();backAsk(false);paintCover();
  if($("screen")){$("screen").classList.add("hidden");
    $("screen").setAttribute("aria-hidden","true");}
}
// «Вернуться в меню»: закрывает итальянскую панель и ЯВНО сообщает приложению, что игрок вышел
// из итальянской онлайн-партии. Экран под панелью (первый, второй, лобби) не угадывается:
// приложение само открывает итальянский второй экран. Ни Firebase, ни Worker здесь не трогаются.
function leave(notice){
  dg("leave",{notice:notice||"menu"});
  stopPresence(true);
  close();
  try{
    const doc=global.document,Ev=global.CustomEvent;
    if(doc&&typeof doc.dispatchEvent==="function"&&typeof Ev==="function")
      doc.dispatchEvent(new Ev("italian-online:exit",{detail:(notice==="no_active_game"||notice==="gate_closed")?{ruleset:"italian",notice}:{ruleset:"italian"}}));
  }catch(_){}
}
// Stage 6C: «Играть с другом» (the Russian flow: one tap, a NEW room is created for you; see friendEntryCore for what is read first).
// Exactly ONE room is created through the existing guarded createCore (preflight, one SDK write, read-only confirmation).
// A repeated tap while the entry runs returns the same promise. Nothing here writes by itself.
// Re-audit (MEDIUM): a room-creation write whose fate is NOT YET CONFIRMED BY A READ: {code}. It is set before the write and cleared only when (a) the Rules DEFINITIVELY refused it (PERMISSION_DENIED: nothing was written),
// or (b) the room is positively confirmed by readRoom and entered. A successful write ACK alone is not a successful confirming READ. A write that is still
// unanswered, or that failed in any other way (network, timeout, unknown error), may nevertheless reach the server later, so a "not_found" read proves
// nothing in this page session and NEVER allows a second room. A page reload drops the browser's queue of unsent writes together with this variable.
let createDoubt=null;
function definitiveRefusal(e){return !!e&&(e.code==="PERMISSION_DENIED"||e.code==="permission-denied"||/^PERMISSION_DENIED\b/.test(String(e.message||"")));}
let entryRun=null,entryGen=0;   // Stage F-A transitions (audit): every entry attempt has a GENERATION; closing the screen invalidates the running one (see entryReset)
// Closing the screen ends the player's interest in a running entry attempt, even one that never answers (a hung access check, an unanswered write):
// the NEXT «Играть с другом» must start a new attempt instead of being handed the old, hung promise. The old attempt keeps running in the background,
// but every step of it is guarded by the screen epoch (resetRoom), so it can neither write a room, nor speak, nor paint any more; its `finally` is
// guarded by the generation, so it can never clear the state of the newer attempt.
function entryReset(){entryGen++;entryRun=null;s.entering=false;}
async function waitForUser(ms){   // the app signs the player in at start; right after a cold start it may still be a moment away
  const until=Date.now()+ms;
  while(!currentUser()&&Date.now()<until)await new Promise(r=>global.setTimeout(r,150));
  return currentUser();
}
// Owner decision (7 Nov): «Играть с другом» is a NEW game and a NEW invitation, exactly like the Russian online (createOnlineRoom: every tap creates a new room,
// it never looks at an old one). The saved it86.lastRoom is NOT a reason to open an old room; an old game of this player stays reachable ONLY through
// «Кто играет?» -> «Продолжить» (and the invitation link), as in the Russian lobby. The one thing read here is a creation of THIS page session whose fate is still
// unknown (createDoubt): it is read first and, if the room exists and is still ours to wait in / play, restored - a late or unanswered server answer never produces a second room.
// A failed read of it keeps the code («Проверить комнату») and creates nothing. Returns "restored" | "new" | "unknown" | "skipped" | "aborted".
async function friendEntryCore(){
  const u=currentUser();
  if(s.code||s.busy||s.autoJoin)return "skipped";
  const doubt=createDoubt;
  if(!doubt)return "new";
  const code=doubt.code;
  if(!u)return "unknown";
  const epoch=s.epoch,tk=begin();say(M("msg.looking_unfinished"));
  try{
    let raw;
    try{raw=await readRoom(code,u);}
    catch(_){
      if(epoch!==s.epoch)return "aborted";
      s.recover=true;if($("code"))$("code").value=code;say(M("msg.resume_unknown"));return "unknown";   // unanswered/failed read, or the room is not visible yet: keep, never create a second
    }
    if(epoch!==s.epoch||!s.visible)return "aborted";
    let v=null;try{v=project(raw,u.uid);}catch(_){v=null;}
    if(v&&!v.spectator&&!over(raw)){
      try{enter(code,raw);}catch(_){if(createDoubt===doubt)createDoubt=null;return "new";}
      say(M("msg.restored_server",{status:statusFor(raw,s.view)}));
      return "restored";
    }
    if(createDoubt===doubt)createDoubt=null;   // positively read and not a room to wait in any more: the doubt about its creation is over
    return "new";
  }finally{end(tk);}
}
// The state of an ACTIVE game of this player by the server clock, like the Russian isRoomAbandonedNow but fail-closed:
//   "expired" - BOTH players have been away for >= 60 s counted from the SECOND departure (ItalianOnlinePresence.isAbandoned): the game is dead, the Worker/sweep voids it;
//   "active"  - the presence was READ with a confirmed server clock and the game is not abandoned (a returning player is inside the minute);
//   "unknown" - the server clock or the presence could not be obtained (module missing, offset never arrives, read failed or timed out): nothing is claimed.
// It is judged BEFORE entering, because entering puts the player online and erases the evidence. The phone clock is never used for the verdict.
async function absenceState(code,raw){
  let ref=null,l=null;const T0=Date.now();
  try{
    if(!Presence||typeof Presence.isAbandoned!=="function"){dg("presence",{result:"unknown",why:"presence module missing"});return "unknown";}
    const clock=new Promise(res=>{ref=db().ref(".info/serverTimeOffset");l=snap=>res(snap&&snap.val?snap.val():null);ref.on("value",l);});   // as clockStart does: a listener, first value only
    const timeout=new Promise(res=>global.setTimeout(()=>res("timeout"),4000));
    const got=await Promise.race([Promise.all([db().ref("roomsItalianPresence/"+code).once("value"),clock]).catch(e=>{dg("presence.readError",()=>({err:Diag.errCode(e)}));return null;}),timeout]);
    if(!got||got==="timeout"){dg("presence",()=>({result:"unknown",why:got==="timeout"?"TIMEOUT 4s (presence read or server clock never answered)":"presence read FAILED",ms:Date.now()-T0}));return "unknown";}
    const off=got[1];
    if(typeof off!=="number"||!isFinite(off)){dg("presence",()=>({result:"unknown",why:"server clock offset is not a number",ms:Date.now()-T0}));return "unknown";}
    const pv=got[0]&&got[0].val?got[0].val():null,verdict=Presence.isAbandoned(raw,pv,Date.now()+off,true)===true?"expired":"active";
    dg("presence",()=>({result:verdict,ms:Date.now()-T0,offsetMs:off,...Diag.explainPresence(raw,pv,Date.now()+off,true)}));
    return verdict;
  }catch(e){dg("presence",()=>({result:"unknown",why:"exception "+Diag.errCode(e)}));return "unknown";}
  finally{if(ref&&l)try{ref.off("value",l);}catch(_){}}
}
function enterFriend(){
  if(entryRun)return entryRun;
  const epoch=s.epoch,gen=++entryGen;
  s.entering=true;s.recover=false;render();
  entryRun=(async()=>{
    try{
      const u=currentUser()||await waitForUser(4000);
      if(epoch!==s.epoch)return;   // the screen was closed meanwhile: this attempt is invalid and must not touch anything
      if(!u){   // not signed in (yet): nothing is written; an unconfirmed creation keeps the player in recovery, never in «create a second one»
        if(createDoubt){s.recover=true;if($("code"))$("code").value=createDoubt.code;}
        say(M("msg.login_first"));
      }else{
        s.gateClosed=false;
        const r=await friendEntryCore();
        if(r==="new"&&epoch===s.epoch&&s.visible&&!s.code&&!s.busy&&!s.spectator&&!s.uncertain&&
           !s.pendingJoin&&!s.recover&&!s.autoJoin&&!createDoubt)
          await createCore(null);
        if(s.gateClosed&&!s.code&&epoch===s.epoch&&s.visible){s.gateClosed=false;leave("gate_closed");return;}   // closed by the server: no test panel, back to the second screen with one clear message
      }
    }catch(_){/* every step reports its own state; never an unhandled rejection */}
    finally{if(entryGen===gen){entryRun=null;s.entering=false;if(s.visible)render();}}   // only the CURRENT attempt may release the entry state
  })();
  return entryRun;
}
// Russian parity (checkForInviteLink): while a link / «Продолжить» is being CHECKED, the app shows one neutral line and never the panel. A finished, dead or
// missing game then returns to the second screen of Italian draughts with «Нет активной игры» (no board, no create/join controls flashing in between).
// The guard belongs to ONE check (token): a late answer of an older / replaced check can neither lift the guard of a newer one nor leave it behind;
// close() and show() clear it unconditionally (the panel cannot stay veiled when it is closed, replaced or opened for another reason).
let veilTok=0;
function veil(on){const el=$("screen");if(el&&el.classList){if(on)el.classList.add("it86-veil");else el.classList.remove("it86-veil");}}
function veilReset(){veilTok++;veil(false);}
function veilOn(){veilTok++;veil(true);return veilTok;}
function veilOff(tok){if(tok===veilTok)veil(false);}
async function openInvite(param){
  // One invite at a time: a repeated start_param while one is being handled is a no-op (never a second join).
  if(s.autoJoin){dg("openInvite.ignored",{why:"another invite is being handled (s.autoJoin)"});return true;}
  const mine={},epoch=s.epoch;let vt=-1;
  dg("openInvite.called",()=>({param:Diag.describeParam(param),parsed:!!(Invite&&Invite.parseInviteParam(param)),visibleBefore:s.visible,epoch:epoch,remembered:Diag.maskCode(remembered())}));
  try{
    show();
    vt=veilOn();
    const code=Invite&&Invite.parseInviteParam(param);
    if(!code){say(M("msg.bad_link"));return false;}
    s.autoJoin=mine;
    if($("code"))$("code").value=code;
    // Read-only look first. Only a valid WAITING room of ANOTHER player is joinable; a room the player already
    // belongs to is simply restored by inspect() and never written.
    const outcome=await inspect(code);
    veilOff(vt);
    dg("openInvite.outcome",()=>({outcome:outcome,sameEpoch:epoch===s.epoch,visible:s.visible,stillMine:s.autoJoin===mine,showsNoActiveGame:outcome==="gone"&&epoch===s.epoch&&s.visible&&s.autoJoin===mine}));
    if(outcome==="gone"&&epoch===s.epoch&&s.visible&&s.autoJoin===mine){say(M("msg.no_active_game"));leave("no_active_game");return true;}   // the line is the fallback if the app does not answer the exit event   // the Russian answer for a finished / dead / missing game
    if(outcome==="joinable"&&epoch===s.epoch&&s.visible&&!s.busy&&!s.spectator&&s.autoJoin===mine){
      // An earlier attempt for this room is still unconfirmed: only the manual «Проверить» decides, never a second write.
      if(s.pendingJoin&&s.pendingJoin.code===code)say(M("msg.join_uncertain"));
      else await joinByCode(code); // same guarded path as the manual button; failures/unknown are reported there, never retried
    }
    return true;
  }catch(e){dg("openInvite.error",()=>({err:Diag.errCode(e)}));if(epoch===s.epoch&&s.visible)say(M("msg.invite_unavailable"));return false;}
  finally{veilOff(vt);if(s.autoJoin===mine){s.autoJoin=null;if(s.visible)render();}}   // render again: without a room the manual controls come back as the way out
}
// Returns "joinable" only for a valid waiting room created by ANOTHER player; "gone" for a finished / void / dead (both away >= 60 s) / missing room;
// every other outcome returns "other".
async function inspect(code){
  const u=currentUser(),epoch=s.epoch;
  dg("inspect.start",()=>({code:Diag.maskCode(code),user:u?Diag.maskUid(u.uid):"NO-USER",validCode:CODE.test(code),epoch:epoch}));
  if(!u||!CODE.test(code)){say(M("msg.need_login_code24"));dg("verdict",{outcome:"other",reason:"no signed-in user or bad code (nothing read)"});return "other";}
  const tk=begin();say(M("msg.reading_room"));const T0=Date.now();
  try{
    lastHttp=null;
    const raw=await readRoom(code,u);
    dg("room.read",()=>({result:"FOUND",status:raw.status,seat:Diag.seatOf(raw,u.uid),rev:raw.revision,ended:!!(raw.winner||raw.result),ms:Date.now()-T0}));
    if(epoch!==s.epoch||!s.visible){dg("verdict",{outcome:"other",reason:"STALE answer: the screen was closed or replaced while reading (ignored on purpose)"});return "other";}
    if(raw.status==="waiting"&&raw.players&&raw.players.light&&raw.players.light.id!==u.uid){
      if(!Opening.validOpening(raw))throw Error("invalid_invite");
      if($("code"))$("code").value=code;
      dg("verdict",{outcome:"joinable",reason:"waiting room of another player"});
      return "joinable";
    }
    // The Russian rule for a link / «Продолжить»: a finished, void or dead (both away >= 60 s) game is NOT opened - «Нет активной партии» instead of the old board
    // and instead of the old end window. Only a room the player belongs to is judged here; anything else keeps the existing «room unavailable» path below.
    let mine=null,projErr=null;try{const pv=project(raw,u.uid);mine=pv.spectator?null:pv;}catch(e){mine=null;projErr=e&&e.message;}
    const dead=mine&&raw.status==="active"?await absenceState(code,raw):"active";   // only a running game of this player needs the clock
    if(mine&&(raw.status==="finished"||raw.status==="void"||over(raw)||dead==="expired")){
      if(epoch!==s.epoch||!s.visible){dg("verdict",{outcome:"other",reason:"STALE answer after the checks (ignored on purpose)"});return "other";}
      if(remembered()===code)forget();
      dg("verdict",()=>({outcome:"gone",reason:raw.status==="finished"?"finished":raw.status==="void"?"void":over(raw)?"over":"expired (both away >= 60 s, proven by server clock)",status:raw.status}));
      return "gone";
    }
    if(mine&&dead==="unknown"){   // neither alive nor dead is proven: the board stays closed, the code stays remembered, the same «Продолжить» / link can simply be tried again
      if(epoch!==s.epoch||!s.visible)return "other";
      dg("verdict",{outcome:"other",reason:"expiry unknown (clock/presence not obtained): board stays closed, NOT declared finished"});
      say(M("msg.expiry_unknown"));return "other";
    }
    if(epoch!==s.epoch||!s.visible)return "other";
    dg("verdict",()=>({outcome:"enter",reason:mine?"my game, alive: opening the board":"not my game ("+(projErr||"spectator")+"): no board for me",status:raw.status,seat:Diag.seatOf(raw,u.uid)}));
    enter(code,raw);say(M("msg.room_confirmed",{status:statusFor(raw,s.view)}));
    return "other";
  }catch(e){
    // The Russian difference between «the room is not there» (!room -> «Нет активной игры») and a temporary failure (the old text, nothing is claimed about the room).
    dg("room.read",()=>({result:e&&e.message==="not_found"?"NOT_FOUND (empty answer)":"ERROR",err:Diag.errCode(e),http:lastHttp,ms:Date.now()-T0}));
    if(e&&e.message==="not_found"){if(epoch===s.epoch&&s.visible&&remembered()===code)forget();const g=epoch===s.epoch&&s.visible;dg("verdict",{outcome:g?"gone":"other",reason:g?"not_found (the database has no such room)":"STALE not_found (screen was closed)"});return g?"gone":"other";}   // the room is not there: «Нет активной игры», like Russian
    if(epoch===s.epoch&&s.visible)say(M("msg.room_unavailable_or_bad"));
    dg("verdict",()=>({outcome:"other",reason:"temporary/other read failure ("+Diag.errCode(e)+"): NOT declared finished"}));
    return "other";
  }
  finally{end(tk);}
}
async function create(){await createCore(null);}
// The room creation used by the «Создать комнату» button AND by the rematch. `fixedCode` is set only by the rematch: it is a code that
// has already been reserved in roomsItalianRematch, so every attempt of one rematch targets the SAME room id (the Rules allow a room to
// be created only once at an id). Returns "created" | "uncertain" | "failed" | "busy"; messages are unchanged.
// STEP K3: the time limit per move chosen on the Russian #time-control-screen BEFORE the room is created (script.js hands it over with setTimeControl, then
// presses the entry button). It is taken once by the entry click; a rematch room inherits the limit of the finished room. 0 = no limit = no field.
let pendingTc=0,entryTc=0;
function tcValid(v){return !!Invite&&typeof Invite.validTimeControl==="function"&&Invite.validTimeControl(v);}
function setTimeControl(sec){pendingTc=tcValid(sec)?sec:0;return pendingTc;}
async function createCore(fixedCode,tcArg){
  if(s.busy||s.spectator)return "busy";const u=currentUser(),epoch=s.epoch;
  if(!u){say(M("msg.login_first"));return "failed";}
  const tk=begin();say(M("msg.checking_create"));
  let code=null;
  try{
    if(!deps()||!pinned())throw Error("unavailable");
    const gate=await Preflight.checkAccess(db(),auth(),"create",
      {appCheck:global.firebase.appCheck()});
    if(epoch!==s.epoch)return "failed";   // an invalidated (late) attempt: no message, no write
    if(!gate||gate.allowed!==true||!same(u)){
      s.gateClosed=!!(gate&&gate.reason==="server_gate_closed");   // the SERVER keeps Italian Online closed for this player: reported, never bypassed
      say(describeGate(gate));return "failed";
    }
    await ensureName(u);   // Stage 6E-2: the verified username is read from the sign-in token BEFORE the name is put into the room
    if(epoch!==s.epoch)return "failed";
    if(!same(u)){say(M("msg.server_unknown"));return "failed";}
    code=fixedCode||Invite.generateCode();
    const tc=tcArg!==undefined?tcArg:entryTc;
    const data=Invite.createWaitingRoom({code,ownerId:u.uid,ownerName:name(u),
      serverTimestamp:global.firebase.database.ServerValue.TIMESTAMP,...(tcValid(tc)&&tc>0?{timeControlSeconds:tc}:{})});
    // Exactly one user-initiated SDK write. An ACK failure is UNKNOWN, not retry.
    // Audit (HIGH): the code is remembered BEFORE the write and marked as "in doubt" (createDoubt) until the room is positively READ and entered (or the Rules
    // definitively refuse the write). If the answer never comes, or the ACK is followed by a missing/failed confirming read, and the player leaves and enters
    // again, the new entry READS this room first and, while the doubt lasts, never creates a second one (see friendEntryCore).
    remember(code);const doubt={code};createDoubt=doubt;
    try{await db().ref("roomsItalian/"+code).set(data);}   // ACK is not proof that the subsequent confirming read will succeed; keep the guard until enter()
    catch(e){if(definitiveRefusal(e)&&createDoubt===doubt)createDoubt=null;throw e;}   // refused by the Rules: nothing was written. Any other failure stays in doubt.
    if(epoch!==s.epoch)return "uncertain";
    const raw=await readRoom(code,u);
    // Re-audit (HIGH): the confirming read is an asynchronous step of its own. If the player left meanwhile (and maybe opened ANOTHER room), this late answer
    // belongs to a finished operation: it must neither replace the room now on the screen nor open a closed screen. The room stays remembered; the next
    // entry reads and restores it.
    if(epoch!==s.epoch||!s.visible||!same(u))return "uncertain";
    enter(code,raw);
    say(M("msg.room_created"));
    return "created";
  }catch(_){
    if(code&&epoch===s.epoch){
      s.code=code;s.uncertain=true;remember(code);render();   // remembered: after a restart the entry READS this room first, it never creates a second one
      say(M("msg.create_uncertain"));return "uncertain";
    }else if(epoch===s.epoch)say(M("msg.create_closed"));
    return "failed";
  }finally{end(tk);}
}
// Manual button: the code comes from the input field.
function joinRoom(){return joinByCode((($("code")&&$("code").value)||"").trim().toUpperCase());}
// Single join path used by the manual button AND by the invite link.
async function joinByCode(code){
  if(s.busy||s.spectator)return "busy";const u=currentUser(),epoch=s.epoch;
  if(!u||!CODE.test(code)){say(M("msg.need_login_code24b"));return "blocked";}
  const tk=begin();say(M("msg.checking_join"));
  try{
    if(!deps()||!pinned())throw Error("unavailable");
    const gate=await Preflight.checkAccess(db(),auth(),"join",
      {appCheck:global.firebase.appCheck()});
    if(epoch!==s.epoch)return "blocked";   // left meanwhile: a late refusal is not shown
    if(!gate||gate.allowed!==true||!same(u)){
      say(describeGate(gate));return "blocked";
    }
    await ensureName(u);   // Stage 6E-2
    const raw=await readRoom(code,u);
    if(epoch!==s.epoch||!s.visible)return "blocked";
    // Already seated (refresh or second tap): recover by reading, never write.
    if(raw.players&&((raw.players.light&&raw.players.light.id===u.uid)||
       (raw.players.dark&&raw.players.dark.id===u.uid))){
      enter(code,raw);say(M("msg.game_restored",{status:statusFor(raw,s.view)}));return "joined";
    }
    if(!Opening.validOpening(raw)||raw.players.light.id===u.uid){
      say(M("msg.join_unavailable"));return "blocked";
    }
    const claim={expectedCreatedAt:raw.createdAt,expectedOwnerId:raw.players.light.id,
      expectedOwnerName:raw.players.light.name,playerId:u.uid,playerName:name(u),
      serverTimestamp:global.firebase.database.ServerValue.TIMESTAMP};   // K3: a timed room starts its clock with the database time at this write
    s.pendingJoin={code,claim};
    const result=await Join.joinOnce(db(),auth(),code,claim,
      {explicitUserAction:true,appCheck:global.firebase.appCheck()}); // the click on "Join" or the player's own opening of the invite link
    if(epoch!==s.epoch||!s.visible)return "uncertain";
    if(!result||result.status!=="joined_confirmed"||result.confirmed!==true){
      s.code=code;s.uncertain=true;render();
      say(M("msg.join_uncertain"));return "uncertain";
    }else{enter(code,result.room);say(M("msg.joined"));return "joined";}
  }catch(_){if(epoch===s.epoch&&s.visible)say(M("msg.join_closed"));
    return s.pendingJoin&&s.pendingJoin.code===code?"uncertain":"blocked";}
  finally{end(tk);}
}
async function checkRoom(){
  if(s.busy||s.spectator)return;const u=currentUser(),epoch=s.epoch;
  const code=s.code||(($("code")&&$("code").value)||"").trim().toUpperCase();
  if(!u||!CODE.test(code)){say(M("msg.need_login_valid_code"));return;}
  const tk=begin();say(M("msg.checking_server"));
  let settle=false;
  try{
    if(s.pendingJoin&&s.pendingJoin.code===code){
      const r=await Join.checkOwnSeat(db(),auth(),code,s.pendingJoin.claim,
        {appCheck:global.firebase.appCheck()});
      if(epoch!==s.epoch)return;
      if(r&&r.status==="joined_confirmed"){enter(code,r.room);say(M("msg.join_confirmed"));return;}
    }
    const raw=await readRoom(code,u);
    if(epoch!==s.epoch)return;
    if(raw.status==="waiting"&&raw.players.light.id!==u.uid){
      say(M("msg.seat_unconfirmed"));return;
    }
    // A sent move whose fate this room does not settle: the board is NOT released by this read (the request may still be written); the same request is repeated.
    const P=s.pend;
    if(P&&P.code===code&&P.epoch===epoch&&P.unknown&&fate(P,raw)==="open"){settle=true;return;}
    enter(code,raw);say(M("msg.server_refreshed",{status:statusFor(raw,s.view)}));
  }catch(_){if(epoch===s.epoch&&s.visible)say(M("msg.confirm_unavailable"));}
  finally{end(tk);if(settle)settlePending();}
}
function select(row,col){
  const v=s.view;if(!v||v.spectator||s.busy||s.uncertain||
    v.room.status!=="active"||v.room.turn!==v.color)return;
  const legal=ownMovable(v);
  const piece=v.game.pieces.find(p=>p.row===row&&p.col===col);
  const forced=v.game.mustContinueFrom;
  if(s.selected&&legal.some(m=>m.fromRow===s.selected.row&&m.fromCol===s.selected.col&&
     m.toRow===row&&m.toCol===col)){
    const from=s.selected;s.selected=null;render();
    const local=Engine.attemptMove(v.game,from.row,from.col,row,col,v.color);
    if(!local||local.ok!==true){say(M("msg.rules_forbid"));return;}
    sendMove(from.row,from.col,row,col,local);return;
  }
  if(forced){say(M("msg.continue_capture"));return;}
  if(piece&&piece.color===v.color){
    if(legal.some(m=>m.fromRow===row&&m.fromCol===col)){s.selected={row,col};render();}
    else{s.selected=null;render();
      say(M("msg.cannot_move_piece"));}
    return;
  }
  if(s.selected){s.selected=null;render();say(M("msg.move_invalid"));}
}
async function sendMove(fr,fc,tr,tc,local){
  const v=s.view,code=s.code,u=currentUser(),epoch=s.epoch;
  if(!v||v.spectator||!u||!code||s.busy||s.uncertain||v.room.turn!==v.color)return;
  const requestId=secureId(),shown=v.room.revision||0;
  // The move is drawn (with its sound and animation) at once, BEFORE any network round trip; begin() below draws it and locks the board.
  prepareLocal(v,fr,fc,tr,tc,local,requestId,u.uid);
  let keepLocal=false,sent=false;   // only an UNKNOWN answer keeps the picture; every other way out draws the server position again
  const tk=begin();say(M("msg.waiting_server"));
  try{
    const freshRaw=await readRoom(code,u),fresh=project(freshRaw,u.uid);
    if(epoch!==s.epoch)return;
    if(!admit(code,freshRaw)){ // older than what is already shown: do not send
      dropLocal();say(M("msg.stale_check"));return;
    }
    const revision=fresh.room.revision||0;
    if(fresh.room.status!=="active"||fresh.room.turn!==fresh.color||revision!==shown){
      dropLocal();adopt(fresh.room,fresh);say(M("msg.position_changed"));return;
    }
    const intent={roomCode:code,expectedMatchNumber:0,expectedRevision:revision,
      fromRow:fr,fromCol:fc,toRow:tr,toCol:tc,requestId};
    // From here on the Worker MAY have the request (tokens, HTTP request, reply share ONE deadline; expiry = UNKNOWN).
    s.pend={code,epoch,uid:u.uid,requestId,base:revision,intent,unknown:false,resent:false};sent=true;
    await deliver(s.pend,u,epoch);
  }catch(_){
    if(epoch===s.epoch){
      const P=s.pend;
      if(P&&P.requestId===requestId){P.unknown=true;s.uncertain=true;keepLocal=true;say(M("msg.move_uncertain"));}   // sent, fate unknown: locked until the room settles it
      else if(!sent){s.uncertain=true;keepLocal=true;say(M("msg.move_uncertain"));}   // never sent (the read / the token failed): as before, the next read releases the board
      // else: sent, but a room that arrived meanwhile already settled it (confirmed / moved on): a late transport failure must not lock the game again
    }
  }finally{
    if(!keepLocal&&s.loc&&s.loc.requestId===requestId)dropLocal();
    end(tk);if(epoch===s.epoch)render();
  }
}
// The POST of one prepared move and everything that follows its answer. Used for the first send and for the repeat of the SAME request after an unknown
// answer (P.resent). Throws when the fate is still unknown.
async function deliver(P,u,epoch){
  const code=P.code,requestId=P.requestId;
  const reply=await deadline(MOVE_DEADLINE_MS,async signal=>{
    const t=await tokens(u);
    const response=await request(WORKER+"/italian/move",{
      method:"POST",headers:{"Content-Type":"application/json",
        Authorization:"Bearer "+t.id,"X-Firebase-AppCheck":t.app},
      body:JSON.stringify(P.intent)},signal);
    let result=null;try{result=await response.json();}catch(_){result=null;}
    return {ok:response.ok===true,status:response.status,result};
  });
  if(epoch!==s.epoch)return;   // left meanwhile: the late reply of the Worker speaks to nobody
  if(reply.ok&&reply.status===200&&reply.result&&reply.result.ok===true){
    const after=await readRoom(code,u);
    if(epoch!==s.epoch)return;
    if(!after.lastMoveReceipt||after.lastMoveReceipt.requestId!==requestId||
       after.lastMoveReceipt.actorUid!==u.uid||after.revision!==P.base+1)
      throw Error("receipt_unconfirmed");
    const nv=project(after,u.uid);
    if(!admit(code,after))throw Error("receipt_unconfirmed");
    adopt(after,nv);
    say(M("msg.move_confirmed",{status:statusFor(after,nv)}));
    return;
  }
  // Only a documented status/error pair is a definitive refusal.
  const refusal=definitive(reply.status,reply.result);
  if(refusal){
    if(s.pend===P)s.pend=null;   // the Worker said no: nothing was or will be written for this request
    if(!P.resent){dropLocal();render();}   // refused before anything was written: the server position comes back at once
    say(refusal);
    try{const raw=await readRoom(code,u),again=project(raw,u.uid);
      if(epoch===s.epoch&&admit(code,raw))adopt(again.room,again);}catch(_){}
    if(epoch===s.epoch){if(s.loc&&s.loc.requestId===requestId)dropLocal();s.uncertain=false;}
    return;
  }
  throw Error("move_unconfirmed");
}
// «Проверить» after an unknown answer, when the room still shows the old position: the request is repeated ONCE per press, unchanged.
async function settlePending(){
  const P=s.pend,u=currentUser(),epoch=s.epoch;
  if(!P||!u||s.busy||!P.unknown||P.epoch!==epoch||P.code!==s.code)return;
  P.resent=true;
  const tk=begin();say(M("msg.waiting_server"));
  try{await deliver(P,u,epoch);}
  catch(_){if(epoch===s.epoch&&s.pend===P){s.uncertain=true;say(M("msg.move_uncertain"));}}
  finally{end(tk);if(epoch===s.epoch)render();}
}
// ---- Stage F-A: resign, draw offer, reactions, «Партия не состоялась» ----
// The browser never decides a result: it ASKS the Worker (POST /italian/end: kind resign | draw | void) and shows what the room says afterwards.
// The Worker and the Rules re-check everything (who asks, the 60-second absence of BOTH players on the database clock, the agreed offer).
function workerPost(path,body){
  const u=currentUser();if(!u)return Promise.reject(Error("auth_required"));
  return deadline(MOVE_DEADLINE_MS,async signal=>{
    const t=await tokens(u);
    const response=await request(WORKER+path,{method:"POST",
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+t.id,"X-Firebase-AppCheck":t.app},
      body:JSON.stringify(body)},signal);
    let result=null;try{result=await response.json();}catch(_){result=null;}
    return {ok:response.ok===true,status:response.status,result};
  });
}
// Answers of POST /italian/end that mean "the Worker refused BEFORE writing anything" (the room is unchanged): shown as words, the room is then read again.
// (Separate from DEFINITIVE above: that table is the classification of the MOVE route.)
const END_REFUSED={
  "409:italian_draw_not_agreed":"err.draw_not_agreed",
  "409:italian_presence_not_proven":"err.presence_not_proven",
  "409:italian_end_rejected":"err.end_rejected",
  "409:italian_timer_off":"err.timer_off",                 // K3: /italian/end kind "timeout" in a room without a limit
  "409:italian_time_not_expired":"err.time_not_expired"    // K3: the database did not accept the claim: the time is not up yet
};
function endRefusal(reply){
  if(!reply)return null;
  const r=reply.result,key=reply.status+":"+(r&&r.error);
  return Object.prototype.hasOwnProperty.call(END_REFUSED,key)?M(END_REFUSED[key]):definitive(reply.status,r);
}
async function adoptFresh(code,epoch){
  const u=currentUser();if(!u)return;
  try{
    const raw=await readRoom(code,u),nv=s.spectator?projectSpectator(raw):project(raw,u.uid);
    if(epoch===s.epoch&&admit(code,raw)){adopt(raw,nv);say(statusFor(raw,nv));render();}
  }catch(_){/* the next poll shows the truth */}
}
// ---- STEP K3: the per-move timer (the Russian #turn-timer line over the board, the red last 10 seconds, the loss by time) ----
// The clock is the SERVER clock (.info/serverTimeOffset, as the Russian getEstimatedServerNow): the phone clock alone is never trusted. The display is not
// fail-closed (until the offset arrives it falls back to the phone clock, as in Russian); the REQUEST for the loss is: it needs the confirmed offset and a live
// connection. The browser never records the loss: it asks the Worker (POST /italian/end kind "timeout"); the Rules judge with the database time.
function timerClock(){
  if(Timer&&s.room&&Timer.limitOf(s.room))clockStart();   // idempotent; a player's presence controller owns a clock too, this one is independent of it
  const c=s.clk,n=srv();
  return c&&c.ready?{ms:Date.now()+c.offset,ready:true,connected:n.connected}:n;
}
function timerLine(){
  const room=s.room;
  if(!Timer||!room||!Timer.limitOf(room))return null;
  const shown=(s.loc&&s.loc.view&&s.loc.view.room)||room;   // our own move is on the screen but not confirmed yet: the turn has passed to the opponent
  const n=timerClock();
  let left=null,turn=shown.turn;
  if(room.status==="active"&&!holdOn(s)){
    left=s.loc&&shown.turn!==room.turn?Timer.limitOf(room):Timer.remaining(room,n.ms);   // the new move starts with the full time (the server value arrives with the confirmation)
  }
  return {left,turn};
}
function paintTimer(){
  const box=$("timer");if(!box)return;
  const room=s.room;
  box.classList.remove("timer-low");
  // The element exists only while a countdown is shown: no limit, waiting, finished / void (any terminal result), no start time yet -> hidden as a whole (no empty gap).
  const t=s.visible&&Timer&&room&&Timer.limitOf(room)&&room.status==="active"?timerLine():null;
  if(!t||t.left===null){box.hidden=true;box.textContent="";return;}
  box.hidden=false;
  box.textContent=I18N.render(M("timer.line",{who:I18N.render(M(t.turn==="light"?"end.whites":"end.blacks")),time:Timer.formatTime(t.left)}));
  if(Timer.isLow(t.left))box.classList.add("timer-low");
}
async function timeoutClaim(){
  const room=s.room,v=s.view;
  if(!Timer||s.claimingTm||!room||!v||v.spectator||s.spectator||s.uncertain||s.loc||!s.code)return;
  const n=timerClock(),now=Date.now();
  if(!Timer.mayClaim({room,player:true,idle:true,ready:n.ready,connected:n.connected,serverNow:n.ms,lastAt:s.tmAt,at:now}))return;
  const epoch=s.epoch,token={epoch,code:s.code};   // the request is owned by this token: only its own finally may release it
  s.tmAt=now;s.claimingTm=token;
  try{
    const out=await endRequest("timeout");
    if(out.stale||epoch!==s.epoch)return;
    if(!out.ok)await refresh();   // not recorded (too early by the database clock, a move landed, somebody else's request won): the room tells; no scary text
  }catch(_){/* the next tick may ask again after the spacing */}
  finally{if(s.claimingTm===token)s.claimingTm=null;}   // a late finally of an earlier room finds another token (or none) and changes nothing
}
function timerTick(){
  if(!s.visible)return;
  paintTimer();
  timeoutClaim();
}
async function endRequest(kind){
  const code=s.code,epoch=s.epoch;if(!code)return {ok:false,stale:true};
  let reply;
  try{reply=await workerPost("/italian/end",{roomCode:code,kind});}
  catch(_){return epoch!==s.epoch?{ok:false,stale:true}:{ok:false,unknown:true};}
  if(epoch!==s.epoch)return {ok:false,stale:true};
  const ok=reply.ok&&reply.status===200&&!!reply.result&&reply.result.ok===true;
  if(ok)await adoptFresh(code,epoch);
  return {ok,reply};
}
// «Партия не состоялась»: both players have been away for more than a minute (counted from the SECOND departure). A returning player, a spectator
// or any viewer of the list asks the Worker; the Rules refuse unless the database itself proves it, so an arrival that wins the race keeps the game going.
async function voidFlow(){
  const t=Date.now();
  if(s.voiding||t-s.lastVoid<5000||!s.code||!s.room||s.room.status!=="active")return;
  s.voiding=true;s.lastVoid=t;
  const epoch=s.epoch;
  try{
    say(M("void.checking"));
    const out=await endRequest("void");
    if(out.stale||epoch!==s.epoch)return;
    if(!out.ok){
      const d=out.reply?endRefusal(out.reply):null;
      say(d||M("void.unknown"));
      await refresh();   // somebody came back, a move landed or the answer was lost: the room tells
    }
  }finally{
    s.voiding=false;
    if(epoch===s.epoch&&s.room&&s.room.status==="active")syncPresence();
  }
}
function resignAsk(open){const m=$("resign-confirm");if(!m)return;m.classList.toggle("hidden",!open);if(open){const n=$("resign-no");if(n)try{n.focus({preventScroll:true});}catch(_){}}}
async function resignNow(){
  resignAsk(false);
  const v=s.view,room=s.room;
  if(!v||v.spectator||!room||room.status!=="active"||s.uncertain)return;
  const out=await endRequest("resign");
  if(out.stale)return;
  if(!out.ok){
    const d=out.reply?endRefusal(out.reply):null;
    say(d||M("err.resign_unknown"));
    refresh();
  }
}
// The draw dialog and the emoji burst: the Russian #draw-offer-modal / #emoji-burst-container (markup and classes), texts from the Russian dictionary.
function drawPaint(view){
  const m=$("draw-offer"),t=$("draw-offer-text"),a=$("draw-accept"),d=$("draw-decline"),c=$("draw-cancel");
  if(!m)return;
  const ph=view&&view.phase;
  if(ph!=="incoming"&&ph!=="waiting"){
    m.classList.add("hidden");
    if(ph==="agreed")say(M("draw.confirming"));
    return;
  }
  if(ph==="incoming"){
    if(t)t.textContent=I18N.render(M("draw.offers",{name:seatName(s.room,view.by)||I18N.render(M("draw.opponent"))}));
    if(a)a.classList.remove("hidden");if(d)d.classList.remove("hidden");if(c)c.classList.add("hidden");
  }else{
    if(t)t.textContent=I18N.render(M("draw.waiting"));
    if(a)a.classList.add("hidden");if(d)d.classList.add("hidden");if(c)c.classList.remove("hidden");
  }
  m.classList.remove("hidden");
  const f=ph==="incoming"?d:c;if(f)try{f.focus({preventScroll:true});}catch(_){}
}
function burst(emoji){
  const box=$("emoji-burst"),doc=global.document;if(!box||!doc)return;
  for(let i=0;i<5;i++){   // the same five emoji, the same random spread and timings as script.js triggerEmojiBurst
    const el=doc.createElement("div");el.className="burst-emoji";el.textContent=emoji;
    el.style.left=(Math.random()*100)+"vw";
    el.style.setProperty("--dx-mid",((Math.random()-0.5)*100)+"px");
    el.style.setProperty("--dx-end",((Math.random()-0.5)*200)+"px");
    el.style.animationDuration=(1.5+Math.random())+"s";el.style.animationDelay=(Math.random()*0.3)+"s";
    box.appendChild(el);
    el.addEventListener("animationend",()=>el.remove());
  }
}
function paintActions(){
  const row=$("reactions-row");if(!row)return;
  const v=s.view,r=s.room;
  row.classList.toggle("hidden",!(s.visible&&v&&!v.spectator&&r&&r.status==="active"&&r.players&&r.players.dark&&!holdOn(s)));
}
function actionsStop(){
  const a=s.ac;s.ac=null;
  if(a)try{a.ctl.stop();}catch(_){}
  drawPaint(null);paintActions();
}
function actionsSync(){
  const r=s.room,v=s.view;
  const on=!!Actions&&s.visible&&!!s.code&&!!r&&r.status==="active"&&!!v&&!!currentUser();
  if(!on){actionsStop();return;}
  if(s.ac&&s.ac.code===s.code&&s.ac.spec===!!v.spectator){s.ac.ctl.refresh();paintActions();return;}
  actionsStop();
  try{
    const ctl=Actions.create({database:db(),TIMESTAMP:global.firebase.database.ServerValue.TIMESTAMP,code:s.code,myColor:v.spectator?null:v.color,
      getRoom:()=>s.room,finishDraw:()=>endRequest("draw"),onDraw:drawPaint,onBurst:b=>burst(b.emoji),now:()=>Date.now(),
      setTimeout:(f,m)=>global.setTimeout(f,m),clearTimeout:t=>global.clearTimeout(t)});
    s.ac={ctl,code:s.code,spec:!!v.spectator};ctl.start();
  }catch(_){s.ac=null;}
  paintActions();
}
// ---- Stage F-A: lazy cleanup of dead games by a client that has the «Кто играет?» list open (see shared/italian-online-sweep.js) ----
let sweeper=null;
function sweepEnv(){
  const d=global.document,u=currentUser();
  return {
    listActive:async()=>{
      const snap=await db().ref("roomsItalian").orderByChild("status").equalTo("active").limitToFirst(50).once("value");
      const v=snap&&snap.val?snap.val():null;return v&&typeof v==="object"?v:{};
    },
    readPresence:async c=>{const snap=await db().ref("roomsItalianPresence/"+c).once("value");return snap&&snap.val?snap.val():null;},
    serverNow:()=>Date.now()+(sweepClock.offset||0),serverReady:()=>sweepClock.ready,
    isAbandoned:Presence.isAbandoned,
    requestVoid:c=>workerPost("/italian/end",{roomCode:c,kind:"void"}),
    now:()=>Date.now(),u,d
  };
}
const sweepClock={offset:0,ready:false,ref:null,l:null};
function sweepTick(){
  const d=global.document;
  if(!Sweep||!Presence||!d||typeof d.getElementById!=="function")return;
  const lobby=d.getElementById("group-lobby-screen");
  if(!lobby||lobby.classList.contains("hidden")||s.visible||d.visibilityState==="hidden"){return;}   // only while the list is on screen (and not while a game screen of this module is open)
  const u=currentUser();if(!u)return;
  try{
    if(!sweepClock.ref){
      sweepClock.ref=db().ref(".info/serverTimeOffset");
      sweepClock.l=snap=>{const x=snap&&snap.val?snap.val():null;if(typeof x==="number"&&isFinite(x)){sweepClock.offset=x;sweepClock.ready=true;}};
      sweepClock.ref.on("value",sweepClock.l);
    }
    if(!sweeper)sweeper=Sweep.create(sweepEnv());
    sweeper.tick();
  }catch(_){}
}
// ---- Stage 5: rematch (state machine: shared/italian-online-rematch.js; Rules: roomsItalianRematch) ----
// Only the screen and the access to the existing guarded paths live here. The negotiation is a separate small node; the finished
// room is never written. If the module or the Rules are missing, the panel simply stays hidden (fail closed).
const RM_VISIBLE=["idle","waiting_answer","incoming","declined_by_other","declined_by_me","cancelled_by_me","cancelled_by_other","expired_by_other","expired_by_me","accepted","reserved"];
const RM_BUTTONS=["propose","accept","decline","cancel","retry"];
function rmStop(){
  const c=s.rm;s.rm=null;s.rmView=null;
  if(c)try{c.stop();}catch(_){}
  rmPaint();
}
function rmSync(){
  const r=s.room,v=s.view;
  // A game that ended by the opponent's ABSENCE («Соперник не вернулся в игру») offers NO rematch: the other player is gone, a proposal would only wait for nobody.
  // Only «Закрыть» stays (leave -> the second screen of Italian draughts). A normal win, loss, draw or resignation keeps the rematch.
  const on=!!Rematch&&s.visible&&!!s.code&&!!r&&r.status==="finished"&&!isTechEnd(r.winReason)&&!!v&&!v.spectator&&!!r.players&&
    !!r.players.light&&!!r.players.dark&&UID.test(r.players.light.id)&&UID.test(r.players.dark.id);
  if(!on){if(s.rm)rmStop();return;}
  if(s.rm&&s.rm.oldCode===s.code)return;
  if(s.rm)rmStop();
  const u=currentUser();if(!u||!deps()||!pinned())return;
  try{
    const c=Rematch.create({database:db(),TIMESTAMP:global.firebase.database.ServerValue.TIMESTAMP,
      oldCode:s.code,myColor:v.color,myUid:u.uid,oldDarkId:r.players.dark.id,oldLightId:r.players.light.id,
      setInterval:(f,m)=>global.setInterval(f,m),clearInterval:t=>global.clearInterval(t),
      setTimeout:(f,m)=>global.setTimeout(f,m),clearTimeout:t=>global.clearTimeout(t),now:()=>Date.now(),hooks:rmHooks});
    s.rm=c;c.start();
  }catch(_){s.rm=null;}
}
const rmHooks={
  onView:v=>{s.rmView=v;rmPaint();},
  // The same access check as the «Создать комнату» button, asked BEFORE a code is reserved.
  gate:async()=>{
    try{
      if(!deps()||!pinned())return false;
      const g=await Preflight.checkAccess(db(),auth(),"create",{appCheck:global.firebase.appCheck()});
      return !!g&&g.allowed===true;
    }catch(_){return false;}
  },
  newCode:()=>Invite.generateCode(),
  // Read-only: is there already a room at the reserved code? Anything but a clear "not found" is "unknown" (never a write).
  roomState:async code=>{
    const u=currentUser();if(!u)return "unknown";
    try{await readRoom(code,u);return "present";}
    catch(e){return e&&e.message==="not_found"?"absent":"unknown";}
  },
  // The former dark player creates the room: the SAME guarded path as the button (preflight, one SDK write, read-only confirmation).
  createRoom:code=>{s.rmJoin=code;return createCore(code,s.room&&s.room.timeControlSeconds>0?s.room.timeControlSeconds:0);},   // K3: the rematch room keeps the limit of the finished one
  enterExisting:async code=>{
    const u=currentUser();if(!u)return false;
    try{
      const raw=await readRoom(code,u);
      if(!raw||!raw.players||!raw.players.light||raw.players.light.id!==u.uid||raw.status==="finished")return false;
      s.rmJoin=code;enter(code,raw);return true;
    }catch(_){return false;}
  },
  // The former light player joins the new room through the SAME guarded join as the invite link. Only a room created by the
  // former dark player is accepted; an unknown outcome is reported and never repeated.
  tryJoin:async(code,creator)=>{
    const u=currentUser();if(!u)return "failed";
    if(s.busy||s.spectator)return "busy";
    let raw;
    try{raw=await readRoom(code,u);}catch(_){return "not_ready";}   // not created yet (or a read problem): the bounded polling decides
    if(!raw||raw.ruleset!=="italian"||!raw.players||!raw.players.light||raw.players.light.id!==creator)return "failed";
    if(raw.players.dark&&raw.players.dark.id===u.uid){try{enter(code,raw);return "joined";}catch(_){return "failed";}}
    if(raw.status!=="waiting")return "failed";
    const out=await joinByCode(code);
    return out==="joined"?"joined":out==="uncertain"?"uncertain":out==="busy"?"busy":"failed";
  }
};
function rmPaint(){
  const box=$("rematch");if(!box)return;
  const v=s.rm?s.rmView:null,show=!!v&&RM_VISIBLE.indexOf(v.phase)!==-1;
  box.hidden=!show;
  const text=$("rematch-text"),b={};
  let m=null;
  if(show){
    const sec=Math.max(0,Math.ceil((v.remainingMs||0)/1000));
    const nm=s.room&&s.room.players&&s.room.players[v.by]?seatName(s.room,v.by):"";
    // B2R21: ONE offer per finished game. Terminal states (refusal / cancel / expiry) show a message and nothing but the result window's «Закрыть»
    // (which leaves to the second Italian menu); there is no «Реванш», no «Принять», no «Отменить» in them.
    if(v.phase==="idle")b.propose=true;
    else if(v.phase==="waiting_answer"){m=M("rematch.waiting",{sec});b.cancel=true;}
    else if(v.phase==="incoming"){m=M("rematch.offers",{name:nm,sec});b.accept=true;b.decline=true;}
    else if(v.phase==="declined_by_other")m=M("rematch.declined_other");
    else if(v.phase==="declined_by_me")m=M("rematch.declined_me");
    else if(v.phase==="cancelled_by_me")m=M("rematch.cancelled_me");
    else if(v.phase==="cancelled_by_other")m=M("rematch.cancelled_other");
    else if(v.phase==="expired_by_other")m=M("rematch.expired_sender");
    else if(v.phase==="expired_by_me")m=M("rematch.expired_receiver");
    else if(v.phase==="accepted")m=M(v.amFormerDark?"rematch.creating":"rematch.waiting_creation");
    else if(v.phase==="reserved")m=M(v.amFormerDark?"rematch.creating":"rematch.joining");
    if(v.error==="failed"){m=M("rematch.failed");if(v.amFormerDark&&(v.phase==="reserved"||v.phase==="accepted"))b.retry=true;}
    else if(v.error==="uncertain"){m=M(v.amFormerDark?"rematch.uncertain_dark":"rematch.uncertain_light");b.retry=!!v.amFormerDark;}
    else if(v.error==="no_room"){m=M("rematch.no_room");b.retry=true;}
    else if(v.error==="unavailable")m=M("rematch.unavailable");
  }
  if(text)text.textContent=m?I18N.render(m):"";
  for(const k of RM_BUTTONS){const n=$("rematch-"+k);if(n){n.hidden=!b[k];n.disabled=!!(v&&v.busy);}}
  // IT C5: an incoming offer is answered with «Принять» / «Отклонить» only; the extra «Закрыть» of the result window is hidden while it is open.
  const cl=$("end-close");if(cl)cl.hidden=!!(show&&v.phase==="incoming");
}
// Stage 6D: «Скопировать ссылку» works like the Russian one (script.js: copyPendingFriendInviteLink): the Clipboard API, then the textarea + execCommand fallback,
// the result is shown on the button itself for 1.4 s («✓ Ссылка скопирована» / «Не удалось скопировать»).
let copyTimer=null;
function copyFeedback(key){
  const b=$("copy");if(!b)return;
  const at=s.code;if(copyTimer)global.clearTimeout(copyTimer);
  b.textContent=I18N.render(M(key));
  copyTimer=global.setTimeout(()=>{copyTimer=null;if(s.code!==at)return;b.textContent=I18N.render(M("waiting.copy"));},1400);
}
function legacyCopy(text){
  const d=global.document;
  try{
    const ta=d.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");
    ta.style.cssText="position:fixed;left:-9999px;top:0;opacity:0";
    d.body.appendChild(ta);ta.select();ta.setSelectionRange(0,ta.value.length);
    let ok=false;try{ok=!!d.execCommand("copy");}catch(_){}
    ta.remove();return ok;
  }catch(_){return false;}
}
function copyLink(){
  if(!s.code)return;
  const url=link(s.code),nav=global.navigator;
  if(nav&&nav.clipboard&&typeof nav.clipboard.writeText==="function"){
    nav.clipboard.writeText(url).then(()=>copyFeedback("waiting.copied"),
      ()=>copyFeedback(legacyCopy(url)?"waiting.copied":"waiting.copy_failed"));
    return;
  }
  copyFeedback(legacyCopy(url)?"waiting.copied":"waiting.copy_failed");
}
function attach(){
  const on=(id,fn)=>{const n=$(id);if(n)n.addEventListener("click",fn);};
  const start=global.document.getElementById("btn-italian-online");
  if(start)start.addEventListener("click",()=>{entryTc=pendingTc;pendingTc=0;show();enterFriend();});
  on("create",create);on("join",joinRoom);on("check",checkRoom);on("exit",exitPressed);
  on("end-close",leave);on("back-yes",()=>{backAsk(false);leave();});on("back-no",()=>backAsk(false));
  // Stage F-A: the Russian reaction / draw / resign controls
  on("offer-draw",()=>{if(s.ac)s.ac.ctl.offerDraw();});
  on("draw-accept",()=>{drawPaint(null);if(s.ac)s.ac.ctl.acceptDraw();});
  on("draw-decline",()=>{drawPaint(null);if(s.ac)s.ac.ctl.declineDraw();});
  on("draw-cancel",()=>{drawPaint(null);if(s.ac)s.ac.ctl.cancelDraw();});
  on("resign",()=>{const v=s.view,r=s.room;if(v&&!v.spectator&&r&&r.status==="active")resignAsk(true);});
  on("resign-yes",resignNow);on("resign-no",()=>resignAsk(false));
  if(Actions)[["laugh",0],["fire",1],["shock",2],["angry",3]].forEach(([id,i])=>on("react-"+id,()=>{if(s.ac)s.ac.ctl.react(Actions.EMOJI[i]);}));
  if(Sweep&&typeof global.setInterval==="function")global.setInterval(sweepTick,20000);
  for(const k of RM_BUTTONS)on("rematch-"+k,()=>{
    if(!s.rm||typeof s.rm[k]!=="function")return;
    const ctl=s.rm,epoch0=s.epoch,code0=s.code;   // IT C5: the identity of the room visit that sent the refusal
    const p=ctl[k]();
    // IT C5: after a CONFIRMED refusal (the write succeeded) the player who refused returns to the second Italian menu; a refused write leaves the window as it is.
    // A LATE confirmation of room A must never close room B: epoch, room code and the controller instance must still be the ones that sent it.
    if(k==="decline"&&p&&typeof p.then==="function")p.then(ok=>{if(ok===true&&s.visible&&s.epoch===epoch0&&s.code===code0&&s.rm===ctl)leave();},()=>{});
  });
  on("share",()=>{
    if(!s.code)return;
    const url=link(s.code),tg=global.Telegram&&global.Telegram.WebApp;
    if(tg&&typeof tg.openTelegramLink==="function")
      tg.openTelegramLink("https://t.me/share/url?url="+encodeURIComponent(url)+
        "&text="+encodeURIComponent(I18N.render(M("share.text"))));
    else copyLink();   // outside Telegram: the link is copied (the result is shown on the «Скопировать ссылку» button)
  });
  on("copy",copyLink);on("back",ev=>{if(holdOn(s)){exitPressed();return;}leave(ev);});   // K1A: while the friend-connected picture runs the game is already live: «Назад» asks like the game exit does
  // Telegram WebView may suspend the audio context again (background): every tap on this screen resumes it (idempotent, no sound).
  const scr=$("screen");
  if(scr&&SND&&typeof scr.addEventListener==="function")for(const ev of ["click","touchend"])scr.addEventListener(ev,()=>SND.unlock(),{passive:true});
  // Stage 6E: like the Russian screen, a resize / rotation removes the running overlays at once (the board itself is already right)
  if(typeof global.addEventListener==="function")for(const ev of ["resize","orientationchange"])global.addEventListener(ev,()=>{const f=fx();if(f)f.cancel();});
  I18N.onLanguageChange(relang);I18N.applyStatic(global.document);
  if(typeof global.document.addEventListener==="function")
    global.document.addEventListener("visibilitychange",()=>{
      if(global.document.visibilityState==="visible"&&s.visible&&s.code&&!s.busy)refresh();
    });
}
global.ItalianOnlineTwoPlayerUI=Object.freeze({show,close,openInvite,project,link,secureId,spectate,setTimeControl});
if(global.document&&typeof global.document.getElementById==="function")attach();
})(typeof window!=="undefined"?window:globalThis);

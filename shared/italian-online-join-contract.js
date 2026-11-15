// PR-77: pure fail-closed Italian waiting -> active admission proposal.
// Does not read/write Firebase or change the legacy Russian client.
(function (global) {
  "use strict";
  const UID=/^tg_[0-9]+$/;
  const REQUIRED=['ruleset','status','turn','createdAt','matchNumber','moveCount',
    'capturedLight','capturedDark','pieces','players'];
  function validPlainObject(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
  // STEP K3: the optional time limit chosen by the creator (the same six values as the Russian screen). A waiting room never carries turnStartedAt.
  const TIME_VALUES=[0,30,60,120,180,300];
  function validOpening(room){
    const hasTime=validPlainObject(room)&&Object.prototype.hasOwnProperty.call(room,'timeControlSeconds');
    if(hasTime&&TIME_VALUES.indexOf(room.timeControlSeconds)===-1) return false;
    if(!validPlainObject(room)||Object.keys(room).length!==REQUIRED.length+(hasTime?1:0) ||
       REQUIRED.some(k=>!Object.prototype.hasOwnProperty.call(room,k))) return false;
    if(room.ruleset!=='italian'||room.status!=='waiting'||room.turn!=='light'||
       !Number.isSafeInteger(room.createdAt)||room.createdAt<=0||
       room.matchNumber!==0||room.moveCount!==0||
       room.capturedLight!==0||room.capturedDark!==0) return false;
    if(!validPlainObject(room.players)||Object.keys(room.players).length!==1||
       !validPlainObject(room.players.light)||Object.keys(room.players.light).length!==2||
       !UID.test(room.players.light.id)||typeof room.players.light.name!=='string'||
       room.players.light.name.length<1||room.players.light.name.length>80) return false;
    if(!validPlainObject(room.pieces)||Object.keys(room.pieces).length!==24) return false;
    if(!global.ItalianOnlineInviteContract ||
       typeof global.ItalianOnlineInviteContract.validInitialPieces!=='function')return false;
    const entries=Object.entries(room.pieces);
    for(const [key,p] of entries){
      if(!validPlainObject(p)||key!==p.row+'_'+p.col||
         Object.keys(p).length!==4)return false;
    }
    return global.ItalianOnlineInviteContract.validInitialPieces(entries.map(x=>x[1]));
  }
  function proposeJoin(current,input){
    if(!input||!UID.test(input.playerId)||
      typeof input.playerName!=='string')return null;
    const name=input.playerName.trim();
    if(name.length<1||name.length>80||
       !Number.isSafeInteger(input.expectedCreatedAt)||
       !validOpening(current)||
       current.createdAt!==input.expectedCreatedAt||
       !UID.test(input.expectedOwnerId)||
       current.players.light.id!==input.expectedOwnerId||
       typeof input.expectedOwnerName!=='string'||
       current.players.light.name!==input.expectedOwnerName||
       current.players.light.id===input.playerId)return null;
    const updated={
      ...current,
      // Keep the proposed transaction state independent of the read snapshot.
      pieces:Object.fromEntries(Object.entries(current.pieces).map(([key,p])=>[key,{...p}])),
      status:'active',
      players:{
        light:{...current.players.light},
        dark:{id:input.playerId,name}
      }
    };
    // STEP K3: in a timed room the clock starts HERE, with the database time (the STAGING Rules demand turnStartedAt === now at this write).
    // Without the server value the join is refused (fail closed): a timed game must never start without its start time.
    if(current.timeControlSeconds>0){
      if(!input.serverTimestamp||input.serverTimestamp['.sv']!=='timestamp')return null;
      updated.turnStartedAt=input.serverTimestamp;
    }
    return updated;
  }
  // The room as it stood just before the join (waiting, one player) for the strict opening check of a CONFIRMED join. A timed room must carry a
  // real start time (a number the database wrote), an untimed one none; anything else is not a join this client made.
  function activeToWaiting(room){
    if(!validPlainObject(room)||!validPlainObject(room.players)||!room.players.light)return null;
    const timed=room.timeControlSeconds>0,has=Object.prototype.hasOwnProperty.call(room,'turnStartedAt');
    if(timed?!(Number.isSafeInteger(room.turnStartedAt)&&room.turnStartedAt>0):has)return null;
    const waiting={...room,status:'waiting',players:{light:room.players.light}};
    delete waiting.turnStartedAt;
    return waiting;
  }
  global.ItalianOnlineJoinContract=Object.freeze({
    validOpening,proposeJoin,activeToWaiting
  });
})(typeof window !== 'undefined' ? window : globalThis);

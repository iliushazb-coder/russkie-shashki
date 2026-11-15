// PR-78: Italian admission, F1 cold-cache prefetch + F2 read-only reconciliation
// + F3 transaction watchdog. No legacy /rooms fallback or automatic join retry.
(function (global) {
  "use strict";

  const INITIAL_READ_MS = 30000;
  const TRANSACTION_MS = 30000;
  const RECOVERY_READ_MS = 5000;
  const inFlight = new WeakMap();

  function timeoutOption(options,key,fallback) {
    const n=options&&options[key];
    return Number.isSafeInteger(n)&&n>=1&&n<=60000?n:fallback;
  }
  function check(database,code,input) {
    const invite=global.ItalianOnlineInviteContract;
    const join=global.ItalianOnlineJoinContract;
    if(!invite||!join||!invite.validCode(code)||
       !database||typeof database.ref!=="function"||
       !input||typeof input!=="object"||
       !Number.isSafeInteger(input.expectedCreatedAt)||
       typeof input.expectedOwnerId!=="string"||
       !/^tg_[0-9]+$/.test(input.expectedOwnerId)||
       typeof input.expectedOwnerName!=="string"||
       input.expectedOwnerName.length<1||input.expectedOwnerName.length>80||
       typeof input.playerId!=="string"||
       !/^tg_[0-9]+$/.test(input.playerId)||
       typeof input.playerName!=="string"||
       input.playerName.trim().length<1||
       input.playerName.trim().length>80){
      throw new Error("italian_join_invalid_request");
    }
    return join;
  }
  function reference(database,code) {
    const ref=database.ref("roomsItalian/"+code);
    if(!ref||typeof ref.on!=="function"||typeof ref.off!=="function"){
      throw new Error("italian_join_transaction_unavailable");
    }
    return ref;
  }
  function observedOwnSeat(room,input,join) {
    if(!room||room.ruleset!=="italian"||room.status!=="active"||
       !room.players||!room.players.light||!room.players.dark||
       room.createdAt!==input.expectedCreatedAt||
       room.players.light.id!==input.expectedOwnerId||
       room.players.light.name!==input.expectedOwnerName||
       room.players.dark.id!==input.playerId||
       room.players.dark.name!==input.playerName.trim()||
       Object.keys(room.players).length!==2||
       Object.keys(room.players.dark).length!==2||
       !Object.prototype.hasOwnProperty.call(room.players.dark,"id")||
       !Object.prototype.hasOwnProperty.call(room.players.dark,"name")){
      return false;
    }
    // Verify every canonical piece and absence of extra room metadata
    // by projecting the allowed waiting-room structure for validation.
    const waiting=typeof join.activeToWaiting==="function"?join.activeToWaiting(room):{...room,status:"waiting",players:{light:room.players.light}};   // K3: a timed room carries its start time
    return !!waiting&&join.validOpening(waiting)===true;
  }
  function unknown(reason) {
    return {committed:false,uncertain:true,reason};
  }

  // Preserve mutable SDK errors; immutable/Proxy/primitive rejections use
  // a wrapper with the original thrown value in cause.
  function uncertainSdkError(error) {
    if(error!==null&&(typeof error==="object"||typeof error==="function")){
      try {
        error.italianJoinUncertain=true;
        if(error.italianJoinUncertain===true)return error;
      } catch (_) {
        // Frozen, sealed, or rejecting Proxy objects must not mask the cause.
      }
    }
    const wrapped=new Error("italian_join_outcome_uncertain");
    wrapped.cause=error;
    wrapped.italianJoinUncertain=true;
    return wrapped;
  }

  // A bounded value-subscription read; never writes and always detaches.
  // RTDB value events may be served from cache, even when the contents
  // match a valid, previously committed room. Neither a positive nor a
  // negative value event proves the CURRENT remote state of a room.
  async function readFirstValue(ref,ms) {
    let timer,callback,attached=false;
    try {
      return await new Promise(function(resolve,reject){
        callback=function(snap){resolve(snap);};
        const cancelled=function(err){reject(err);};
        timer=setTimeout(function(){
          reject(new Error("italian_join_read_timeout"));
        },ms);
        attached=true;
        try {ref.on("value",callback,cancelled);}
        catch(err){reject(err);}
      });
    } finally {
      if(timer!==undefined)clearTimeout(timer);
      if(attached)ref.off("value",callback);
    }
  }
  async function reconcileOnRef(ref,input,join,ms) {
    try {
      const snapshot=await readFirstValue(ref,ms);
      if(!snapshot||typeof snapshot.val!=="function")return unknown("read_invalid");
      const room=snapshot.val();
      if(observedOwnSeat(room,input,join)) {
        // F2-1: strictly advisory. A cached positive is NOT proof of a
        // successful server commit. Never call it committed:true.
        return unknown("unverified_cached_match");
      }
      return unknown("not_confirmed");
    } catch(e) {
      return unknown("read_unavailable");
    }
  }
  async function reconcileJoin(database,code,input,options) {
    const join=check(database,code,input);
    const ref=reference(database,code);
    return reconcileOnRef(ref,input,join,
      timeoutOption(options,"recoveryTimeoutMs",RECOVERY_READ_MS));
  }

  async function joinWaitingRoom(database,code,input,options) {
    const join=check(database,code,input);
    const ref=reference(database,code);
    if(typeof ref.transaction!=="function"){
      throw new Error("italian_join_transaction_unavailable");
    }
    // Deduplicate a pending local write, including AFTER a watchdog
    // timeout. Firebase cannot cancel a transaction promise on timeout.
    let locks=inFlight.get(database);
    if(!locks){locks=new Map();inFlight.set(database,locks);}
    if(locks.has(code))return unknown("join_in_flight");
    const token={};
    locks.set(code,token);
    let transactionStarted=false;
    let transactionSettled=false;
    let firstListener,initialTimer,attached=false;
    let watchdogTimer,returnedResult,primaryError;
    const deliver=function(value){returnedResult=value;return value;};
    const release=function(){if(locks.get(code)===token)locks.delete(code);};
    try {
      const snapshot=await new Promise(function(resolve,reject){
        firstListener=function(snap){resolve(snap);};
        const cancelled=function(err){reject(err);};
        initialTimer=setTimeout(function(){
          reject(new Error("italian_join_initial_read_timeout"));
        },timeoutOption(options,"initialTimeoutMs",INITIAL_READ_MS));
        attached=true;
        try {ref.on("value",firstListener,cancelled);}
        catch(err){reject(err);}
      });
      if(initialTimer!==undefined){clearTimeout(initialTimer);initialTimer=undefined;}
      if(!snapshot||typeof snapshot.val!=="function"){
        throw new Error("italian_join_initial_snapshot_invalid");
      }
      const initialRoom=snapshot.val();
      // A previously occupied seat might be ours, but this initial
      // Firebase value event could be STALE CACHE. Do not confirm
      // server success from it, and do not attempt another write.
      if(observedOwnSeat(initialRoom,input,join)){
        return deliver(unknown("unverified_cached_match"));
      }
      if(join.proposeJoin(initialRoom,input)===null){
        // A cached null/foreign/stale room is not a trustworthy negative
        // server result either. Abort without writes; report UNKNOWN.
        return deliver(unknown("preflight_not_confirmed"));
      }
      transactionStarted=true;
      const settled=Promise.resolve().then(function(){
        return ref.transaction(function(current){
          const proposed=join.proposeJoin(current,input);
          return proposed===null?undefined:proposed;
        },undefined,false);
      }).then(function(result){
        return {kind:"result",result};
      },function(error){
        return {kind:"error",error};
      }).then(function(value){
        transactionSettled=true;
        release(); // allow a later user action only after SDK actually settles
        return value;
      });
      const deadline=new Promise(function(resolve){
        watchdogTimer=setTimeout(function(){
          resolve({kind:"timeout"});
        },timeoutOption(options,"transactionTimeoutMs",TRANSACTION_MS));
      });
      const finished=await Promise.race([settled,deadline]);
      if(finished.kind==="timeout"){
        // No cancellation! A late server commit remains possible.
        // Leave the in-flight lock until the SDK actually settles.
        const seen=await reconcileOnRef(ref,input,join,
          timeoutOption(options,"recoveryTimeoutMs",RECOVERY_READ_MS));
        return deliver(seen.reason==="unverified_cached_match"?seen:unknown("transaction_timeout"));
      }
      if(finished.kind==="error"){
        const seen=await reconcileOnRef(ref,input,join,
          timeoutOption(options,"recoveryTimeoutMs",RECOVERY_READ_MS));
        // A matching snapshot can still be stale; never promote it to
        // success after an SDK error.
        // Keep SDK failure (e.g. permission_denied) visible but mark the
        // commit outcome ambiguous: never infer "nothing was written".
        throw uncertainSdkError(finished.error);
      }
      const outcome=finished.result;
      if(!outcome||outcome.committed!==true||
         !outcome.snapshot||typeof outcome.snapshot.val!=="function"){
        const seen=await reconcileOnRef(ref,input,join,
          timeoutOption(options,"recoveryTimeoutMs",RECOVERY_READ_MS));
        return deliver(seen.reason==="unverified_cached_match"?seen:unknown("commit_not_confirmed"));
      }
      const committed=outcome.snapshot.val();
      if(!observedOwnSeat(committed,input,join)){
        throw new Error("italian_join_commit_mismatch");
      }
      return deliver({committed:true,room:committed});
    } catch(error) {
      primaryError=error;
      throw error;
    } finally {
      if(initialTimer!==undefined)clearTimeout(initialTimer);
      if(watchdogTimer!==undefined)clearTimeout(watchdogTimer);
      try {
        if(attached)ref.off("value",firstListener);
      } catch(offError) {
        // Cleanup must not hide a verified commit or primary SDK failure.
        // The listener may still be attached if off() throws.
        if(returnedResult){
          returnedResult.listenerCleanupUncertain=true;
          returnedResult.listenerCleanupError=offError;
        } else {
          let recorded=false;
          if(primaryError&&(typeof primaryError==="object"||typeof primaryError==="function")){
            try {
              primaryError.italianJoinCleanupError=offError;
              recorded=primaryError.italianJoinCleanupError===offError;
            } catch (_) {}
          }
          if(!recorded&&typeof console!=="undefined"&&typeof console.warn==="function"){
            console.warn("italian_join_listener_cleanup_failed",offError);
          }
        }
      } finally {
        if(!transactionStarted||transactionSettled)release();
      }
    }
  }
  global.ItalianOnlineJoinTransport=Object.freeze({
    joinWaitingRoom,reconcileJoin
  });
})(typeof window!=="undefined"?window:globalThis);

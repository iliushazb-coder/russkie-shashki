// PR-81: Italian join UI-facing coordinator; NOT loaded into index.html.
// Explicit user action only. One SDK attempt, then one read-only remote check.
// Fail closed on lost ACK, cache-only success, errors, or a missing dependency.
(function(global){
  "use strict";

  const UID=/^tg_[0-9]+$/;
  const inFlight=new WeakMap();
  const transport=global.ItalianOnlineJoinTransport;
  const joinFn=transport && typeof transport.joinWaitingRoom==="function" ?
    transport.joinWaitingRoom:null;
  const gate=global.ItalianOnlineJoinConfirmationGate;
  const checkFn=gate && typeof gate.confirmOwnSeat==="function" ?
    gate.confirmOwnSeat:null;
  const invite=global.ItalianOnlineInviteContract;
  const codeFn=invite && typeof invite.validCode==="function" ?
    invite.validCode:null;

  function unknown(reason){
    return {committed:false,uncertain:true,status:"check_room",reason};
  }
  function depsOK(){
    return !!(joinFn && checkFn && codeFn &&
      global.ItalianOnlineJoinTransport===transport &&
      global.ItalianOnlineJoinConfirmationGate===gate &&
      global.ItalianOnlineInviteContract===invite &&
      transport.joinWaitingRoom===joinFn &&
      gate.confirmOwnSeat===checkFn &&
      invite.validCode===codeFn);
  }
  function snapshot(code,input){
    if(!codeFn || !codeFn.call(invite,code) ||
       !input || typeof input!=="object")return null;
    const s={
      expectedCreatedAt:input.expectedCreatedAt,
      expectedOwnerId:input.expectedOwnerId,
      expectedOwnerName:input.expectedOwnerName,
      playerId:input.playerId,
      playerName:input.playerName
    };
    // STEP K3: the database time sentinel for the start of a timed game (the transaction writes it; only this exact value is carried on)
    if(input.serverTimestamp&&typeof input.serverTimestamp==="object"&&input.serverTimestamp[".sv"]==="timestamp")s.serverTimestamp={".sv":"timestamp"};
    if(!Number.isSafeInteger(s.expectedCreatedAt) || s.expectedCreatedAt<=0 ||
       typeof s.expectedOwnerId!=="string" || !UID.test(s.expectedOwnerId) ||
       typeof s.playerId!=="string" || !UID.test(s.playerId) ||
       s.playerId===s.expectedOwnerId ||
       typeof s.expectedOwnerName!=="string" ||
       s.expectedOwnerName.length===0 || s.expectedOwnerName.length>80 ||
       typeof s.playerName!=="string" ||
       s.playerName.trim().length===0 || s.playerName.trim().length>80){
      return null;
    }
    return s;
  }
  function authOK(auth,user,uid){
    return !!(auth && user && typeof user==="object" &&
      auth.currentUser===user && user.uid===uid);
  }
  function gateOptions(options){
    const result={};
    if(options && Object.prototype.hasOwnProperty.call(options,"appCheck"))
      result.appCheck=options.appCheck;
    if(options && Object.prototype.hasOwnProperty.call(options,"confirmationTimeoutMs"))
      result.timeoutMs=options.confirmationTimeoutMs;
    // Caller cannot select a host. PR-80 supplies the fixed trusted pin.
    return result;
  }
  function transactionOptions(options){
    const result={};
    for(const key of ["initialTimeoutMs","transactionTimeoutMs","recoveryTimeoutMs"]){
      if(options && Object.prototype.hasOwnProperty.call(options,key))
        result[key]=options[key];
    }
    return result;
  }
  async function check(database,auth,user,code,claim,options){
    if(!depsOK())return unknown("dependency_changed");
    try {
      const result=await checkFn.call(gate,database,auth,code,claim,
        gateOptions(options));
      if(!authOK(auth,user,claim.playerId))return unknown("auth_changed");
      if(!depsOK())return unknown("dependency_changed");
      if(result && result.committed===true && result.confirmed===true &&
         result.status==="joined_confirmed" &&
         result.source==="firebase_rest_server" &&
         result.room && typeof result.room==="object" &&
         !Array.isArray(result.room)){
        return result;
      }
      return unknown(result && typeof result.reason==="string" ?
        result.reason:"server_not_confirmed");
    } catch (_) {
      return unknown("confirmation_unavailable");
    }
  }
  function preflight(database,auth,code,input){
    if(!depsOK())return {error:unknown("dependency_unavailable")};
    if(!database || (typeof database!=="object" && typeof database!=="function"))
      return {error:unknown("database_unavailable")};
    const claim=snapshot(code,input);
    if(!claim)return {error:unknown("invalid_request")};
    const user=auth&&auth.currentUser;
    if(!authOK(auth,user,claim.playerId))
      return {error:unknown("auth_identity_mismatch")};
    return {claim,user};
  }
  // A manual "check room" button calls this read-only path; it NEVER calls
  // the join transport, including while its SDK transaction is still pending.
  async function checkOwnSeat(database,auth,code,input,options){
    try {
      const p=preflight(database,auth,code,input);
      if(p.error)return p.error;
      return await check(database,auth,p.user,code,p.claim,options);
    } catch (_) {
      return unknown("verification_unavailable");
    }
  }
  // This method is WRITE-CAPABLE and must be wired only behind an explicit
  // user gesture + future server-controlled Italian feature gates. Merely
  // importing this script does NOT call it. Never retry after an UNKNOWN.
  async function joinOnce(database,auth,code,input,options){
    let held=false,locks,token;
    try {
      if(!options || options.explicitUserAction!==true)
        return unknown("explicit_user_action_required");
      const p=preflight(database,auth,code,input);
      if(p.error)return p.error;
      locks=inFlight.get(database);
      if(!locks){locks=new Map();inFlight.set(database,locks);}
      if(locks.has(code))return unknown("join_in_flight");
      token={};
      locks.set(code,token);
      held=true;
      // One invocation only. PR-78 retains its own SDK transaction lock
      // beyond a timeout until the underlying Firebase promise settles.
      try {
        await joinFn.call(transport,database,code,p.claim,
          transactionOptions(options));
      } catch (_) {
        // SDK exception means UNKNOWN; a lost ACK can still have committed.
        // Continue to read-only authoritative PR-80 confirmation.
      }
      // Even a verified SDK transaction is NOT promoted to UI success without
      // an authoritative remote check. No second SDK write is issued here.
      return await check(database,auth,p.user,code,p.claim,options);
    } catch (_) {
      return unknown("join_unavailable");
    } finally {
      if(held && locks && locks.get(code)===token)locks.delete(code);
    }
  }
  global.ItalianOnlineJoinUIOrchestrator=Object.freeze({joinOnce,checkOwnSeat});
})(typeof window!=="undefined"?window:globalThis);

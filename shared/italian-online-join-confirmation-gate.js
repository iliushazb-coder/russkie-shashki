// PR-80: explicitly invoked, read-only Italian join confirmation gate.
// Not loaded by production UI; no SDK writes, no automatic retry.
(function(global){
  "use strict";

  // Reviewed source: PRIVATE script.js firebaseConfig.databaseURL at PR-80 BASE.
  // This is an independent pin, NEVER derived from database.app.options or invite.
  // Reconfirm against actual deployed configuration before production.
  const TRUSTED_HOST="russkie-shashki-online-default-rtdb.europe-west1.firebasedatabase.app";
  function pending(reason){
    return {committed:false,uncertain:true,status:"check_room",reason};
  }

  // Capture the vetted collaborators at initialization, not at call time.
  // This prevents a later global replacement from silently being promoted to
  // a trusted verifier. A script that executes BEFORE this module can still
  // compromise this trust root; script integrity is a separate release gate.
  const verifiedService=global.ItalianOnlineJoinRemoteConfirmation;
  const verifiedConfirm=verifiedService &&
    typeof verifiedService.confirmJoin==="function" ?
    verifiedService.confirmJoin:null;
  const verifiedJoin=global.ItalianOnlineJoinContract;
  const verifiedOpening=verifiedJoin &&
    typeof verifiedJoin.validOpening==="function" ?
    verifiedJoin.validOpening:null;
  const verifiedInvite=global.ItalianOnlineInviteContract;
  const verifiedCode=verifiedInvite &&
    typeof verifiedInvite.validCode==="function" ?
    verifiedInvite.validCode:null;

  function dependenciesUnchanged(){
    return !!(verifiedConfirm && verifiedOpening && verifiedCode &&
      global.ItalianOnlineJoinRemoteConfirmation===verifiedService &&
      global.ItalianOnlineJoinContract===verifiedJoin &&
      global.ItalianOnlineInviteContract===verifiedInvite &&
      verifiedService.confirmJoin===verifiedConfirm &&
      verifiedJoin.validOpening===verifiedOpening &&
      verifiedInvite.validCode===verifiedCode);
  }

  function ownOpeningVerified(room,input){
    try {
      if(!room || typeof room!=="object" || Array.isArray(room) ||
         room.ruleset!=="italian" || room.status!=="active" ||
         room.createdAt!==input.expectedCreatedAt ||
         !room.players || typeof room.players!=="object" ||
         Array.isArray(room.players) || Object.keys(room.players).length!==2 ||
         !room.players.light || !room.players.dark ||
         typeof room.players.dark!=="object" ||
         Array.isArray(room.players.dark) ||
         Object.keys(room.players.dark).length!==2 ||
         !Object.prototype.hasOwnProperty.call(room.players.dark,"id") ||
         !Object.prototype.hasOwnProperty.call(room.players.dark,"name") ||
         room.players.light.id!==input.expectedOwnerId ||
         room.players.light.name!==input.expectedOwnerName ||
         room.players.dark.id!==input.playerId ||
         room.players.dark.name!==input.playerName.trim()){
        return false;
      }
      // Reuse PR-77's strict 24-piece canonical validator. The projected
      // waiting room retains all other fields so extra/damaged data fails.
      const waiting=typeof verifiedJoin.activeToWaiting==="function"?verifiedJoin.activeToWaiting(room):{...room,status:"waiting",players:{light:room.players.light}};   // K3: a timed room carries its start time
      return !!waiting&&verifiedOpening.call(verifiedJoin,waiting)===true;
    } catch (_) {
      return false;
    }
  }

  async function confirmOwnSeat(database,auth,code,input,options){
    try {
      // Refuse caller-provided hostname overrides. A matching explicit value
      // does not supply authority; the source-level pin always wins.
      if(options && Object.prototype.hasOwnProperty.call(options,"expectedDatabaseHost") &&
         options.expectedDatabaseHost!==TRUSTED_HOST){
        return pending("host_override_rejected");
      }
      if(!input || typeof input!=="object" || typeof input.playerId!=="string" ||
         !auth || !auth.currentUser || auth.currentUser.uid!==input.playerId){
        return pending("auth_identity_mismatch");
      }
      const user=auth.currentUser;
      if(!verifiedConfirm || !verifiedOpening || !verifiedCode ||
         !global.ItalianOnlineJoinRemoteConfirmation){
        return pending("remote_confirmation_unavailable");
      }
      if(!dependenciesUnchanged()){
        return pending("verification_dependency_changed");
      }
      if(!verifiedCode.call(verifiedInvite,code)){
        return pending("invalid_request");
      }
      // Freeze the claim of whom we are checking across all async work.
      // A caller mutating its original input mid-fetch must not change it.
      const expected={
        expectedCreatedAt:input.expectedCreatedAt,
        expectedOwnerId:input.expectedOwnerId,
        expectedOwnerName:input.expectedOwnerName,
        playerId:input.playerId,
        playerName:input.playerName
      };
      const remoteOptions={expectedDatabaseHost:TRUSTED_HOST};
      if(options && Object.prototype.hasOwnProperty.call(options,"timeoutMs"))
        remoteOptions.timeoutMs=options.timeoutMs;
      if(options && Object.prototype.hasOwnProperty.call(options,"appCheck"))
        remoteOptions.appCheck=options.appCheck;
      const outcome=await verifiedConfirm.call(
        verifiedService,database,auth,code,expected,remoteOptions);
      if(auth.currentUser!==user || auth.currentUser.uid!==expected.playerId)
        return pending("auth_changed");
      if(!dependenciesUnchanged())
        return pending("verification_dependency_changed");
      if(outcome && outcome.committed===true && outcome.confirmed===true &&
         outcome.source==="firebase_rest_server" &&
         ownOpeningVerified(outcome.room,expected)){
        return {committed:true,confirmed:true,status:"joined_confirmed",
          source:"firebase_rest_server",room:outcome.room};
      }
      return pending(outcome && typeof outcome.reason==="string"?
        outcome.reason:"server_not_confirmed");
    } catch (_) {
      // SDK getters and adapters can unexpectedly throw (PR-79 P3).
      // No exception from a recovery check may be interpreted as success.
      return pending("verification_unavailable");
    }
  }
  global.ItalianOnlineJoinConfirmationGate=Object.freeze({
    confirmOwnSeat,TRUSTED_HOST
  });
})(typeof window!=="undefined"?window:globalThis);

// PR-79: authenticated server-only Italian join confirmation.
// Uses RTDB HTTPS REST GET (NOT SDK get()/on('value') local cache).
// Standalone/default-off: no UI, Worker, Rules or /rooms integration.
(function (global) {
  "use strict";
  const DEFAULT_MS=8000;
  const UID=/^tg_[0-9]+$/;

  function unknown(reason) {
    return {committed:false,uncertain:true,reason};
  }
  function validInput(code,input) {
    const invite=global.ItalianOnlineInviteContract;
    const join=global.ItalianOnlineJoinContract;
    return !!(invite && typeof invite.validCode==="function" &&
      invite.validCode(code) && join && typeof join.validOpening==="function" &&
      input && typeof input==="object" &&
      Number.isSafeInteger(input.expectedCreatedAt) && input.expectedCreatedAt>0 &&
      typeof input.expectedOwnerId==="string" && UID.test(input.expectedOwnerId) &&
      typeof input.expectedOwnerName==="string" &&
      input.expectedOwnerName.length>0 && input.expectedOwnerName.length<=80 &&
      typeof input.playerId==="string" && UID.test(input.playerId) &&
      input.playerId!==input.expectedOwnerId &&
      typeof input.playerName==="string" &&
      input.playerName.trim().length>0 && input.playerName.trim().length<=80);
  }
  function validServerSeat(room,input) {
    const join=global.ItalianOnlineJoinContract;
    try {
      if(!room || typeof room!=="object" || Array.isArray(room) ||
         room.ruleset!=="italian" || room.status!=="active" ||
         room.createdAt!==input.expectedCreatedAt ||
         !room.players || typeof room.players!=="object" ||
         Array.isArray(room.players) || Object.keys(room.players).length!==2 ||
         !room.players.light || !room.players.dark ||
         typeof room.players.dark!=="object" || Array.isArray(room.players.dark) ||
         Object.keys(room.players.dark).length!==2 ||
         !Object.prototype.hasOwnProperty.call(room.players.dark,"id") ||
         !Object.prototype.hasOwnProperty.call(room.players.dark,"name") ||
         room.players.light.id!==input.expectedOwnerId ||
         room.players.light.name!==input.expectedOwnerName ||
         room.players.dark.id!==input.playerId ||
         room.players.dark.name!==input.playerName.trim())return false;
      // A strict canonical opening validator rejects extra room metadata,
      // extra players/pieces, kings, altered counters and mismatched owners.
      const waiting=typeof join.activeToWaiting==="function"?join.activeToWaiting(room):{...room,status:"waiting",players:{light:room.players.light}};   // K3: a timed room carries its start time
      return !!waiting&&join.validOpening(waiting)===true;
    } catch (_) {
      return false;
    }
  }
  // PR-79: fail closed unless the Firebase app URL, actual database instance,
  // independently pinned hostname and auth project all agree BEFORE we fetch
  // an ID token. This slice deliberately supports only the project's default
  // RTDB instance, not arbitrary named/sharded database instances.
  function rootUrl(value) {
    if(typeof value!=="string" || !global.URL)return null;
    try {
      const u=new global.URL(value);
      if(u.protocol!=="https:" || u.username || u.password || u.port ||
         (u.pathname!=="/" && u.pathname!=="") || u.search || u.hash)return null;
      return u;
    } catch (_) {
      return null;
    }
  }
  function defaultHostForProject(host,project) {
    const dbName=project+"-default-rtdb";
    if(host===project+".firebaseio.com" ||
       host===dbName+".firebaseio.com")return true;
    const prefix=dbName+".";
    if(!host.startsWith(prefix))return false;
    const suffix=host.slice(prefix.length);
    return /^[a-z]+-[a-z]+[0-9]+\.firebasedatabase\.app$/.test(suffix);
  }
  function restBase(database,project,expectedHost) {
    if(typeof expectedHost!=="string" ||
       !/^[a-z0-9.-]+$/.test(expectedHost) ||
       expectedHost.length>253){
      return {reason:"remote_host_not_pinned"};
    }
    const appUrl=rootUrl(database&&database.app&&database.app.options&&
      database.app.options.databaseURL);
    if(!appUrl || !defaultHostForProject(appUrl.hostname,project)){
      return {reason:"remote_database_invalid"};
    }
    let instanceUrl;
    try {
      // SDK Reference.toString() is the absolute URL of THIS Database instance.
      // No on()/get()/transaction() call or cached snapshot is used.
      if(!database || typeof database.ref!=="function")throw Error("no_ref");
      const root=database.ref();
      if(!root || typeof root.toString!=="function")throw Error("no_root_url");
      instanceUrl=rootUrl(root.toString());
    } catch (_) {
      return {reason:"database_instance_mismatch"};
    }
    if(!instanceUrl || instanceUrl.origin!==appUrl.origin){
      return {reason:"database_instance_mismatch"};
    }
    if(instanceUrl.hostname!==expectedHost){
      return {reason:"remote_host_mismatch"};
    }
    return {base:instanceUrl};
  }
  // Confirmation is idempotent and read-only, including after lost ACK.
  // It attests that THIS player's seat is CURRENTLY on the remote server,
  // not which physical device's earlier transaction created that seat.
  async function confirmJoin(database,auth,code,input,options) {
    if(!validInput(code,input))return unknown("invalid_request");
    const dbProject=database&&database.app&&database.app.options&&
      database.app.options.projectId;
    const authProject=auth&&auth.app&&auth.app.options&&auth.app.options.projectId;
    if(typeof dbProject!=="string" || typeof authProject!=="string" ||
       !/^[a-z][a-z0-9-]{2,62}$/.test(dbProject) ||
       dbProject!==authProject)return unknown("auth_project_mismatch");
    const checked=restBase(database,dbProject,options&&options.expectedDatabaseHost);
    if(!checked.base)return unknown(checked.reason);
    const base=checked.base;
    if(!auth || !auth.currentUser ||
       auth.currentUser.uid!==input.playerId ||
       typeof auth.currentUser.getIdToken!=="function")return unknown("auth_identity_mismatch");
    if(typeof global.fetch!=="function" || typeof global.AbortController!=="function"){
      return unknown("remote_transport_unavailable");
    }
    const signedInUser=auth.currentUser;
    const requestedMs=options&&options.timeoutMs;
    const ms=Number.isSafeInteger(requestedMs)&&requestedMs>=1&&requestedMs<=60000?
      requestedMs:DEFAULT_MS;
    const controller=new global.AbortController();
    let timer;
    let timedOut=false;
    const deadline=new Promise(function(resolve){
      timer=setTimeout(function(){
        timedOut=true;
        try {controller.abort();} catch (_) {}
        resolve(unknown("remote_timeout"));
      },ms);
    });
    const task=(async function(){
      try {
        const idToken=await signedInUser.getIdToken();
        if(timedOut)return unknown("remote_timeout");
        if(typeof idToken!=="string" || idToken.length<20 ||
           idToken.length>10000 || /\s/.test(idToken)){
          return unknown("auth_token_invalid");
        }
        if(auth.currentUser!==signedInUser ||
           auth.currentUser.uid!==input.playerId)return unknown("auth_changed");
        const endpoint=new global.URL("roomsItalian/"+code+".json",base);
        endpoint.searchParams.set("auth",idToken);
        const headers={Accept:"application/json"};
        if(options&&options.appCheck){
          if(typeof options.appCheck.getToken!=="function")
            return unknown("app_check_unavailable");
          const appCheckResult=await options.appCheck.getToken();
          if(timedOut)return unknown("remote_timeout");
          const appCheckToken=typeof appCheckResult==="string"?appCheckResult:
            appCheckResult&&appCheckResult.token;
          if(typeof appCheckToken!=="string" || !appCheckToken ||
             appCheckToken.length>10000 || /\s/.test(appCheckToken))
            return unknown("app_check_unavailable");
          headers["X-Firebase-AppCheck"]=appCheckToken;
        }
        if(timedOut)return unknown("remote_timeout");
        // App Check acquisition may be asynchronous: never send an old user's
        // Firebase ID token after switching accounts, even if UID is reused.
        if(auth.currentUser!==signedInUser ||
           auth.currentUser.uid!==input.playerId ||
           !auth.app || !auth.app.options ||
           auth.app.options.projectId!==dbProject){
          return unknown("auth_changed");
        }
        const response=await global.fetch(endpoint.toString(),{
          method:"GET",headers,cache:"no-store",credentials:"omit",
          redirect:"error",referrerPolicy:"no-referrer",signal:controller.signal
        });
        if(timedOut)return unknown("remote_timeout");
        if(!response || response.status!==200 || response.ok!==true ||
           response.redirected===true)return unknown("remote_read_unavailable");
        const room=await response.json();
        if(timedOut)return unknown("remote_timeout");
        if(auth.currentUser!==signedInUser ||
           auth.currentUser.uid!==input.playerId)return unknown("auth_changed");
        if(!validServerSeat(room,input))return unknown("server_not_confirmed");
        return {committed:true,confirmed:true,source:"firebase_rest_server",room};
      } catch (_) {
        return unknown(timedOut?"remote_timeout":"remote_read_unavailable");
      }
    })();
    try {
      return await Promise.race([task,deadline]);
    } finally {
      if(timer!==undefined)clearTimeout(timer);
    }
  }
  global.ItalianOnlineJoinRemoteConfirmation=Object.freeze({
    confirmJoin
  });
})(typeof window!=="undefined"?window:globalThis);

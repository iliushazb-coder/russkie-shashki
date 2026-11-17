// PR-83: read-only server preflight for a FUTURE Italian Online UI.
// Not loaded by index.html. No Firebase SDK reads (cache is not authoritative),
// no join, no writes, no UI; server Rules remain the FINAL admission authority.
(function(global){
  "use strict";
  const PROJECT="russkie-shashki-online";
  const TRUSTED_HOST="russkie-shashki-online-default-rtdb.europe-west1.firebasedatabase.app";
  const UID=/^tg_[0-9]+$/;
  const DEFAULT_MS=8000;
  const trustedFetch=global.fetch;
  const trustedURL=global.URL;
  const trustedAbort=global.AbortController;

  function denied(reason,operation){
    return {allowed:false,verified:false,status:"italian_online_unavailable",
      operation:operation==="join"||operation==="create"?operation:null,reason};
  }
  function sameUser(auth,user,uid){
    return !!(auth&&user&&auth.currentUser===user&&user.uid===uid);
  }
  function tokenOK(v){
    return typeof v==="string" && v.length>=20 && v.length<=10000 &&
      !/\s/.test(v);
  }
  function rootUrl(value){
    if(typeof value!=="string"||!trustedURL)return null;
    try {
      const u=new trustedURL(value);
      if(u.protocol!=="https:"||u.username||u.password||u.port||
         (u.pathname!=="/"&&u.pathname!=="")||u.search||u.hash)return null;
      return u;
    } catch (_) {return null;}
  }
  function authoritativeBase(database,auth){
    try {
      if(!database||typeof database.ref!=="function"||
         !database.app||!database.app.options||
         database.app.options.projectId!==PROJECT||
         !auth||!auth.app||!auth.app.options||
         auth.app.options.projectId!==PROJECT)return null;
      const app=rootUrl(database.app.options.databaseURL);
      const ref=database.ref();
      const instance=rootUrl(ref&&typeof ref.toString==="function"?
        ref.toString():null);
      if(!app||!instance||app.origin!==instance.origin||
         app.hostname!==TRUSTED_HOST||instance.hostname!==TRUSTED_HOST)return null;
      return instance;
    } catch (_) {return null;}
  }
  // PR-84: a pinned configuration must remain pinned across every await.
  // Reads are advisory; RTDB Rules remain the final write-authority.
  function configurationStillPinned(database,auth,initialBase){
    const current=authoritativeBase(database,auth);
    return !!current && current.href===initialBase.href;
  }
  function dependenciesOK(){
    return typeof trustedFetch==="function" && typeof trustedURL==="function" &&
      typeof trustedAbort==="function" &&
      global.fetch===trustedFetch && global.URL===trustedURL &&
      global.AbortController===trustedAbort;
  }
  // Advisory read-only preflight: even an allowed=true result is NOT a write
  // authorization. Firebase Rules revalidate the gate and tester on commit.
  async function checkAccess(database,auth,operation,options){
    const op=operation==="join"||operation==="create"?operation:null;
    if(!op)return denied("invalid_operation",op);
    try {
      if(!dependenciesOK())return denied("transport_unavailable",op);
      const base=authoritativeBase(database,auth);
      if(!base)return denied("database_identity_mismatch",op);
      const user=auth&&auth.currentUser;
      const uid=user&&user.uid;
      if(!UID.test(uid)||!sameUser(auth,user,uid)||
         typeof user.getIdToken!=="function")return denied("auth_identity_mismatch",op);
      if(!options||!options.appCheck||
         typeof options.appCheck.getToken!=="function")
        return denied("app_check_unavailable",op);
      const ms=Number.isSafeInteger(options.timeoutMs)&&options.timeoutMs>=1&&
        options.timeoutMs<=60000?options.timeoutMs:DEFAULT_MS;
      const abort=new trustedAbort();
      let timer,timedOut=false;
      const deadline=new Promise(resolve=>{
        timer=setTimeout(()=>{
          timedOut=true;
          try {abort.abort();} catch (_) {}
          resolve(denied("server_timeout",op));
        },ms);
      });
      const work=(async()=>{
        try {
          const idToken=await user.getIdToken();
          if(timedOut)return denied("server_timeout",op);
          if(!tokenOK(idToken))return denied("auth_token_invalid",op);
          if(!sameUser(auth,user,uid))return denied("auth_changed",op);
          const checkResult=await options.appCheck.getToken();
          if(timedOut)return denied("server_timeout",op);
          const appToken=typeof checkResult==="string"?checkResult:
            checkResult&&checkResult.token;
          if(!tokenOK(appToken))return denied("app_check_unavailable",op);
          if(!sameUser(auth,user,uid)||!dependenciesOK())
            return denied("auth_or_transport_changed",op);
          const headers={Accept:"application/json","X-Firebase-AppCheck":appToken};

          async function readExactTrue(path){
            if(timedOut||!sameUser(auth,user,uid)||!dependenciesOK())
              return {ok:false,reason:"auth_or_transport_changed"};
            if(!configurationStillPinned(database,auth,base))
              return {ok:false,reason:"database_identity_changed"};
            const endpoint=new trustedURL(path+".json",base);
            endpoint.searchParams.set("auth",idToken);
            const response=await trustedFetch(endpoint.toString(),{
              method:"GET",headers,cache:"no-store",credentials:"omit",
              redirect:"error",referrerPolicy:"no-referrer",signal:abort.signal
            });
            if(timedOut)return {ok:false,reason:"server_timeout"};
            if(!response||response.status!==200||response.ok!==true||
               response.redirected===true)return {ok:false,reason:"server_read_unavailable"};
            const value=await response.json();
            if(timedOut)return {ok:false,reason:"server_timeout"};
            if(!sameUser(auth,user,uid)||!dependenciesOK())
              return {ok:false,reason:"auth_or_transport_changed"};
            if(!configurationStillPinned(database,auth,base))
              return {ok:false,reason:"database_identity_changed"};
            return value===true?{ok:true}:{ok:false,reason:"server_gate_closed"};
          }

          const flag=operation==="create"?"creationEnabled":"joinEnabled";
          const f=await readExactTrue("italianOnlineControl/"+flag);
          if(!f.ok)return denied(f.reason,op);
          // Access = open to everyone (server flag italianOnlineControl/openToAll === true) OR a listed tester.
          // A failed/closed openToAll read only means "not open to all": the tester check then decides (and reports its own reason).
          const o=await readExactTrue("italianOnlineControl/openToAll");
          if(!o.ok){
            const t=await readExactTrue("italianOnlineControl/testers/"+uid);
            if(!t.ok)return denied(t.reason,op);
          }
          if(!sameUser(auth,user,uid)||!dependenciesOK()||timedOut)
            return denied("auth_or_transport_changed",op);
          if(!configurationStillPinned(database,auth,base))
            return denied("database_identity_changed",op);
          return {allowed:true,verified:true,status:"preflight_ready",
            operation:op,source:"firebase_rest_server"};
        } catch (_) {
          return denied(timedOut?"server_timeout":"server_read_unavailable",op);
        }
      })();
      try {return await Promise.race([work,deadline]);}
      finally {clearTimeout(timer);}
    } catch (_) {return denied("preflight_unavailable",op);}
  }
  global.ItalianOnlineAccessPreflight=Object.freeze({checkAccess});
})(typeof window!=="undefined"?window:globalThis);

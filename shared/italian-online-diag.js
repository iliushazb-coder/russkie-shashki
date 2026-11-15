// STAGING-ONLY diagnostics of reopening an Italian Online invite link (STEP I, phase 2).
//
// READ-ONLY. It records what the app SEES and DECIDES (launch context, start_param, auth, room read, status, presence, the exact reason of «Нет активной игры»)
// into a small on-screen panel the owner can open inside the STAGING Mini App, photograph or copy - Android has no console for an ordinary user.
// It never writes to Firebase, never calls the Worker, never changes a room, a presence node or any game state and never sends anything anywhere:
// the only storage it touches is the phone's own localStorage key "it86.diag.v1" (the last launches, for the owner to read after a restart).
//
// OFF in production by construction (fail closed): arm(host) is called by the Italian UI module with ITS database host. The production host does
// not contain "-stg-" / "-staging-", so `on` stays false, NO storage is read or written, NO element is created, no listener is added and every note() is a no-op.
// Only the staging build (whose host is substituted by tools/build-staging-frontend.js) turns it on.
//
// Privacy: no token, no initData, no full invite link, no full room code (first 4 + last 4 hex only), no full user id (last 3 digits only).
(function (global) {
  "use strict";
  const KEY = "it86.diag.v1", MAX_LAUNCHES = 3, MAX_ENTRIES = 90, MAX_FIELD = 120;
  const D = { on: false, t0: 0, launch: null, saved: [], timer: 0, panel: null, btn: null, attention: false, last: null };

  // ---- pure helpers (exported for tests) ----
  // The staging database host is e.g. (a project id with a "-stg-" or "-staging-" part) "russkie-shashki-stg-2026-default-rtdb.europe-west1.firebasedatabase.app". Anything else -> false.
  function gate(host) { return typeof host === "string" && /^[a-z0-9-]*-(?:stg|staging)-[a-z0-9-]*\.[a-z0-9.-]*firebasedatabase\.app$/.test(host); }
  function maskCode(c) { return typeof c === "string" && /^[A-Fa-f0-9]{24}$/.test(c) ? c.slice(0, 4) + "…" + c.slice(-4) : (typeof c === "string" && c ? "?(len " + c.length + ")" : "-"); }
  function maskUid(u) { return typeof u === "string" && /^tg_[0-9]+$/.test(u) ? "tg_…" + u.slice(-3) : (u ? "?" : "-"); }
  // A start_param value described WITHOUT revealing it: format class + masked code for a valid Italian invite.
  function describeParam(v) {
    if (v === undefined || v === null) return "absent";
    if (typeof v !== "string") return "not-a-string";
    if (v === "") return "empty";
    if (/^it_[A-F0-9]{24}$/.test(v)) return "it_OK(" + maskCode(v.slice(3)) + ")";
    if (/^it_[A-Fa-f0-9]{24}$/i.test(v)) return "it_BAD-CASE(" + maskCode(v.slice(3)) + ")";
    if (/^it_/i.test(v)) return "it_BAD-FORMAT(len " + v.length + ")";
    return "other(len " + v.length + ")";   // e.g. a Russian room code: its value is a secret and is never shown
  }
  const num = v => typeof v === "number" && isFinite(v);
  const sec = ms => Math.round(ms / 100) / 10;
  // Presence of both seats against the 60-second rule, with the SAME predicates the app uses (ItalianOnlinePresence), explained field by field.
  function explainPresence(room, presenceRaw, serverNow, ready) {
    const P = global.ItalianOnlinePresence;
    if (!P || typeof P.aggregate !== "function" || typeof P.isAbandoned !== "function") return { err: "presence_module_missing" };
    const out = { node: presenceRaw && typeof presenceRaw === "object" ? "read" : "null", clock: ready && num(serverNow) ? "ready" : "NOT-ready" };
    const ag = P.aggregate(presenceRaw);
    let max = -Infinity, bothOff = true;
    for (const c of ["light", "dark"]) {
      const x = ag && ag[c];
      if (!x) { out[c] = presenceRaw && presenceRaw[c] ? "partial/unknown" : "missing"; bothOff = false; continue; }
      if (x.online) { out[c] = "online" + (ready && num(serverNow) && num(x.lastSeen) ? "(beat " + sec(serverNow - x.lastSeen) + "s ago)" : ""); bothOff = false; }
      else { out[c] = "AWAY" + (ready && num(serverNow) ? " " + sec(serverNow - x.absentSince) + "s" : ""); if (num(x.absentSince)) max = Math.max(max, x.absentSince); }
    }
    if (bothOff && ag && num(max) && ready && num(serverNow)) out.sinceSecondDeparture = sec(serverNow - max) + "s (limit 60s)";
    let verdict; try { verdict = P.isAbandoned(room, presenceRaw, serverNow, !!ready); } catch (_) { verdict = "error"; }
    out.abandoned = verdict;
    return out;
  }
  function seatOf(raw, uid) {
    if (!raw || typeof raw !== "object" || !raw.players) return "no-players";
    if (!uid) return "no-user";
    const l = raw.players.light, d = raw.players.dark;
    return l && l.id === uid ? "light" : d && d.id === uid ? "dark" : "NOT-A-PLAYER";
  }
  // Launch context: every place the Telegram deep link can arrive, each described without its value.
  function launchContext() {
    const o = {};
    try {
      const W = global.Telegram && global.Telegram.WebApp;
      o.webapp = !!W;
      if (W) {
        o.platform = W.platform || "-"; o.version = W.version || "-";
        o.unsafeStartParam = describeParam(W.initDataUnsafe && W.initDataUnsafe.start_param);
        let sp; try { sp = typeof W.initData === "string" && W.initData ? new global.URLSearchParams(W.initData).get("start_param") : undefined; } catch (_) { sp = undefined; }
        o.initDataStartParam = typeof W.initData === "string" ? (W.initData ? describeParam(sp) : "initData-empty") : "no-initData";
        o.user = maskUid(W.initDataUnsafe && W.initDataUnsafe.user && W.initDataUnsafe.user.id != null ? "tg_" + W.initDataUnsafe.user.id : null);
      }
      const L = global.location;
      if (L) {
        const h = new global.URLSearchParams(String(L.hash || "").replace(/^#/, "")), q = new global.URLSearchParams(String(L.search || ""));
        o.hashStartParam = describeParam(h.get("tgWebAppStartParam"));
        o.queryStartParam = describeParam(q.has("tgWebAppStartParam") ? q.get("tgWebAppStartParam") : q.get("startapp"));
        const hd = h.get("tgWebAppData");   // the real Telegram Android/desktop launch: initData travels inside the URL hash
        if (hd) { try { o.hashDataStartParam = describeParam(new global.URLSearchParams(hd).get("start_param")); } catch (_) { o.hashDataStartParam = "unreadable"; } }
        o.hashKeys = [...h.keys()].map(k => k.slice(0, 22)).join(",").slice(0, 100);
      }
      const nav = global.performance && global.performance.getEntriesByType && global.performance.getEntriesByType("navigation")[0];
      o.navType = nav ? nav.type : "-";
      o.vis = global.document ? global.document.visibilityState : "-";
      o.discarded = global.document && global.document.wasDiscarded === true;
      let r = null; try { r = global.localStorage.getItem("it86.lastRoom"); } catch (_) { r = undefined; }
      o.lastRoom = r === undefined ? "storage-error" : r ? maskCode(r) : "empty";
    } catch (e) { o.err = String(e && e.message || e).slice(0, 60); }
    return o;
  }

  // ---- privacy: ONE central filter every recorded string passes through (note data, object keys, loaded history, the final dump) ----
  // Whatever a caller (or an error text, a URL, a header) puts in, none of these can reach the screen, the clipboard or localStorage:
  //  - secret-looking key=value / "key":"value" pairs (auth, token, key, secret, hash, initData, start_param, password, signature, session, cookie ...) -> key=[x]
  //  - "Bearer ..." and JWT-like / base64-like long tokens -> [token]
  //  - any URL -> [url] ;  a bare query string -> ?[query]
  //  - a 24-hex room code -> first4…last4 (longer hex runs -> [hex]) ;  a Telegram user id tg_<digits> -> tg_…last3
  const SECRET_KEY = "(?:auth|access_token|id_token|refresh_token|token|api[_-]?key|apikey|key|secret|password|passwd|pwd|sig|signature|hash|session|sid|cookie|credential|initdata|tgwebappdata|start_param|startapp|tgwebappstartparam|query_id)";
  const RE_KV = new RegExp("(" + SECRET_KEY + ")([\"']?\\s*[=:]\\s*)(\\[x\\]|\"[^\"]*\"|'[^']*'|[^\\s&,;}\\]\"']+)", "gi");
  function scrub(str) {
    let t = String(str);
    t = t.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]+/gi, "$1 [token]");
    t = t.replace(/[a-z][a-z0-9+.-]{1,12}:\/\/[^\s"'<>)\]]*/gi, "[url]");
    t = t.replace(RE_KV, function (m, k, sep) { return k + sep.replace(/\s+/g, "") + "[x]"; });
    t = t.replace(/%7B[^\s&]*/gi, "[x]");                                   // percent-encoded JSON (the Telegram "user" object inside initData)
    t = t.replace(/\b(user_?id|chat_?id|id)(["']?\s*[=:]\s*)"?\d{5,}"?/gi, "$1$2[x]");   // a raw numeric id
    t = t.replace(/\?[A-Za-z0-9_.%-]+=[^\s]*/g, "?[query]");
    t = t.replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){0,2}/g, "[token]");
    t = t.replace(/[A-Fa-f0-9]{24,}/g, function (h) { return h.length === 24 ? h.slice(0, 4) + "…" + h.slice(-4) : "[hex]"; });
    t = t.replace(/\btg_[0-9]{4,}\b/g, function (u) { return "tg_…" + u.slice(-3); });
    t = t.replace(/[A-Za-z0-9_+\/-]{32,}/g, function (x) { return /\d/.test(x) && /[A-Za-z]/.test(x) ? "[long]" : x; });   // a long opaque run (a token), not a plain word
    return t;
  }
  // A SAFE category of an error instead of its free text (a message can carry a URL, a token or a room code).
  function errCode(e) {
    try {
      if (e === null || e === undefined) return "none";
      const msg = typeof e === "string" ? e : String(e.message || ""), code = e && typeof e === "object" ? String(e.code || "") : "", name = e && typeof e === "object" ? String(e.name || "") : "";
      if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,4}$/.test(msg) && msg.length <= 40) return msg;   // a machine code of the app itself (not_found, server_unavailable, italian_game_abandoned ...)
      const h = /^http[_ ]?(\d{3})$/i.exec(msg); if (h) return "http_" + h[1];
      if (/^[a-z0-9]+([\/_.-][a-z0-9]+){0,3}$/i.test(code) && code.length <= 40 && !/[A-Fa-f0-9]{16,}/.test(code)) return "code:" + code;
      const all = (msg + " " + name).toLowerCase();
      if (/time.?out|timed out/.test(all)) return "timeout";
      if (name === "AbortError" || /abort/.test(all)) return "aborted";
      if (/permission|denied|unauthori[sz]ed|forbidden/.test(all)) return "permission_denied";
      if (/network|failed to fetch|offline|load failed|econn|enotfound/.test(all)) return "network";
      if (/json|parse|unexpected token/.test(all)) return "parse_error";
      return "error:" + (/^[A-Za-z]{2,24}$/.test(name) ? name : "unknown");
    } catch (_) { return "error:unknown"; }
  }

  // ---- recording ----
  function clean(v) {
    if (v === null || v === undefined) return v;
    if (typeof v === "string") { const t = scrub(v.length > 600 ? v.slice(0, 600) : v); return t.length > MAX_FIELD ? t.slice(0, MAX_FIELD) + "…" : t; }
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (typeof v === "object") { const o = {}; let n = 0; for (const k of Object.keys(v)) { if (n++ > 24) break; o[scrub(k.slice(0, 40)).slice(0, 24)] = clean(v[k]); } return o; }
    return scrub(String(v).slice(0, 80)).slice(0, 40);
  }
  function persist() {
    D.timer = 0;
    try { global.localStorage.setItem(KEY, JSON.stringify({ v: 1, launches: D.saved.concat([D.launch]).slice(-MAX_LAUNCHES) })); } catch (_) {}
  }
  function note(tag, data) {
    if (!D.on || !D.launch) return;
    try {
      const e = { t: Math.round(global.performance && global.performance.now ? global.performance.now() : Date.now() - D.t0), w: new Date().toTimeString().slice(0, 8), g: String(tag).slice(0, 40), d: clean(data) };
      const sig = e.g + JSON.stringify(e.d);
      if (sig === D.last) return;   // an identical repeat (e.g. a lobby re-render) adds nothing
      D.last = sig;
      const log = D.launch.log; log.push(e); if (log.length > MAX_ENTRIES) log.splice(1, log.length - MAX_ENTRIES);
      if (e.g === "verdict" && e.d && e.d.outcome === "gone") D.attention = true;
      // the decisive records are written AT ONCE (the Mini App may be closed within milliseconds of «Нет активной игры»); the rest are batched
      if (e.g === "verdict" || e.g === "exit.event" || e.g === "openInvite.outcome" || e.g === "room.read" || e.g === "auth.failed" || e.g === "page.pagehide") { if (D.timer) { global.clearTimeout(D.timer); D.timer = 0; } persist(); }
      else if (!D.timer) D.timer = global.setTimeout(persist, 250);
      refresh();
    } catch (_) {}
  }
  function ctx(tag) { if (D.on) note("ctx:" + tag, launchContext()); }
  function fmtData(d) {
    if (d === undefined || d === null) return "";
    if (typeof d !== "object") return String(d);
    return Object.keys(d).map(k => k + "=" + (typeof d[k] === "object" && d[k] !== null ? JSON.stringify(d[k]) : String(d[k]))).join(" ");
  }
  function fmtLaunch(L, title) {
    const lines = [title + " (" + (L.log.length) + ")"];
    for (const e of L.log) lines.push("+" + (e.t / 1000).toFixed(1) + "s " + e.w + " " + e.g + (e.d !== undefined ? " " + fmtData(e.d) : ""));
    return lines.join("\n");
  }
  // The last "verdict" of this launch in one line (what the owner reads first).
  function summary() {
    const log = D.launch ? D.launch.log : [];
    for (let i = log.length - 1; i >= 0; i--) if (log[i].g === "verdict") return "ИТОГ: " + fmtData(log[i].d);
    return "ИТОГ: проверка приглашения в этом запуске не выполнялась";
  }
  function dump() {
    if (!D.on) return "";
    const parts = ["STAGING-диагностика (только чтение). Код/ID замаскированы. Часы телефона не участвуют в решении.", summary(), "", fmtLaunch(D.launch, "ЗАПУСК " + D.launch.id + " (текущий)")];
    for (let i = D.saved.length - 1; i >= 0; i--) parts.push("", fmtLaunch(D.saved[i], "ЗАПУСК " + D.saved[i].id + " (предыдущий)"));
    return scrub(parts.join("\n"));   // last line of defence: the whole report is filtered once more
  }

  // ---- the panel: a tiny corner button + an overlay opened on demand; it never intercepts anything else ----
  function css(el, s) { el.style.cssText = s; }
  function refresh() {
    try {
      if (D.btn) D.btn.style.opacity = D.attention ? "1" : ".55", D.btn.style.borderColor = D.attention ? "#ffb347" : "rgba(255,255,255,.28)";
      if (D.panel && D.panel.style.display !== "none") D.panel.querySelector("pre").textContent = dump();
    } catch (_) {}
  }
  function copy() {
    const text = dump();
    try { if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) { global.navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); }); return; } } catch (_) {}
    legacyCopy(text);
  }
  function legacyCopy(text) {
    try { const ta = global.document.createElement("textarea"); ta.value = text; css(ta, "position:fixed;left:-9999px;top:0"); global.document.body.appendChild(ta); ta.select(); global.document.execCommand("copy"); ta.remove(); } catch (_) {}
  }
  function build() {
    const doc = global.document;
    if (!doc || !doc.body || D.btn) return;
    const btn = doc.createElement("button");
    btn.type = "button"; btn.id = "it-diag-btn"; btn.textContent = "i"; btn.setAttribute("aria-label", "Диагностика (staging)");
    css(btn, "position:fixed;left:6px;bottom:calc(6px + env(safe-area-inset-bottom,0px));width:24px;height:24px;padding:0;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(0,0,0,.5);color:#e9dcc3;font:700 12px/22px monospace;text-align:center;opacity:.55;z-index:2147483000;cursor:pointer;-webkit-tap-highlight-color:transparent");
    const panel = doc.createElement("div");
    panel.id = "it-diag-panel"; panel.setAttribute("role", "dialog");
    css(panel, "position:fixed;left:6px;right:6px;bottom:calc(38px + env(safe-area-inset-bottom,0px));max-height:62vh;display:none;flex-direction:column;background:rgba(18,9,7,.97);color:#e9dcc3;border:1px solid #d9a96e;border-radius:10px;z-index:2147483001;font:11px/1.35 monospace");
    const bar = doc.createElement("div");
    css(bar, "display:flex;gap:8px;padding:6px;border-bottom:1px solid rgba(217,169,110,.4)");
    const mk = (label, fn) => { const b = doc.createElement("button"); b.type = "button"; b.textContent = label; css(b, "flex:1;padding:7px 4px;border-radius:8px;border:1px solid #d9a96e;background:#4a1511;color:#fff3d6;font:700 12px sans-serif"); b.addEventListener("click", fn); return b; };
    bar.appendChild(mk("Копировать", copy));
    bar.appendChild(mk("Закрыть", function () { panel.style.display = "none"; }));
    const pre = doc.createElement("pre");
    css(pre, "margin:0;padding:8px;overflow:auto;white-space:pre-wrap;word-break:break-all;user-select:text;-webkit-user-select:text;flex:1 1 auto");
    panel.appendChild(bar); panel.appendChild(pre);
    btn.addEventListener("click", function () { const show = panel.style.display === "none"; panel.style.display = show ? "flex" : "none"; if (show) { pre.textContent = dump(); pre.scrollTop = 0; } });
    doc.body.appendChild(btn); doc.body.appendChild(panel);
    D.btn = btn; D.panel = panel; refresh();
  }

  // ---- lifecycle ----
  function lifecycle() {
    const w = global;
    try {
      w.document.addEventListener("visibilitychange", function () { note("page.visibility", { state: w.document.visibilityState }); if (w.document.visibilityState === "hidden") persist(); });
      w.addEventListener("pageshow", function (e) { note("page.pageshow", { persisted: !!(e && e.persisted) }); });
      w.addEventListener("pagehide", function (e) { note("page.pagehide", { persisted: !!(e && e.persisted) }); });
      w.document.addEventListener("italian-online:exit", function (e) { note("exit.event", { notice: (e && e.detail && e.detail.notice) || "none" }); });   // «Нет активной игры» / back to the menu
      w.addEventListener("online", function () { note("net.online"); });
      w.addEventListener("offline", function () { note("net.offline"); });
      const W = w.Telegram && w.Telegram.WebApp;
      if (W && typeof W.onEvent === "function") {
        ["activated", "deactivated"].forEach(function (ev) { try { W.onEvent(ev, function () { note("tg." + ev); }); } catch (_) {} });
      }
    } catch (_) {}
  }
  // Called by the Italian UI module with its own database host. Idempotent; production (no "-stg-") stays completely inert.
  function arm(host) {
    if (D.armed) return D.on;          // one-shot: the FIRST call decides for the whole page life (a later call with another host cannot switch it on)
    D.armed = true;
    if (!gate(host)) { D.on = false; return false; }
    D.on = true; D.t0 = Date.now();
    try { const raw = global.localStorage.getItem(KEY), j = raw ? JSON.parse(raw) : null; D.saved = j && j.v === 1 && Array.isArray(j.launches) ? j.launches.filter(l => l && Array.isArray(l.log)).slice(-(MAX_LAUNCHES - 1)).map(function (l) { return { id: +l.id || 0, at: scrub(l.at || "").slice(0, 19), log: l.log.slice(-MAX_ENTRIES).map(function (e) { return { t: +e.t || 0, w: scrub(e.w || "").slice(0, 8), g: scrub(e.g || "").slice(0, 40), d: clean(e.d) }; }) }; }) : []; } catch (_) { D.saved = []; }
    const id = (D.saved.length ? (D.saved[D.saved.length - 1].id || 0) : 0) + 1;
    D.launch = { id: id, at: new Date().toISOString().slice(0, 19), log: [] };
    note("launch", launchContext());
    lifecycle();
    if (global.document && global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", build); else build();
    return true;
  }
  global.ItalianOnlineDiag = Object.freeze({
    arm: arm, note: note, ctx: ctx, dump: dump, gate: gate, maskCode: maskCode, maskUid: maskUid, describeParam: describeParam, explainPresence: explainPresence, seatOf: seatOf, scrub: scrub, errCode: errCode, launchContext: launchContext,
    get on() { return D.on; }
  });
})(typeof window !== "undefined" ? window : globalThis);

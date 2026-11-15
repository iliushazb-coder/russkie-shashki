// Stage 6E-2: the name a Telegram player is given in a game room, as ONE neutral rule for every ruleset (no network, no storage, no Firebase).
//   1. a VERIFIED Telegram username (the claim the server put into the sign-in token) -> "@username";
//   2. otherwise the first name; 3. otherwise the last name; 4. otherwise the account name; 5. otherwise the localized fallback.
// A decorative name never replaces an available verified username. The result is only a label for the room: the player id, the sign-in and the
// shape of the room are not touched (the room keeps allowing a name of 1..80 characters).
(function (global) {
    "use strict";
    const USERNAME = /^[A-Za-z0-9_]{5,32}$/;
    const clean = v => (typeof v === "string" ? v.trim() : "");
    function username(v) {
        const u = clean(v).replace(/^@/, "");
        return USERNAME.test(u) ? u : "";
    }
    function cut(text, max) {
        let out = text.slice(0, max);
        const last = out.charCodeAt(out.length - 1);
        if (out.length === max && last >= 0xD800 && last <= 0xDBFF) out = out.slice(0, -1);   // never cut a pair of surrogates in half
        return out.trim();
    }
    // o: { verifiedUsername, telegramUser: { first_name, last_name }, accountName, fallback }
    function choose(o) {
        o = o || {};
        const u = username(o.verifiedUsername);
        if (u) return "@" + u;
        const t = o.telegramUser && typeof o.telegramUser === "object" ? o.telegramUser : {};
        const n = clean(t.first_name) || clean(t.last_name) || clean(o.accountName) || clean(o.fallback) || "Игрок";
        return cut(n, 80) || "Игрок";
    }
    const api = Object.freeze({ choose, username });
    global.PlayerDisplayName = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

// Ссылка на Telegram-сообщество (вместо личной подписи разработчика). ОДНА настройка адреса, подписи на ru / en / it / pt.
// ТОЛЬКО ССЫЛКА И ТЕКСТ: модуль ничего не знает про игру, комнаты, Firebase и правила.
//   CommunityLink.URL            -- единственное место, где записан адрес группы;
//   CommunityLink.label(lang)    -- подпись на языке (неизвестный язык -> русский);
//   CommunityLink.render(lang?)  -- обновляет каждый элемент [data-community-link]: текст, href, и открытие через Telegram WebApp;
//   CommunityLink.open(url?)     -- открывает ссылку через Telegram.WebApp.openTelegramLink, иначе window.open (false -> ничего не открыто).
// Без JavaScript остаётся обычная ссылка из разметки (target="_blank"), поэтому подпись работает и вне Telegram.
(function (global) {
  "use strict";

  const URL_COMMUNITY = "https://t.me/checkers_dama_online";
  const LABELS = Object.freeze({
    ru: "Сообщество в Telegram",
    en: "Telegram Community",
    it: "Comunità Telegram",
    pt: "Comunidade no Telegram"
  });

  function normalize(lang) {
    if (typeof lang !== "string") return "ru";
    const base = lang.trim().toLowerCase().split(/[-_]/)[0];
    return Object.prototype.hasOwnProperty.call(LABELS, base) ? base : "ru";
  }
  function label(lang) { return LABELS[normalize(lang)]; }

  function isTelegramUrl(u) { return /^https:\/\/t\.me\//.test(String(u)); }

  function open(url) {
    const target = typeof url === "string" && url ? url : URL_COMMUNITY;
    try {
      const tg = global.Telegram && global.Telegram.WebApp;
      if (tg && isTelegramUrl(target) && typeof tg.openTelegramLink === "function") {
        tg.openTelegramLink(target);
        return true;
      }
    } catch (_) { /* fall through to the plain window */ }
    try {
      if (typeof global.open === "function") { global.open(target, "_blank", "noopener"); return true; }
    } catch (_) { /* nothing else to try */ }
    return false;
  }

  function onClick(ev) {
    // Внутри Telegram -- родной переход в группу; вне Telegram оставляем стандартное поведение ссылки.
    const tg = global.Telegram && global.Telegram.WebApp;
    if (!tg || typeof tg.openTelegramLink !== "function") return;
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    open(URL_COMMUNITY);
  }

  function render(lang) {
    const doc = global.document;
    if (!doc || typeof doc.querySelectorAll !== "function") return 0;
    const l = lang || (doc.documentElement && doc.documentElement.lang) || "ru";
    const text = label(l);
    let n = 0;
    doc.querySelectorAll("[data-community-link]").forEach(function (a) {
      a.textContent = text;
      a.setAttribute("href", URL_COMMUNITY);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      if (!a.__communityBound) { a.__communityBound = true; a.addEventListener("click", onClick); }
      n++;
    });
    return n;
  }

  const api = Object.freeze({ URL: URL_COMMUNITY, LABELS, normalize, label, open, render });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.CommunityLink = api;
})(typeof window !== "undefined" ? window : globalThis);

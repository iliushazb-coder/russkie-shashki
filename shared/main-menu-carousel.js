// Главное меню: 3D-карусель флагов, название выбранных правил с короткой строкой (STEP J), счётчик «Кто играет?».
//
// ТОЛЬКО ПРЕДСТАВЛЕНИЕ. Модуль не знает ни про Firebase, ни про Worker, ни про игровые движки:
//   * «Играть» вызывает переданный колбэк onPlay(ruleset) -- в script.js это клик по существующей
//     кнопке выбора правил (showModeScreen("russian" | "italian")), то есть ровно прежний переход
//     на второе меню;
//   * состав и порядок десяти групп задаёт реестр shared/main-menu-registry.js; доступны только русские и итальянские, остальные восемь -- «Скоро», кнопка «Играть» заблокирована,
//     никаких игровых режимов для них не создаётся;
//   * число у «Кто играет?» выставляет ТОЛЬКО setPlayersCount(n) из подтверждённых данных;
//     пока такого вызова нет -- индикатор скрыт (выдуманный ноль не показывается).
// Анимация: только transform/opacity, цикл requestAnimationFrame работает лишь пока есть движение.
(function (global) {
  "use strict";

  const STEP = 0.62;                 // угол между соседними флагами на «колесе», рад
  const PX_PER_ITEM = 78;            // сколько пикселей свайпа = один флаг
  const TAP_SLOP = 7;                // сдвиг, после которого касание считается свайпом
  const SWIPE_STEP_MIN = 0.2;        // сколько «флага» нужно протянуть, чтобы свайп засчитался как шаг на соседнюю группу
  const SWIPE_FLICK_V = 1.2;         // или быстрый бросок: флагов в секунду (тогда хватает и короткого движения)
  const SWIPE_FLICK_MIN = 0.06;      // но не короче этого (дрожание пальца)
  const CARD_PX_PER_ITEM = 150;      // жест по карточке: сколько пикселей = одна группа (и на столько же сдвигается содержимое)
  const CLICK_SWALLOW_MS = 400;      // после свайпа по карточке настоящие клики по ней (в т.ч. по «Играть») гасятся
  // Доводка после отпускания пальца -- слегка недодемпфированная пружина: один небольшой перелёт цели и мягкий возврат, без качания.
  // Стартует со скоростью пальца (нет скачка скорости). omega -- «жёсткость» (рад/с), zeta -- затухание (1 = без перелёта; 0,62 = перелёт ≈ 8% пути).
  // Для подбора на телефоне (временно): адрес с ?spring=16,0.62 (omega,zeta); значения ограничены, чтобы нельзя было получить качание.
  const SPRING_OMEGA = 9;           // рад/с
  const SPRING_ZETA = 0.5;
  const OMEGA_MIN = 8, OMEGA_MAX = 40, ZETA_MIN = 0.45, ZETA_MAX = 1;
  const STEP_OVERSHOOT_MIN = 0.06;     // обычный свайп-шаг: гарантированный видимый перелёт цели (группы). На коротком свайпе пружине остаётся мало пути и перелёт был бы невидим -- при отпускании добавляется небольшой «бросок» скорости к цели ровно настолько, чтобы перелёт достиг этого значения
  const KICK_MAX = 6;                // предел добавки скорости (групп/с)
  const OVERSHOOT_MAX = 0.15;        // перелёт цели не больше этого (в группах), как бы далеко ни ехали и как бы быстро ни бросили
  const SPRING_MAX_S = 2.4;          // страховка: дольше анимация не длится
  const SPRING_EPS_X = 0.004;        // «пришли»: расстояние до цели, групп (≈0,4 px на экране -- глазом не видно; дальше -- точная посадка)
  const SPRING_EPS_V = 0.05;         // и скорость, групп/с
  const LONG_JUMP = 1.5;             // прыжок дальше стольких групп (тап по далёкому флагу): название меняется один раз, без промежуточных
  // B2R27: колесо во время жеста -- настоящее тело с состоянием (позиция + скорость): оно следует за пальцем критически демпфированной пружиной (без перелёта),
  // а скорость ограничена. Поэтому на отпускании скорость колеса -- его собственная, и пружина доводки принимает её без скачка (нет «стены»).
  const FOLLOW_OMEGA = 16;           // рад/с: жёсткость слежения за пальцем (отставание от пальца ≈ 2*v/omega)
  const FOLLOW_VMAX = 4;             // групп/с: ЖЁСТКИЙ предел скорости колеса под пальцем (один поворот на группу не быстрее ~250 мс)
  const FOLLOW_AMAX = 45;            // групп/с²: ЖЁСТКИЙ предел ускорения (4 групп/с набираются за ~90 мс -- нет рывка в начале жеста)
  const RUBBER_MAX = 0.25;           // «резинка»: на сколько групп сверх соседней можно протянуть (с нарастающим сопротивлением)
  const FAR_SLOW = 0.25;             // далёкая цель (тап по дальнему флагу): пружина медленнее в 1 + FAR_SLOW*(расстояние-1) раз, чтобы глаз успевал увидеть вращение

  // ---- флаги: простые инлайн-SVG (не emoji: одинаково выглядят на всех телефонах) ----
  // Состав групп (какие флаги в каком круге) задаёт реестр shared/main-menu-registry.js; здесь -- только картинки по коду страны.
  // Круг группы -- одна кнопка и ведёт в ОДИН режим (или «Скоро»). Флаги группы -- иллюстрация, не утверждение о правилах.
  // ---- флаги: картинки лежат в shared/flag-icons.js (FlagIcons); здесь -- только раскладка флагов группы по кругу ----
  function flagSvg(code) { return global.FlagIcons ? global.FlagIcons.svg(code) : ""; }
  function mini(code) { return global.FlagIcons ? global.FlagIcons.mini(code) : ""; }

  // Круг группы: один флаг -- на весь круг; два -- диагональные половинки; три и больше -- главный по центру и спутники по кругу.
  function groupFlagHtml(g) {
    const f = g.flags;
    if (f.length <= 1) return flagSvg(f[0]);
    if (f.length === 2) {
      return '<span class="mm-pair" aria-hidden="true"><i class="mm-pair-a">' + flagSvg(f[0]) + '</i><i class="mm-pair-b">' + flagSvg(f[1]) + "</i></span>";
    }
    const sats = f.slice(1);
    let h = '<span class="mm-mosaic" aria-hidden="true">';
    sats.forEach(function (code, k) {
      const a = (-90 + (360 / sats.length) * k) * Math.PI / 180;
      h += '<i class="mm-m-sat" style="left:' + (50 + 35 * Math.cos(a) - 13).toFixed(1) + '%;top:' + (50 + 35 * Math.sin(a) - 13).toFixed(1) + '%">' + (mini(code) || flagSvg(code)) + "</i>";
    });
    return h + '<i class="mm-m-main">' + (mini(f[0]) || flagSvg(f[0])) + "</i></span>";
  }

  // Порядок и состав -- из реестра (утверждённый список из десяти групп). ruleset -- то, что понимает showModeScreen().
  // Реестр проверяется ЯВНО при init(): если его нет или он повреждён, меню не строится, «Играть» заблокирована и никуда не ведёт,
  // ошибка видна (в карточке и в консоли) и не маскируется пустой каруселью. Молчаливых запасных значений нет.
  let COUNTRIES = Object.freeze([]);
  let N = 0;
  const PLAYABLE_RULESETS = { russian: 1, italian: 1 };   // единственные режимы, которые понимает showModeScreen()
  const BOARDS = { classic: 1, turkish: 1 };
  const MAX_GROUPS = 24;

  // Возвращает { ok: true, groups } или { ok: false, error: "код причины" }. Ничего не исправляет и не подставляет.
  function validateRegistry(reg) {
    if (!reg || typeof reg !== "object") return { ok: false, error: "registry_missing" };
    const g = reg.GROUPS;
    if (!Array.isArray(g) || g.length < 1 || g.length > MAX_GROUPS) return { ok: false, error: "registry_groups_invalid" };
    const seen = {};
    for (let i = 0; i < g.length; i++) {
      const x = g[i];
      if (!x || typeof x !== "object") return { ok: false, error: "group_not_object:" + i };
      if (typeof x.id !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(x.id)) return { ok: false, error: "group_id_invalid:" + i };
      if (Object.prototype.hasOwnProperty.call(seen, x.id)) return { ok: false, error: "group_id_duplicate:" + x.id };
      seen[x.id] = 1;
      if (typeof x.available !== "boolean") return { ok: false, error: "group_available_invalid:" + x.id };
      if (x.ruleset !== null && !(typeof x.ruleset === "string" && Object.prototype.hasOwnProperty.call(PLAYABLE_RULESETS, x.ruleset))) return { ok: false, error: "group_ruleset_invalid:" + x.id };
      // играбельна ровно та группа, у которой есть известный режим: нельзя «Играть» без режима и нельзя режим у «Скоро»
      if (x.available !== (x.ruleset !== null)) return { ok: false, error: "group_playable_mismatch:" + x.id };
      if (!Object.prototype.hasOwnProperty.call(BOARDS, x.board)) return { ok: false, error: "group_board_invalid:" + x.id };
      if (!Array.isArray(x.flags) || x.flags.length < 1 || x.flags.length > 8) return { ok: false, error: "group_flags_invalid:" + x.id };
      for (let k = 0; k < x.flags.length; k++) {
        if (typeof x.flags[k] !== "string" || !flagSvg(x.flags[k])) return { ok: false, error: "group_flag_unknown:" + x.id };
      }
    }
    return { ok: true, groups: g };
  }

  const clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  const mod = function (v, n) { return ((v % n) + n) % n; };
  const reducedMotion = function () {
    try { return !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch (e) { return false; }
  };

  // ---- временный замер плавности (ТОЛЬКО по адресу с ?mmfps=1; без параметра -- ни кода в кадре, ни нагрузки) ----
  // Пишет интервалы между кадрами карусели во время движения (палец или доводка) и задержку «последнее движение пальца -> кадр».
  // Показывает: p50 / p95 / p99 / max, долю кадров дольше 20 мс и 33 мс, число кадров. Сброс -- тап по плашке.
  const M = (function () {
    let on = false;
    try { on = /[?&]mmfps=1(?:&|$)/.test(global.location.search); } catch (_) {}
    if (!on) return null;
    const m = { dts: [], lats: [], prev: 0, moveT: 0, box: null, shown: 0 };
    const pct = function (a, q) { if (!a.length) return 0; const b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };
    const f1 = function (v) { return v.toFixed(1); };
    m.move = function (t) { m.moveT = t; };
    m.frame = function (moving) {
      const now = global.performance.now();
      if (!moving) { m.prev = 0; return; }
      if (m.prev && now - m.prev < 120) { m.dts.push(now - m.prev); if (m.dts.length > 3000) m.dts.shift(); }
      m.prev = now;
      if (m.moveT) { m.lats.push(now - m.moveT); if (m.lats.length > 3000) m.lats.shift(); m.moveT = 0; }
      if (now - m.shown > 500) { m.shown = now; m.show(); }
    };
    m.show = function () {
      if (!m.box) {
        const b = global.document.createElement("div");
        b.style.cssText = "position:fixed;left:4px;top:4px;z-index:99999;padding:4px 6px;background:rgba(0,0,0,.75);color:#9f9;font:11px/1.3 monospace;white-space:pre;border-radius:4px;";
        b.addEventListener("pointerdown", function (e) { e.stopPropagation(); m.dts = []; m.lats = []; m.show(); });
        global.document.body.appendChild(b); m.box = b;
      }
      const d = m.dts, n = d.length;
      let o20 = 0, o33 = 0;
      for (let i = 0; i < n; i++) { if (d[i] > 20) o20++; if (d[i] > 33.4) o33++; }
      m.box.textContent = "кадров " + n + "  >20мс " + (n ? Math.round(100 * o20 / n) : 0) + "%  >33мс " + (n ? Math.round(100 * o33 / n) : 0) + "%\n" +
        "dt p50 " + f1(pct(d, .5)) + "  p95 " + f1(pct(d, .95)) + "  p99 " + f1(pct(d, .99)) + "  max " + f1(pct(d, 1)) + " мс\n" +
        "задержка пальца p50 " + f1(pct(m.lats, .5)) + "  p95 " + f1(pct(m.lats, .95)) + " мс  (тап = сброс)";
    };
    return m;
  })();

  // Настройка пружины из адреса (?spring=omega,zeta) -- только для подбора; без параметра -- значения по умолчанию.
  const SPRING = (function () {
    const r = { w: SPRING_OMEGA, z: SPRING_ZETA };
    try {
      const m = /[?&]spring=([0-9.]+),([0-9.]+)(?:&|$)/.exec(global.location.search);
      if (m) {
        const w = parseFloat(m[1]), z = parseFloat(m[2]);
        if (isFinite(w)) r.w = clamp(w, OMEGA_MIN, OMEGA_MAX);
        if (isFinite(z)) r.z = clamp(z, ZETA_MIN, ZETA_MAX);
      }
    } catch (_) {}
    return r;
  })();

  const S = {
    inited: false, opts: null, root: null, track: null, dots: [], slots: [], labels: [], flags: [],
    card: null, cardView: null, cardOff: false, swallowUntil: 0, cardTitle: null, cardChip: null, cardSub: null, play: null,
    badge: null, error: null, pos: 0, vel: 0, animRaf: 0, dragRaf: 0, ljShown: -1, idx: -1, width: 0, size: 96, dirty: true, raf: 0, anim: null, drag: null, cache: [], tgLocked: false, tgTimer: 0
  };

  function T(key) { return (S.opts && S.opts.t) ? S.opts.t(key) : key; }

  // ---- геометрия и кадр ----
  function measure() {
    const w = S.track.clientWidth;
    if (!w) return false;
    S.width = w;
    S.size = clamp(Math.round(w * 0.29), 84, 112);
    S.track.style.setProperty("--mm-size", S.size + "px");
    S.track.style.height = (S.size + 60) + "px";
    S.dirty = false;
    return true;
  }

  // Все записи в style идут через кэш последнего значения: кадр, в котором у элемента ничего не изменилось, не трогает DOM (меньше пересчётов стилей на слабых телефонах);
  // невидимые флаги (за краем «колеса») не обновляются вообще.
  function render() {
    S.raf = 0;
    if (M) M.frame(!!S.anim || !!(S.drag && S.drag.moved));
    if ((S.dirty || !S.width) && !measure()) return; // меню скрыто: нечего рисовать
    const R = Math.min(172, S.width * 0.475);
    const size = S.size;
    for (let i = 0; i < N; i++) {
      let d = i - S.pos;
      d -= N * Math.round(d / N);                    // кратчайшее расстояние по кругу, [-N/2, N/2]
      const a = d * STEP, c = Math.cos(a), front = c > 0 ? c : 0;
      const op = clamp((c - 0.04) / 0.4, 0, 1);
      const slot = S.slots[i];
      const C = S.cache[i] || (S.cache[i] = {});
      if (op === 0) {
        if (C.vis !== "hidden") { slot.style.visibility = "hidden"; C.vis = "hidden"; }
        continue;
      }
      const sc = 0.34 + 0.66 * front * front * front;
      const x = Math.sin(a) * R;
      const ad = Math.abs(d);
      const focus = ad >= 1 ? 0 : 1 - ad;
      const tx = "translate3d(" + x.toFixed(1) + "px,0,0)";
      if (C.tx !== tx) { slot.style.transform = tx; C.tx = tx; }
      const z = String(100 + Math.round(front * 100));
      if (C.z !== z) { slot.style.zIndex = z; C.z = z; }
      if (C.vis !== "visible") { slot.style.visibility = "visible"; C.vis = "visible"; }
      const ft = "perspective(520px) rotateY(" + (-Math.sin(a) * 34).toFixed(1) + "deg) scale(" + sc.toFixed(3) + ")";
      if (C.ft !== ft) { S.flags[i].style.transform = ft; C.ft = ft; }
      const fo = op.toFixed(2);
      if (C.fo !== fo) { S.flags[i].style.opacity = fo; C.fo = fo; }
      const fc = focus.toFixed(2);
      if (C.fc !== fc) { S.flags[i].style.setProperty("--mm-focus", fc); C.fc = fc; }
      const lab = S.labels[i];
      const lo = ad <= 1 ? 1 - 0.25 * ad : Math.max(0, 0.75 - (ad - 1) * 1.5);
      const lop = (lo * op).toFixed(2);
      if (C.lo !== lop) { lab.style.opacity = lop; C.lo = lop; }
      const lt = "translate3d(0," + (-(size * (1 - sc)) / 2).toFixed(1) + "px,0)";
      if (C.lt !== lt) { lab.style.transform = lt; C.lt = lt; }
    }
    // Прыжок через несколько групп (тап по далёкому флагу): название не мелькает промежуточными -- см. cardLongJump
    const lj = S.anim && Math.abs(S.anim.to - S.anim.from) > LONG_JUMP ? S.anim : null;
    if (lj) cardLongJump(lj);
    else {
      if (S.ljShown >= 0) { S.ljShown = -1; fillCard(false); }   // прыжок кончился (или прерван): карточка -- выбранной группы
      applyCardOffset(S.pos - Math.round(S.pos));
    }
    const idx = mod(Math.round(S.pos), N);
    if (idx !== S.idx) selectIndex(idx, !!lj);
  }

  // Длинный прыжок: исходное название гаснет (сдвиг/затухание как обычно), посередине карточка скрыта, у цели новое название появляется.
  // Текст подменяется только в «невидимых» зонах (|сдвиг| = 0,5 -- прозрачность 0), промежуточные группы на карточку не попадают.
  function cardLongJump(a) {
    const v = S.cardView;
    if (!v) return;
    const dF = S.pos - a.from, dT = S.pos - a.to;
    let e, show;
    if (Math.abs(dF) < 0.5) { e = dF; show = mod(Math.round(a.from), N); }
    else if (Math.abs(dT) < 0.5) { e = dT; show = mod(Math.round(a.to), N); }
    else { v.style.opacity = "0"; S.cardOff = true; return; }
    if (S.ljShown !== show) { fillCard(false, show); S.ljShown = show; }
    v.style.transform = "translate3d(" + (-e * CARD_PX_PER_ITEM).toFixed(1) + "px,0,0)";
    v.style.opacity = (1 - Math.pow(Math.min(1, 2 * Math.abs(e)), 1.6)).toFixed(3);
    S.cardOff = true;
  }

  // Содержимое карточки идёт за той же позицией S.pos, что и флаги (тот же кадр): сдвиг -e*150 px и затухание до 0 в точке
  // e = ±0.5, где как раз и меняется выбранная группа (текст подменяется, пока он невидим). В покое -- без transform/opacity.
  function applyCardOffset(e) {
    const v = S.cardView;
    if (!v) return;
    const a = Math.abs(e);
    if (a < 0.002 || reducedMotion()) {
      if (S.cardOff) { v.style.transform = ""; v.style.opacity = ""; S.cardOff = false; }
      return;
    }
    v.style.transform = "translate3d(" + (-e * CARD_PX_PER_ITEM).toFixed(1) + "px,0,0)";
    v.style.opacity = (1 - Math.pow(Math.min(1, 2 * a), 1.6)).toFixed(3);
    S.cardOff = true;
  }

  // Карточка «не осела»: идёт анимация, палец на экране или содержимое сдвинуто -- «Играть» в этот момент не срабатывает.
  function cardUnsettled() {
    return !!S.anim || !!(S.drag && S.drag.moved) || Math.abs(S.pos - Math.round(S.pos)) > 0.02;
  }

  function schedule() {
    if (S.raf) return;
    S.raf = global.requestAnimationFrame ? global.requestAnimationFrame(render) : setTimeout(render, 16);
  }

  // ---- выбор, карточка, точки ----
  function selectIndex(idx, quietText) {
    S.idx = idx;
    for (let i = 0; i < N; i++) {
      const on = i === idx;
      S.dots[i].classList.toggle("mm-dot-on", on);
      S.slots[i].classList.toggle("mm-slot-focus", on);
      S.flags[i].setAttribute("aria-current", on ? "true" : "false");
      S.flags[i].tabIndex = on ? 0 : -1;
    }
    if (!quietText) fillCard(true);
  }

  // Название всегда в одну строку: если не влезает по ширине (длинные «Испанские / португальские шашки» на узком экране), шрифт уменьшается шагами
  // до нужного. Высота строки задана в CSS в пикселях, поэтому блок не меняет размер. Скрытое меню (ширина 0) не трогаем: ResizeObserver подгонит, когда оно появится.
  const TITLE_MIN_PX = 13;
  function fitTitle() {
    const el = S.cardTitle;
    if (!el) return;
    el.style.fontSize = "";
    if (!el.clientWidth) return;
    let px = parseFloat(global.getComputedStyle(el).fontSize) || 20;
    while (el.scrollWidth > el.clientWidth && px > TITLE_MIN_PX) { px -= 0.5; el.style.fontSize = px + "px"; }
  }

  // B2R26: строка под названием -- всегда одна строка (высота зоны задана в CSS и не зависит от текста): если не влезает по ширине, шрифт уменьшается шагами.
  const SUB_MIN_PX = 10;
  function fitSub() {
    const el = S.cardSub;
    if (!el) return;
    el.style.fontSize = "";
    if (!el.clientWidth) return;
    let px = parseFloat(global.getComputedStyle(el).fontSize) || 14;
    while (el.scrollWidth > el.clientWidth && px > SUB_MIN_PX) { px -= 0.5; el.style.fontSize = px + "px"; }
  }

  // Название в две ровные строки (дизайн B2R1): режем по пробелу ближе к середине (не оставляя «/» в начале второй строки). Текст целиком не меняется:
  // между строками обычный пробел, поэтому textContent прежний. Одно слово -- одна строка.
  function setCardTitle(el, text) {
    el.textContent = "";
    const words = String(text).split(" ");
    let best = -1, bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      if (words[i] === "/") continue;
      const diff = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    const doc = el.ownerDocument;
    const parts = best < 0 ? [String(text)] : [words.slice(0, best).join(" "), words.slice(best).join(" ")];
    parts.forEach(function (t, k) {
      if (k) el.appendChild(doc.createTextNode(" "));
      const span = doc.createElement("span");
      span.textContent = t;
      el.appendChild(span);
    });
  }

  // Карточка: название + одна короткая строка «правила · 8×8». «Скоро» -- неброская пометка под строкой (место занято всегда, высота не меняется);
  // доска, страны и длинные описания в интерфейс больше не выводятся.
  function fillCard(animate, forceIdx) {
    if (S.idx < 0) return;
    const c = COUNTRIES[forceIdx >= 0 ? forceIdx : S.idx];
    setCardTitle(S.cardTitle, T("mm_n_" + c.id));
    fitTitle();
    S.cardSub.textContent = T("mm_s_" + c.id);
    fitSub();
    S.cardChip.textContent = T("mm_chip_soon");
    S.cardChip.hidden = c.available;
    S.play.disabled = !c.available;
    S.play.setAttribute("aria-disabled", c.available ? "false" : "true");
    S.card.setAttribute("data-country", c.id);
    S.card.setAttribute("data-available", c.available ? "1" : "0");
    // Появление новой карточки теперь делает сдвиг/затухание содержимого в render().
  }

  function refreshText() {
    if (S.error) { const n = global.document && global.document.getElementById("mm-card-sub"); if (n) n.textContent = T("mm_registry_error"); return; }
    if (!S.inited) return;
    S.track.setAttribute("aria-label", T("mm_aria_carousel"));
    for (let i = 0; i < N; i++) {
      const c = COUNTRIES[i];
      S.labels[i].textContent = T("mm_c_" + c.id);
      S.flags[i].setAttribute("aria-label", T("mm_c_" + c.id) + " — " + T("mm_n_" + c.id) + ", " + T(c.available ? "mm_chip_ok" : "mm_chip_soon"));
    }
    fillCard(false);
  }

  // ---- движение: свайп, инерция, фиксация по центру ----
  function cancelFrame(id) { if (id && global.cancelAnimationFrame) global.cancelAnimationFrame(id); }

  // Остановить доводку (новое касание, прыжок на группу): единственный цикл кадров снимается, скорость обнуляется.
  function stopAnim() {
    S.anim = null; S.vel = 0;
    if (S.animRaf) { cancelFrame(S.animRaf); S.animRaf = 0; }
  }

  // Пружина, аналитическое решение (не зависит от частоты кадров 60/90/120 Гц). A = from - to, v0 -- скорость пальца (групп/с, + = к росту S.pos).
  //   z < 1:  x(t) = e^{-c t} (A cos(wd t) + ((v0 + c A) / wd) sin(wd t)),  c = z w,  wd = w sqrt(1 - z^2)   (x -- отклонение от цели)
  //   z = 1:  x(t) = (A + (v0 + w A) t) e^{-w t}  (критическое затухание, без перелёта)
  function springAt(P, t) {
    const e = Math.exp(-P.c * t);
    if (P.wd === 0) {
      const B = P.v0 + P.w * P.A, x = P.A + B * t;
      return { x: x * e, v: (B - P.w * x) * e };
    }
    const co = Math.cos(P.wd * t), si = Math.sin(P.wd * t);
    return { x: e * (P.A * co + ((P.v0 + P.c * P.A) / P.wd) * si), v: e * (P.v0 * co - ((P.c * P.v0 + P.w * P.w * P.A) / P.wd) * si) };
  }
  // Наибольший перелёт цели (в группах, >= 0) за время анимации: по сетке 10 мс. Считается один раз при запуске доводки.
  function springOvershoot(P) {
    const dir = P.A !== 0 ? (P.A < 0 ? 1 : -1) : (P.v0 >= 0 ? 1 : -1);   // направление движения к цели
    let m = 0;
    for (let t = 0.01; t <= 2.4; t += 0.01) { const o = dir * springAt(P, t).x; if (o > m) m = o; }
    return m;
  }
  function springParams(A, v0, floor) {
    const aa0 = Math.abs(A);
    let w = SPRING.w / (1 + FAR_SLOW * Math.max(0, aa0 - 1)), z = SPRING.z;
    // Далёкая цель (тап по дальнему флагу): перелёт 8% от трёх групп был бы заметен -- поднимаем затухание ровно настолько, чтобы перелёт = OVERSHOOT_MAX
    const aa = Math.abs(A);
    if (z < 1 && aa > 1e-9) {
      const nat = aa * Math.exp(-Math.PI * z / Math.sqrt(1 - z * z));
      if (nat > OVERSHOOT_MAX) { const k = -Math.log(OVERSHOOT_MAX / aa); z = Math.min(1, k / Math.sqrt(Math.PI * Math.PI + k * k)); }
    }
    const mkP = function (zz, vv) { const q = { w: w, z: zz, c: zz * w, wd: zz < 0.999 ? w * Math.sqrt(1 - zz * zz) : 0, A: A, v0: vv }; if (q.wd === 0) q.c = w; return q; };
    let P = mkP(z, v0);
    if (P.wd === 0) {                                      // критическое затухание (zeta = 1): перелёта нет вовсе -- скорость к цели ограничена w|A|
      P.c = w;
      const lim = w * aa, toward = A < 0 ? 1 : -1;
      if (aa > 1e-9 && P.v0 * toward > lim) P.v0 = toward * lim;
    }
    // B2R27: перелёт при унаследованной скорости больше предела -- СНАЧАЛА усиливаем затухание (скорость колеса не трогаем: на отпускании нет скачка скорости),
    // и только если даже критическое затухание не укладывается (скорость к цели больше w*|A|), скорость уменьшается ниже.
    if (P.v0 !== 0 && P.wd !== 0 && springOvershoot(P) > OVERSHOOT_MAX) {
      const Q = mkP(1, P.v0);
      if (springOvershoot(Q) <= OVERSHOOT_MAX) {
        let lo = P.z, hi = 1;
        for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (springOvershoot(mkP(m, P.v0)) > OVERSHOOT_MAX) lo = m; else hi = m; }
        P = mkP(hi, P.v0);
      } else P = Q;
    }
    // Бросок: скорость пальца не должна дать перелёт больше предела -- уменьшаем её (бинарно), пока перелёт не уложится
    if (P.v0 !== 0 && springOvershoot(P) > OVERSHOOT_MAX) {
      let lo = 0, hi = 1;
      const v = P.v0;
      for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; P.v0 = v * m; if (springOvershoot(P) > OVERSHOOT_MAX) hi = m; else lo = m; }
      P.v0 = v * lo;
    }
    // Короткий свайп: перелёт ниже заданного минимума -- добавляем скорость к цели (минимально необходимую), чтобы перелёт стал виден
    // (если колесо уже движется ОТ цели, добавка скорости к цели развернула бы его скачком -- такой случай её не получает)
    if (floor > 0 && P.wd !== 0 && A !== 0 && P.v0 * (A < 0 ? 1 : -1) >= 0 && springOvershoot(P) < floor) {
      const dir = A !== 0 ? (A < 0 ? 1 : -1) : (P.v0 >= 0 ? 1 : -1), base = P.v0;
      let lo = 0, hi = KICK_MAX;
      for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; P.v0 = base + dir * m; if (springOvershoot(P) < floor) lo = m; else hi = m; }
      P.v0 = base + dir * hi;
      if (springOvershoot(P) > OVERSHOOT_MAX) P.v0 = base + dir * lo;
    }
    return P;
  }

  // Если доводка уже идёт, новая цель наследует текущую позицию и скорость (быстрые повторные шаги не дёргаются).
  function animateTo(target, ms, v0, floor) {
    if (reducedMotion() || !ms) { stopAnim(); S.pos = target; schedule(); return; }
    const A = S.pos - target;
    const v = typeof v0 === "number" && isFinite(v0) ? v0 : (S.anim ? S.vel : 0);
    const P = springParams(A, v, floor || 0);
    if (S.animRaf) { cancelFrame(S.animRaf); S.animRaf = 0; }   // ровно один активный цикл кадров
    S.anim = { from: S.pos, to: target, P: P, t0: 0 };
    S.vel = P.v0;
    const a0 = S.anim;
    const tick = function (now) {
      const a = S.anim;
      if (!a || a !== a0) return;                           // цель сменилась или остановлено: этот цикл не нужен
      S.animRaf = 0;
      if (!a.t0) a.t0 = now;
      const t = Math.min(SPRING_MAX_S, Math.max(0, (now - a.t0) / 1000));
      const st = springAt(a.P, t);
      S.pos = a.to + st.x;
      S.vel = st.v;
      if (S.raf) { cancelFrame(S.raf); S.raf = 0; }         // кадр рисуем здесь же: второй (от schedule) не нужен
      if (t >= SPRING_MAX_S || (Math.abs(st.x) < SPRING_EPS_X && Math.abs(st.v) < SPRING_EPS_V)) {
        S.anim = null; S.vel = 0; S.pos = mod(a.to, N); render();
        return;
      }
      render();
      S.animRaf = global.requestAnimationFrame(tick);
    };
    S.animRaf = global.requestAnimationFrame(tick);
  }

  function goTo(i, ms) {            // по кругу, кратчайшим путём
    const cur = Math.round(S.pos);
    let delta = mod(i, N) - mod(cur, N);
    if (delta > N / 2) delta -= N;
    if (delta < -N / 2) delta += N;
    if (delta === 0) { animateTo(cur, 160); return; }
    animateTo(cur + delta, ms || 360);
  }

  // Жест прерван / тап в момент анимации: позиция могла остаться дробной -- возвращаем к ближайшей группе.
  function settle() {
    const r = Math.round(S.pos);
    if (Math.abs(S.pos - r) > 0.001) goTo(r, 200);
  }

  // Telegram (Bot API 7.7+): вертикальный «свайп вниз» сворачивает/сдвигает всё окно мини-приложения. На время жеста по карусели его отключаем,
  // чтобы нижняя часть экрана не уезжала за пальцем; после жеста возвращаем как было. Старые клиенты и обычный браузер -- ничего не делаем.
  function tgSwipes(lock) {
    if (S.tgLocked === lock) return;
    try {
      const w = global.Telegram && global.Telegram.WebApp;
      if (!w || (typeof w.isVersionAtLeast === "function" && !w.isVersionAtLeast("7.7"))) return;
      const f = lock ? w.disableVerticalSwipes : w.enableVerticalSwipes;
      if (typeof f === "function") { f.call(w); S.tgLocked = lock; }
    } catch (_) {}
  }

  // Страховка: блокировка свайпов Telegram не должна пережить жест. Если сигналы окончания жеста не пришли (палец увели за экран, окно свёрнуто,
  // меню скрыли во время касания), через 3 с без событий указателя вертикальные свайпы возвращаются сами; новое движение блокирует их снова.
  const TG_WATCHDOG_MS = 3000;
  function tgWatch() {
    if (S.tgTimer) global.clearTimeout(S.tgTimer);
    S.tgTimer = global.setTimeout(function () { S.tgTimer = 0; tgSwipes(false); }, TG_WATCHDOG_MS);
  }
  function endDrag() {
    S.drag = null;
    if (S.dragRaf) { cancelFrame(S.dragRaf); S.dragRaf = 0; }
    if (S.tgTimer) { global.clearTimeout(S.tgTimer); S.tgTimer = 0; }
    tgSwipes(false);
  }

  // Принудительное завершение жеста (потеря захвата указателя, скрытие страницы/меню, новое касание поверх старого):
  // отпускаем захват, возвращаем вертикальные свайпы Telegram и доводим карусель к стартовой группе -- без шага.
  function abortDrag() {
    const d = S.drag;
    endDrag();
    if (!d) return;
    try { d.el.releasePointerCapture(d.id); } catch (_) {}
    if (d.moved) animateTo(d.base, 220); else settle();
  }

  function menuShown() {
    const m = S.root && S.root.closest ? S.root.closest("#menu-screen") : null;
    return !!(m && !m.classList.contains("hidden") && S.root.getClientRects().length);
  }

  // Захват потерян посреди жеста (не после нашего же pointerup -- тогда S.drag уже пуст): жест прерван системой.
  function onLostCapture(e) {
    const d = S.drag;
    // Событие всплывает: касание сначала неявно захватывается кнопкой («Играть»/флаг), потом захват переходит к нам -- это lostpointercapture на кнопке, не потеря жеста.
    // Потерей считается только событие на самом элементе, который держал захват (d.el).
    if (d && e.pointerId === d.id && e.target === d.el) abortDrag();
  }
  // Указатель закончился вне карусели (палец увели с карточки до порога свайпа и отпустили в другом месте).
  function onDocPointerEnd(e) {
    const d = S.drag;
    if (d && e.pointerId === d.id) onUp(e);
  }

  function onDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const onCard = e.currentTarget === S.card;
    if (onCard && S.error) return;
    if (S.drag) abortDrag();                              // второе касание поверх незавершённого: старый жест закрываем целиком
    const keepV = S.anim ? S.vel : 0;                       // палец поймал колесо в движении: его скорость переходит в слежение (без остановки)
    stopAnim();
    S.vel = keepV;
    const slot = !onCard && e.target && e.target.closest ? e.target.closest("[data-i]") : null;
    S.swallowUntil = 0;
    // base -- группа, с которой начат жест (если палец лёг во время доводки, это ближайшая к текущей позиции): от неё свайп уводит не дальше чем на одну соседнюю
    S.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, pos0: S.pos, base: Math.round(S.pos), moved: false, x: 0, T: 0, ft: 0, slot: slot ? +slot.getAttribute("data-i") : -1, lastX: e.clientX, lastT: e.timeStamp, v: 0,
               card: onCard, el: onCard ? S.card : S.track, ppi: onCard ? CARD_PX_PER_ITEM : PX_PER_ITEM };
    S.drag.x = S.pos - S.drag.base; S.drag.T = S.pos;
    tgSwipes(true);
    tgWatch();
    // По флагам захватываем сразу (как раньше). По карточке -- только после порога: обычный тап по «Играть» остаётся обычным кликом.
    if (!onCard) { try { S.track.setPointerCapture(e.pointerId); } catch (_) {} }
  }

  // Цель под пальцем: до ±1 от стартовой группы -- как есть; сверх -- не больше RUBBER_MAX, плавно (экспонента), производная непрерывна в ±1.
  function rubber(o) {
    const a = o < 0 ? -o : o;
    if (a <= 1) return o;
    const x = 1 + RUBBER_MAX * (1 - Math.exp(-(a - 1) / RUBBER_MAX));
    return o < 0 ? -x : x;
  }
  // Слежение колеса за пальцем: точное (аналитическое) решение критически демпфированной пружины за шаг dt -- не зависит от частоты кадров.
  // e = позиция - цель, v = скорость. Пока пределы скорости и ускорения не достигнуты -- точное решение; иначе -- жёсткое ограничение (ниже).
  function dragTick(now) {
    S.dragRaf = 0;
    const d = S.drag;
    if (!d || !d.moved) return;
    const dt = d.ft ? Math.min(0.05, Math.max(0, (now - d.ft) / 1000)) : 0;
    d.ft = now;
    const w = FOLLOW_OMEGA, k = Math.exp(-w * dt);
    let e = S.pos - d.T, v = S.vel;
    const B = v + w * e;
    let e1 = (e + B * dt) * k, v1 = (v - w * B * dt) * k;          // идеальное слежение (критическое демпфирование)
    // строгие физические пределы колеса: ускорение и скорость. Пока они не достигнуты -- точное решение выше; иначе скорость меняется не быстрее FOLLOW_AMAX
    // и не превышает FOLLOW_VMAX, а смещение берётся из той же скорости -- ни скорость, ни смещение за кадр не выходят за предел.
    const dvMax = FOLLOW_AMAX * dt;
    if (Math.abs(v1 - v) > dvMax || Math.abs(v1) > FOLLOW_VMAX) {
      v1 = v + Math.max(-dvMax, Math.min(dvMax, v1 - v));
      v1 = Math.max(-FOLLOW_VMAX, Math.min(FOLLOW_VMAX, v1));
      e1 = e + 0.5 * (v + v1) * dt;
    }
    e = e1; v = v1;
    S.pos = d.T + e; S.vel = v;
    if (S.raf) { cancelFrame(S.raf); S.raf = 0; }
    render();
    S.dragRaf = global.requestAnimationFrame(dragTick);
  }

  function onMove(e) {
    const d = S.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!S.tgLocked) tgSwipes(true);                      // сторож мог снять блокировку, пока палец стоял: движение возобновилось
    tgWatch();
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < TAP_SLOP) {
      // по карточке: преимущественно вертикальное движение -- это прокрутка / жест Telegram, не наш (не держим, не захватываем)
      if (d.card && Math.abs(e.clientY - d.y0) >= TAP_SLOP) { endDrag(); settle(); }
      return;
    }
    if (!d.moved && d.card && Math.abs(e.clientY - d.y0) > Math.abs(dx)) { endDrag(); settle(); return; }
    if (!d.moved && d.card) { try { d.el.setPointerCapture(e.pointerId); } catch (_) {} }
    d.moved = true;
    if (M) M.move(e.timeStamp);
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) {
      const inst = -((e.clientX - d.lastX) / d.ppi) / (dt / 1000);
      d.v = d.v * 0.6 + inst * 0.4;
    }
    d.lastX = e.clientX; d.lastT = e.timeStamp;
    // Один свайп -- одна группа: дальше соседней от стартовой карусель не уходит; за границей -- «резинка» (нарастающее сопротивление, не жёсткая стенка)
    d.x = d.pos0 - d.base - dx / d.ppi;                    // путь пальца от стартовой группы (в группах)
    d.T = d.base + rubber(d.x);                            // цель слежения; саму позицию двигает dragTick
    if (!S.dragRaf) { d.ft = 0; S.dragRaf = global.requestAnimationFrame(dragTick); }
    schedule();
  }

  function onUp(e) {
    const d = S.drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    endDrag();
    try { d.el.releasePointerCapture(d.id); } catch (_) {}
    // Жест отобран системой (pointercancel) -- и по флагам, и по карточке/«Играть», двигался палец или нет: без шага, назад к стартовой группе. Клика после отмены не бывает.
    if (e && e.type === "pointercancel") {
      if (Math.abs(S.pos - d.base) > 0.001) animateTo(d.base, 220, S.vel); else schedule();
      return;
    }
    if (d.card) {
      if (!d.moved) { settle(); return; }                 // тап по карточке: ничего не двигаем (клик по «Играть» пройдёт); если прервали анимацию -- доводим до центра
      S.swallowUntil = Date.now() + CLICK_SWALLOW_MS;
    }
    if (!d.moved) {
      if (e && e.type === "pointerup" && d.slot >= 0) goTo(d.slot, 360);
      else goTo(Math.round(S.pos), 200);
      return;
    }
    // Решение по пройденному пути и скорости: шаг ровно на одну группу в сторону движения либо возврат к стартовой.
    const disp = d.x;                                    // путь пальца: решение шаг/возврат по нему
    const stale = e && e.timeStamp - d.lastT > 90;       // палец остановился перед отпусканием: броска нет
    const v = S.vel;                                     // скорость самого колеса (не пальца): пружина доводки принимает её как есть -- без скачка
    const fv = stale ? 0 : d.v;                          // скорость пальца -- только для решения «бросок»
    const dir = disp === 0 ? 0 : disp > 0 ? 1 : -1;
    const flick = Math.abs(fv) >= SWIPE_FLICK_V && Math.abs(disp) >= SWIPE_FLICK_MIN && (fv > 0 ? 1 : -1) === dir;
    const step = (Math.abs(disp) >= SWIPE_STEP_MIN || flick) ? dir : 0;
    const target = d.base + step;
    // При шаге -- видимый перелёт даже на коротком свайпе. Но если колесо под пальцем уже прошло цель (перелёт идёт сам), добавка скорости не нужна:
    // она развернула бы колесо на отпускании (баг, найденный при проверке B2R27: скорость +1,7 -> -1,6 групп/с за кадр).
    const passed = step !== 0 && (S.pos - target) * step > 0;
    animateTo(target, 1, v, step !== 0 && !passed ? STEP_OVERSHOOT_MIN : 0);
  }

  // Один шаг карусели. Если анимация ещё идёт, шаг считается от её конечной точки (а не от середины пути),
  // поэтому быстрые нажатия не «съедаются» и не проскакивают лишнего.
  function stepBy(dir) {
    const base = S.anim ? Math.round(S.anim.to) : Math.round(S.pos);
    goTo(base + dir, 300);
  }

  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;   // те же ограничения, что у onDocKey
    if (e.key === "ArrowLeft") { e.preventDefault(); stepBy(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stepBy(1); }
  }

  // ---- стрелки ← → на уровне страницы (фокус на кружке искать не нужно) ----
  function isTypingTarget(t) {
    if (!t || !t.tagName) return false;
    const tag = t.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    const r = t.getAttribute && t.getAttribute("role");
    return r === "slider" || r === "spinbutton" || r === "textbox";
  }

  // Меню с каруселью сейчас на экране и поверх него нет окна (диалога).
  function menuInteractive() {
    const doc = global.document;
    if (!doc || !S.root || !S.root.isConnected) return false;
    if (S.root.closest(".hidden") || !S.root.getClientRects().length) return false;
    return !doc.querySelector('.modal-overlay:not(.hidden), [aria-modal="true"]:not(.hidden)');
  }

  function onDocKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;   // кружок сам уже обработал / сочетания клавиш
    const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!dir || S.drag || S.error) return;
    if (isTypingTarget(e.target) || !menuInteractive()) return;
    if (e.repeat && S.anim) return;          // зажатая клавиша: не копим шаги, пока идёт анимация
    e.preventDefault();
    stepBy(dir);
  }

  // ---- колесо мыши и горизонтальный трекпад ----
  // Вниз / вправо -- следующий флаг, вверх / влево -- предыдущий. Обычное колесо: один «щелчок» = один шаг.
  // Трекпад шлёт десятки мелких событий и «хвост» инерции: считаем жест целиком, хвост шагов не добавляет.
  const WHEEL_LINE_PX = 33;          // deltaMode=1 (строки): одна строка в пикселях (3 строки ≈ щелчок колеса)
  const WHEEL_PAGE_PX = 400;         // deltaMode=2 (страницы)
  const WHEEL_THRESH = 40;           // накопленный сдвиг (px) для первого шага жеста
  const WHEEL_GAP_MS = 160;          // пауза между событиями, после которой начинается новый жест
  const WHEEL_MIN_MS = 100;          // не чаще одного шага за это время при любых условиях
  const WHEEL_NOTCH_MS = 200;        // следующий «щелчок» внутри того же жеста -- не раньше
  const WHEEL_REPEAT_MS = 260;       // длинный непрерывный свайп: следующий шаг не раньше
  const WHEEL_REPEAT_PX = 90;        // ... и после такого сдвига с прошлого шага
  const W = { dir: 0, acc: 0, lastT: 0, lastAbs: 0, peak: 0, stepped: false, lastStepT: -1e9, since: 0 };

  function wheelNow() { return global.performance && global.performance.now ? global.performance.now() : Date.now(); }

  function onWheel(e) {
    if (e.ctrlKey || S.error) return;                       // Ctrl+колесо = масштаб страницы браузера: не трогаем
    const k = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
    const dx = (e.deltaX || 0) * k, dy = (e.deltaY || 0) * k;
    const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;        // главная ось жеста
    if (!d || !isFinite(d)) return;
    if (S.drag) return;                                     // идёт перетаскивание: колесо игнорируем, стандартное поведение браузера не блокируем
    e.preventDefault();                                     // только над каруселью: страница под ней не прокручивается
    const now = wheelNow(), a = Math.abs(d), dir = d > 0 ? 1 : -1;
    if (dir !== W.dir || now - W.lastT > WHEEL_GAP_MS) { W.dir = dir; W.acc = 0; W.peak = 0; W.stepped = false; W.since = 0; W.lastAbs = 0; }
    const prev = W.lastAbs;
    W.lastT = now; W.lastAbs = a; W.peak = Math.max(W.peak, a); W.acc += a;
    if (now - W.lastStepT < WHEEL_MIN_MS) return;
    let go;
    if (!W.stepped) go = W.acc >= WHEEL_THRESH;
    else {
      W.since += a;
      go = (now - W.lastStepT >= WHEEL_NOTCH_MS && a >= WHEEL_THRESH && a >= prev) ||           // новый щелчок, а не затухающий хвост
           (now - W.lastStepT >= WHEEL_REPEAT_MS && W.since >= WHEEL_REPEAT_PX && a >= W.peak * 0.6);   // непрерывный свайп
    }
    if (go) { W.stepped = true; W.lastStepT = now; W.since = 0; stepBy(dir); }
  }

  // ---- сборка ----
  function el(tag, cls, html) {
    const n = global.document.createElement(tag);
    if (cls) n.className = cls;
    if (html) n.innerHTML = html;
    return n;
  }

  function build() {
    const doc = global.document;
    S.root = doc.getElementById("mm-carousel-root");
    S.card = doc.getElementById("mm-card");
    S.cardView = doc.getElementById("mm-card-view");
    S.cardTitle = doc.getElementById("mm-card-title");
    S.cardChip = doc.getElementById("mm-card-chip");
    S.cardSub = doc.getElementById("mm-card-sub");
    S.play = doc.getElementById("mm-play");
    S.badge = doc.getElementById("mm-who-count");
    const dots = doc.getElementById("mm-dots");
    if (!S.root || !S.card || !S.cardView || !S.cardTitle || !S.cardChip || !S.cardSub || !S.play || !dots) return false;
    S.track = el("div", "mm-track");
    S.track.setAttribute("role", "group");
    S.track.setAttribute("aria-roledescription", "carousel");
    for (let i = 0; i < N; i++) {
      const c = COUNTRIES[i];
      const slot = el("div", "mm-slot");
      slot.setAttribute("data-i", String(i));
      const flag = el("button", "mm-flag" + (c.available ? "" : " mm-flag-soon"));
      flag.type = "button";
      flag.setAttribute("data-flag", c.id);
      flag.innerHTML = '<span class="mm-disc">' + groupFlagHtml(c) + '</span><span class="mm-ring"></span><span class="mm-gloss"></span>';
      const lab = el("span", "mm-label");
      slot.appendChild(flag); slot.appendChild(lab);
      S.track.appendChild(slot);
      S.slots.push(slot); S.flags.push(flag); S.labels.push(lab);
      const dot = el("span", "mm-dot" + (c.available ? "" : " mm-dot-soon"));
      dots.appendChild(dot); S.dots.push(dot);
    }
    S.root.appendChild(S.track);
    return true;
  }

  // Отказ: ничего не строим, «Играть» заблокирована (обработчик не вешается), причина видна и записана.
  function failInit(code) {
    S.error = code;
    try { if (global.console && global.console.error) global.console.error("[main-menu] реестр групп отклонён: " + code); } catch (e) {}
    const doc = global.document;
    if (!doc) return false;
    const play = doc.getElementById("mm-play"), note = doc.getElementById("mm-card-sub"), card = doc.getElementById("mm-card");
    if (play) { play.disabled = true; play.setAttribute("aria-disabled", "true"); }
    if (card) { card.setAttribute("data-registry-error", "1"); card.setAttribute("data-available", "0"); }
    if (note) { note.textContent = T("mm_registry_error"); note.hidden = false; }
    return false;
  }

  function init(opts) {
    if (S.inited) return true;
    S.opts = opts || {};
    S.error = null;
    const v = validateRegistry(global.MainMenuRegistry);
    if (!v.ok) return failInit(v.error);
    COUNTRIES = v.groups; N = COUNTRIES.length;
    if (!global.document || !build()) return false;
    const initial = COUNTRIES.findIndex(function (c) { return c.id === S.opts.initialId; });
    S.pos = initial >= 0 ? initial : 0;
    S.inited = true;
    S.track.addEventListener("pointerdown", onDown);
    S.track.addEventListener("pointermove", onMove);
    S.track.addEventListener("pointerup", onUp);
    S.track.addEventListener("pointercancel", onUp);
    S.track.addEventListener("lostpointercapture", onLostCapture);
    S.track.addEventListener("keydown", onKey);
    if (S.card) {
      S.card.addEventListener("pointerdown", onDown);
      S.card.addEventListener("pointermove", onMove);
      S.card.addEventListener("pointerup", onUp);
      S.card.addEventListener("pointercancel", onUp);
      S.card.addEventListener("lostpointercapture", onLostCapture);
      // Настоящий клик (мышь/касание) вскоре после свайпа по карточке не должен дойти до «Играть». Клик с клавиатуры (detail 0) не трогаем.
      S.card.addEventListener("click", function (e) {
        if (e.detail !== 0 && S.swallowUntil && Date.now() < S.swallowUntil) { e.stopImmediatePropagation(); e.preventDefault(); }
      }, true);
    }
    // Колесо -- только над каруселью (passive:false, чтобы страница под ней не прокручивалась); стрелки -- на всей странице.
    (S.root || S.track).addEventListener("wheel", onWheel, { passive: false });
    global.document.addEventListener("keydown", onDocKey);
    // Гарантированное завершение жеста: конец/отмена указателя вне элементов карусели, потеря захвата, скрытие страницы или меню.
    global.document.addEventListener("pointerup", onDocPointerEnd);
    global.document.addEventListener("pointercancel", onDocPointerEnd);
    global.document.addEventListener("visibilitychange", function () { if (global.document.hidden) abortDrag(); });
    global.addEventListener("pagehide", abortDrag);
    global.addEventListener("blur", abortDrag);
    try {
      const menuEl = S.root.closest("#menu-screen");
      if (menuEl && global.MutationObserver) {
        new global.MutationObserver(function () { if ((S.drag || S.tgLocked) && !menuShown()) abortDrag(); }).observe(menuEl, { attributes: true, attributeFilter: ["class", "hidden", "style"] });
      }
    } catch (e) {}
    // Клавиатура / экранный диктор: click без указателя (detail === 0). Касание и мышь обрабатываются выше.
    S.track.addEventListener("click", function (e) {
      if (e.detail !== 0) return;
      const slot = e.target && e.target.closest ? e.target.closest("[data-i]") : null;
      if (slot) goTo(+slot.getAttribute("data-i"), 320);
    });
    S.play.addEventListener("click", function () {
      if (cardUnsettled()) return;                       // карточка в движении: не запускаем то, что сейчас не видно целиком
      const c = COUNTRIES[S.idx];
      if (!c || !c.available || !c.ruleset || typeof S.opts.onPlay !== "function") return;
      S.opts.onPlay(c.ruleset);
    });
    if (global.ResizeObserver) {
      try { new global.ResizeObserver(function () { S.dirty = true; schedule(); }).observe(S.track); } catch (e) {}
    }
    global.addEventListener("resize", function () { S.dirty = true; schedule(); fitTitle(); fitSub(); });
    if (global.ResizeObserver && S.card) {
      try { new global.ResizeObserver(function () { fitTitle(); fitSub(); }).observe(S.card); } catch (e) {}
    }
    refreshText();
    selectIndex(mod(Math.round(S.pos), N));
    refreshText();
    schedule();
    return true;
  }

  // Число игроков -- только из подтверждённых данных. Не целое / меньше 1 / нет данных -> индикатор скрыт.
  function setPlayersCount(n) {
    if (!S.badge) S.badge = global.document && global.document.getElementById("mm-who-count");
    if (!S.badge) return;
    if (typeof n === "number" && isFinite(n) && n >= 1 && Math.floor(n) === n) {
      S.badge.textContent = n > 99 ? "99+" : String(n);
      S.badge.hidden = false;
    } else {
      S.badge.textContent = "";
      S.badge.hidden = true;
    }
  }

  function select(id, instant) {
    const i = COUNTRIES.findIndex(function (c) { return c.id === id; });
    if (i < 0 || !S.inited) return false;
    stopAnim();
    if (instant) { S.pos = i; render(); } else goTo(i, 320);
    return true;
  }

  function getState() {
    return { error: S.error, index: S.idx, id: S.idx >= 0 ? COUNTRIES[S.idx].id : null, pos: S.pos, vel: S.vel, count: N, ids: COUNTRIES.map(function (c) { return c.id; }) };
  }

  global.MainMenuCarousel = Object.freeze({ init: init, refreshText: refreshText, setPlayersCount: setPlayersCount, select: select, getState: getState, get COUNTRIES() { return COUNTRIES; } });
})(typeof window !== "undefined" ? window : globalThis);

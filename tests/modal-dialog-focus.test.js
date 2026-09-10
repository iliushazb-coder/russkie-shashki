// №42-B1: role=dialog/aria-modal + focus management для четырёх ЛОКАЛЬНЫХ
// confirm-модалок (resign-confirm, back-confirm, bot-difficulty,
// continue-or-new). Асинхронные/remote-управляемые модалки (draw-offer,
// rematch-request, end-game, opponent-left, spectator-interrupted),
// вложенная пара (stats-modal/bot-details-modal), недостижимая
// offline-opponent-modal, info-modal, board keyboard, aria-live,
// aria-pressed -- сознательно вне этого среза (№42-B2 или отдельные пункты).

const fs = require('fs');
const path = require('path');
const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const B1_MODALS = ['resign-confirm-modal', 'back-confirm-modal', 'bot-difficulty-modal', 'continue-or-new-modal'];
// review fix (№42-B2a): 4 из 9 B2-кандидатов теперь реализованы --
// draw-offer/rematch-request/end-game/spectator-interrupted. Guard "role=
// dialog ещё не появился" для них корректно устарел (см. секцию 1b ниже,
// которая теперь проверяет обратное). opponent-left-modal и
// offline-opponent-modal остаются вне scope дольше -- недостижимы из UI
// (dead-markup follow-up, не B2), info-modal/stats-modal/bot-details-modal
// -- B2c/B2b, ещё не начаты.
// review fix (№42-B2b): stats-modal/bot-details-modal теперь тоже
// реализованы. opponent-left-modal/offline-opponent-modal остаются
// недостижимы (dead-markup follow-up), info-modal -- B2c, ещё не начат.
const B2_DONE_MODALS = ['draw-offer-modal', 'rematch-request-modal', 'end-game-modal', 'spectator-interrupted-modal',
  'stats-modal', 'bot-details-modal'];
const B2_STILL_PENDING_MODALS = ['opponent-left-modal', 'info-modal', 'offline-opponent-modal'];

function modalTag(id) {
  const m = new RegExp('<div id="' + id + '"[^>]*>').exec(HTML);
  if (!m) throw new Error('modal not found in index.html: ' + id);
  return m[0];
}

console.log('=== 1. role=dialog + aria-modal ровно на 4 B1-модалках ===');
for (const id of B1_MODALS) {
  const tag = modalTag(id);
  check(`${id}: role="dialog"`, /role="dialog"/.test(tag));
  check(`${id}: aria-modal="true"`, /aria-modal="true"/.test(tag));
}
console.log('=== 1b. scope guard: B2-модалки, реализованные в №42-B2a, ТЕПЕРЬ имеют role/aria-modal (guard retired) ===');
for (const id of B2_DONE_MODALS) {
  const tag = modalTag(id);
  check(`${id}: role="dialog" (появилось в №42-B2a)`, /role="dialog"/.test(tag));
  check(`${id}: aria-modal (появилось в №42-B2a)`, /aria-modal/.test(tag));
}
console.log('=== 1c. scope guard: остальные B2-кандидаты по-прежнему БЕЗ role/aria-modal (B2b/B2c/dead, ещё не начаты) ===');
for (const id of B2_STILL_PENDING_MODALS) {
  const tag = modalTag(id);
  check(`${id}: без role="dialog" (вне scope №42-B2a)`, !/role="dialog"/.test(tag));
  check(`${id}: без aria-modal (вне scope №42-B2a)`, !/aria-modal/.test(tag));
}

console.log('=== 2. data-modal-initial-focus и data-modal-escape -- точная привязка ===');

const EXPECTED = {
  'resign-confirm-modal':    { initial: 'btn-resign-no',               escape: 'btn-resign-no' },
  'back-confirm-modal':      { initial: 'btn-back-bot-no',             escape: 'btn-back-bot-no' },
  'bot-difficulty-modal':    { initial: 'btn-difficulty-back',         escape: 'btn-difficulty-back' },
  'continue-or-new-modal':   { initial: 'btn-continue-existing-session', escape: 'btn-continue-or-new-back' }
};

function modalBlock(id) {
  const start = HTML.indexOf('<div id="' + id + '"');
  // Блоки модалок в разметке идут без глубокой вложенности друг в друга
  // (кроме stats-modal/bot-details-modal, сюда не входящих) -- следующий
  // "<div id=\"...-modal\"" после этого и есть граница текущего блока.
  const rest = HTML.slice(start + 10);
  const nextIdx = rest.search(/<div id="[a-z-]+-modal"/);
  return HTML.slice(start, nextIdx === -1 ? HTML.length : start + 10 + nextIdx);
}

for (const [id, exp] of Object.entries(EXPECTED)) {
  const block = modalBlock(id);
  const initialMatch = new RegExp('id="' + exp.initial + '"[^>]*data-modal-initial-focus').test(block);
  const escapeMatch = new RegExp('id="' + exp.escape + '"[^>]*data-modal-escape').test(block);
  check(`${id}: data-modal-initial-focus на ${exp.initial}`, initialMatch);
  check(`${id}: data-modal-escape на ${exp.escape}`, escapeMatch);
}

check('continue-or-new-modal: initial-focus и escape НАМЕРЕННО на разных кнопках',
  EXPECTED['continue-or-new-modal'].initial !== EXPECTED['continue-or-new-modal'].escape);

console.log('=== 2b. review fix: role="dialog" требует accessible name -- aria-labelledby на <p> ===');
for (const id of B1_MODALS) {
  const tag = modalTag(id);
  const m = /aria-labelledby="([a-z0-9-]+)"/.exec(tag);
  check(`${id}: имеет aria-labelledby`, !!m, tag);
  if (m) {
    const labelId = m[1];
    check(`${id}: aria-labelledby="${labelId}" указывает на РЕАЛЬНО существующий id="${labelId}"`,
      new RegExp('id="' + labelId + '"').test(HTML));
    check(`${id}: элемент с этим id -- локализованный <p data-i18n=...>, не пустышка`,
      new RegExp('<p id="' + labelId + '"[^>]*data-i18n=').test(HTML));
  }
}

console.log('=== 3. ровно 4 data-modal-initial-focus и 4 data-modal-escape СРЕДИ B1-МОДАЛОК ===');
// review fix (№42-B2a): раньше проверялось "ровно 4 во всём index.html" --
// корректно ломается любым легитимным расширением (B2a добавляет свои
// data-modal-initial-focus/escape на ДРУГИХ модалках). Инвариант B1 --
// "ровно 4 внутри блоков ИМЕННО этих 4 модалок", не общее число по файлу.
const B1_BLOCKS = B1_MODALS.map(id => {
  const start = HTML.indexOf('<div id="' + id + '"');
  const rest = HTML.slice(start + 10);
  const nextIdx = rest.search(/<div id="[a-z-]+-modal"/);
  return HTML.slice(start, nextIdx === -1 ? HTML.length : start + 10 + nextIdx);
}).join('\n');
check('ровно 4 data-modal-initial-focus внутри 4 B1-модалок',
  (B1_BLOCKS.match(/data-modal-initial-focus/g) || []).length === 4);
check('ровно 4 data-modal-escape внутри 4 B1-модалок',
  (B1_BLOCKS.match(/data-modal-escape/g) || []).length === 4);

console.log('=== 4. Escape не ведёт на destructive-кнопку ни в одной из 4 ===');
const DESTRUCTIVE = { 'resign-confirm-modal': 'btn-resign-yes', 'back-confirm-modal': 'btn-back-bot-yes' };
for (const [id, destructiveBtn] of Object.entries(DESTRUCTIVE)) {
  check(`${id}: data-modal-escape НЕ на ${destructiveBtn}`,
    !new RegExp('id="' + destructiveBtn + '"[^>]*data-modal-escape').test(modalBlock(id)));
}

console.log('=== 5. реальные openModal/closeModal: helper владеет видимостью, не только фокусом ===');

function helperBody(name) {
  // review fix (№42-B2a): openModal() получил второй необязательный
  // параметр (options), поэтому точное совпадение '(modal)' больше не
  // находит функцию. Ищем по началу сигнатуры -- любой список параметров.
  const start = SRC.indexOf('function ' + name + '(modal');
  if (start === -1) throw new Error(name + ' not found in script.js');
  let depth = 0, i = SRC.indexOf('{', start), end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return SRC.slice(start, end + 1);
}

const OPEN_BODY = helperBody('openModal');
const CLOSE_BODY = helperBody('closeModal');

check('openModal() снимает "hidden" (иначе .focus() ниже молча не сработает)',
  /modal\.classList\.remove\("hidden"\)/.test(OPEN_BODY));
check('closeModal() ставит "hidden"',
  /modal\.classList\.add\("hidden"\)/.test(CLOSE_BODY));
check('openModal() сохраняет document.activeElement как trigger',
  /document\.activeElement/.test(OPEN_BODY));
check('openModal() снимает предыдущий keydown-listener перед повторным открытием (идемпотентность)',
  /removeEventListener\("keydown"/.test(OPEN_BODY) && /modalFocusState\.get\(modal\)/.test(OPEN_BODY));
check('openModal() ставит keydown-listener НА САМ modal, не на document/window (иначе висел бы глобально)',
  /modal\.addEventListener\("keydown"/.test(OPEN_BODY) && !/document\.addEventListener\("keydown"/.test(OPEN_BODY));
check('closeModal() снимает keydown-listener',
  /removeEventListener\("keydown"/.test(CLOSE_BODY));
check('closeModal() проверяет что trigger всё ещё в DOM и видим перед .focus() (не падает на исчезнувшем элементе)',
  /document\.body\.contains\(state\.trigger\)/.test(CLOSE_BODY) && /offsetParent/.test(CLOSE_BODY));

console.log('=== 6. getFocusableInModal фильтрует по видимости, не по конкретному классу ===');
const FOCUSABLE_BODY = helperBody('getFocusableInModal');
check('фильтр по offsetParent (общий признак видимости, не завязан на имя .hidden)',
  /offsetParent/.test(FOCUSABLE_BODY));
check('фильтр исключает disabled', /\.disabled/.test(FOCUSABLE_BODY));
check('review fix: фильтр исключает tabindex="-1" через el.tabIndex (защита на будущее переиспользование в №42-B2, не влияет на текущие 4 B1-диалога -- ни в одном нет [tabindex])',
  /el\.tabIndex\s*>=\s*0/.test(FOCUSABLE_BODY));
check('review fix: ни один из 4 B1-диалогов сегодня не использует [tabindex] (иначе фикс был бы поведенческим, не защитным)',
  B1_MODALS.every(id => !/tabindex=/.test(modalBlock(id))));

console.log('=== 7. все 19 исходных classList-вызовов этих 4 модалок заменены на helper ===');
for (const varName of ['resignConfirmModal', 'backConfirmModal', 'botDifficultyModal', 'continueOrNewModal']) {
  const raw = new RegExp(varName + '\\.classList\\.(add|remove)\\("hidden"\\)').test(SRC);
  check(`${varName}: не осталось прямых classList.add/remove("hidden")`, !raw);
}

console.log('=== 8. B2a/B2b call sites мигрированы; остальные B2/async всё ещё вне scope (scope guard) ===');
for (const varName of ['drawOfferModal', 'rematchRequestModal', 'endGameModal', 'spectatorInterruptedModal', 'statsModal']) {
  const stillRaw = new RegExp(varName + '\\.classList\\.(add|remove)\\("hidden"\\)').test(SRC);
  check(`${varName}: прямого classList БОЛЬШЕ НЕТ (мигрировано в №42-B2a/B2b)`, !stillRaw);
}
// bot-details-modal не имеет персистентной const-переменной -- ищем ЛОКАЛЬНУЮ
// переменную modal, полученную по id, тем же способом, что и в самом коде.
check('bot-details-modal: прямого modal.classList.add/remove("hidden") БОЛЬШЕ НЕТ (мигрировано в №42-B2b)',
  !/getElementById\("bot-details-modal"\)[\s\S]{0,40}modal\.classList\.(add|remove)\("hidden"\)/.test(SRC));
for (const varName of ['opponentLeftModal', 'infoModal', 'offlineOpponentModal']) {
  const stillRaw = new RegExp(varName + '\\.classList\\.(add|remove)\\("hidden"\\)').test(SRC);
  check(`${varName}: по-прежнему прямой classList (вне scope №42-B2a/B2b)`, stillRaw);
}

console.log('=== 9. bot-difficulty "Назад": РЕАЛЬНЫЙ побочный эффект, не только скрытие modal ===');
//
// Playwright-fixture в panel-browser-layout.test.js проверяет generic
// focus/Tab/Escape-механику через представительную (не настоящую) click-
// привязку -- она НЕ исполняет реальную бизнес-логику каждого из 19
// call-site'ов (это потребовало бы фактически загружать всё приложение).
// Здесь -- наоборот: исполняется РЕАЛЬНОЕ тело btnDifficultyBack'а,
// извлечённое из script.js, чтобы доказать, что Escape/клик на "Назад"
// действительно сбрасывает pendingReplaceExistingSession, а не только
// прячет модалку (baseline-требование задания, не decoration).
{
  const anchor = 'btnDifficultyBack.addEventListener("click", function () {';
  const start = SRC.indexOf(anchor);
  if (start === -1) throw new Error('btnDifficultyBack click handler not found in script.js');
  const bodyStart = SRC.indexOf('{', start + anchor.length - 1);
  let depth = 0, i = bodyStart, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const handlerBody = SRC.slice(bodyStart + 1, end);

  check('извлечённое тело реально содержит closeModal(botDifficultyModal), не голый classList',
    /closeModal\(botDifficultyModal\)/.test(handlerBody));
  check('извлечённое тело реально содержит сброс pendingReplaceExistingSession',
    /pendingReplaceExistingSession\s*=\s*null/.test(handlerBody));

  // Исполняем РЕАЛЬНОЕ тело с минимальными stub'ами того, что не относится
  // к самому side-effect'у (экран/лобби) -- closeModal/openModal тоже
  // настоящие, извлечённые из того же script.js.
  const sandbox = {
    botDifficultyModal: { classList: { add() {}, remove() {} } },
    menuScreen: {}, isBotGame: true,
    pendingReplaceExistingSession: 'STALE_SESSION_FROM_PREVIOUS_FLOW',
    pendingExistingSessionForResume: 'STALE_RESUME',
    pendingOldSpectateCodeForCleanup: 'STALE_CODE',
    showScreen: function () {}, loadActiveRooms: function () {},
    document: { activeElement: null, body: { contains: () => false } },
    modalFocusState: new WeakMap()
  };
  const helperStart = SRC.indexOf('const modalFocusState = new WeakMap();');
  const helperEndMarker = 'function closeModal(modal) {';
  const heStart = SRC.indexOf(helperEndMarker, helperStart);
  let d2 = 0, j = SRC.indexOf('{', heStart), he = -1;
  for (; j < SRC.length; j++) {
    if (SRC[j] === '{') d2++;
    else if (SRC[j] === '}') { d2--; if (d2 === 0) { he = j; break; } }
  }
  const helperSrc = SRC.slice(helperStart, he + 1).replace('const modalFocusState = new WeakMap();', '');

  const names = Object.keys(sandbox);
  const fn = new Function(...names, helperSrc + '\n' + handlerBody + '\nreturn { pendingReplaceExistingSession, pendingExistingSessionForResume, pendingOldSpectateCodeForCleanup };');
  const result = fn(...names.map(n => sandbox[n]));

  check('после клика "Назад": pendingReplaceExistingSession реально сброшен (не просто предположение)',
    result.pendingReplaceExistingSession === null, JSON.stringify(result));
  check('после клика "Назад": pendingExistingSessionForResume тоже сброшен',
    result.pendingExistingSessionForResume === null);
  check('после клика "Назад": pendingOldSpectateCodeForCleanup тоже сброшен',
    result.pendingOldSpectateCodeForCleanup === null);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

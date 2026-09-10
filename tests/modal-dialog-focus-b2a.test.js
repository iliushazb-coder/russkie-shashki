// №42-B2a: role=dialog/aria-modal + focus management для 4 АСИНХРОННЫХ
// (Firebase/presence-driven) диалогов: draw-offer, rematch-request,
// end-game, spectator-interrupted. Расширяет B1's openModal()/closeModal()
// необязательным вторым параметром { returnFocus: false }, не меняя ни
// один из 4 B1 call-site'ов (они вызывают openModal(modal) одним
// аргументом). Вне scope: B2b (nested stats-modal/bot-details-modal),
// B2c (info-modal, 46 call-site'ов), opponent-left-modal и
// offline-opponent-modal (недостижимы -- отдельный dead-markup follow-up).

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const B2A_MODALS = ['draw-offer-modal', 'rematch-request-modal', 'end-game-modal', 'spectator-interrupted-modal'];
// B1 -- проверить, что НЕ задеты этой правкой.
const B1_MODALS = ['resign-confirm-modal', 'back-confirm-modal', 'bot-difficulty-modal', 'continue-or-new-modal'];
// Остальное вне scope этого среза.
// review fix (№42-B2b): stats-modal/bot-details-modal реализованы в
// №42-B2b. Отделяем от того, что по-прежнему вне scope (info-modal --
// B2c, opponent-left-modal/offline-opponent-modal -- недостижимы).
const OUT_OF_SCOPE = ['info-modal', 'opponent-left-modal', 'offline-opponent-modal'];
const B2B_DONE = ['stats-modal', 'bot-details-modal'];

function modalTag(id) {
  const m = new RegExp('<div id="' + id + '"[^>]*>').exec(HTML);
  if (!m) throw new Error('modal not found in index.html: ' + id);
  return m[0];
}
function modalBlock(id) {
  const start = HTML.indexOf('<div id="' + id + '"');
  const rest = HTML.slice(start + 10);
  const nextIdx = rest.search(/<div id="[a-z-]+-modal"/);
  return HTML.slice(start, nextIdx === -1 ? HTML.length : start + 10 + nextIdx);
}
function helperBody(name) {
  const start = SRC.indexOf('function ' + name + '(modal');
  if (start === -1) throw new Error(name + ' not found in script.js');
  let depth = 0, i = SRC.indexOf('{', start), end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return SRC.slice(start, end + 1);
}

console.log('=== 1. role=dialog + aria-modal + aria-labelledby на всех 4 B2a-диалогах ===');
for (const id of B2A_MODALS) {
  const tag = modalTag(id);
  check(`${id}: role="dialog"`, /role="dialog"/.test(tag));
  check(`${id}: aria-modal="true"`, /aria-modal="true"/.test(tag));
  const m = /aria-labelledby="([a-z0-9-]+)"/.exec(tag);
  check(`${id}: имеет aria-labelledby`, !!m);
  if (m) {
    check(`${id}: aria-labelledby указывает на реально существующий id`,
      new RegExp('id="' + m[1] + '"').test(HTML));
  }
}

console.log('=== 2. Escape scoping: НЕТ safe neutral action -> НЕТ data-modal-escape ===');
check('draw-offer-modal: НЕТ data-modal-escape (Accept/Decline меняют исход партии, нет нейтрального действия)',
  !/data-modal-escape/.test(modalBlock('draw-offer-modal')));
check('rematch-request-modal: НЕТ data-modal-escape (та же причина)',
  !/data-modal-escape/.test(modalBlock('rematch-request-modal')));

console.log('=== 3. Escape scoping: ЕСТЬ safe действие -> Escape делегирует РЕАЛЬНОЙ безопасной кнопке ===');
check('end-game-modal: data-modal-escape на btn-close-game (не btn-new-game)',
  /id="btn-close-game"[^>]*data-modal-escape/.test(modalBlock('end-game-modal')) &&
  !/id="btn-new-game"[^>]*data-modal-escape/.test(modalBlock('end-game-modal')));
check('spectator-interrupted-modal: data-modal-escape на единственной кнопке btn-spectator-interrupted-ok',
  /id="btn-spectator-interrupted-ok"[^>]*data-modal-escape/.test(modalBlock('spectator-interrupted-modal')));

console.log('=== 4. initial-focus: безопасный/наименее коммитящий выбор ===');
check('rematch-request-modal: initial-focus на Отклонить, не Принять',
  /id="btn-rematch-decline"[^>]*data-modal-initial-focus/.test(modalBlock('rematch-request-modal')) &&
  !/id="btn-rematch-accept"[^>]*data-modal-initial-focus/.test(modalBlock('rematch-request-modal')));
check('draw-offer-modal: initial-focus на Отклонить (для чужого предложения)',
  /id="btn-draw-decline"[^>]*data-modal-initial-focus/.test(modalBlock('draw-offer-modal')));
check('draw-offer-modal: initial-focus ТАКЖЕ на Отменить предложение (для своего предложения -- единственная видимая опция)',
  /id="btn-draw-cancel"[^>]*data-modal-initial-focus/.test(modalBlock('draw-offer-modal')));
check('draw-offer-modal: НЕ на Принять (коммитящее действие)',
  !/id="btn-draw-accept"[^>]*data-modal-initial-focus/.test(modalBlock('draw-offer-modal')));

console.log('=== 5. openModal(modal, options): returnFocus необязателен, B1-поведение не меняется ===');
const OPEN_BODY = helperBody('openModal');
check('openModal принимает второй параметр options', /function openModal\(modal, options\)/.test(SRC));
check('returnFocus по умолчанию true (options отсутствует -> true)',
  /const returnFocus = !options \|\| options\.returnFocus !== false/.test(OPEN_BODY));
check('trigger не захватывается при returnFocus:false', /returnFocus \? \(existing \? existing\.trigger/.test(OPEN_BODY));

console.log('=== 5b. review fix: initial-focus учитывает видимость (draw-offer динамически меняет набор кнопок) ===');
check('initial выбирается среди ВИДИМЫХ [data-modal-initial-focus] (offsetParent), не первого по DOM',
  /initialCandidates\.find\(function \(el\) \{ return el\.offsetParent !== null/.test(OPEN_BODY));

console.log('=== 6. B1 4 call-site\'а НЕ изменены (одна форма вызова, без options) ===');
for (const varName of ['resignConfirmModal', 'backConfirmModal', 'botDifficultyModal', 'continueOrNewModal']) {
  const re = new RegExp('openModal\\(' + varName + '\\)');
  check(`${varName}: openModal(modal) без второго аргумента (B1 не тронут)`, re.test(SRC));
}

console.log('=== 7. returnFocus:false ровно у end-game и spectator-interrupted, не у draw/rematch ===');
check('openModal(endGameModal, { returnFocus: false }) присутствует',
  /openModal\(endGameModal, \{ returnFocus: false \}\)/.test(SRC));
check('openModal(spectatorInterruptedModal, { returnFocus: false }) присутствует',
  /openModal\(spectatorInterruptedModal, \{ returnFocus: false \}\)/.test(SRC));
check('openModal(drawOfferModal) БЕЗ returnFocus:false (screen никогда не меняется)',
  /openModal\(drawOfferModal\)/.test(SRC) && !/openModal\(drawOfferModal, \{ returnFocus: false \}\)/.test(SRC));
check('openModal(rematchRequestModal) БЕЗ returnFocus:false',
  /openModal\(rematchRequestModal\)/.test(SRC) && !/openModal\(rematchRequestModal, \{ returnFocus: false \}\)/.test(SRC));

console.log('=== 8. review fix: guard от повторного открытия на неизменённом состоянии (redundant re-render) ===');
// checkDrawProposal/checkRematchProposal/renderEndGameModal вызываются на
// КАЖДЫЙ renderBoard(), не только при новом предложении -- без guard'а
// каждый несвязанный ре-рендер стирал бы фокус пользователя обратно на
// initial-focus, даже если он уже протабился внутри диалога.
check('drawOfferModal: openModal вызывается только при classList.contains("hidden")',
  /if \(drawOfferModal\.classList\.contains\("hidden"\)\) openModal\(drawOfferModal\)/.test(SRC));
check('rematchRequestModal: тот же guard',
  /if \(rematchRequestModal\.classList\.contains\("hidden"\)\) openModal\(rematchRequestModal\)/.test(SRC));
check('endGameModal: тот же guard',
  /if \(endGameModal\.classList\.contains\("hidden"\)\) openModal\(endGameModal, \{ returnFocus: false \}\)/.test(SRC));

console.log('=== 8b. review fix: closeModal() не крадёт фокус у ДРУГОГО уже открытого диалога ===');
// Подтверждаем ДВЕ вещи: (1) реальный порядок renderBoard() -- именно
// renderEndGameModal() идёт РАНЬШЕ checkRematchProposal()/checkDrawProposal(),
// а не наоборот (без этого browser-тест мог бы моделировать удобный, но
// нереалистичный обратный порядок и не поймать найденный баг); (2) сам fix
// в closeModal() действительно проверяет наличие другого видимого диалога.
{
  const rbStart = SRC.indexOf('function renderBoard()');
  if (rbStart === -1) throw new Error('renderBoard not found in script.js');
  let depth = 0, i = SRC.indexOf('{', rbStart), end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const rbBody = SRC.slice(rbStart, end + 1);
  const idxEndGame = rbBody.indexOf('renderEndGameModal()');
  const idxRematch = rbBody.indexOf('checkRematchProposal()');
  const idxDraw = rbBody.indexOf('checkDrawProposal()');
  check('renderBoard(): renderEndGameModal() реально вызывается РАНЬШЕ checkRematchProposal() (не предположение)',
    idxEndGame !== -1 && idxRematch !== -1 && idxEndGame < idxRematch,
    `endGame@${idxEndGame} rematch@${idxRematch}`);
  check('renderBoard(): checkRematchProposal() реально вызывается РАНЬШЕ checkDrawProposal()',
    idxRematch !== -1 && idxDraw !== -1 && idxRematch < idxDraw,
    `rematch@${idxRematch} draw@${idxDraw}`);
}
const CLOSE_BODY_B2A = helperBody('closeModal');
check('closeModal(): проверяет, не находится ли фокус внутри ДРУГОГО видимого .modal-overlay, перед восстановлением trigger',
  /\.closest\(["']\.modal-overlay:not\(\.hidden\)["']\)/.test(CLOSE_BODY_B2A));
check('closeModal(): при активном другом модальном диалоге НЕ вызывает .focus() на старом trigger (условие обёрнуто, не удалено)',
  /if \(!activeInsideOtherOpenModal && state\.trigger/.test(CLOSE_BODY_B2A));

console.log('=== 9. все прямые classList.add/remove("hidden") для 4 B2a модалок заменены ===');

for (const varName of ['drawOfferModal', 'rematchRequestModal', 'endGameModal', 'spectatorInterruptedModal']) {
  const raw = new RegExp(varName + '\\.classList\\.(add|remove)\\("hidden"\\)').test(SRC);
  check(`${varName}: не осталось прямых classList.add/remove("hidden")`, !raw);
}

console.log('=== 10. B2c/dead-markup не задеты этим срезом; B2b (реализован отдельно) корректно ИМЕЕТ role/aria-modal ===');
for (const id of OUT_OF_SCOPE) {
  const tag = modalTag(id);
  check(`${id}: без role="dialog" (вне scope №42-B2a)`, !/role="dialog"/.test(tag));
}
for (const id of B2B_DONE) {
  const tag = modalTag(id);
  check(`${id}: role="dialog" (реализовано в №42-B2b, не в этом файле, но факт корректен)`, /role="dialog"/.test(tag));
}
for (const varName of ['infoModal', 'offlineOpponentModal', 'opponentLeftModal']) {
  const stillRaw = new RegExp(varName + '\\.classList\\.(add|remove)\\("hidden"\\)').test(SRC);
  check(`${varName}: по-прежнему прямой classList (вне scope №42-B2a)`, stillRaw);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

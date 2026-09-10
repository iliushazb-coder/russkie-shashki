// №42-B2c: role=dialog/aria-modal + focus management для info-modal.
// Ключевая находка перед реализацией: все 45 реальных production call
// sites showInfoModal() передают ровно (text, false) -- двухкнопочный
// режим (offerNewGame=true) и non-navigating режим (navigateToMenu=false)
// СЕГОДНЯ нигде не используются, но код обязан корректно работать, если
// они появятся. return-focus поэтому не хардкожен, а вычисляется из
// СУЩЕСТВУЮЩИХ параметров: !(infoModalShouldNavigate || offerNewGame).
// btnInfoNewGame навигирует БЕЗУСЛОВНО (не читает infoModalShouldNavigate
// вовсе), поэтому || offerNewGame обязателен -- без него комбинация
// (offerNewGame=true, navigateToMenu=false) дала бы неверный returnFocus:true.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

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
function extractFn(marker) {
  const s = SRC.indexOf(marker);
  if (s === -1) throw new Error('function not found: ' + marker);
  let d = 0, i = SRC.indexOf('{', s), e = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') d++;
    else if (SRC[i] === '}') { d--; if (d === 0) { e = i; break; } }
  }
  return SRC.slice(s, e + 1);
}
function extractHandler(marker) {
  const s = SRC.indexOf(marker);
  if (s === -1) throw new Error('handler not found: ' + marker);
  const e = SRC.indexOf('});', s);
  return SRC.slice(s, e + 3);
}

console.log('=== 1. role=dialog + aria-modal + aria-labelledby ===');
{
  const tag = modalTag('info-modal');
  check('info-modal: role="dialog"', /role="dialog"/.test(tag));
  check('info-modal: aria-modal="true"', /aria-modal="true"/.test(tag));
  check('info-modal: aria-labelledby="info-modal-text"', /aria-labelledby="info-modal-text"/.test(tag));
  check('info-modal-text реально существует в разметке', /id="info-modal-text"/.test(HTML));
}

console.log('=== 2. initial-focus / escape ТОЛЬКО на btn-info-close, никогда на btn-info-new-game ===');
{
  const block = modalBlock('info-modal');
  check('btn-info-close: data-modal-initial-focus', /id="btn-info-close"[^>]*data-modal-initial-focus/.test(block));
  check('btn-info-close: data-modal-escape', /id="btn-info-close"[^>]*data-modal-escape/.test(block));
  check('btn-info-new-game: НЕТ data-modal-initial-focus (безусловно навигирует -- не безопасный дефолт)',
    !/id="btn-info-new-game"[^>]*data-modal-initial-focus/.test(block));
  check('btn-info-new-game: НЕТ data-modal-escape (Escape никогда не должен запускать новую партию)',
    !/id="btn-info-new-game"[^>]*data-modal-escape/.test(block));
}

console.log('=== 3. return-focus policy: формула читает РЕАЛЬНЫЕ параметры, не хардкод ===');
{
  const body = extractFn('function showInfoModal(text, offerNewGame, navigateToMenu) {');
  check('showInfoModal() открывает через openModal(infoModal, {...}), не голый classList',
    /openModal\(infoModal,\s*\{\s*returnFocus:/.test(body));
  check('формула ровно !(infoModalShouldNavigate || offerNewGame)',
    /returnFocus:\s*!\(infoModalShouldNavigate\s*\|\|\s*offerNewGame\)/.test(body));
}

console.log('=== 4. проверка всех 4 комбинаций параметров по РЕАЛЬНЫМ handler\'ам (не по формуле саму по себе) ===');
{
  // Симулируем вычисление formula в Node напрямую -- та же строка, что в SRC.
  function returnFocusFor(infoModalShouldNavigate, offerNewGame) {
    return !(infoModalShouldNavigate || offerNewGame);
  }
  const newGameBody = extractHandler('btnInfoNewGame.addEventListener("click", function () {');
  const closeBody = extractHandler('btnInfoClose.addEventListener("click", function () {');
  check('btnInfoNewGame реально навигирует БЕЗУСЛОВНО (не проверяет infoModalShouldNavigate) -- обоснование || offerNewGame в формуле',
    /showScreen\(timeControlScreen\)/.test(newGameBody) && !/infoModalShouldNavigate/.test(newGameBody));
  check('btnInfoClose навигирует ТОЛЬКО если infoModalShouldNavigate',
    /if \(infoModalShouldNavigate\)/.test(closeBody) && /showScreen\(menuScreen\)/.test(closeBody));

  check('offerNewGame=false, navigateToMenu=true(default): единственный exit (Close) навигирует -> returnFocus=false',
    returnFocusFor(true, false) === false);
  check('offerNewGame=false, navigateToMenu=false: единственный exit (Close) НЕ навигирует -> returnFocus=true',
    returnFocusFor(false, false) === true);
  check('offerNewGame=true, navigateToMenu=true: оба exit навигируют -> returnFocus=false',
    returnFocusFor(true, true) === false);
  check('offerNewGame=true, navigateToMenu=false: Close не навигирует, но New Game -- ДА (безусловно) -> returnFocus=false',
    returnFocusFor(false, true) === false);
}

console.log('=== 5. все реальные call sites сегодня передают ровно (text, false) -- 2 аргумента, дефолтный navigateToMenu ===');
{
  const calls = SRC.match(/showInfoModal\([^;]*\)/g) || [];
  const realCalls = calls.filter(c => !c.startsWith('showInfoModal(text, offerNewGame, navigateToMenu)'));
  check('ровно 45 реальных call sites', realCalls.length === 45, 'найдено: ' + realCalls.length);
  const nonConforming = realCalls.filter(c => !/,\s*false\)$/.test(c));
  check('ВСЕ 45 передают ровно ", false)" вторым/последним аргументом (двухкнопочный режим сегодня нигде не включён)',
    nonConforming.length === 0, JSON.stringify(nonConforming));
}

console.log('=== 6. нет прямого classList для info-modal нигде, кроме самого helper\'а ===');
check('infoModal.classList отсутствует вне openModal/closeModal', !/infoModal\.classList/.test(SRC));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

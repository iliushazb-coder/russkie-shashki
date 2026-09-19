// №3B: плавное ЗАКРЫТИЕ модалок без задержки бизнес-логики.
// Source-level контракт дополняет Playwright-проверку в panel-browser-layout:
// здесь фиксируем generation-safe teardown, CSS contract и async reopen guards.
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(n, c, d) {
  console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : ''));
  c ? passed++ : failed++;
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

function fnBody(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start === -1) throw new Error(name + ' not found');
  let depth = 0, i = SRC.indexOf('{', start), end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return SRC.slice(start, end + 1);
}

const OPEN = fnBody('openModal');
const CLOSE = fnBody('closeModal');
const FINISH = fnBody('finishModalClose');
const CANCEL = fnBody('cancelPendingModalClose');

console.log('=== 1. close-state generation / stale callback safety ===');
check('modalCloseState — WeakMap', /const modalCloseState = new WeakMap\(\)/.test(SRC));
check('есть отдельное поколение close-cycle', /let modalCloseGeneration = 0/.test(SRC));
check('finish проверяет generation до .hidden',
  /state\.generation !== generation/.test(FINISH) && /classList\.add\("hidden"\)/.test(FINISH));
check('cancel снимает fallback timer', /clearModalCloseState\(modal, state\)/.test(CANCEL));
check('cancel снимает modal-closing', /classList\.remove\("modal-closing"\)/.test(CANCEL));
check('openModal СНАЧАЛА отменяет старый close-cycle',
  OPEN.indexOf('cancelPendingModalClose(modal)') !== -1 &&
  OPEN.indexOf('cancelPendingModalClose(modal)') < OPEN.indexOf('classList.remove("hidden")'));

console.log('=== 2. логическое закрытие мгновенное ===');
check('close сразу ставит modal-closing', /classList\.add\("modal-closing"\)/.test(CLOSE));
check('keydown listener снимается ДО визуального finish', /removeEventListener\("keydown"/.test(CLOSE));
check('focus lookup исключает .modal-closing',
  /\.modal-overlay:not\(\.hidden\):not\(\.modal-closing\)/.test(CLOSE));
check('закрытая визуально модалка сразу aria-hidden', /setAttribute\("aria-hidden", "true"\)/.test(CLOSE));
check('закрытая визуально модалка сразу inert', /setAttribute\("inert", ""\)/.test(CLOSE));
check('open снимает aria-hidden и inert',
  /removeAttribute\("aria-hidden"\)/.test(OPEN) && /removeAttribute\("inert"\)/.test(OPEN));
check('повторный close во время closing идемпотентен',
  /classList\.contains\("modal-closing"\)[\s\S]*modalCloseState\.has\(modal\)/.test(CLOSE));

console.log('=== 3. animationend + fallback, но без stale-hide ===');
check('animationend фильтруется по overlay и имени close-анимации',
  /event\.target !== modal/.test(CLOSE) && /event\.animationName !== "modalCloseOverlay"/.test(CLOSE));
check('есть fallback timer', /setTimeout\(function \(\) \{[\s\S]*finishModalClose\(modal, generation\)/.test(CLOSE));
check('fallback = 280ms для 180ms close', /const MODAL_CLOSE_FALLBACK_MS = 280/.test(SRC));
check('fixture/animation:none закрывается сразу, не ждёт fallback',
  /animationName === "none"/.test(CLOSE) && /finishModalClose\(modal, generation\)/.test(CLOSE));
check('reduced-motion закрывается сразу',
  /prefersReducedModalMotion\(\)/.test(CLOSE) &&
  /classList\.add\("hidden"\)/.test(CLOSE));

console.log('=== 4. CSS close contract ===');
check('.modal-closing выключает pointer events',
  /\.modal-overlay\.modal-closing\s*\{[^}]*pointer-events:\s*none/.test(CSS));
check('overlay close = 180ms', /modalCloseOverlay 180ms/.test(CSS));
check('box close = 180ms', /modalCloseBox 180ms/.test(CSS));
check('overlay open = 180ms', /animation:\s*fadeInOverlay 0\.18s ease/.test(CSS));
check('box open = 180ms', /animation:\s*modalPop 0\.18s/.test(CSS));
check('stats больше не имеет отдельного close-duration',
  !/#stats-modal\.modal-closing\s*\{[^}]*animation-duration/.test(CSS));
check('box мягко уходит вниз и чуть уменьшается',
  /translateY\(10px\) scale\(0\.94\)/.test(CSS));
check('reduced-motion выключает close-анимацию',
  /prefers-reduced-motion:[^)]*reduce[\s\S]*\.modal-overlay\.modal-closing[\s\S]*animation:\s*none !important/.test(CSS));

console.log('=== 5. remote reopen guards считают closing логически закрытым ===');
check('isModalLogicallyOpen исключает modal-closing',
  /function isModalLogicallyOpen[\s\S]*!modal\.classList\.contains\("modal-closing"\)/.test(SRC));
check('end-game guard использует isModalLogicallyOpen',
  /if \(!isModalLogicallyOpen\(endGameModal\)\) openModal\(endGameModal/.test(SRC));
check('draw guard использует isModalLogicallyOpen',
  /if \(!isModalLogicallyOpen\(drawOfferModal\)\) openModal\(drawOfferModal/.test(SRC));
check('rematch guard использует isModalLogicallyOpen',
  /if \(!isModalLogicallyOpen\(rematchRequestModal\)\) openModal\(rematchRequestModal/.test(SRC));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

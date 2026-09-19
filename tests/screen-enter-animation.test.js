// ==========================================================================
// MAIN SCREEN NAVIGATION: outgoing is hidden synchronously; incoming = 180ms.
// ==========================================================================
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? ' — ' + info : '')); }
}
function noComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function funcBody(src, name) {
    const i = src.indexOf('function ' + name + '(');
    if (i === -1) return null;
    const from = src.indexOf('{', i);
    let depth = 0;
    for (let k = from; k < src.length; k++) {
        if (src[k] === '{') depth++;
        else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
    }
    return null;
}

const CLEAN = noComments(SRC);
const CSS_CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const SCREENS = ['menu-screen','time-control-screen','group-lobby-screen','waiting-screen','game-screen'];

console.log('=== 1. INCOMING ONLY = 180ms ===');
const enterRule = /((?:#[a-z-]+:not\(\.hidden\),\s*\n)*#[a-z-]+:not\(\.hidden\))\s*\{[^}]*animation:\s*screenEnter 180ms/.exec(CSS_CLEAN);
check('1.1 enter-rule найден и = 180ms', !!enterRule);
SCREENS.forEach(function(id, i) {
    check('1.' + (i + 2) + ' enter #' + id,
        !!enterRule && enterRule[1].includes('#' + id + ':not(.hidden)'));
});
check('1.7 keyframes screenEnter существует', /@keyframes screenEnter\s*\{/.test(CSS_CLEAN));
check('1.8 screenLeave CSS отсутствует', !/screenLeave/.test(CSS_CLEAN));
check('1.9 .screen-leaving CSS отсутствует', !/\.screen-leaving/.test(CSS_CLEAN));
check('1.10 все 5 экранов есть в HTML', SCREENS.every(id => HTML.includes('id="' + id + '"')));
check('1.11 early incoming input заблокирован до 70%', /70%\\s*\\{[^}]*pointer-events:\\s*none/.test(CSS_CLEAN));
check('1.12 input включается после guard', /70\\.01%\\s*\\{[^}]*pointer-events:\\s*auto/.test(CSS_CLEAN));

console.log('\n=== 2. OUTGOING HIDE СИНХРОННЫЙ ===');
{
    const hide = funcBody(CLEAN, 'hideScreenImmediately') || '';
    const show = funcBody(CLEAN, 'showScreen') || '';
    check('2.1 hide helper найден', !!hide);
    check('2.2 outgoing сразу aria-hidden', /setAttribute\("aria-hidden", "true"\)/.test(hide));
    check('2.3 outgoing сразу inert', /setAttribute\("inert", ""\)/.test(hide));
    check('2.4 outgoing сразу .hidden', /classList\.add\("hidden"\)/.test(hide));
    check('2.5 showScreen скрывает каждый non-target через helper',
        /candidate !== screen[\s\S]*hideScreenImmediately\(candidate\)/.test(show));
    check('2.6 target .hidden снимается синхронно', /screen\.classList\.remove\("hidden"\)/.test(show));
    check('2.7 target снимает aria-hidden/inert',
        /screen\.removeAttribute\("aria-hidden"\)/.test(show) &&
        /screen\.removeAttribute\("inert"\)/.test(show));
    check('2.8 нет async/await/Promise/timer', !/async |await |Promise|\.then\(|setTimeout/.test(show));
}

console.log('\n=== 3. НЕТ STALE VISUAL TAIL ===');
check('3.1 screenLeaveState удалён', !/screenLeaveState/.test(CLEAN));
check('3.2 screenLeaveGeneration удалён', !/screenLeaveGeneration/.test(CLEAN));
check('3.3 finishScreenLeave удалён', !/finishScreenLeave/.test(CLEAN));
check('3.4 cancelPendingScreenLeave удалён', !/cancelPendingScreenLeave/.test(CLEAN));
check('3.5 logical-active зависит только от hidden',
    /function isScreenLogicallyActive[\s\S]*!screen\.classList\.contains\("hidden"\)/.test(CLEAN) &&
    !/function isScreenLogicallyActive[\s\S]{0,200}screen-leaving/.test(CLEAN));

console.log('\n=== 4. GAME/FIREBASE ЛОГИКА НЕ ЖДЁТ ===');
{
    const show = funcBody(CLEAN, 'showScreen') || '';
    check('4.1 hideStartupCover остаётся первым действием',
        /^function showScreen\(screen\)\s*\{\s*hideStartupCover\(\);/.test(show));
    check('4.2 game timer использует logical helper', /if \(isScreenLogicallyActive\(gameScreen\)\)/.test(CLEAN));
    check('4.3 showScreen не содержит delay', !/setTimeout|requestAnimationFrame/.test(show));
}

console.log('\n=== 5. REDUCED MOTION + CACHE ===');
{
    const blocks = CSS_CLEAN.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    const rm = blocks.find(b => /#menu-screen:not\(\.hidden\)/.test(b));
    check('5.1 reduced-motion выключает incoming animation', !!rm && /animation:\s*none\s*!important/.test(rm));
    check('5.2 style cache >= 47', Number((/style\.css\?v=(\d+)/.exec(HTML) || [])[1]) >= 47);
    check('5.3 script cache >= 232', Number((/script\.js\?v=(\d+)/.exec(HTML) || [])[1]) >= 232);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed ? 1 : 0);

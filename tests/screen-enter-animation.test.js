// ==========================================================================
// КОРОТКИЙ ПЕРЕХОД МЕЖДУ 5 ОСНОВНЫМИ ЭКРАНАМИ.
// Логика синхронна; old уходит за 180ms, target полностью входит за 260ms.
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

console.log('=== 1. ENTER + LEAVE: ВСЕ 5 ЭКРАНОВ ===');
const enterRule = /((?:#[a-z-]+:not\(\.hidden\):not\(\.screen-leaving\),\s*\n)*#[a-z-]+:not\(\.hidden\):not\(\.screen-leaving\))\s*\{[^}]*animation:\s*screenEnter 260ms/.exec(CSS_CLEAN);
const leaveRule = /((?:#[a-z-]+\.screen-leaving,\s*\n)*#[a-z-]+\.screen-leaving)\s*\{[\s\S]*?animation:\s*screenLeave 180ms[^}]*\}/.exec(CSS_CLEAN);
check('1.1 enter-rule найден и = 260ms', !!enterRule);
check('1.2 leave-rule найден и = 180ms', !!leaveRule);
SCREENS.forEach(function(id, i) {
    check('1.' + (i + 3) + ' enter #' + id,
        !!enterRule && enterRule[1].includes('#' + id + ':not(.hidden):not(.screen-leaving)'));
    check('1.' + (i + 8) + ' leave #' + id,
        !!leaveRule && leaveRule[1].includes('#' + id + '.screen-leaving'));
});
check('1.13 оба keyframes существуют', /@keyframes screenEnter\s*\{/.test(CSS_CLEAN) && /@keyframes screenLeave\s*\{/.test(CSS_CLEAN));
check('1.14 экраны существуют в HTML', SCREENS.every(id => HTML.includes('id="' + id + '"')));
check('1.15 target не проявляется до 70% enter-animation',
    /@keyframes screenEnter\s*\{[\s\S]*?0%,\s*70%\s*\{\s*opacity:\s*0/.test(CSS_CLEAN));

console.log('\n=== 2. PER-SCREEN LIFECYCLE + STALE GUARD ===');
check('2.1 WeakMap per-screen state', /const screenLeaveState = new WeakMap\(\)/.test(CLEAN));
check('2.2 generation существует', /let screenLeaveGeneration = 0/.test(CLEAN));
check('2.3 fallback = 300ms', /const SCREEN_TRANSITION_FALLBACK_MS = 300/.test(CLEAN));
{
    const finish = funcBody(CLEAN, 'finishScreenLeave') || '';
    const cancel = funcBody(CLEAN, 'cancelPendingScreenLeave') || '';
    const start = funcBody(CLEAN, 'startScreenLeave') || '';
    check('2.4 stale generation не может finish', /state\.generation !== generation/.test(finish));
    check('2.5 cancel чистит timer/listener', /clearScreenLeaveState/.test(cancel));
    check('2.6 повторный leave идемпотентен', /screen-leaving/.test(start) && /screenLeaveState\.has/.test(start));
    check('2.7 animationend фильтруется по target+name',
        /event\.target !== screen/.test(start) && /event\.animationName !== "screenLeave"/.test(start));
    check('2.8 fallback вызывает finish с generation',
        /setTimeout[\s\S]*finishScreenLeave\(screen, generation\)/.test(start));
}

console.log('\n=== 3. SHOWSCREEN ЛОГИЧЕСКИ СИНХРОННЫЙ ===');
{
    const body = funcBody(CLEAN, 'showScreen') || '';
    check('3.1 showScreen найден', !!body);
    check('3.2 hideStartupCover остаётся первым действием',
        /^function showScreen\(screen\)\s*\{\s*hideStartupCover\(\);/.test(body));
    check('3.3 outgoing snapshot идёт ДО cancel reopened target', (function () {
        const leavePos = body.indexOf('startScreenLeave(candidate)');
        const cancelPos = body.indexOf('cancelPendingScreenLeave(screen)');
        return leavePos !== -1 && cancelPos !== -1 && leavePos < cancelPos;
    })());
    check('3.4 target .hidden снимается синхронно', /screen\.classList\.remove\("hidden"\)/.test(body));
    check('3.5 target сразу снимает aria-hidden/inert',
        /screen\.removeAttribute\("aria-hidden"\)/.test(body) && /screen\.removeAttribute\("inert"\)/.test(body));
    check('3.6 нет async/await/Promise', !/async |await |Promise|\.then\(/.test(body));
    check('3.7 старые экраны уходят через общий helper', /startScreenLeave\(candidate\)/.test(body));
}

console.log('\n=== 4. LAYOUT: УХОДЯЩИЙ ЭКРАН ВНЕ FLOW ===');
check('4.1 position fixed', /position:\s*fixed\s*!important/.test(leaveRule ? leaveRule[0] : ''));
check('4.2 left/top берутся из snapshot vars',
    /--screen-leave-left/.test(CSS_CLEAN) && /--screen-leave-top/.test(CSS_CLEAN));
check('4.3 width/height фиксируются snapshot vars',
    /--screen-leave-width/.test(CSS_CLEAN) && /--screen-leave-height/.test(CSS_CLEAN));
check('4.4 уходящий экран не принимает pointer events',
    /pointer-events:\s*none\s*!important/.test(leaveRule ? leaveRule[0] : ''));
{
    const start = funcBody(CLEAN, 'startScreenLeave') || '';
    check('4.5 geometry берётся до screen-leaving', /getBoundingClientRect\(\)[\s\S]*classList\.add\("screen-leaving"\)/.test(start));
    check('4.6 outgoing сразу aria-hidden + inert',
        /setAttribute\("aria-hidden", "true"\)/.test(start) && /setAttribute\("inert", ""\)/.test(start));
}

console.log('\n=== 5. ЛОГИЧЕСКАЯ ВИДИМОСТЬ НЕ ЗАВЯЗАНА НА VISUAL TAIL ===');
{
    const logical = funcBody(CLEAN, 'isScreenLogicallyActive') || '';
    check('5.1 helper исключает hidden', /classList\.contains\("hidden"\)/.test(logical));
    check('5.2 helper исключает screen-leaving', /classList\.contains\("screen-leaving"\)/.test(logical));
    check('5.3 game timer использует logical helper', /if \(isScreenLogicallyActive\(gameScreen\)\)/.test(CLEAN));
    check('5.4 прямой gameScreen hidden-read больше не управляет timer',
        !/if \(!gameScreen\.classList\.contains\("hidden"\)\)/.test(CLEAN));
}

console.log('\n=== 6. REDUCED MOTION ===');
{
    const start = funcBody(CLEAN, 'startScreenLeave') || '';
    check('6.1 JS reduce прячет outgoing сразу',
        /prefersReducedScreenMotion\(\)[\s\S]*classList\.add\("hidden"\)/.test(start));
    const blocks = CSS_CLEAN.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
    const rm = blocks.find(b => /screen-leaving/.test(b) && /screenEnter/.test(CSS_CLEAN));
    check('6.2 CSS reduced-motion содержит screen-leaving', !!rm);
    check('6.3 CSS animation none !important', !!rm && /animation:\s*none\s*!important/.test(rm));
}

console.log('\n=== 7. ХАРАКТЕР АНИМАЦИИ + CACHE ===');
{
    const enter = /@keyframes screenEnter\s*\{[\s\S]*?\n\}/.exec(CSS_CLEAN);
    const leave = /@keyframes screenLeave\s*\{[\s\S]*?\n\}/.exec(CSS_CLEAN);
    check('7.1 enter opacity + 10px', !!enter && /opacity:\s*0/.test(enter[0]) && /translateY\(10px\)/.test(enter[0]));
    check('7.2 leave opacity + 8px', !!leave && /opacity:\s*0/.test(leave[0]) && /translateY\(8px\)/.test(leave[0]));
    check('7.3 без scale/blur/filter в screen keyframes',
        !!enter && !!leave && !/scale\(|blur\(|filter:/.test(enter[0] + leave[0]));
    check('7.4 style cache >= 41', Number((/style\.css\?v=(\d+)/.exec(HTML) || [])[1]) >= 41);
    check('7.5 script cache >= 228', Number((/script\.js\?v=(\d+)/.exec(HTML) || [])[1]) >= 228);
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed ? 1 : 0);

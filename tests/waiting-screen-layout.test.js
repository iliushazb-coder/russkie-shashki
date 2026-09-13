const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
let passed = 0;
let failed = 0;

function check(name, condition) {
  console.log((condition ? '  ✅ ' : '  ❌ ') + name);
  condition ? passed++ : failed++;
}

const match = html.match(/<div id="waiting-screen" class="hidden">([\s\S]*?)<\/div>\s*\n\s*<div id="game-screen"/);
check('waiting-screen block is present', !!match);

if (match) {
  const block = match[1];
  const linkPos = block.indexOf('id="invite-link-box"');
  const statusPos = block.indexOf('id="waiting-text"');
  const sharePos = block.indexOf('id="btn-share-link"');
  const backPos = block.indexOf('id="btn-back-from-waiting"');

  check('order is link -> waiting status -> share -> back',
    linkPos !== -1 && statusPos > linkPos && sharePos > statusPos && backPos > sharePos);

  const waitingTextTag = block.match(/<p id="waiting-text"[^>]*>/);
  check('waiting-text has no inline style attribute (styling belongs in style.css)',
    !!waitingTextTag && !/style\s*=/.test(waitingTextTag[0]));

  check('waiting Back button has no extra inline margin-top',
    !/id="btn-back-from-waiting"[^>]*margin-top/.test(block));
}

const cssRule = css.match(/#waiting-text\s*\{([\s\S]*?)\}/);
check('#waiting-text rule is present in style.css', !!cssRule);

if (cssRule) {
  const rule = cssRule[1];
  check('waiting status is 18px (in style.css)', /font-size:\s*18px/.test(rule));
  check('waiting status is centered (in style.css)', /text-align:\s*center/.test(rule));
  check('waiting status resets default paragraph margin (in style.css)', /margin:\s*0/.test(rule));
}

check('stylesheet cache-bust is v21', /<link rel="stylesheet" href="style\.css\?v=21">/.test(html));
check('script cache-bust remains v209', /<script src="script\.js\?v=209"><\/script>/.test(html));

console.log(`\nИТОГ waiting-screen layout: ${passed}/${passed + failed}`);
if (failed) process.exitCode = 1;

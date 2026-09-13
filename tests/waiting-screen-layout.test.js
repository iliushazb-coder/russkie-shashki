const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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
  check('waiting status is 18px', /id="waiting-text"[^>]*font-size:\s*18px/.test(block));
  check('waiting status is centered', /id="waiting-text"[^>]*text-align:\s*center/.test(block));
  check('waiting status resets default paragraph margin', /id="waiting-text"[^>]*margin:\s*0/.test(block));
  check('waiting Back button has no extra inline margin-top',
    !/id="btn-back-from-waiting"[^>]*margin-top/.test(block));
}

check('script cache-bust remains v209', /<script src="script\.js\?v=209"><\/script>/.test(html));

console.log(`\nWAITING_LAYOUT_RESULT: ${passed}/${passed + failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;

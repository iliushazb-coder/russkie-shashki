// №42-B2b: role=dialog/aria-modal + focus management для ВЛОЖЕННОЙ пары
// stats-modal / bot-details-modal. Ключевой structural fact, проверенный
// на реальном main перед реализацией: это DOM-siblings (bot-details-modal
// -- отдельный <div>, физически ПОСЛЕ закрывающего тега stats-modal, не
// внутри него). Именно поэтому здесь НЕ вводится modal stack/pause-resume
// -- существующий B1/B2a openModal()/closeModal(), с per-modal keydown-
// listener'ом на самом узле, уже даёт корректную изоляцию: события внутри
// bot-details-modal физически не всплывают до listener'а stats-modal,
// поскольку они не в отношении предок-потомок.

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

console.log('=== 1. role=dialog + aria-modal на обоих ===');
for (const id of ['stats-modal', 'bot-details-modal']) {
  const tag = modalTag(id);
  check(`${id}: role="dialog"`, /role="dialog"/.test(tag));
  check(`${id}: aria-modal="true"`, /aria-modal="true"/.test(tag));
}

console.log('=== 2. aria-labelledby: статичный у bot-details, начальное значение у stats ===');
check('bot-details-modal: aria-labelledby="bot-details-title"',
  /aria-labelledby="bot-details-title"/.test(modalTag('bot-details-modal')));
check('bot-details-title реально существует в разметке', /id="bot-details-title"/.test(HTML));
check('stats-modal: начальный aria-labelledby="stats-title-online" (совпадает с дефолтной активной вкладкой в static HTML)',
  /aria-labelledby="stats-title-online"/.test(modalTag('stats-modal')));
check('stats-tab-online реально активна по умолчанию в static HTML (dial совпадает с label)',
  /id="stats-tab-online" class="stats-tab-btn stats-tab-active"/.test(HTML));

console.log('=== 3. review fix: aria-labelledby обновляется динамически в РЕАЛЬНЫХ tab-switch handler\'ах ===');
// stats-modal сохраняет последнюю выбранную вкладку между открытиями
// (openStatsModal() её не сбрасывает -- проверено отдельно ниже), поэтому
// aria-labelledby обязан синхронизироваться с фактически видимым заголовком
// НЕ только при открытии, а при КАЖДОМ переключении вкладки.
{
  const onlineHandlerStart = SRC.indexOf('statsTabOnline.addEventListener("click", function () {');
  const botHandlerStart = SRC.indexOf('statsTabBot.addEventListener("click", function () {');
  if (onlineHandlerStart === -1) throw new Error('statsTabOnline click handler not found');
  if (botHandlerStart === -1) throw new Error('statsTabBot click handler not found');
  const onlineHandlerBody = SRC.slice(onlineHandlerStart, SRC.indexOf('});', onlineHandlerStart));
  const botHandlerBody = SRC.slice(botHandlerStart, SRC.indexOf('});', botHandlerStart));
  check('клик на "Онлайн": statsModal.setAttribute("aria-labelledby", "stats-title-online")',
    /statsModal\.setAttribute\("aria-labelledby",\s*"stats-title-online"\)/.test(onlineHandlerBody));
  check('клик на "С ботом": statsModal.setAttribute("aria-labelledby", "stats-title-bot")',
    /statsModal\.setAttribute\("aria-labelledby",\s*"stats-title-bot"\)/.test(botHandlerBody));
}

console.log('=== 4. review fix: openStatsModal() НЕ сбрасывает выбранную вкладку -- нельзя жёстко считать Online всегда initial ===');
{
  const osStart = SRC.indexOf('function openStatsModal()');
  if (osStart === -1) throw new Error('openStatsModal not found');
  let depth = 0, i = SRC.indexOf('{', osStart), end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const osBody = SRC.slice(osStart, end + 1);
  check('openStatsModal() НЕ трогает stats-tab-active (подтверждает: активная вкладка -- persistent state, не сбрасывается при открытии)',
    !/stats-tab-active/.test(osBody));
  check('openStatsModal() использует openModal(statsModal), не прямой classList',
    /openModal\(statsModal\)/.test(osBody));
}

console.log('=== 5. initial-focus: btn-stats-close выбран КАК ЕДИНСТВЕННЫЙ корректный вариант независимо от активной вкладки ===');
{
  const statsBlock = HTML.slice(HTML.indexOf('<div id="stats-modal"'), HTML.indexOf('<div id="bot-details-modal"'));
  check('stats-modal: data-modal-initial-focus на btn-stats-close (НЕ на stats-tab-online -- та может быть не активна при переоткрытии)',
    /id="btn-stats-close"[^>]*data-modal-initial-focus/.test(statsBlock));
  check('stats-tab-online/stats-tab-bot НЕ имеют data-modal-initial-focus (не единственно верный дефолт -- зависит от persisted состояния)',
    !/id="stats-tab-online"[^>]*data-modal-initial-focus/.test(statsBlock) && !/id="stats-tab-bot"[^>]*data-modal-initial-focus/.test(statsBlock));
}
check('bot-details-modal: data-modal-initial-focus на btn-bot-details-close (единственная кнопка)',
  /id="btn-bot-details-close"[^>]*data-modal-initial-focus/.test(HTML.slice(HTML.indexOf('<div id="bot-details-modal"'))));

console.log('=== 6. Escape -- оба делегируют РЕАЛЬНЫМ safe close handler\'ам ===');
check('stats-modal: data-modal-escape на btn-stats-close',
  /id="btn-stats-close"[^>]*data-modal-escape/.test(HTML.slice(HTML.indexOf('<div id="stats-modal"'), HTML.indexOf('<div id="bot-details-modal"'))));
check('bot-details-modal: data-modal-escape на btn-bot-details-close',
  /id="btn-bot-details-close"[^>]*data-modal-escape/.test(HTML.slice(HTML.indexOf('<div id="bot-details-modal"'))));

console.log('=== 7. пункт 1/2 задания: единственный open/close путь у каждого (перепроверено на этом коммите) ===');
check('openBotDetailsModal ровно 1 вызов (единственный production open path)',
  (SRC.match(/openBotDetailsModal\(/g) || []).length === 2); // 1 вызов + 1 определение
check('renderBotStatsRow (единственный источник клика, открывающего bot-details) ровно 1 call site',
  (SRC.match(/renderBotStatsRow\(/g) || []).length === 2); // 1 вызов + 1 определение
check('statsModal.classList (сырой) отсутствует нигде, кроме самого helper\'а openModal/closeModal',
  (SRC.match(/(?<!function openModal\(modal, options\) \{[\s\S]{0,600})statsModal\.classList/g) || []).length === 0);

console.log('=== 8. review fix: DOM-структурный факт -- siblings, не nested (обоснование "без stack") ===');
{
  const statsIdx = HTML.indexOf('<div id="stats-modal"');
  const detailsIdx = HTML.indexOf('<div id="bot-details-modal"');
  const between = HTML.slice(statsIdx, detailsIdx);
  // Если бы bot-details-modal был ВНУТРИ stats-modal, между их открывающими
  // тегами не было бы закрывающего "</div>" верхнего уровня stats-modal.
  const statsModalBoxCloses = (between.match(/\n    <\/div>/g) || []).length;
  check('bot-details-modal физически идёт ПОСЛЕ закрытия stats-modal в разметке (siblings, не nested)',
    statsModalBoxCloses >= 1, `найдено закрытий: ${statsModalBoxCloses}`);
}

console.log('=== 9. real openModal/closeModal helper -- владеет visibility (переиспользуется без изменений) ===');
const OPEN_BODY = helperBody('openModal');
const CLOSE_BODY = helperBody('closeModal');
check('openModal() по-прежнему единственная реализация (не задвоена ради nested)',
  (SRC.match(/function openModal\(modal, options\)/g) || []).length === 1);
check('closeModal() по-прежнему единственная реализация (не задвоена ради nested)',
  (SRC.match(/function closeModal\(modal\)/g) || []).length === 1);
check('closeModal() всё ещё содержит activeInsideOtherOpenModal (B2a fix переиспользуется, не переписан)',
  /activeInsideOtherOpenModal/.test(CLOSE_BODY));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

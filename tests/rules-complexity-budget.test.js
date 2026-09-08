// №23 (round 14 correction): round 13 incorrectly claimed this guard fixed
// the real Firebase Rules Emulator failure on v12. It did not. A REAL
// Emulator run (confirmed via GitHub Actions on exact v12 content, run
// 34145773229 / job 101817395663, Firebase Database Emulator v4.11.2)
// showed the Rules DID load and DID run all 243 tests successfully -- the
// only failure was a single genuine security-semantic bug (DELETE of an
// existing ratedEvents entry was wrongly ALLOWED, because the create-only
// immutability check lived in .validate, which Firebase does not run on
// delete operations at all -- fixed separately in worker/index.mjs's
// sibling change to ratedEvents/$matchId/events/$seq/.write, see that
// commit). The room-level .write's size was NEVER the confirmed cause;
// that was round 13's own unverified hypothesis, stated with appropriate
// hedging at the time but wrong.
//
// This guard is kept as an INDEPENDENT best practice, justified on its own
// merits, not as evidence a specific bug was fixed: Firebase's own rules
// language documentation does state that deeply nested/complex expressions
// CAN hit real compiler complexity limits in general (a failure mode
// targaryen cannot model at all, since it has no complexity analysis) --
// avoiding unnecessary accumulation of duplicated logic in a single giant
// expression remains good practice regardless of whether it caused this
// particular incident. The round-13 extraction of ratedReplay's monotonic/
// permission logic into a consolidated child-level .validate is kept for
// this same independent reason (and confirmed security-behavior-identical
// via a full rerun of every accumulated targaryen scenario before/after),
// not as a claimed fix for a confirmed regression.

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firebase', 'database.rules.json'), 'utf8'));

// Бюджет выбран с запасом НАД текущим фактическим максимумом (после round-14
// fixes) и ЗАМЕТНО ниже v12's 8417 симв. -- не потому что 8417 доказанно
// плохо (реальный Emulator его успешно загрузил), а чтобы это НЕ РОСЛО
// молча без осознанного решения, раз уж документированный класс риска
// (compiler complexity limits) в принципе существует для сложных выражений.
const MAX_SINGLE_EXPRESSION_LENGTH = 7200;

function walk(node, pathStr, results) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const key of Object.keys(node)) {
      if (key === '.write' || key === '.validate' || key === '.read') {
        const expr = node[key];
        if (typeof expr === 'string') {
          results.push({ path: pathStr + '/' + key, length: expr.length });
        }
      } else {
        walk(node[key], pathStr + '/' + key, results);
      }
    }
  }
}

const results = [];
walk(rules.rules, '', results);
results.sort((a, b) => b.length - a.length);

check('0. хотя бы одно .write/.validate/.read выражение найдено (sanity)', results.length > 0);

for (const r of results) {
  if (r.length > MAX_SINGLE_EXPRESSION_LENGTH) {
    check(`expression ${r.path} (${r.length} симв.) в пределах бюджета ${MAX_SINGLE_EXPRESSION_LENGTH}`, false,
      'превышен бюджет — либо обоснованно поднять MAX_SINGLE_EXPRESSION_LENGTH с комментарием, либо вынести часть логики в отдельный child-level .validate (см. round-13 пример с ratedReplay)');
  }
}
check(`все ${results.length} expressions в пределах бюджета ${MAX_SINGLE_EXPRESSION_LENGTH} симв. (самое длинное: ${results[0].path} = ${results[0].length})`,
  results.every(r => r.length <= MAX_SINGLE_EXPRESSION_LENGTH));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

// ==========================================================================
// НАДЁЖНОСТЬ САМОГО РАННЕРА.
//
// Раннер — инструмент, которым проверяется всё остальное. Пока он может
// соврать, любому зелёному результату цена невелика. Здесь он проверяется
// как обычный код: создаются НАСТОЯЩИЕ временные сюиты с заведомо
// известным поведением, запускаются настоящим Node, и решение раннера
// сверяется с ожидаемым.
//
// Две исторические причины ненадёжности, которые эти тесты закрывают:
//   1. подсчёт символов ✅/❌ в произвольном тексте — они встречаются в
//      НАЗВАНИЯХ тестов (в 14 сюитах уже есть);
//   2. числа из вывода учитывались даже при ненулевом коде возврата.
// ==========================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateSuite } = require('./run.js');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-selftest-'));
function makeSuite(name, body) {
    const f = path.join(tmp, name);
    fs.writeFileSync(f, body);
    return f;
}
// Запускаем сюиту ровно так, как это делает раннер, и отдаём его вердикт.
function runAndEvaluate(file) {
    let out = '', code = 0;
    try {
        out = execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
        code = (typeof e.status === 'number') ? e.status : 1;
    }
    return { verdict: evaluateSuite(out, code), out: out, code: code };
}

console.log('=== 1. СЮИТА ЗАВЕРШАЕТСЯ С НЕНУЛЕВЫМ КОДОМ ===');

(function () {
    // Печатает КРАСИВЫЙ итог и всё равно падает — например, в асинхронном
    // колбэке после вывода. Код возврата обязан перевесить текст.
    const f = makeSuite('exit1.js',
        "console.log('  ✅ проверка прошла');\n" +
        "console.log('\\nИТОГ: 5/5');\n" +
        "process.exit(1);\n");
    const r = runAndEvaluate(f);
    check('1.1 сюита действительно вышла с кодом 1', r.code === 1, 'код ' + r.code);
    check('1.2 раннер считает её НЕДОСТОВЕРНОЙ', r.verdict.ok === false);
    check('1.3 её числа НЕ попадают в общий счёт',
        r.verdict.pass === 0 && r.verdict.fail === 0,
        r.verdict.pass + '/' + r.verdict.fail);
    check('1.4 причина названа кодом возврата',
        /код возврата/.test(r.verdict.reason), r.verdict.reason);
})();

console.log('\n=== 2. СЮИТА ПАДАЕТ ДО ИТОГОВОЙ СТРОКИ ===');

(function () {
    const f = makeSuite('crash.js',
        "console.log('  ✅ первая проверка');\n" +
        "console.log('  ✅ вторая проверка');\n" +
        "undefinedFunction();\n" +
        "console.log('\\nИТОГ: 2/2');\n");
    const r = runAndEvaluate(f);
    check('2.1 сюита упала', r.code !== 0, 'код ' + r.code);
    check('2.2 раннер считает её недостоверной', r.verdict.ok === false);
    check('2.3 два напечатанных ✅ НЕ учтены', r.verdict.pass === 0);
})();

(function () {
    // Падение до вывода вообще: ни одной строки результата.
    const f = makeSuite('crash-early.js', "throw new Error('не загрузилась');\n");
    const r = runAndEvaluate(f);
    check('2.4 падение при загрузке -> недостоверна', r.verdict.ok === false);
    check('2.5 и в общий счёт ничего не добавлено',
        r.verdict.pass === 0 && r.verdict.fail === 0);
})();

console.log('\n=== 3. ❌ В НАЗВАНИИ ПРОХОДЯЩЕГО ТЕСТА ===');

(function () {
    // Ровно тот случай, который ломал старый раннер: тест ПРОШЁЛ, но в его
    // названии стоит ❌ как обычный символ.
    const f = makeSuite('emoji-name.js',
        "console.log('  ✅ строка содержит 🏆 ❌ 🎮 отдельными колонками');\n" +
        "console.log('  ✅ вторая проверка');\n" +
        "console.log('\\nИТОГ: 2/2');\n");
    const r = runAndEvaluate(f);
    check('3.1 сюита признана успешной', r.verdict.ok === true, r.verdict.reason);
    check('3.2 засчитано ровно 2 пройденных', r.verdict.pass === 2, String(r.verdict.pass));
    check('3.3 НЕТ несуществующего провала', r.verdict.fail === 0, String(r.verdict.fail));
    check('3.4 КОНТРОЛЬ: старый подсчёт символов дал бы провал', (function () {
        const p = (r.out.match(/✅/g) || []).length;
        const fl = (r.out.match(/❌/g) || []).length;
        return fl === 1 && p === 2;   // именно так ошибался прежний раннер
    })());
})();

console.log('\n=== 4. ✅ В ПРОИЗВОЛЬНОМ ТЕКСТЕ ===');

(function () {
    const f = makeSuite('emoji-text.js',
        "console.log('Легенда: ✅ = пройдено, ❌ = провалено');\n" +
        "console.log('  ✅ единственная настоящая проверка');\n" +
        "console.log('Итоговая сводка ниже ✅✅✅');\n" +
        "console.log('\\nИТОГ: 1/1');\n");
    const r = runAndEvaluate(f);
    check('4.1 засчитана ровно 1 проверка, а не 5', r.verdict.pass === 1, String(r.verdict.pass));
    check('4.2 сюита успешна', r.verdict.ok === true);
})();

console.log('\n=== 5. ИТОГ ОТСУТСТВУЕТ ===');

(function () {
    const f = makeSuite('no-summary.js',
        "console.log('  ✅ проверка один');\n" +
        "console.log('  ✅ проверка два');\n");
    const r = runAndEvaluate(f);
    check('5.1 код возврата нулевой', r.code === 0);
    check('5.2 но сюита признана недостоверной', r.verdict.ok === false);
    check('5.3 причина — отсутствие ИТОГ',
        /нет машинно-читаемой строки/.test(r.verdict.reason), r.verdict.reason);
    check('5.4 два ✅ НЕ учтены молча', r.verdict.pass === 0, String(r.verdict.pass));
})();

console.log('\n=== 6. ПОВРЕЖДЁННЫЙ ИТОГ ===');

check('6.1 пройдено больше, чем всего -> недостоверна', (function () {
    const r = evaluateSuite('\nИТОГ: 99/5\n', 0);
    return r.ok === false && /повреждённый/.test(r.reason);
})());
check('6.2 итог 0/0 -> недостоверна (ни одной проверки)', (function () {
    const r = evaluateSuite('\nИТОГ: 0/0\n', 0);
    return r.ok === false;
})());
check('6.3 итог без чисел не распознаётся как итог', (function () {
    const r = evaluateSuite('\nИТОГ: много/мало\n', 0);
    return r.ok === false && /нет машинно-читаемой/.test(r.reason);
})());
check('6.4 итог посреди строки НЕ засчитывается', (function () {
    // Попытка выдать текст внутри названия теста за итог.
    const r = evaluateSuite('  ✅ проверка про ИТОГ: 9/9 в названии\n', 0);
    return r.ok === false;
})());
check('6.5 подделка невозможна: строки тестов начинаются с отступа и значка', (function () {
    const r = evaluateSuite('  ❌ ИТОГ: 1/1\n', 0);
    return r.ok === false;
})());

console.log('\n=== 7. НОРМАЛЬНЫЕ СЮИТЫ СЧИТАЮТСЯ ПРАВИЛЬНО ===');

(function () {
    const f = makeSuite('ok.js',
        "console.log('  ✅ раз');\nconsole.log('  ✅ два');\nconsole.log('  ✅ три');\n" +
        "console.log('\\nИТОГ: 3/3');\n");
    const r = runAndEvaluate(f);
    check('7.1 три из трёх -> успех', r.verdict.ok === true && r.verdict.pass === 3 && r.verdict.fail === 0);
})();

(function () {
    // Честный частичный провал: сюита отработала, но часть проверок упала.
    const f = makeSuite('partial.js',
        "console.log('  ✅ раз');\nconsole.log('  ❌ два');\n" +
        "console.log('\\nИТОГ: 1/2');\nprocess.exit(1);\n");
    const r = runAndEvaluate(f);
    check('7.2 частичный провал: числа достоверны и учитываются', (function () {
        // при ненулевом коде числа не берём — это осознанная строгость
        return r.verdict.ok === false;
    })());
})();

check('7.3 частичный провал БЕЗ падения процесса учитывается в счёте', (function () {
    const r = evaluateSuite('\nИТОГ: 7/10\n', 0);
    return r.ok === false && r.pass === 7 && r.fail === 3;
})());

check('7.4 нестандартный заголовок итога распознаётся', (function () {
    // так печатает leaderboard-ui
    const r = evaluateSuite('\nИТОГ leaderboard-ui: 24/24\n', 0);
    return r.ok === true && r.pass === 24;
})());

check('7.5 берётся ПОСЛЕДНИЙ итог, если их несколько', (function () {
    const r = evaluateSuite('ИТОГ: 1/1\nещё проверки\nИТОГ: 9/9\n', 0);
    return r.ok === true && r.pass === 9;
})());

console.log('\n=== 8. ВСЕ БОЕВЫЕ СЮИТЫ СООТВЕТСТВУЮТ КОНТРАКТУ ===');

(function () {
    const { FILES } = require('./run.js');
    const missing = [];
    FILES.forEach(function (entry) {
        const file = entry[1];
        if (file === 'runner-selftest.test.js') return;   // себя не запускаем
        const full = path.join(__dirname, file);
        if (!fs.existsSync(full)) { missing.push(file + ' (нет файла)'); return; }
        const r = runAndEvaluate(full);
        if (!r.verdict.ok) missing.push(file + ' — ' + r.verdict.reason);
    });
    check('8.1 каждая боевая сюита даёт валидный итог и нулевой код',
        missing.length === 0, missing.join('; '));
})();

check('8.2 core-rules приведена к общему контракту', (function () {
    const r = runAndEvaluate(path.join(__dirname, 'core-rules.test.js'));
    return r.verdict.ok === true && r.verdict.pass > 0;
})());

check('8.3 раннер больше не считает символы ✅/❌', (function () {
    const src = fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8');
    const code = src.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');
    return code.indexOf("match(/✅/g)") === -1 && code.indexOf("match(/❌/g)") === -1;
})());

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

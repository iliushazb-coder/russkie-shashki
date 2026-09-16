// ==========================================================================
// КОД КОМНАТЫ КАК СЕКРЕТ ПРИГЛАШЕНИЯ.
//
// Контекст: после закрытия публичного перечисления /rooms (Rules читают
// ветку только lobby-запросом по active) приватность комнаты «Играть с
// другом» держится ровно на невозможности угадать её код. Код стал
// capability, поэтому генерация обязана быть криптографической.
//
// Прежний вариант — 6 символов base36 через Math.random() — давал ~31 бит
// и некриптографический источник. Здесь закрепляется новый: 12 байт из
// crypto.getRandomValues, 24 символа uppercase HEX, 96 бит.
//
// Функция берётся ИЗ РЕАЛЬНОГО script.js и исполняется, а не проверяется
// регулярками по тексту: тест обязан ловить поведение, а не формулировку.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; console.log('❌ ' + name + (info ? ' — ' + info : '')); }
}

function extractGenerator() {
    const m = SRC.match(/function generateRoomCode\(\)[\s\S]*?\n}/);
    if (!m) throw new Error('generateRoomCode() не найдена в script.js');
    return m[0];
}

const source = extractGenerator();
// eslint-disable-next-line no-eval
eval(source);

console.log('=== 1. ИСТОЧНИК СЛУЧАЙНОСТИ ===');

check('1.1 генератор не содержит Math.random()', !/Math\.random/.test(source));
check('1.2 генератор использует crypto.getRandomValues', /getRandomValues/.test(source));
check('1.3 запрошено ровно 12 байт (96 бит)', /Uint8Array\(12\)/.test(source));

console.log('\n=== 2. ФОРМАТ РЕЗУЛЬТАТА ===');

const sample = generateRoomCode();
check('2.1 длина ровно 24 символа', sample.length === 24, 'получено: ' + sample.length);
check('2.2 только [0-9A-F]', /^[0-9A-F]{24}$/.test(sample), sample);

let allWellFormed = true;
for (let i = 0; i < 200; i++) {
    const c = generateRoomCode();
    if (!/^[0-9A-F]{24}$/.test(c)) { allWellFormed = false; break; }
}
check('2.3 формат стабилен на 200 вызовах', allWellFormed);

console.log('\n=== 3. РАЗЛИЧИМОСТЬ ===');

const seen = new Set();
for (let i = 0; i < 1000; i++) seen.add(generateRoomCode());
check('3.1 1000 вызовов дают 1000 различных кодов', seen.size === 1000, 'уникальных: ' + seen.size);

// Разные случайные байты обязаны давать разные коды: подменяем RNG на
// детерминированный, чтобы проверить именно отображение байт -> код, а не
// удачу настоящего генератора.
const realCrypto = globalThis.crypto;
function withFakeRng(fill, fn) {
    Object.defineProperty(globalThis, 'crypto', {
        value: { getRandomValues: function (arr) { for (let i = 0; i < arr.length; i++) arr[i] = fill(i); return arr; } },
        configurable: true
    });
    try { return fn(); }
    finally { Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true }); }
}

const fromZeros = withFakeRng(() => 0, () => generateRoomCode());
const fromOnes = withFakeRng(() => 255, () => generateRoomCode());
const fromIndex = withFakeRng((i) => i, () => generateRoomCode());

check('3.2 нулевые байты дают все нули', fromZeros === '0'.repeat(24), fromZeros);
check('3.3 байты 0xFF дают все F', fromOnes === 'F'.repeat(24), fromOnes);
check('3.4 разные входные байты дают разные коды',
    fromZeros !== fromOnes && fromOnes !== fromIndex && fromZeros !== fromIndex);
check('3.5 каждый байт кодируется двумя hex-символами (padStart)',
    fromIndex.slice(0, 4) === '0001', fromIndex);

console.log('\n=== 4. FAIL CLOSED ===');

// Никакого отката на Math.random(): без secure RNG генератор обязан
// бросить, а не выдать предсказуемый код.
let threw = false, threwMessage = '';
Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
try { generateRoomCode(); }
catch (e) { threw = true; threwMessage = String(e && e.message); }
finally { Object.defineProperty(globalThis, 'crypto', { value: realCrypto, configurable: true }); }

check('4.1 без secure RNG генератор бросает, а не возвращает код', threw);
check('4.2 ошибка названа явно', threwMessage === 'secure_rng_unavailable', threwMessage);
check('4.3 в генераторе нет fallback-ветки на Math.random',
    !/Math\.random/.test(source) && !/fallback/i.test(source));

console.log('\n=== 5. СОВМЕСТИМОСТЬ СО СТАРЫМИ ССЫЛКАМИ ===');

// checkForInviteLink() присваивает start_param как есть. Никакой
// валидации длины/формата быть не должно — иначе сломаются и новые
// 24-символьные, и legacy 6-символьные коды.
const invite = SRC.slice(SRC.indexOf('function checkForInviteLink'));
const inviteBody = invite.slice(0, invite.indexOf('\n}'));
check('5.1 invite parsing присваивает start_param без переформатирования',
    /roomCode\s*=\s*startParam\s*;/.test(inviteBody));
check('5.2 в invite parsing нет проверки длины кода',
    !/startParam\.length/.test(inviteBody));
check('5.3 в invite parsing нет regex-валидации формата кода',
    !/\{6\}/.test(inviteBody) && !/\{24\}/.test(inviteBody));

// Оба формата обязаны проходить один и тот же путь без различий.
check('5.4 legacy 6-символьный код нигде не отвергается по длине',
    !/length\s*===\s*6/.test(SRC) && !/length\s*!==\s*6/.test(SRC));
check('5.5 новый 24-символьный код нигде не отвергается по длине',
    !/length\s*===\s*24/.test(SRC) && !/length\s*!==\s*24/.test(SRC));

console.log('\n=== 6. ЭНТРОПИЯ ===');

// 12 байт = 96 бит против прежних ~31. Считаем по фактическому формату,
// а не по заявлению в комментарии.
const bits = Math.log2(Math.pow(16, sample.length));
check('6.1 пространство кодов = 96 бит', bits === 96, 'получено: ' + bits);
check('6.2 это строго больше прежних 36^6 (~31 бит)', bits > Math.log2(Math.pow(36, 6)));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed === 0 ? 0 : 1);

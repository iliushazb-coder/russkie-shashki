// №32: user-facing русские строки вне t(). Проверяет три вещи:
// (1) все новые ключи существуют во ВСЕХ поддерживаемых языках и нигде не
// оставлен русский fallback; (2) render-time локализация подписей
// соперника работает и НЕ трогает реальные имена; (3) persisted RTDB
// fallback-значения намеренно НЕ локализованы на записи (общая база
// хранит нейтральное значение, UI выбирает текст) -- это инвариант, а не
// упущение, поэтому он закреплён тестом.

const fs = require('fs');
const path = require('path');
const { extractFunc } = require('./helpers/loader');

let passed = 0, failed = 0;
function check(n, c, d) { console.log((c ? '  ✅ ' : '  ❌ ') + n + (!c && d ? ' — ' + d : '')); c ? passed++ : failed++; }

const src = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

// ===== 1. словарь: ключи во всех языках =====

function extractLangBlock(lang) {
  const m = src.match(new RegExp('\\n    ' + lang + ': \\{([\\s\\S]*?)\\n    \\},'));
  if (!m) throw new Error('language block not found: ' + lang);
  return m[1];
}

const LANGS = ['ru', 'en', 'it'];
const NEW_KEYS = ['err_opponent_left', 'err_room_unavailable', 'friend_connected', 'waiting_for_opponent'];
const blocks = {};
for (const lang of LANGS) blocks[lang] = extractLangBlock(lang);

console.log('=== 1. новые ключи присутствуют во всех языках ===');
for (const key of NEW_KEYS) {
  for (const lang of LANGS) {
    check(`${key} есть в ${lang}`, new RegExp('\\b' + key + ':').test(blocks[lang]));
  }
}

console.log('=== 2. в en/it не оставлен русский текст для новых ключей ===');
for (const key of NEW_KEYS) {
  for (const lang of ['en', 'it']) {
    const m = blocks[lang].match(new RegExp('\\b' + key + ':\\s*"([^"]*)"'));
    check(`${key} в ${lang} не содержит кириллицы`, !!m && !/[а-яА-ЯёЁ]/.test(m[1]), m ? m[1] : 'ключ не найден');
  }
}

// ===== 3. прямых user-facing литералов больше нет =====

console.log('=== 3. подтверждённые user-facing литералы убраны из кода ===');
check('нет showInfoModal("Соперник покинул игру.")', src.indexOf('showInfoModal("Соперник покинул игру.') === -1);
check('нет showInfoModal("Комната уже занята...")', src.indexOf('showInfoModal("Комната уже занята') === -1);
check('waitingText не присваивается литералом "Ожидание подключения друга..."', src.indexOf('waitingText.textContent = "Ожидание подключения друга') === -1);
check('waitingText не присваивается литералом "Друг подключился!..."', src.indexOf('waitingText.textContent = "Друг подключился') === -1);
// review fix: используем УЖЕ СУЩЕСТВОВАВШИЙ до №32 ключ waiting_friend
// (ru "Ожидание подключения друга..." -- буквально тот же текст, что был
// захардкожен), а не новый дублирующий waiting_for_friend.
check('waiting UI использует существующий t("waiting_friend")',
  (src.match(/waitingText\.textContent = t\("waiting_friend"\)/g) || []).length === 2);
check('candidate НЕ создаёт дублирующий ключ waiting_for_friend',
  src.indexOf('waiting_for_friend') === -1);
for (const lang of LANGS) {
  check(`существующий ключ waiting_friend на месте в ${lang}`, /\bwaiting_friend:/.test(blocks[lang]));
}
check('waiting UI использует t("friend_connected")', src.indexOf('waitingText.textContent = t("friend_connected")') !== -1);

// ===== 4. persisted RTDB значения НЕ локализованы (инвариант) =====

console.log('=== 4. persisted RTDB fallback значения намеренно НЕ локализованы на записи ===');
check('opponentName пишется нейтральным stored значением (не t(...)) в createOnlineRoom',
  /opponentName: "Ожидание соперника\.\.\."/.test(src));
check('opponentName пишется нейтральным stored значением (не t(...)) в createRoomAndShowWaiting',
  /opponentName: "Ожидание подключения\.\.\."/.test(src));
check('ни одна запись opponentName не использует t(...)', !/opponentName:\s*t\(/.test(src));

// ===== 5. loadActiveRooms: source of truth -- room.players, а НЕ persisted opponentName =====
//
// review fix: users/<uid>/rooms/<code>/opponentName принимает И waiting-заглушки,
// И настоящие имена (myTelegramName / creatorName) -- schema их не различает,
// поэтому распознавать заглушку ПО ТЕКСТУ принципиально небезопасно: реальный
// пользователь Telegram с display name "Ожидание соперника..." неотличим от
// заглушки. Строка попадает в список только при isValidActiveGame, где оба
// игрока уже доказаны (id непусты и различны), поэтому имя берётся напрямую из
// room.players, а соперник определяется ПО UID.

console.log('=== 5. реальный loadActiveRooms: имя из room.players, соперник по UID ===');

const MY_ID = 'ME';
const NOW = 1700000000000;

// Строка берётся ИЗ production-исходника, чтобы тест не проверял сам себя.
const OPPONENT_PICK_LINES = (function () {
  const m = /^\s*const opponentPlayer = .*$\n^\s*items\.push\(\{ code: code, opponent: .*$/m.exec(src);
  if (!m) throw new Error('opponentPlayer/items.push lines not found in script.js');
  return m[0];
})();

function pickOpponentName(opts) {
  const lightP = { id: opts.lightId, name: opts.lightName };
  const darkP = { id: opts.darkId, name: opts.darkName };
  const sandbox = {
    currentLang: opts.lang, myTelegramId: MY_ID, lightP: lightP, darkP: darkP,
    code: 'R1', items: [],
    data: { R1: { opponentName: opts.persistedOpponentName, myColor: opts.myColor } }
  };
  const names = Object.keys(sandbox);
  const body = `
    ${/const translations = \{[\s\S]*?\n\};/.exec(src)[0]}
    ${extractFunc('t')}
    ${OPPONENT_PICK_LINES}
    return items[0].opponent;
  `;
  return new Function(...names, body)(...names.map(n => sandbox[n]));
}

function asLight(oppName, lang, persisted) {
  return pickOpponentName({ lightId: MY_ID, lightName: 'Я', darkId: 'OPP', darkName: oppName,
                            myColor: 'light', lang: lang, persistedOpponentName: persisted });
}
function asDark(oppName, lang, persisted) {
  return pickOpponentName({ lightId: 'OPP', lightName: oppName, darkId: MY_ID, darkName: 'Я',
                            myColor: 'dark', lang: lang, persistedOpponentName: persisted });
}

check('5.1 обычное имя соперника отображается как есть', asLight('Иван', 'en') === 'Иван');

// Ключевая группа: реальные имена, буквально совпадающие с бывшими sentinel'ами.
const trickyNames = ['Ожидание соперника...', 'Ожидание подключения...', 'Ожидание...', 'Соперник'];
for (const nm of trickyNames) {
  for (const lang of ['ru', 'en', 'it']) {
    check(`5.x реальное имя ${JSON.stringify(nm)} остаётся literal (${lang})`,
      asLight(nm, lang) === nm, String(asLight(nm, lang)));
  }
}

check('5.2 пустое имя соперника -> localized opponent_default (en)',
  asLight('', 'en') === 'Opponent', String(asLight('', 'en')));
check('5.3 отсутствующее имя соперника -> localized opponent_default (it)',
  asLight(undefined, 'it') === 'Avversario', String(asLight(undefined, 'it')));
check('5.4 отсутствующее имя -> localized opponent_default (ru)',
  asLight(null, 'ru') === 'Соперник', String(asLight(null, 'ru')));

// ===== 5b. membership invariant: чужая активная комната не показывается =====
//
// review fix: остальные условия isValidActiveGame доказывают, что комната
// валидна и активна, но НЕ то, что текущий пользователь её участник. Строки
// берутся ИЗ production-исходника, чтобы тест не проверял сам себя.

console.log('=== 5b. membership: чужая активная комната отбрасывается и чистится ===');

const GUARD_LINES = (function () {
  const start = src.indexOf('const isCurrentUserParticipant');
  if (start === -1) throw new Error('isCurrentUserParticipant not found in script.js');
  const vaEnd = src.indexOf('\n', src.indexOf('const isValidActiveGame', start));
  return src.slice(start, vaEnd);
})();

const DISPATCH_LINES = (function () {
  const m = /^\s*if \(isValidActiveGame\) \{[\s\S]*?^\s*\} else \{\n^\s*database\.ref\("users\/" \+ myTelegramId \+ "\/rooms\/" \+ code\)\.remove\(\);\n^\s*\}/m.exec(src);
  if (!m) throw new Error('isValidActiveGame dispatch block not found in script.js');
  return m[0];
})();

function runMembership(lightId, darkId) {
  const lightP = { id: lightId, name: 'Светлый' };
  const darkP = { id: darkId, name: 'Тёмный' };
  const removes = [];
  const sandbox = {
    currentLang: 'en', myTelegramId: MY_ID, lightP: lightP, darkP: darkP,
    room: { status: 'active' }, code: 'R1', items: [],
    bothPlayersExist: true, differentPlayers: true,
    isStaleRoom: false, isSomeoneOffline: false,
    data: { R1: { opponentName: 'ignored', myColor: 'light' } },
    database: { ref: (p) => ({ remove: () => { removes.push(p); } }) }
  };
  const names = Object.keys(sandbox);
  const body = `
    ${/const translations = \{[\s\S]*?\n\};/.exec(src)[0]}
    ${extractFunc('t')}
    ${GUARD_LINES}
    ${DISPATCH_LINES}
    return { items: items, removes: removes, valid: isValidActiveGame };
  `;
  const fn = new Function(...names, 'removes', body);
  return fn(...names.map(n => sandbox[n]), removes);
}

const asLightMember = runMembership(MY_ID, 'OPP');
check('5b.1 я light -> карточка создана, соперник = dark',
  asLightMember.items.length === 1 && asLightMember.items[0].opponent === 'Тёмный',
  JSON.stringify(asLightMember.items));

const asDarkMember = runMembership('OPP', MY_ID);
check('5b.2 я dark -> карточка создана, соперник = light',
  asDarkMember.items.length === 1 && asDarkMember.items[0].opponent === 'Светлый',
  JSON.stringify(asDarkMember.items));

const stranger = runMembership('OTHER_A', 'OTHER_B');
check('5b.3 я НЕ участник -> isValidActiveGame ложно', stranger.valid === false);
check('5b.4 я НЕ участник -> карточка НЕ создаётся (чужое имя не раскрывается)',
  stranger.items.length === 0, JSON.stringify(stranger.items));
check('5b.5 я НЕ участник -> stale запись удаляется существующим remove path',
  stranger.removes.length === 1 && stranger.removes[0] === 'users/ME/rooms/R1',
  JSON.stringify(stranger.removes));

console.log('=== 6. обе стороны: соперник определяется по UID, не по myColor ===');
check('6.1 я light -> вижу имя dark', asLight('Татьяна', 'en') === 'Татьяна');
check('6.2 я dark -> вижу имя light', asDark('Татьяна', 'en') === 'Татьяна');
check('6.3 я dark, соперник с "опасным" именем -> literal',
  asDark('Ожидание соперника...', 'en') === 'Ожидание соперника...');

console.log('=== 7. КЛЮЧЕВОЙ regression: persisted sentinel игнорируется в пользу room.players ===');
const key1 = asLight('Иван', 'en', 'Ожидание соперника...');
check('7.1 persisted opponentName="Ожидание соперника...", room.players.name="Иван" -> показывается Иван',
  key1 === 'Иван', String(key1));
const key2 = asLight('Иван', 'ru', 'Ожидание подключения...');
check('7.2 то же на ru -> Иван, а не заглушка', key2 === 'Иван', String(key2));
const key3 = asDark('Мария', 'it', 'Ожидание...');
check('7.3 то же со стороны dark -> Мария', key3 === 'Мария', String(key3));

console.log('=== 8. spectator: реальное players.*.name остаётся literal, пустой слот -> waiting ===');

const SPECTATOR_NAME_LINES = (function () {
  const m = /^\s*let lightName = .*$\n^\s*let darkName = .*$/m.exec(src);
  if (!m) throw new Error('spectator lightName/darkName lines not found in script.js');
  return m[0];
})();

function spectatorNames(lightNameValue, darkNameValue, lang) {
  const room = {
    status: 'active',
    players: {
      light: lightNameValue === undefined ? null : { id: 'L', name: lightNameValue },
      dark: darkNameValue === undefined ? null : { id: 'D', name: darkNameValue }
    }
  };
  const sandbox = { currentLang: lang, room: room };
  const names = Object.keys(sandbox);
  const body = `
    ${/const translations = \{[\s\S]*?\n\};/.exec(src)[0]}
    ${extractFunc('t')}
    ${SPECTATOR_NAME_LINES}
    return { lightName: lightName, darkName: darkName };
  `;
  return new Function(...names, body)(...names.map(n => sandbox[n]));
}

for (const nm of trickyNames) {
  for (const lang of ['ru', 'en', 'it']) {
    const r = spectatorNames(nm, 'Другой', lang);
    check(`8.x spectator: реальное имя ${JSON.stringify(nm)} остаётся literal (${lang})`,
      r.lightName === nm, r.lightName);
  }
}
const nullSlot = spectatorNames(undefined, 'Другой', 'en');
check('8.1 spectator: пустой слот -> localized waiting (en)',
  nullSlot.lightName === 'Waiting for an opponent...', nullSlot.lightName);
check('8.2 spectator: пустой слот -> localized waiting (it)',
  spectatorNames(undefined, 'Другой', 'it').lightName === 'In attesa di un avversario...');
check('8.3 spectator: второй игрок с реальным именем не задет', nullSlot.darkName === 'Другой');

console.log('=== 9. неоднозначный text-based helper удалён (не держим мёртвую архитектуру) ===');
check('9.1 localizeOpponentPlaceholder больше не существует в script.js',
  src.indexOf('localizeOpponentPlaceholder') === -1);
check('9.2 sentinel-список удалён', src.indexOf('OPPONENT_WAITING_SENTINELS') === -1);
check('9.3 loadActiveRooms больше не читает data[code].opponentName для отображения',
  !/opponent: [^\n]*data\[code\]\.opponentName/.test(src));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

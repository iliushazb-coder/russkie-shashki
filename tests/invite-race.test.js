// ==========================================================================
// INVITE JOIN RACE — атомарный захват места чёрных.
//
// Прежняя схема: once() -> проверки -> безусловный update(). Двое, прошедшие
// проверки по ОДНОМУ И ТОМУ ЖЕ снимку, оба записывались; побеждал последний,
// а первый оставался на экране партии, где он уже не участник.
//
// Схема 44d3af0 (откачена в 0aef5c0) вела транзакцию по КОРНЮ комнаты. На
// холодном кеше колбэк получает null, для корня это «комнаты нет», возврат
// undefined прерывал транзакцию без похода на сервер, а на втором прерывании
// выдавался err_room_taken БЕЗ проверки — отсюда ложная ошибка.
//
// Здесь транзакция идёт по УЗЛУ МЕСТА rooms/<code>/players/dark, где null —
// легитимное «свободно». Мок воспроизводит реальную семантику SDK, включая
// ПЕРЕЗАПУСК колбэка с серверным значением при расхождении.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info ? '  — ' + info : '')); }
}
function grab(n) {
    const m = new RegExp('^function ' + n + '\\([\\s\\S]*?\\n\\}', 'm').exec(SRC);
    if (!m) throw new Error('не найдена функция ' + n);
    return m[0];
}

global.firebase = { database: { ServerValue: { TIMESTAMP: '__TS__' } } };

// ОДНОШАГОВЫЙ КОНТРАКТ (v7): одна корневая транзакция вместо
// «захват места -> активация». Промежуточного состояния нет.
eval(grab('buildAtomicInviteJoin'));
eval(grab('classifyAtomicInviteJoinFailure'));

// Совместимость с прежними именами в этой сюите: смысл проверок сохраняется,
// меняется только точка входа.
const buildInviteSeatClaim = function (currentSeat, uid, name) {
    const room = { pieces: { x: 1 }, status: 'waiting',
        players: { light: { id: 'A' }, dark: currentSeat || null } };
    const r = buildAtomicInviteJoin(room, uid, name);
    return r === undefined ? undefined : r.players.dark;
};
const classifyInviteClaimFailure = classifyAtomicInviteJoinFailure;

console.log('=== 1. ЧИСТАЯ ЛОГИКА ЗАХВАТА МЕСТА ===');

check('1.1 свободное место (null) занимается', (function () {
    const r = buildInviteSeatClaim(null, 'B', 'Боря');
    return r && r.id === 'B' && r.name === 'Боря';
})());
check('1.2 холодный кеш не отличается от свободного места', (function () {
    // Это и есть причина отказа от транзакции по корню комнаты:
    // для узла места null означает «свободно», а не «нет данных».
    return buildInviteSeatClaim(undefined, 'B', 'Боря').id === 'B';
})());
check('1.3 место, занятое другим, НЕ перезаписывается',
    buildInviteSeatClaim({ id: 'C', name: 'Ц' }, 'B', 'Боря') === undefined);
check('1.4 повторный вход того же игрока идемпотентен', (function () {
    // Одношаговый контракт: комната уже active с нами — возвращается без
    // изменений, повторная запись безвредна.
    const room = { pieces: { x: 1 }, status: 'active',
        players: { light: { id: 'A' }, dark: { id: 'B', name: 'Боря' } } };
    const r = buildAtomicInviteJoin(room, 'B', 'Боря');
    return r === room;
})());
check('1.5 пустой объект без id считается свободным местом',
    buildInviteSeatClaim({}, 'B', 'Боря').id === 'B');

console.log('\n=== 2. КЛАССИФИКАЦИЯ ОТКАЗА — ПО СЕРВЕРУ, А НЕ ПО ПРЕРЫВАНИЮ ===');

function room(o) {
    o = o || {};
    return Object.assign({
        pieces: { '5_0': { color: 'light' } }, turn: 'light', status: 'waiting',
        players: Object.assign({ light: { id: 'A', name: 'Аня' } }, o.players || {})
    }, o.over || {});
}
check('2.1 место наше И комната active -> won',
    classifyInviteClaimFailure(
        room({ players: { dark: { id: 'B' } }, over: { status: 'active' } }), 'B') === 'won');
check('2.1b место наше, но комната ещё waiting -> НЕ won', (function () {
    // В одношаговом контракте waiting с нашим dark означает незавершённый
    // вход, а не успех: комната обязана стать active той же транзакцией.
    return classifyInviteClaimFailure(room({ players: { dark: { id: 'B' } } }), 'B') !== 'won';
})());
check('2.2 место чужое -> occupied',
    classifyInviteClaimFailure(room({ players: { dark: { id: 'C' } } }), 'B') === 'occupied');
check('2.3 комнаты нет -> missing', classifyInviteClaimFailure(null, 'B') === 'missing');
check('2.4 комната без pieces -> missing',
    classifyInviteClaimFailure({ players: {}, status: 'waiting' }, 'B') === 'missing');
check('2.5 комната уже active -> not_waiting',
    classifyInviteClaimFailure(room({ over: { status: 'active' } }), 'B') === 'not_waiting');
check('2.6 моя же комната -> self',
    classifyInviteClaimFailure(room(), 'A') === 'self');
check('2.7 свободно и ждёт -> unknown (ложное прерывание)',
    classifyInviteClaimFailure(room(), 'B') === 'unknown');
check('2.8 unknown НИКОГДА не означает "занято"', (function () {
    // Ровно эта подмена ломала схему 44d3af0.
    return classifyInviteClaimFailure(room(), 'B') !== 'occupied';
})());

console.log('\n=== 3. ПРОМЕЖУТОЧНОГО СОСТОЯНИЯ БОЛЬШЕ НЕ СУЩЕСТВУЕТ ===');

// Двухфазная схема оставляла на сервере отдельно закоммиченное место, из-за
// чего требовалась уборка по таймауту — и каждая её версия рождала новую
// гонку: место-призрак, active без чёрных, вырезанный из завершённой партии
// игрок. Одношаговая транзакция не создаёт такого состояния в принципе.

check('3.1 захват места и активация — ОДНА запись', (function () {
    const room = { pieces: { x: 1 }, status: 'waiting', players: { light: { id: 'A' } } };
    const r = buildAtomicInviteJoin(room, 'B', 'Боря');
    return r && r.players.dark.id === 'B' && r.status === 'active' &&
        r.turnStartedAt === '__TS__';
})());
check('3.2 отказ НЕ оставляет частичной записи', (function () {
    // Комната занята другим: возвращается undefined, то есть на сервер не
    // уходит ничего вообще.
    const room = { pieces: { x: 1 }, status: 'waiting',
        players: { light: { id: 'A' }, dark: { id: 'C' } } };
    return buildAtomicInviteJoin(room, 'B', 'Боря') === undefined;
})());
check('3.3 завершённая партия не воскрешается', (function () {
    const room = { pieces: { x: 1 }, status: 'active', winner: 'light',
        players: { light: { id: 'A' }, dark: { id: 'B' } } };
    return buildAtomicInviteJoin(room, 'B', 'Боря') === undefined;
})());
check('3.4 исчезнувшая комната не создаётся заново',
    buildAtomicInviteJoin(null, 'B', 'Боря') === undefined);
check('3.5 огрызок без pieces не принимается',
    buildAtomicInviteJoin({ players: {}, status: 'waiting' }, 'B', 'Боря') === undefined);
check('3.5b комната в неизвестном статусе не занимается', (function () {
    // Ни waiting, ни active — например, промежуточный или чужой статус.
    const room = { pieces: { x: 1 }, status: 'matchmaking',
        players: { light: { id: 'A' } } };
    return buildAtomicInviteJoin(room, 'B', 'Боря') === undefined;
})());
check('3.5c active-комната БЕЗ нашего места не занимается', (function () {
    const room = { pieces: { x: 1 }, status: 'active',
        players: { light: { id: 'A' } } };
    return buildAtomicInviteJoin(room, 'B', 'Боря') === undefined;
})());
check('3.6 игра с самим собой запрещена', (function () {
    const room = { pieces: { x: 1 }, status: 'waiting', players: { light: { id: 'A' } } };
    return buildAtomicInviteJoin(room, 'A', 'Аня') === undefined;
})());
check('3.7 функций уборки места в коде больше НЕТ', (function () {
    return SRC.indexOf('releaseInviteSeatIfMine') === -1 &&
        SRC.indexOf('shouldReleaseInviteSeat') === -1 &&
        SRC.indexOf('buildInviteSeatRelease') === -1;
})());

console.log('\n=== 4. ГОНКА ДВУХ ГОСТЕЙ НА ОДНОЙ ССЫЛКЕ ===');

// Модель сервера с реальной семантикой транзакции RTDB.
function makeServer(initialRoom) {
    return {
        room: JSON.parse(JSON.stringify(initialRoom)),
        writes: [],
        // Транзакция по узлу места: колбэк сначала с ЛОКАЛЬНЫМ значением
        // (холодный кеш = null), при расхождении с сервером — ПЕРЕЗАПУСК.
        claimSeat: function (uid, name) {
            let res = buildInviteSeatClaim(null, uid, name);   // холодный кеш
            if (res === undefined) return { committed: false };
            const onServer = (this.room.players && this.room.players.dark) || null;
            if (JSON.stringify(onServer) !== JSON.stringify(null)) {
                res = buildInviteSeatClaim(onServer, uid, name);   // перезапуск
                if (res === undefined) return { committed: false };
            }
            this.room.players.dark = res;
            this.writes.push({ who: uid, path: 'players/dark' });
            return { committed: true };
        },
        activate: function (uid) {
            this.room.status = 'active';
            this.room.turnStartedAt = '__TS__';
            this.writes.push({ who: uid, path: 'status' });
        },
        meta: function (uid) { this.writes.push({ who: uid, path: 'users/' + uid }); }
    };
}
const freeRoom = { pieces: { '5_0': { color: 'light' } }, turn: 'light', status: 'waiting',
                   players: { light: { id: 'A', name: 'Аня' } } };

(function () {
    const srv = makeServer(freeRoom);
    // B и C нажали ссылку одновременно: оба прочитали ОДИН И ТОТ ЖЕ снимок,
    // где место свободно, и оба идут захватывать.
    const rB = srv.claimSeat('B', 'Боря');
    const rC = srv.claimSeat('C', 'Циля');

    check('4.1 ровно один захват удался',
        (rB.committed ? 1 : 0) + (rC.committed ? 1 : 0) === 1,
        'B=' + rB.committed + ' C=' + rC.committed);
    check('4.2 победил первый, а не последний', rB.committed === true && rC.committed === false);
    check('4.3 на сервере стоит именно победитель', srv.room.players.dark.id === 'B');
    check('4.4 проигравший НЕ перезаписал победителя', srv.room.players.dark.id !== 'C');

    // Победитель доводит комнату до игры, проигравший не делает ничего.
    if (rB.committed) { srv.activate('B'); srv.meta('B'); }
    if (rC.committed) { srv.activate('C'); srv.meta('C'); }

    check('4.5 проигравший НЕ записал метаданные',
        srv.writes.every(function (w) { return w.who !== 'C'; }),
        JSON.stringify(srv.writes));
    check('4.6 статус активирован ровно один раз',
        srv.writes.filter(function (w) { return w.path === 'status'; }).length === 1);
})();

(function () {
    // Обратный порядок — победитель тот, кто успел первым, кто бы это ни был.
    const srv = makeServer(freeRoom);
    const rC = srv.claimSeat('C', 'Циля');
    const rB = srv.claimSeat('B', 'Боря');
    check('4.7 порядок не зашит: победил тот, кто раньше',
        rC.committed === true && rB.committed === false && srv.room.players.dark.id === 'C');
})();

(function () {
    // Трое одновременно.
    const srv = makeServer(freeRoom);
    const rs = ['B', 'C', 'D'].map(function (u) { return srv.claimSeat(u, u); });
    check('4.8 из троих побеждает ровно один',
        rs.filter(function (r) { return r.committed; }).length === 1);
})();

console.log('\n=== 5. ПОВТОРНЫЙ ВХОД ПОБЕДИТЕЛЯ ИДЕМПОТЕНТЕН ===');

(function () {
    const srv = makeServer(freeRoom);
    srv.claimSeat('B', 'Боря');
    const before = JSON.stringify(srv.room.players.dark);
    const again = srv.claimSeat('B', 'Боря');
    check('5.1 повторный захват тем же игроком проходит', again.committed === true);
    check('5.2 значение места не изменилось',
        JSON.stringify(srv.room.players.dark) === before);
    check('5.3 чужой после этого по-прежнему не может занять',
        srv.claimSeat('C', 'Циля').committed === false);
})();

console.log('\n=== 6. НЕЛЬЗЯ ЗАНЯТЬ НЕПОДХОДЯЩУЮ КОМНАТУ ===');

check('6.1 завершённая партия', (function () {
    const r = room({ over: { status: 'finished', winner: 'light' } });
    return classifyInviteClaimFailure(r, 'B') === 'not_waiting';
})());
check('6.2 брошенная партия отсекается раньше, предикатом v184', (function () {
    // isRoomAbandonedNow вызывается до захвата и не менялся этим патчем.
    return /isRoomAbandonedNow\(room\)/.test(grab('checkForInviteLink'));
})());
check('6.3 занятая комната', classifyInviteClaimFailure(
    room({ players: { dark: { id: 'C' } }, over: { status: 'active' } }), 'B') === 'occupied');

console.log('\n=== 7. КОД: СТРУКТУРА ПОТОКА ===');

const flow = grab('checkForInviteLink').split('\n')
    .filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n');

check('7.1 вход — ОДНА атомарная join-операция (attemptAtomicInviteJoin)',
    /attemptAtomicInviteJoin\(/.test(flow) &&
    !/inviteRoomRef\.transaction\(/.test(flow));
check('7.2 отдельной транзакции по players/dark больше нет',
    flow.indexOf('players/dark') === -1);
check('7.3 безусловного update с players/dark нет',
    flow.indexOf('"players/dark":') === -1);
check('7.4 узкий join-write через update() — у update() нет applyLocally/локального оптимизма в принципе',
    /roomRef\.update\(/.test(grab('claimDarkSeatAndActivate')) &&
    !/\.transaction\(/.test(grab('claimDarkSeatAndActivate')));
check('7.5 прерывание классифицируется, а не считается отказом', (function () {
    return /classifyAtomicInviteJoinFailure/.test(flow);
})());
check('7.6 исчерпание попыток даёт err_join_failed, а НЕ err_room_taken', (function () {
    const i2 = flow.indexOf('inviteJoinAttempts < INVITE_JOIN_MAX_ATTEMPTS');
    const tail = flow.slice(i2, i2 + 400);
    return i2 !== -1 && tail.indexOf('err_join_failed') !== -1 &&
        tail.indexOf('err_room_taken') === -1;
})());
check('7.7 ложное прерывание ПОВТОРЯЕТСЯ, а не превращается в отказ',
    /return startAtomicInviteJoin\(\);/.test(flow));
check('7.8 метаданные и startOnlineGame — только после подтверждения', (function () {
    const f = grab('checkForInviteLink');
    const success = f.indexOf('function finishInviteSuccess');
    return success !== -1 &&
        f.indexOf('users/" + myTelegramId + "/rooms/', success) > success &&
        f.indexOf('startOnlineGame()', success) > success;
})());
check('7.9 turnStartedAt — СЕРВЕРНАЯ метка',
    /turnStartedAt = firebase\.database\.ServerValue\.TIMESTAMP/
        .test(grab('buildAtomicInviteJoin')));
check('7.10 слушатель удерживается и снимается своим колбэком',
    /off\("value", warmHandler\)/.test(grab('checkForInviteLink')));

console.log('\n=== 8. ЧУЖИЕ ПОДСИСТЕМЫ НЕ ЗАТРОНУТЫ ===');

check('8.1 joinGroupRoom по-прежнему устанавливает status=active при join',
    grab('joinGroupRoom').indexOf('claimDarkSeatAndActivate') !== -1 &&
    /status:\s*"active"/.test(grab('claimDarkSeatAndActivate')));
check('8.2 resumeOwnActiveRoom по-прежнему используется для creator/reopen',
    /resumeOwnActiveRoom\(roomCode\)/.test(grab('checkForInviteLink')));
check('8.3 предикат v184 в потоке сохранён',
    /isRoomAbandonedNow/.test(grab('checkForInviteLink')));
check('8.4 CLOCK SAFETY не задет: checkTimeout использует серверное время',
    /getEstimatedServerNow\(\) - currentState\.turnStartedAt/.test(grab('checkTimeout')));

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
process.exit(failed > 0 ? 1 : 0);

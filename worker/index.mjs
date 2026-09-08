/**
 * Dark settlement candidate. Not deployed.
 *
 * Invariants:
 * - caller UID comes from a Firebase ID token verified by the Worker entrypoint;
 * - RTDB access uses a Firebase ID token for uid=srv_settlement, so Rules apply;
 * - receipt + BOTH players' stats are one atomic multi-location PATCH;
 * - receipt is create-only in Rules and is the cross-version idempotency lock;
 * - расчёт партии — ОДНА атомарная операция: квитанция и обе статистики
   одним корневым PATCH. Никаких последующих записей нет, поэтому
   частичного состояния не бывает по построению;
 * - no stats.recentMatches marker is used.
 */

// №23: тот же physical source, что и client (shared/game-engine.js), не
// копия. С №23 Worker функционально использует engine для authoritative
// replay завершённых ходов (Model 3-lite) — см. commitRatedEvent/replayEvents
// ниже. Промежуточные jump-сегменты multi-capture остаются client-side,
// без изменений — Worker подтверждает только ЗАВЕРШЁННЫЙ ход целиком.
import "../shared/game-engine.js";
if (!globalThis.RussianCheckersEngine ||
    typeof globalThis.RussianCheckersEngine.attemptMove !== "function") {
    throw new Error("shared_game_engine_missing");
}
const {
    createInitialPieces,
    getDrawPositionKey,
    attemptMove,
    computeNextDrawState
} = globalThis.RussianCheckersEngine;

const SRV_UID = "srv_settlement";
const ELO_K = 32;
const ELO_START = 1000;

// ===== №23: PROTECTED EVENT LOG + REPLAY (Model 3-lite) =====
//
// Инварианты (согласованная архитектура, 4 раунда reconciliation):
// - Единственный писатель "ratedEvents/$matchId/events/$seq" — srv_settlement
//   (Rules: create-only, без delete-ветки, даже для srv_settlement).
// - "$seq" — fixed-width 6-значный числовой КЛЮЧ УЗЛА, единственный source of
//   truth последовательности; отдельного "seq"-поля внутри события нет.
// - "requestId" — client-generated idempotency identity, персистится внутри
//   immutable-события; retry с тем же requestId возвращает существующий seq.
// - Client НИКОГДА не поставляет authoritative actorUid/color/generation/seq —
//   Worker server-stamps их из verified bearer UID + Worker-owned match card.
// - Промежуточные multi-capture сегменты остаются прямой client-write в
//   rooms/$room (без изменений); ТОЛЬКО завершающий сегмент хода (тот, где
//   attemptMove локально даёт mustContinueFrom===null) идёт через
//   POST /rated/event с ПОЛНЫМ path от начала хода.
// - Draw-state (computeNextDrawState) вызывается Worker'ом РОВНО один раз на
//   completed turn, с movingPieceWasKing, прочитанным из состояния ДО первого
//   сегмента — доказано эмпирически эквивалентным per-segment клиентскому
//   поведению (промоушен mid-chain не создаёт расхождения: wasCapture
//   доминирует над movingPieceWasKing в обоих использующих его выражениях).
// - "rooms/$room/ratedReplay/{matchId,acceptedSeq}" — Worker-owned, monotonic
//   (Rules: acceptedSeq строго numeric > предыдущего), projection-marker;
//   НИКОГДА не источник Elo-истины — только UX-синхронизация.
// - "replayVersion" в match card — Worker-owned migration marker; для
//   replayVersion>=1 "room.winner"/"room.result" НИКОГДА не Elo truth;
//   technical result (timeout/disconnect) для таких матчей fail-closed
//   unrated, пока не появится отдельный server-verifiable technical verifier.

// №23 fix (round 10): найдено на review — round-9's "10-slot reserve"
// доказуемо неполно: reserve ограничивал ТОЛЬКО draw_offer/draw_cancel от
// входа в последние 10 слотов, но НИЧТО не мешало draw-спаму (490) +
// обычным легитимным turn-событиям (10 ещё) вместе достичь потолка 500,
// после чего терминальное событие (resign/final turn/draw_accept) всё
// равно получало бы event_limit_exceeded. Единственный доказуемо
// корректный дизайн — ПОЛНОСТЬЮ РАЗДЕЛЬНЫЕ бюджеты: draw_offer/draw_cancel
// считаются в СВОЙ собственный, отдельный счётчик, который НИКОГДА не
// влияет на счётчик turn/resign/draw_accept. Сколько бы draw-спама ни
// было — он исчерпывает ТОЛЬКО свой бюджет, никогда не бюджет игры.
const MAX_EVENTS_PER_MATCH = 500; // turn/resign/draw_accept — бюджет игры
const MAX_DRAW_NEGOTIATION_EVENTS = 40; // draw_offer/draw_cancel — отдельный, независимый бюджет
const MAX_TURN_PATH_POINTS = 16;

function formatSeq(n) {
    return String(n).padStart(6, "0");
}

function isValidRequestId(v) {
    return typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
}

function isValidCoord(p) {
    return p && typeof p === "object" &&
        Number.isInteger(p.row) && p.row >= 0 && p.row <= 7 &&
        Number.isInteger(p.col) && p.col >= 0 && p.col <= 7;
}

function isValidPath(path) {
    return Array.isArray(path) && path.length >= 2 && path.length <= MAX_TURN_PATH_POINTS &&
        path.every(isValidCoord);
}

function trustedInitialState() {
    return {
        pieces: createInitialPieces(),
        turn: "light",
        mustContinueFrom: null,
        capturedDark: 0,
        capturedLight: 0,
        moveCount: 0,
        kingOnlyStreak: 0,
        noProgressStreak: 0,
        positionHistory: [getDrawPositionKey(createInitialPieces(), "light")],
        longRoadAttacker: null,
        longRoadStreak: 0
    };
}

// Прогоняет ОДНО completed-turn событие (type="turn") через attemptMove-цепочку
// целиком, затем ОДИН вызов computeNextDrawState после последнего сегмента.
// Бросает на любую нелегальность/несоответствие actor/color/turn.
function replayTurnEvent(state, actorColor, path) {
    if (state.turn !== actorColor) throw new Error("wrong_actor_turn");
    const movingFrom = path[0];
    const movingPiece = state.pieces[movingFrom.row + "_" + movingFrom.col];
    const movingPieceWasKing = !!(movingPiece && movingPiece.king);

    let cur = state;
    for (let i = 0; i < path.length - 1; i++) {
        const from = path[i], to = path[i + 1];
        const result = attemptMove(cur, from.row, from.col, to.row, to.col, actorColor);
        if (!result) throw new Error("illegal_segment");
        const isLast = (i === path.length - 2);
        if (isLast && result.mustContinueFrom !== null) throw new Error("incomplete_chain");
        if (!isLast && result.mustContinueFrom === null) throw new Error("extra_landing_after_completion");
        cur = result;
    }
    const drawState = computeNextDrawState(state, cur, movingPieceWasKing);
    return {
        pieces: cur.pieces, turn: cur.turn, mustContinueFrom: cur.mustContinueFrom,
        capturedDark: cur.capturedDark, capturedLight: cur.capturedLight, moveCount: cur.moveCount,
        kingOnlyStreak: drawState.kingOnlyStreak, noProgressStreak: drawState.noProgressStreak,
        positionHistory: drawState.positionHistory,
        longRoadAttacker: drawState.longRoadAttacker, longRoadStreak: drawState.longRoadStreak,
        winner: cur.winner || (drawState.drawReason ? "draw" : null),
        winReason: cur.winReason || drawState.drawReason || null,
        // UI/animation-only поля completed-turn projection (не влияют на
        // легальность, но нужны, чтобы rooms/$room корректно отражал
        // завершённый ход для animация/звука/подсказок следующего хода —
        // найдено на review: syncProjection их не писал вовсе).
        lastMove: cur.lastMove, lastMovePath: cur.lastMovePath,
        lastCapturedSquares: cur.lastCapturedSquares, moveType: cur.moveType,
        pendingRemovals: cur.pendingRemovals
    };
}

// Прогоняет ОДИН resign/draw_offer/draw_accept event. Возвращает новое engine
// state (только winner/winReason меняются относительно prevState; остальные
// engine-поля переносятся без изменений — сама доска не двигается).
// ВАЖНО: используется для REPLAY уже ПЕРСИСТЕНТНЫХ событий — "offerSeq" здесь
// уже Worker-derived значение, зафиксированное в момент commit (см.
// findAcceptableOffer ниже, используется ТОЛЬКО при валидации НОВОГО claim'а,
// поскольку client НЕ поставляет offerSeq вовсе — это устраняет необходимость
// клиенту знать Worker-assigned seq чужого события).
function replayNonTurnEvent(state, actorColor, ev, priorEvents) {
    if (ev.type === "resign") {
        return Object.assign({}, state, {
            winner: actorColor === "light" ? "dark" : "light",
            winReason: "resign"
        });
    }
    if (ev.type === "draw_offer" || ev.type === "draw_cancel") {
        return state; // не terminal, engine state не меняется
    }
    if (ev.type === "draw_accept") {
        const offer = priorEvents.find(function (e) { return e._seqStr === ev.offerSeq && e.type === "draw_offer"; });
        if (!offer) throw new Error("stale_or_missing_offer");
        if (offer.actorUid === ev.actorUid) throw new Error("self_accept_rejected");
        return Object.assign({}, state, { winner: "draw", winReason: "draw" });
    }
    throw new Error("unknown_event_type");
}

// Определяет, к какому draw_offer относится НОВЫЙ (ещё не персистентный)
// draw_accept claim. Текущий клиент хранит ОДИН mutable drawProposal-слот:
// ЛЮБОЙ более поздний offer (с любой стороны) затирает предыдущий в UI, а
// cancel/decline снимают его вовсе — поэтому "активный" offer это ПОСЛЕДНЕЕ
// событие среди {draw_offer, draw_cancel}, и оно живое только если это
// именно draw_offer (найдено на review: cancel/decline раньше не попадали
// в protected log вовсе, что позволяло принять уже отменённое предложение).
function findAcceptableOffer(priorEvents, acceptingActorUid) {
    let latest = null;
    for (const e of priorEvents) {
        if (e.type === "draw_offer" || e.type === "draw_cancel") latest = e;
    }
    if (!latest || latest.type !== "draw_offer") throw new Error("stale_or_missing_offer");
    if (latest.actorUid === acceptingActorUid) throw new Error("self_accept_rejected");
    return latest;
}

// Полный replay всего протектед-лога от trusted initial state. Возвращает
// {state, terminal, terminalOutcome}. terminal=true означает, что дальнейшие
// события недопустимы (Worker должен отклонять append после этой точки).
function replayEvents(sortedEvents, card) {
    let state = trustedInitialState();
    let terminal = false, terminalOutcome = null, lastTurnEventTs = null;
    for (const ev of sortedEvents) {
        if (terminal) throw new Error("event_after_terminal");
        if (ev.type === "turn") {
            const result = replayTurnEvent(state, ev.color, ev.path);
            state = { pieces: result.pieces, turn: result.turn, mustContinueFrom: result.mustContinueFrom,
                capturedDark: result.capturedDark, capturedLight: result.capturedLight, moveCount: result.moveCount,
                kingOnlyStreak: result.kingOnlyStreak, noProgressStreak: result.noProgressStreak,
                positionHistory: result.positionHistory,
                longRoadAttacker: result.longRoadAttacker, longRoadStreak: result.longRoadStreak,
                lastMove: result.lastMove, lastMovePath: result.lastMovePath,
                lastCapturedSquares: result.lastCapturedSquares, moveType: result.moveType,
                pendingRemovals: result.pendingRemovals };
            lastTurnEventTs = ev.ts;
            if (result.winner) { terminal = true; terminalOutcome = { winner: result.winner, winReason: result.winReason }; }
        } else {
            const result = replayNonTurnEvent(state, ev.color, ev, sortedEvents);
            state = result;
            if (result.winner) { terminal = true; terminalOutcome = { winner: result.winner, winReason: result.winReason }; }
        }
    }
    return { state, terminal, terminalOutcome, lastTurnEventTs };
}

function canonicalClaimEquals(persisted, claim) {
    if (persisted.type !== claim.type) return false;
    if (claim.type === "turn") {
        if (!Array.isArray(persisted.path) || !Array.isArray(claim.path)) return false;
        if (persisted.path.length !== claim.path.length) return false;
        for (let i = 0; i < claim.path.length; i++) {
            if (persisted.path[i].row !== claim.path[i].row || persisted.path[i].col !== claim.path[i].col) return false;
        }
        return true;
    }
    if (claim.type === "draw_accept") return true; // offerSeq теперь Worker-derived, не часть client claim
    return true; // resign/draw_offer не несут дополнительного claim-содержимого
}

function validateClaimShape(claim) {
    if (!isValidRequestId(claim.requestId)) throw new Error("invalid_request_id");
    if (claim.type !== "turn" && claim.type !== "resign" && claim.type !== "draw_offer" && claim.type !== "draw_accept" && claim.type !== "draw_cancel") {
        throw new Error("invalid_event_type");
    }
    if (claim.type === "turn" && !isValidPath(claim.path)) throw new Error("invalid_path");
    // draw_accept НЕ несёт offerSeq от клиента — Worker сам находит текущий
    // активный offer через findAcceptableOffer() при commit (см. ниже).
}

// №23 fix (round 10, review Blocker 2): чистая функция подсчёта бюджета,
// вынесенная отдельно для изолированного unit-тестирования (без
// необходимости прогонять дорогой в построении legal-move replay для
// синтетических тестовых логов). draw_offer/draw_cancel считаются в СВОЙ
// собственный, полностью независимый счётчик — сколько бы их ни было, они
// НИКОГДА не влияют на game-event бюджет (turn/resign/draw_accept), и
// наоборот. Это доказуемо устраняет ранее найденный exploit: draw-спам
// (490) + легитимные turn-события (10) = 500 суммарно в логе БОЛЬШЕ НЕ
// блокирует терминальное событие, поскольку game-event счётчик считает
// ТОЛЬКО turn/resign/draw_accept (в примере — 10, далеко от потолка 500).
export function checkEventBudget(list, claimType) {
    const isDrawNegotiation = claimType === "draw_offer" || claimType === "draw_cancel";
    const drawNegotiationCount = list.filter(function (e) {
        return e.type === "draw_offer" || e.type === "draw_cancel";
    }).length;
    const gameEventCount = list.length - drawNegotiationCount;
    if (isDrawNegotiation) {
        if (drawNegotiationCount >= MAX_DRAW_NEGOTIATION_EVENTS) throw new Error("draw_action_limit_exceeded");
    } else {
        if (gameEventCount >= MAX_EVENTS_PER_MATCH) throw new Error("event_limit_exceeded");
    }
}

async function fetchAllEvents(env, deps, token, matchId) {
    const raw = (await dbGet(env, deps, token, "ratedEvents/" + matchId + "/events")) || {};
    const keys = Object.keys(raw).sort();
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== formatSeq(i)) throw new Error("event_log_corrupt");
    }
    return keys.map(function (k) { const e = Object.assign({}, raw[k]); e._seqStr = k; return e; });
}

export async function commitRatedEvent(env, deps, token, matchId, card, callerUid, claim) {
    validateClaimShape(claim);
    const actorColor = card.participants[callerUid] && card.participants[callerUid].color;
    if (!actorColor) throw new Error("not_a_participant");

    // №23 fix (round 11, review Point 2): найдено на review — без этой
    // проверки participant мог бы append'ить события (resign и т.п.) в
    // СТАРЫЙ matchId ПОСЛЕ того, как матч уже закончился technical
    // (timeout/disconnect, намеренно unrated по архитектуре) или после
    // реванша — card остаётся валидным навсегда (immutable), а его
    // protected log мог никогда не стать terminal (technical result не
    // логируется как protected event). Без этой проверки artificial-
    // terminal событие durable append'илось бы сразу, а позже
    // settleMatch's room-missing путь мог бы settle'ить ЭТОТ artificial
    // outcome как настоящий Elo — participant-controlled Elo gate вместо
    // lifecycle-инварианта. Легитимный append ВСЕГДА происходит во время
    // живой игры: комната обязана существовать и указывать именно на
    // ЭТОТ matchId.
    //
    // №23 fix (round 15, review): изначально здесь ТАКЖЕ требовался
    // liveRoom.status==='active' — найдено на review, что room.status
    // ПОЛНОСТЬЮ participant-controlled: обычный (не technical, без
    // валидного result) whole-room write легитимно переводит status в
    // 'finished' безо всякого protected event/result (Rules это
    // разрешают). Проигрывающий participant мог форджить ГОЛЫЙ
    // status:'finished' (без winner/winReason/result) специально чтобы
    // ЭТА проверка навсегда заблокировала будущие protected terminal
    // события — и Elo settlement fail-closed unrated. Заменено на
    // проверку ЗАЩИЩЁННОГО поля: room.result СТРОГО валидируется Rules
    // (требует winReason==='disconnect', consistency с players/presence-
    // таймингами) и создаётся ИСКЛЮЧИТЕЛЬНО через настоящий technical-
    // disconnect путь — участник не может создать ВАЛИДНЫЙ result одной
    // point-in-time записью. Легитимный protected-terminal исход (resign
    // и т.п.) НИКОГДА не populate'ит room.result (syncProjection пишет
    // только winner/winReason/status), поэтому эта проверка не мешает
    // repair-механизму (round 6) уже после легитимного protected
    // завершения — той случай отдельно и корректно обрабатывается через
    // replay.terminal ниже.
    const liveRoom = await dbGet(env, deps, token, "rooms/" + card.roomCode);
    if (!liveRoom || liveRoom.ratedMatchId !== matchId || liveRoom.result) {
        throw new Error("stale_generation");
    }

    for (let attempt = 0; attempt < 8; attempt++) {
        const list = await fetchAllEvents(env, deps, token, matchId);

        // №23 fix (round 9): dup-check ПЕРЕД cap-check — legitimate retry
        // уже существующего события (включая repair terminal-события) не
        // должен зависеть от текущего заполнения лога; иначе исчерпанный
        // бюджет заблокировал бы даже повтор УЖЕ принятого события.
        const dup = list.find(function (e) { return e.requestId === claim.requestId; });
        if (dup) {
            if (canonicalClaimEquals(dup, claim)) {
                // №23 fix: retry с тем же requestId — это единственный шанс
                // повторить syncProjection, если предыдущая попытка успешно
                // append'ила событие, но не успела/не смогла синхронизировать
                // projection (см. ниже — при первом append та же проблема
                // ЖЕ приведёт к throw, а не к silent success).
                await syncProjection(env, deps, token, matchId, card);
                return { seq: dup._seqStr, already: true };
            }
            throw new Error("idempotency_conflict");
        }

        // Cap-check ТОЛЬКО для генуинно НОВЫХ событий (дошли сюда — не dup).
        // Полностью раздельные бюджеты (round 10 fix, см. комментарий у
        // констант выше): draw_offer/draw_cancel считаются в СВОЙ, отдельный
        // счётчик, никогда не влияющий на бюджет turn/resign/draw_accept.
        // Вынесено в чистую функцию (checkEventBudget) специально для
        // изолированного unit-тестирования логики подсчёта без
        // необходимости прогонять полный (дорогой в построении для теста)
        // legal-move replay.
        checkEventBudget(list, claim.type);

        const replay = replayEvents(list, card);
        if (replay.terminal) {
            // №23 fix (round 6): ЛЮБОЕ последующее касание матча (даже с
            // ДРУГИМ requestId — retry с другого устройства/после reload без
            // durable pending-marker, или просто попытка ДРУГОГО игрока)
            // должно самолечить projection, если предыдущий append прошёл,
            // но syncProjection тогда не удался. Не полагаемся ТОЛЬКО на
            // dup-branch с совпадающим requestId — иначе retry терминального
            // действия (resign/draw_accept) после ambiguous failure никогда
            // не триггерит repair, потому что match_already_terminal
            // перехватывается раньше dup-проверки для НОВОГО requestId.
            //
            // КРИТИЧНО (найдено на review): syncProjection() здесь НЕ
            // swallow'ится. "Матч уже terminal" и "projection синхронизирована"
            // — два РАЗНЫХ факта. Если repair только что реально провалился,
            // client обязан увидеть эту (non-definitive) ошибку и оставить
            // свой pending-marker для будущего retry — а не получить
            // match_already_terminal, ошибочно счесть исход "доказанным" и
            // снять marker, хотя repair мог просто не случиться. Только если
            // syncProjection ЗДЕСЬ реально успела (включая "уже кто-то
            // синхронизировал" no-op) — код доходит до throw ниже, и клиент
            // корректно трактует match_already_terminal как definitive.
            await syncProjection(env, deps, token, matchId, card);
            throw new Error("match_already_terminal");
        }

        let derivedOfferSeq = null;
        if (claim.type === "turn") {
            replayTurnEvent(replay.state, actorColor, claim.path); // throws на illegal — не мутирует replay.state
        } else if (claim.type === "resign") {
            // всегда легален для участника, если матч не terminal (проверено выше)
        } else if (claim.type === "draw_offer") {
            // всегда легален для участника, если матч не terminal
        } else if (claim.type === "draw_cancel") {
            // всегда легален для участника, если матч не terminal — снимает
            // текущий активный offer независимо от того, кто его предложил
            // (соответствует текущему UI: и cancel своего, и decline чужого
            // предложения одинаково снимают единственный mutable слот)
        } else if (claim.type === "draw_accept") {
            const offer = findAcceptableOffer(list, callerUid); // throws на self-accept/отсутствие активного offer
            derivedOfferSeq = offer._seqStr;
        }

        const nextSeqStr = formatSeq(list.length);
        const cur = await dbGetWithEtag(env, deps, token, "ratedEvents/" + matchId + "/events/" + nextSeqStr);
        if (cur.value) continue; // занято параллельно — перечитать и повторить

        const persisted = {
            requestId: claim.requestId, type: claim.type,
            actorUid: callerUid, color: actorColor, matchId,
            roomCode: card.roomCode, createdAt: card.createdAt, matchNumber: card.matchNumber,
            ts: serverTimestamp()
        };
        if (claim.type === "turn") persisted.path = claim.path;
        if (claim.type === "draw_accept") persisted.offerSeq = derivedOfferSeq;

        const put = await dbPutIfMatch(env, deps, token, "ratedEvents/" + matchId + "/events/" + nextSeqStr, cur.etag, persisted);
        if (!put.ok) continue; // conflict => retry с начала

        // №23 fix: НЕ проглатывать ошибку synchronization — событие уже
        // durable, но клиент не должен получить SUCCESS, пока room либо
        // реально синхронизирована, либо доказано, что она уже на этом/более
        // позднем seq (сама syncProjection это проверяет перед тем как
        // считать permission-denied безопасным no-op). Если синхронизация
        // действительно не удалась — это пробрасывается как ошибка, и
        // естественный client-side retry (тот же requestId) попадёт в ветку
        // dup выше, которая тоже повторит syncProjection.
        await syncProjection(env, deps, token, matchId, card);
        return { seq: nextSeqStr, already: false };
    }
    throw new Error("append_conflict_retry_exhausted");
}

// Monotonic projection sync: чистая функция от protected log, безопасно
// вызываемая повторно (после append, в начале следующего /rated/event, перед
// settle). Rules гарантируют acceptedSeq строго возрастает — поздний writer
// для более раннего seq получает permission_denied и корректно ничего не делает.
export async function syncProjection(env, deps, token, matchId, card) {
    const list = await fetchAllEvents(env, deps, token, matchId);
    if (list.length === 0) return;
    const replay = replayEvents(list, card);
    const latestSeqNum = list.length - 1;
    const roomCode = card.roomCode;

    // Найти seq последнего "turn"-события в логе (если есть вообще) —
    // именно ОНО определяет актуальное board-состояние. Промежуточные
    // multi-capture сегменты (Model 3-lite) client-direct и никогда не
    // логируются отдельно, поэтому "последнее turn-событие" может быть
    // СТАРШЕ, чем latestSeqNum (если после него шли только non-turn
    // события — resign/draw_offer/draw_cancel/draw_accept).
    let lastTurnSeqNum = -1;
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].type === "turn") { lastTurnSeqNum = i; break; }
    }

    // №23 fix (round 9, review point 1): "acceptedSeq" один сам по себе
    // путал ДВА разных факта — "лог обработан до этой позиции" и "board
    // материализована по последнему ходу". Non-turn событие (draw_offer)
    // могло продвинуть acceptedSeq, не тронув board, и ПОСЛЕДУЮЩИЙ
    // permission-denied repair-check видел acceptedSeq>=latest и ошибочно
    // считал всё синхронизированным, хотя board всё ещё отражала более
    // раннее (до упавшего turn-события) состояние. Отдельный "boardSeq" —
    // seq последнего turn-события, чья board РЕАЛЬНО подтверждена
    // записанной — читаем ТЕКУЩЕЕ значение, чтобы решить, нужно ли (пере)
    // писать board СЕЙЧАС, независимо от того, что latest-событие non-turn.
    const currentRatedReplay = await dbGet(env, deps, token, "rooms/" + roomCode + "/ratedReplay");
    const currentBoardSeq = (currentRatedReplay && currentRatedReplay.matchId === matchId && typeof currentRatedReplay.boardSeq === "number")
        ? currentRatedReplay.boardSeq : -1;
    const needsBoardWrite = lastTurnSeqNum > currentBoardSeq;

    const updates = {
        ["rooms/" + roomCode + "/ratedReplay/matchId"]: matchId,
        ["rooms/" + roomCode + "/ratedReplay/acceptedSeq"]: latestSeqNum
    };
    if (needsBoardWrite) {
        updates["rooms/" + roomCode + "/ratedReplay/boardSeq"] = lastTurnSeqNum;
        updates["rooms/" + roomCode + "/pieces"] = replay.state.pieces;
        updates["rooms/" + roomCode + "/turn"] = replay.state.turn;
        updates["rooms/" + roomCode + "/moveCount"] = replay.state.moveCount;
        updates["rooms/" + roomCode + "/mustContinueFrom"] = replay.state.mustContinueFrom;
        updates["rooms/" + roomCode + "/capturedDark"] = replay.state.capturedDark;
        updates["rooms/" + roomCode + "/capturedLight"] = replay.state.capturedLight;
        updates["rooms/" + roomCode + "/kingOnlyStreak"] = replay.state.kingOnlyStreak;
        updates["rooms/" + roomCode + "/noProgressStreak"] = replay.state.noProgressStreak;
        updates["rooms/" + roomCode + "/positionHistory"] = replay.state.positionHistory;
        updates["rooms/" + roomCode + "/longRoadAttacker"] = replay.state.longRoadAttacker;
        updates["rooms/" + roomCode + "/longRoadStreak"] = replay.state.longRoadStreak;
        updates["rooms/" + roomCode + "/lastMove"] = replay.state.lastMove || null;
        updates["rooms/" + roomCode + "/lastMovePath"] = replay.state.lastMovePath || null;
        updates["rooms/" + roomCode + "/lastCapturedSquares"] = replay.state.lastCapturedSquares || null;
        updates["rooms/" + roomCode + "/moveType"] = replay.state.moveType || null;
        updates["rooms/" + roomCode + "/pendingRemovals"] = replay.state.pendingRemovals || null;
        // №23 fix (round 9, review point 2): СВЕЖИЙ ServerValue.TIMESTAMP —
        // РЕАЛЬНОЕ время материализации, не historical event.ts. Пишется
        // РОВНО один раз для ДАННОГО хода (когда boardSeq именно СЕЙЧАС
        // продвигается) — повторные вызовы (repair/idempotent retry) на
        // ТОМ ЖЕ логе увидят currentBoardSeq >= lastTurnSeqNum и НЕ войдут
        // в этот блок вовсе, так что turnStartedAt НЕ сдвигается повторно
        // (Round 5 anti-abuse свойство сохранено), а игрок не теряет время
        // из-за задержки МЕЖДУ commit события и УСПЕШНОЙ материализацией.
        updates["rooms/" + roomCode + "/turnStartedAt"] = serverTimestamp();
    }

    if (replay.terminalOutcome) {
        updates["rooms/" + roomCode + "/winner"] = replay.terminalOutcome.winner;
        updates["rooms/" + roomCode + "/winReason"] = replay.terminalOutcome.winReason;
        updates["rooms/" + roomCode + "/status"] = "finished";
    }

    try {
        await dbPatchRoot(env, deps, token, updates);
    } catch (error) {
        if (!isPermissionDeniedError(error)) throw error;
        // Permission denied МОЖЕТ означать "кто-то уже продвинул projection
        // дальше" (безопасный no-op) — но может означать и настоящий баг
        // (неверный matchId, испорченная card, реальная Rules-ошибка).
        // Не доверяем самому факту 401/403 — перечитываем ratedReplay и
        // подтверждаем ИМЕННО ожидаемый инвариант (включая boardSeq —
        // review point 1 — не только acceptedSeq), прежде чем считать это
        // безопасным no-op.
        const current = await dbGet(env, deps, token, "rooms/" + roomCode + "/ratedReplay");
        const currentSeq = current && typeof current.acceptedSeq === "number" ? current.acceptedSeq : -1;
        const currentMatchIdCheck = current && current.matchId;
        const currentBoardSeqCheck = current && typeof current.boardSeq === "number" ? current.boardSeq : -1;
        const boardRequirementMet = lastTurnSeqNum <= currentBoardSeqCheck;
        if (currentMatchIdCheck !== matchId || currentSeq < latestSeqNum || !boardRequirementMet) {
            throw new Error("projection_sync_denied_unexpected");
        }
        // Подтверждено: room действительно уже на этом или более позднем
        // seq той же generation, И board уже материализована минимум до
        // lastTurnSeqNum — реальный, ожидаемый no-op.
    }
}

function isPermissionDeniedError(error) {
    // dbPatchRoot() всегда бросает Error("db_write_failed") с .status =
    // исходный HTTP-код; текст message никогда не содержит причину, поэтому
    // единственный надёжный сигнал — HTTP-статус, который RTDB REST API
    // возвращает при отклонении записи Rules (401 или 403 в зависимости от
    // конкретного случая).
    return !!(error && (error.status === 401 || error.status === 403));
}

export async function verifiedReplayOutcome(env, deps, token, matchId, card) {
    const list = await fetchAllEvents(env, deps, token, matchId);
    const replay = replayEvents(list, card);
    if (!replay.terminal || !replay.terminalOutcome) throw new Error("match_not_finished");
    return replay.terminalOutcome.winner;
}

let cachedServerToken = null;

export function resetServerTokenCache() { cachedServerToken = null; }

export function isServerTokenFresh(cache, nowMs) {
  return !!cache && typeof cache.idToken === "string" && cache.expiresAtMs - nowMs > 300000;
}

export async function getServerIdToken(env, deps) {
  const now = deps.now();
  if (isServerTokenFresh(cachedServerToken, now)) return cachedServerToken.idToken;
  if (!deps.signCustomToken) throw new Error("server_signer_missing");

  const customToken = await deps.signCustomToken(
    SRV_UID,
    env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
    env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY,
    Math.floor(now / 1000)
  );

  const res = await deps.fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=" +
      encodeURIComponent(env.FIREBASE_WEB_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true })
    }
  );
  if (!res.ok) throw new Error("server_identity_failed");
  const data = await res.json();
  if (!data || typeof data.idToken !== "string") throw new Error("server_identity_failed");

  cachedServerToken = {
    idToken: data.idToken,
    expiresAtMs: now + Number(data.expiresIn || 3600) * 1000
  };
  return cachedServerToken.idToken;
}


// ============ APP CHECK ДЛЯ СЕРВЕРНОЙ ЛИЧНОСТИ (OAuth2 + exchange) ============
//
// База с включённым принуждением App Check отвергает запрос без заголовка
// X-Firebase-AppCheck даже с валидным ID-token и даже на публично читаемом
// пути. Клиентский SDK шлёт заголовок сам, голый REST из Worker — нет.
//
// Порядок ровно как в Firebase Admin SDK:
//   1. подписать OAuth2 assertion ключом сервисного аккаунта;
//   2. обменять его на access token на oauth2.googleapis.com;
//   3. вызвать exchangeCustomToken С ЗАГОЛОВКОМ Authorization: Bearer;
//   4. полученный App Check токен класть в X-Firebase-AppCheck.
//
// Шаг 3 требует OAuth: метод объявляет scopes cloud-platform и firebase, а
// customToken в теле — это ПРОВЕРЯЕМЫЕ ДАННЫЕ, а не учётные данные запроса.
// Именно поэтому Admin SDK ходит туда через AuthorizedHttpClient.
//
// ВАЖНО ПРО ГРАНИЦЫ: OAuth используется ТОЛЬКО для выпуска App Check
// токена. Доступ к базе по-прежнему идёт с Firebase ID token, поэтому
// Security Rules выполняются как раньше. Административного обхода правил
// здесь нет.
//
// Единственная новая переменная: FIREBASE_APP_ID. Номер проекта берётся
// из неё же — второй сегмент идентификатора вида 1:<number>:web:<hex>.

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/firebase";
const APPCHECK_TOKEN_EXCHANGE_AUD =
  "https://firebaseappcheck.googleapis.com/google.firebase.appcheck.v1.TokenExchangeService";

// Пауза после неудачи: постоянная ошибка настройки не должна порождать
// повторный сетевой обмен на КАЖДОЙ операции с базой.
const APPCHECK_FAIL_COOLDOWN_MS = 60000;

let cachedAccessToken = null;     // { token, expiresAtMs }
let cachedAppCheckToken = null;   // { token, expiresAtMs }
let appCheckFailUntilMs = 0;
let appCheckLastError = null;

function resetAppCheckCache() {
  cachedAccessToken = null;
  cachedAppCheckToken = null;
  appCheckFailUntilMs = 0;
  appCheckLastError = null;
}

function isTokenFresh(cache, nowMs) {
  return !!cache && typeof cache.token === "string"
    && cache.expiresAtMs - nowMs > 300000;
}

function projectNumberFromAppId(appId) {
  const m = /^1:(\d+):web:[0-9a-f]+$/.exec(String(appId || ""));
  return m ? m[1] : null;
}

// Диагностика: только фиксированный код и HTTP-статус.
function appCheckLog(code, status, nowMs) {
  const allowed = ["not_configured", "oauth_sign_failed", "oauth_failed",
    "oauth_malformed", "exchange_failed", "exchange_malformed", "sign_failed"];
  const safe = allowed.indexOf(code) !== -1 ? code : "unknown";
  appCheckLastError = safe;
  if (typeof nowMs === "number") appCheckFailUntilMs = nowMs + APPCHECK_FAIL_COOLDOWN_MS;
  try {
    const prefix = (safe.indexOf("oauth") === 0) ? "OAUTH_DEBUG" : "APPCHECK_DEBUG";
    let line = prefix + " error=" + safe;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      line += " status=" + status;
    }
    console.error(line);
  } catch (_) {}
}

// Подписанный assertion для обмена на access token.
async function createOauthAssertion(serviceAccountEmail, privateKeyPem, nowSeconds) {
  if (typeof serviceAccountEmail !== "string" || !serviceAccountEmail.includes("@")) {
    throw new Error("firebase_service_account_email_missing");
  }
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccountEmail,
    scope: GOOGLE_OAUTH_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  return signRs256Jwt(header, payload, privateKeyPem);
}

async function createAppCheckCustomToken(appId, serviceAccountEmail, privateKeyPem, nowSeconds) {
  if (typeof serviceAccountEmail !== "string" || !serviceAccountEmail.includes("@")) {
    throw new Error("firebase_service_account_email_missing");
  }
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: APPCHECK_TOKEN_EXCHANGE_AUD,
    iat: nowSeconds,
    exp: nowSeconds + 300,
    app_id: appId
  };
  return signRs256Jwt(header, payload, privateKeyPem);
}

// Общая подпись: та же схема, что уже используется для custom token Auth.
async function signRs256Jwt(header, payload, privateKeyPem) {
  const signingInput =
    stringToBase64Url(JSON.stringify(header)) + "." +
    stringToBase64Url(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8Bytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, utf8.encode(signingInput)));
  return signingInput + "." + bytesToBase64Url(signature);
}

async function getGoogleAccessToken(env, deps) {
  const now = deps.now();
  if (isTokenFresh(cachedAccessToken, now)) return cachedAccessToken.token;

  let assertion;
  try {
    const sign = deps.signOauthAssertion || createOauthAssertion;
    assertion = await sign(env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
      env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY, Math.floor(now / 1000));
  } catch (e) {
    appCheckLog("oauth_sign_failed", null, now);
    return null;
  }

  const body = "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
    "&assertion=" + encodeURIComponent(assertion);
  const res = await deps.fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body
  });
  if (!res.ok) { appCheckLog("oauth_failed", res.status, now); return null; }
  const data = await res.json();
  if (!data || typeof data.access_token !== "string") {
    appCheckLog("oauth_malformed", null, now); return null;
  }
  const ttl = Number(data.expires_in || 3600);
  cachedAccessToken = { token: data.access_token, expiresAtMs: now + ttl * 1000 };
  return cachedAccessToken.token;
}

// Возвращает App Check токен либо null. null означает: запрос уйдёт БЕЗ
// заголовка, то есть ровно как в текущем production.
async function getAppCheckToken(env, deps) {
  const now = deps.now();
  if (isTokenFresh(cachedAppCheckToken, now)) return cachedAppCheckToken.token;
  if (now < appCheckFailUntilMs) return null;

  const appId = env.FIREBASE_APP_ID;
  const projectNumber = projectNumberFromAppId(appId);
  if (!appId || !projectNumber) { appCheckLog("not_configured", null, now); return null; }

  try {
    const accessToken = await getGoogleAccessToken(env, deps);
    if (!accessToken) return null;   // причина уже записана

    const sign = deps.signAppCheckToken || createAppCheckCustomToken;
    const customToken = await sign(appId, env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
      env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY, Math.floor(now / 1000));

    const res = await deps.fetch(
      "https://firebaseappcheck.googleapis.com/v1/projects/" + projectNumber +
        "/apps/" + encodeURIComponent(appId) + ":exchangeCustomToken",
      { method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + accessToken
        },
        body: JSON.stringify({ customToken: customToken }) });
    if (!res.ok) { appCheckLog("exchange_failed", res.status, now); return null; }
    const data = await res.json();
    if (!data || typeof data.token !== "string") {
      appCheckLog("exchange_malformed", null, now); return null;
    }
    const ttlSec = parseInt(String(data.ttl || "3600"), 10) || 3600;
    cachedAppCheckToken = { token: data.token, expiresAtMs: now + ttlSec * 1000 };
    appCheckLastError = null;
    appCheckFailUntilMs = 0;
    return cachedAppCheckToken.token;
  } catch (e) {
    appCheckLog("sign_failed", null, now);
    return null;
  }
}

async function dbHeaders(env, deps, extra) {
  const h = Object.assign({}, extra || {});
  const token = await getAppCheckToken(env, deps);
  if (token) h["X-Firebase-AppCheck"] = token;
  return h;
}

function dbUrl(env, path, token) {
  const base = String(env.FIREBASE_DB_URL || "").replace(/\/$/, "");
  const clean = String(path || "").replace(/^\//, "");
  return base + "/" + clean + ".json?auth=" + encodeURIComponent(token);
}

export async function dbGet(env, deps, token, path) {
  const r = await deps.fetch(dbUrl(env, path, token),
    { method: "GET", headers: await dbHeaders(env, deps) });
  if (!r.ok) throw new Error("db_read_failed");
  return await r.json();
}

export async function dbGetWithEtag(env, deps, token, path) {
  const r = await deps.fetch(dbUrl(env, path, token), {
    method: "GET",
    headers: await dbHeaders(env, deps, { "X-Firebase-ETag": "true" })
  });
  if (!r.ok) throw new Error("db_read_failed");
  return { value: await r.json(), etag: r.headers.get("ETag") };
}

export async function dbPutIfMatch(env, deps, token, path, etag, value) {
  const r = await deps.fetch(dbUrl(env, path, token), {
    method: "PUT",
    headers: await dbHeaders(env, deps, { "if-match": etag, "Content-Type": "application/json" }),
    body: JSON.stringify(value)
  });
  if (r.status === 412) return { ok: false, conflict: true };
  if (!r.ok) throw new Error("db_write_failed");
  return { ok: true, conflict: false };
}

export async function dbPatchRoot(env, deps, token, updates) {
  const r = await deps.fetch(dbUrl(env, "", token), {
    method: "PATCH",
    headers: await dbHeaders(env, deps, { "Content-Type": "application/json" }),
    body: JSON.stringify(updates)
  });
  if (!r.ok) {
    const err = new Error("db_write_failed");
    err.status = r.status;
    throw err;
  }
  return true;
}

function serverIncrement(delta) {
  return { ".sv": { increment: delta } };
}
function serverTimestamp() {
  return { ".sv": "timestamp" };
}

export function buildCanonicalMatchId(roomCode, createdAt, matchNumber) {
  const stamp = typeof createdAt === "number" && isFinite(createdAt) ? createdAt : 0;
  const num = typeof matchNumber === "number" && isFinite(matchNumber) ? matchNumber : 0;
  return "elo_" + roomCode + "_" + stamp + "_" + num;
}

export function callerColor(room, uid) {
  const p = (room && room.players) || {};
  if (p.light && p.light.id === uid) return "light";
  if (p.dark && p.dark.id === uid) return "dark";
  return null;
}

export function decideRegistration(index, room) {
  const mn = typeof room.matchNumber === "number" ? room.matchNumber : 0;
  if (index && index.createdAt !== room.createdAt) {
    return mn === 0 ? { ok: true, matchNumber: 0, fresh: true } : { ok: false, reason: "not_first_match" };
  }
  if (!index) return mn === 0 ? { ok: true, matchNumber: 0 } : { ok: false, reason: "not_first_match" };
  const last = typeof index.lastMatchNumber === "number" ? index.lastMatchNumber : 0;
  if (mn === last) return { ok: true, matchNumber: mn, already: true };
  if (mn === last + 1) return { ok: true, matchNumber: mn };
  return { ok: false, reason: "match_number_jump" };
}

export function eloDeltas(lightRating, darkRating, result) {
  if (!Number.isFinite(lightRating) || lightRating < 0 ||
      !Number.isFinite(darkRating) || darkRating < 0) {
    throw new Error("card_mismatch");
  }

  const expectedLight = 1 / (1 + Math.pow(10, (darkRating - lightRating) / 400));
  const scoreLight = result === "draw" ? 0.5 : result === "light" ? 1 : 0;
  const originalLight = Math.round(ELO_K * (scoreLight - expectedLight));

  // One original delta is authoritative; the other side is always its exact
  // opposite. If the negative side cannot pay the full loss, cap BOTH sides
  // by that frozen rating so the settlement stays strict zero-sum and >= 0.
  if (originalLight === 0) return { light: 0, dark: 0 };
  const negativeRating = originalLight < 0 ? lightRating : darkRating;
  const cap = Math.min(Math.abs(originalLight), negativeRating);
  if (cap === 0) return { light: 0, dark: 0 };
  const light = originalLight < 0 ? -cap : cap;
  return { light, dark: -light };
}

export function roomOutcome(room) {
  const w = room && room.winner;
  return w === "light" || w === "dark" || w === "draw" ? w : null;
}

function safeName(value, fallback) {
  const s = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return String(s || "Игрок").slice(0, 48);
}

function normalizeStatsNode(cur, uid, name) {
  const st = cur && typeof cur === "object" && !Array.isArray(cur) ? Object.assign({}, cur) : {};
  let changed = !(cur && typeof cur === "object" && !Array.isArray(cur));
  const setIf = (key, value, valid) => {
    if (!valid(st[key])) { st[key] = value; changed = true; }
  };
  setIf("wins", 0, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  setIf("losses", 0, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  setIf("rating", ELO_START, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  setIf("draws", 0, (v) => typeof v === "number" && isFinite(v) && v >= 0);
  if (typeof st.name !== "string" || !st.name.length || st.name.length >= 50) {
    st.name = safeName(name, uid);
    changed = true;
  }
  return { node: st, changed };
}

export async function ensureStatsInitialized(env, deps, token, uid, name) {
  const path = "stats/" + uid;
  for (let i = 0; i < 6; i++) {
    const cur = await dbGetWithEtag(env, deps, token, path);
    const normalized = normalizeStatsNode(cur.value, uid, name);
    if (!normalized.changed) return normalized.node;
    const put = await dbPutIfMatch(env, deps, token, path, cur.etag, normalized.node);
    if (put.ok) return normalized.node;
  }
  throw new Error("stats_init_conflict");
}

function cardByColor(card) {
  const parts = card && card.participants;
  if (!parts || typeof parts !== "object") throw new Error("match_not_rated");
  const uids = Object.keys(parts);
  if (uids.length !== 2) throw new Error("match_not_rated");
  const by = {};
  for (const uid of uids) {
    const color = parts[uid] && parts[uid].color;
    if (color !== "light" && color !== "dark") throw new Error("match_not_rated");
    if (by[color]) throw new Error("match_not_rated");
    by[color] = uid;
  }
  if (!by.light || !by.dark || by.light === by.dark) throw new Error("match_not_rated");
  return by;
}

export function sameGeneration(card, roomCode, room) {
  if (!card || !room) return false;
  const mn = typeof room.matchNumber === "number" ? room.matchNumber : 0;
  return card.roomCode === roomCode && card.createdAt === room.createdAt && card.matchNumber === mn;
}

function cardMatchesRoomPlayers(card, room) {
  const by = cardByColor(card);
  return !!(
    room && room.players && room.players.light && room.players.dark &&
    room.players.light.id === by.light && room.players.dark.id === by.dark
  );
}

function validateExistingCard(card, roomCode, room, expectedLight, expectedDark) {
  if (!sameGeneration(card, roomCode, room)) throw new Error("card_mismatch");
  const by = cardByColor(card);
  if (by.light !== expectedLight || by.dark !== expectedDark) throw new Error("card_mismatch");
  const lp = card.participants[by.light];
  const dp = card.participants[by.dark];
  if (typeof lp.ratingAtJoin !== "number" || typeof dp.ratingAtJoin !== "number") throw new Error("card_mismatch");
  return card;
}

async function ensureMatchCard(env, deps, token, matchId, card) {
  const path = "matches/" + matchId;
  const cur = await dbGetWithEtag(env, deps, token, path);
  if (cur.value) return cur.value;
  const put = await dbPutIfMatch(env, deps, token, path, cur.etag, card);
  if (put.ok) return card;
  const existing = await dbGet(env, deps, token, path);
  if (!existing) throw new Error("card_conflict");
  return existing;
}

async function finalizePointer(env, deps, token, roomCode, matchId, card) {
  const latestRoom = await dbGet(env, deps, token, "rooms/" + roomCode);
  if (!latestRoom || !sameGeneration(card, roomCode, latestRoom)) throw new Error("stale_generation");
  // Mixed-version safety: registration must become visible to cached v193 only
  // while THIS generation is still a live game. If the game finished while
  // /rated/join was in flight, publishing ratingsAtStart afterwards can make
  // v193 switch from its already-taken legacy fallback to the canonical receipt
  // path, allowing the same physical result to be counted by two mechanisms.
  if (latestRoom.status !== "active" || roomOutcome(latestRoom)) throw new Error("room_not_active");
  // A normal rematch changes both matchNumber and sides, but re-check the player
  // binding too: never publish a snapshot captured for a different seat layout.
  if (!cardMatchesRoomPlayers(card, latestRoom)) throw new Error("card_mismatch");
  const index = await dbGet(env, deps, token, "matchIndex/" + roomCode);
  if (!index || index.matchId !== matchId || index.createdAt !== latestRoom.createdAt ||
      index.lastMatchNumber !== latestRoom.matchNumber) {
    throw new Error("stale_generation");
  }
  // Migration compatibility: publish the authoritative rating snapshot into the
  // legacy room shape at the same time as ratedMatchId. Cached v193 clients
  // require BOTH ratingsAtStart values to choose their canonical elo_<...>
  // receipt path; without the full snapshot they fall back to direct stats and
  // online_<...> идентификаторы, несовместимые с расчётом на сервере.
  const by = cardByColor(card);
  const updates = {
    ["rooms/" + roomCode + "/ratedMatchId"]: matchId,
    ["rooms/" + roomCode + "/ratingsAtStart/light"]: card.participants[by.light].ratingAtJoin,
    ["rooms/" + roomCode + "/ratingsAtStart/dark"]: card.participants[by.dark].ratingAtJoin
  };
  // №23 fix (round 9, уточнено в round 10): finalizePointer() вызывается
  // БЕЗУСЛОВНО при КАЖДОМ /rated/join, включая idempotent retry для УЖЕ
  // установленной, ongoing generation (reconnect и т.п.) — найдено на
  // review. Сбрасываем leftover ratedReplay ТОЛЬКО когда ratedMatchId
  // РЕАЛЬНО меняется (genuine новая generation — реванш/первый join);
  // если это retry той же самой generation, ratedReplay уже может нести
  // РЕАЛЬНЫЙ, полезный прогресс партии (acceptedSeq/boardSeq) — сброс его
  // здесь был бы чистой тратой (следующий syncProjection всё равно
  // восстановил бы то же самое), а не просто "безопасным no-op".
  if (latestRoom.ratedMatchId !== matchId) {
    updates["rooms/" + roomCode + "/ratedReplay"] = null;
  }
  await dbPatchRoot(env, deps, token, updates);
}

export async function joinRatedMatch(env, deps, callerUid, roomCode) {
  const token = await getServerIdToken(env, deps);
  const room = await dbGet(env, deps, token, "rooms/" + roomCode);
  if (!room || !room.players) throw new Error("room_not_found");
  const color = callerColor(room, callerUid);
  if (!color) throw new Error("not_a_player");
  if (room.status !== "active" || roomOutcome(room)) throw new Error("room_not_active");

  const lightId = room.players.light && room.players.light.id;
  const darkId = room.players.dark && room.players.dark.id;
  if (!lightId || !darkId || lightId === darkId || !/^tg_\d+$/.test(lightId) || !/^tg_\d+$/.test(darkId)) {
    throw new Error("room_not_ready");
  }
  if (typeof room.createdAt !== "number" || !isFinite(room.createdAt) || room.createdAt <= 0 ||
      typeof room.matchNumber !== "number" || !Number.isInteger(room.matchNumber) || room.matchNumber < 0) {
    throw new Error("room_not_ready");
  }

  const idxPath = "matchIndex/" + roomCode;
  const idx = await dbGetWithEtag(env, deps, token, idxPath);
  const verdict = decideRegistration(idx.value, room);
  if (!verdict.ok) throw new Error(verdict.reason);
  const matchId = buildCanonicalMatchId(roomCode, room.createdAt, verdict.matchNumber);

  // Initialize/freeze ratings before claiming the index. The card is create-only
  // in practice, so the first creator fixes the snapshot for all retries.
  const [sl, sd] = await Promise.all([
    ensureStatsInitialized(env, deps, token, lightId, room.players.light.name),
    ensureStatsInitialized(env, deps, token, darkId, room.players.dark.name)
  ]);

  const proposedCard = {
    roomCode,
    createdAt: room.createdAt,
    matchNumber: verdict.matchNumber,
    replayVersion: 1, // №23: Worker-owned migration marker, client-unspoofable (create-only card)
    participants: {
      [lightId]: { color: "light", ratingAtJoin: sl.rating, name: safeName(room.players.light.name, lightId) },
      [darkId]: { color: "dark", ratingAtJoin: sd.rating, name: safeName(room.players.dark.name, darkId) }
    }
  };

  const card = await ensureMatchCard(env, deps, token, matchId, proposedCard);
  validateExistingCard(card, roomCode, room, lightId, darkId);

  let indexIsOurs = verdict.already && idx.value && idx.value.matchId === matchId;
  if (!indexIsOurs) {
    const claim = await dbPutIfMatch(env, deps, token, idxPath, idx.etag, {
      matchId,
      lastMatchNumber: verdict.matchNumber,
      pair: lightId + "|" + darkId,
      createdAt: room.createdAt
    });
    if (claim.conflict) {
      const again = await dbGet(env, deps, token, idxPath);
      if (!again || again.matchId !== matchId || again.createdAt !== room.createdAt ||
          again.lastMatchNumber !== verdict.matchNumber) {
        throw new Error("registration_conflict");
      }
    }
  }

  await finalizePointer(env, deps, token, roomCode, matchId, card);
  return { matchId, color, already: !!verdict.already };
}

export function validateReceiptAgainstCard(receipt, card, expectedResult) {
  if (!receipt || typeof receipt !== "object") throw new Error("receipt_mismatch");
  const by = cardByColor(card);
  if (receipt.lightId !== by.light || receipt.darkId !== by.dark) throw new Error("receipt_mismatch");
  if (receipt.result !== "light" && receipt.result !== "dark" && receipt.result !== "draw") {
    throw new Error("receipt_mismatch");
  }
  if (expectedResult && receipt.result !== expectedResult) throw new Error("receipt_mismatch");
  if (receipt.settledBy !== undefined && receipt.settledBy !== "worker") throw new Error("receipt_mismatch");

  if (receipt.settledBy === "worker") {
    const rl = card.participants[by.light].ratingAtJoin;
    const rd = card.participants[by.dark].ratingAtJoin;
    const d = eloDeltas(rl, rd, receipt.result);
    if (receipt.lightRatingBefore !== rl || receipt.darkRatingBefore !== rd ||
        receipt.lightDelta !== d.light || receipt.darkDelta !== d.dark) {
      throw new Error("receipt_mismatch");
    }
  }
  return by;
}

function buildSettlementUpdates(matchId, card, result) {
  const by = cardByColor(card);
  const rl = card.participants[by.light].ratingAtJoin;
  const rd = card.participants[by.dark].ratingAtJoin;
  const d = eloDeltas(rl, rd, result);
  const u = {};
  u["eloMatches/" + matchId] = {
    lightId: by.light,
    darkId: by.dark,
    result,
    lightRatingBefore: rl,
    darkRatingBefore: rd,
    lightDelta: d.light,
    darkDelta: d.dark,
    settledBy: "worker",
    createdAt: serverTimestamp()
  };
  u["stats/" + by.light + "/rating"] = serverIncrement(d.light);
  u["stats/" + by.dark + "/rating"] = serverIncrement(d.dark);
  if (result === "draw") {
    u["stats/" + by.light + "/draws"] = serverIncrement(1);
    u["stats/" + by.dark + "/draws"] = serverIncrement(1);
  } else if (result === "light") {
    u["stats/" + by.light + "/wins"] = serverIncrement(1);
    u["stats/" + by.dark + "/losses"] = serverIncrement(1);
  } else {
    u["stats/" + by.dark + "/wins"] = serverIncrement(1);
    u["stats/" + by.light + "/losses"] = serverIncrement(1);
  }
  return { updates: u, deltas: d, by };
}



async function settleFromReceiptWithoutRoom(env, deps, token, matchId, callerUid) {
  const card = await dbGet(env, deps, token, "matches/" + matchId);
  if (!card || !card.participants) throw new Error("match_not_registered");
  if (!Object.prototype.hasOwnProperty.call(card.participants, callerUid)) throw new Error("not_a_participant");
  const receipt = await dbGet(env, deps, token, "eloMatches/" + matchId);
  if (!receipt) throw new Error("nothing_to_resume");
  // Without the live room, only a Worker-owned receipt is trusted for the outcome.
  if (receipt.settledBy !== "worker") throw new Error("legacy_receipt_room_missing");
  validateReceiptAgainstCard(receipt, card, null);
  return {
    matchId,
    already: true,
    source: "worker_receipt_without_room",
    ratingConfirmed: true,
    deltas: { light: receipt.lightDelta, dark: receipt.darkDelta },
    result: receipt.result
  };
}

export async function settleMatch(env, deps, callerUid, roomCode, knownMatchId) {
  const token = await getServerIdToken(env, deps);
  const room = await dbGet(env, deps, token, "rooms/" + roomCode);

  let matchId, card;
  if (!room) {
    if (typeof knownMatchId !== "string" || !knownMatchId) throw new Error("room_not_found");
    matchId = knownMatchId;
    card = await dbGet(env, deps, token, "matches/" + matchId);
    if (!card || !card.participants) throw new Error("match_not_registered");
    if (!Object.prototype.hasOwnProperty.call(card.participants, callerUid)) throw new Error("not_a_participant");
    if (!(card.replayVersion >= 1)) {
      // Legacy (pre-№23) generation без protected log и без живой room:
      // независимо проверить исход нечем — доверяем ТОЛЬКО уже
      // существующему Worker-receipt (без изменений относительно до-№23
      // поведения).
      return await settleFromReceiptWithoutRoom(env, deps, token, matchId, callerUid);
    }
    // №23: room удалена ДО первого settlement, но protected log и card
    // пережили cleanup — ровно ради этого лог физически вынесен из
    // rooms/$room (§14 архитектуры). Первое settlement всё ещё возможно
    // исключительно из card+ratedEvents, без какого-либо обращения к room
    // ниже по функции.
    //
    // №23 fix (round 11, review Point 2): найдено на review — БЕЗ этой
    // проверки knownMatchId мог бы указывать на СТАРУЮ, УЖЕ СУПЕРСЕДНУТУЮ
    // generation (реванш случился, либо матч закончился technical/unrated
    // и НИКОГДА не settle'ился, а комнату потом удалили или она успела
    // уйти на реванш) — card остаётся валидным навсегда (immutable), и
    // без явной проверки против matchIndex (который переживает удаление
    // room — отдельный top-level узел) settlement мог бы конвертировать
    // artificial/technical исход в настоящий Elo. matchIndex ВСЕГДА
    // отражает САМУЮ ПОСЛЕДНЮЮ зарегистрированную generation для этого
    // roomCode, независимо от того, жива ли сама room.
    const index = await dbGet(env, deps, token, "matchIndex/" + roomCode);
    if (!index || index.matchId !== matchId) {
      throw new Error("stale_generation");
    }
  } else {
    matchId = room.ratedMatchId;
    if (typeof matchId !== "string" || !matchId) throw new Error("match_not_registered");
    card = await dbGet(env, deps, token, "matches/" + matchId);
    if (!card) throw new Error("match_not_registered");
    if (!sameGeneration(card, roomCode, room)) throw new Error("stale_generation");
    if (!cardMatchesRoomPlayers(card, room)) throw new Error("card_mismatch");
    if (!Object.prototype.hasOwnProperty.call(card.participants || {}, callerUid)) throw new Error("not_a_participant");
    // №23 fix (round 7): "room.status" — participant-controlled/потенциально
    // stale UX-projection, а НЕ Elo evidence. Для replayVersion>=1 protected
    // log уже authoritative: verifiedReplayOutcome() ниже сам определяет,
    // завершён ли матч (и корректно бросает match_not_finished, если нет).
    // Гейтить settlement по room.status ЗДЕСЬ означало бы, что participant
    // (или просто ещё не отремонтированная projection после сбоя
    // syncProjection) мог бы veto'ить server-verified Elo — найдено на
    // review. Для legacy (без replayVersion) поведение не меняется: там
    // room.status/winner — единственный доступный источник истины.
    if (!(card.replayVersion >= 1) && room.status !== "finished") throw new Error("match_not_finished");
  }

  let result;
  if (card.replayVersion >= 1) {
    // №23: room.winner/room.result НИКОГДА не Elo truth для replayVersion>=1.
    // Technical result (timeout/disconnect) не логируется как protected event,
    // поэтому verifiedReplayOutcome для такого матча корректно бросает
    // match_not_finished — fail-closed unrated, а не молчаливый обход через
    // room.result. Это следствие архитектуры, не отдельная спец-ветка.
    result = await verifiedReplayOutcome(env, deps, token, matchId, card);
  } else {
    result = roomOutcome(room); // room существует гарантированно в этой ветке (legacy room-missing уже вернулся выше)
    if (!result) throw new Error("match_not_finished");
  }

  let existing = await dbGet(env, deps, token, "eloMatches/" + matchId);
  if (existing) {
    validateReceiptAgainstCard(existing, card, result);
    if (existing.settledBy === "worker") {
      return {
        matchId,
        already: true,
        source: "worker",
        ratingConfirmed: true,
        deltas: { light: existing.lightDelta, dark: existing.darkDelta },
        result: existing.result
      };
    }
    // Under BRIDGE-A a legacy receipt is not authoritative proof that the
    // matching stats increments were applied: cached v193 normally writes
    // receipt + stats atomically, but the transition rules still allow a
    // forged create-only receipt. Treat it as the settlement lock for
    // compatibility, but do not tell C1 that an exact rating delta is
    // confirmed. BRIDGE-B removes this transitional ambiguity entirely.
    return {
      matchId,
      already: true,
      source: "legacy",
      ratingConfirmed: false,
      deltas: null,
      result: existing.result
    };
  }

  const by = cardByColor(card);
  await Promise.all([
    ensureStatsInitialized(env, deps, token, by.light, card.participants[by.light].name),
    ensureStatsInitialized(env, deps, token, by.dark, card.participants[by.dark].name)
  ]);

  const built = buildSettlementUpdates(matchId, card, result);
  let wrote = false;
  try {
    await dbPatchRoot(env, deps, token, built.updates);
    wrote = true;
  } catch (error) {
    // A concurrent v193/Worker settlement can make the create-only receipt reject
    // our whole atomic PATCH. Re-read the lock; only a valid matching receipt turns
    // this failure into an idempotent success.
    existing = await dbGet(env, deps, token, "eloMatches/" + matchId);
    if (!existing) throw error;
    validateReceiptAgainstCard(existing, card, result);
  }

  if (wrote) {
    return {
      matchId,
      already: false,
      source: "worker",
      ratingConfirmed: true,
      deltas: built.deltas,
      result
    };
  }
  if (existing && existing.settledBy === "worker") {
    return {
      matchId,
      already: true,
      source: "concurrent",
      ratingConfirmed: true,
      deltas: { light: existing.lightDelta, dark: existing.darkDelta },
      result: existing.result
    };
  }
  return {
    matchId,
    already: true,
    source: "concurrent",
    ratingConfirmed: false,
    deltas: null,
    result: existing ? existing.result : result
  };
}

const FIREBASE_CUSTOM_TOKEN_AUD =
  "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit";

const utf8 = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function stringToBase64Url(value) {
  return bytesToBase64Url(utf8.encode(value));
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("telegram_hash_invalid");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

async function importHmacKey(rawBytes, usages) {
  return crypto.subtle.importKey(
    "raw",
    rawBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages
  );
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await importHmacKey(keyBytes, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

function sortedDataCheckString(params) {
  const pairs = [];
  for (const [key, value] of params.entries()) {
    // Telegram's bot-token validation excludes only hash.
    // A newer "signature" field, if present, remains part of this check string.
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("\n");
}

function safeDisplayName(user) {
  let name = "Игрок";
  if (typeof user.username === "string" && user.username.trim()) {
    name = "@" + user.username.trim();
  } else if (typeof user.first_name === "string" && user.first_name.trim()) {
    name = user.first_name.trim();
  }
  // Existing RTDB rules require name.length < 50.
  return name.slice(0, 49);
}

export async function validateTelegramInitData(
  initData,
  botToken,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = 3600,
  futureSkewSeconds = 60
) {
  if (typeof initData !== "string" || initData.length < 1 || initData.length > 16384) {
    throw new Error("init_data_invalid");
  }
  if (typeof botToken !== "string" || botToken.length < 10) {
    throw new Error("bot_token_missing");
  }

  const params = new URLSearchParams(initData);
  const hashes = params.getAll("hash");
  if (hashes.length !== 1) throw new Error("telegram_hash_missing_or_duplicate");
  const suppliedHash = hexToBytes(hashes[0]);

  const dataCheckString = sortedDataCheckString(params);

  // Telegram Mini App algorithm:
  // secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
  // hash       = HMAC_SHA256(key=secret_key, data=data_check_string)
  const secretKeyBytes = await hmacSha256(
    utf8.encode("WebAppData"),
    utf8.encode(botToken)
  );
  const verifyKey = await importHmacKey(secretKeyBytes, ["verify"]);
  const signatureOK = await crypto.subtle.verify(
    "HMAC",
    verifyKey,
    suppliedHash,
    utf8.encode(dataCheckString)
  );
  if (!signatureOK) throw new Error("telegram_signature_invalid");

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw || !/^\d+$/.test(authDateRaw)) throw new Error("auth_date_invalid");
  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate)) throw new Error("auth_date_invalid");
  if (authDate > nowSeconds + futureSkewSeconds) throw new Error("auth_date_from_future");
  if (nowSeconds - authDate > maxAgeSeconds) throw new Error("auth_date_too_old");

  const userRaw = params.get("user");
  if (!userRaw) throw new Error("telegram_user_missing");

  let user;
  try {
    user = JSON.parse(userRaw);
  } catch {
    throw new Error("telegram_user_invalid_json");
  }

  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new Error("telegram_user_id_invalid");
  }

  const uid = `tg_${user.id}`;
  if (uid.length > 128) throw new Error("firebase_uid_too_long");

  return {
    uid,
    telegramId: String(user.id),
    name: safeDisplayName(user),
    authDate
  };
}

function pemToPkcs8Bytes(pem) {
  if (typeof pem !== "string" || !pem.includes("PRIVATE KEY")) {
    throw new Error("firebase_private_key_missing");
  }
  // Supports Cloudflare secrets pasted with either real newlines or escaped \n.
  const normalized = pem.replace(/\\n/g, "\n");
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!base64) throw new Error("firebase_private_key_invalid");

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function createFirebaseCustomToken(
  uid,
  serviceAccountEmail,
  privateKeyPem,
  nowSeconds = Math.floor(Date.now() / 1000)
) {
  if (typeof uid !== "string" || uid.length < 1 || uid.length > 128) {
    throw new Error("firebase_uid_invalid");
  }
  if (typeof serviceAccountEmail !== "string" || !serviceAccountEmail.includes("@")) {
    throw new Error("firebase_service_account_email_missing");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccountEmail,
    sub: serviceAccountEmail,
    aud: FIREBASE_CUSTOM_TOKEN_AUD,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    uid
  };

  const signingInput =
    stringToBase64Url(JSON.stringify(header)) +
    "." +
    stringToBase64Url(JSON.stringify(payload));

  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      privateKey,
      utf8.encode(signingInput)
    )
  );

  return signingInput + "." + bytesToBase64Url(signature);
}

function parseAllowedOrigins(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store"
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true; // allows direct diagnostic calls; auth still requires signed initData
  return parseAllowedOrigins(env.ALLOWED_ORIGINS).includes(origin);
}

function jsonResponse(request, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env)
    }
  });
}

function publicErrorCode(error) {
  const code = error && error.message ? String(error.message) : "auth_failed";
  const known = new Set([
    "init_data_invalid",
    "telegram_hash_missing_or_duplicate",
    "telegram_hash_invalid",
    "telegram_signature_invalid",
    "auth_date_invalid",
    "auth_date_from_future",
    "auth_date_too_old",
    "telegram_user_missing",
    "telegram_user_invalid_json",
    "telegram_user_id_invalid"
  ]);
  return known.has(code) ? code : "auth_failed";
}


function settlementCorsHeaders(request, env) {
  const headers = corsHeaders(request, env);
  headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
  return headers;
}

function jsonSettlementResponse(request, env, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...settlementCorsHeaders(request, env)
    }
  });
}

function extractBearer(request) {
  const raw = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+([^\s]+)$/i.exec(raw);
  if (!m || m[1].length < 20 || m[1].length > 10000) throw new Error("firebase_auth_invalid");
  return m[1];
}

export async function verifyCallerFirebaseIdToken(env, idToken, fetchFn = fetch) {
  if (!env.FIREBASE_WEB_API_KEY) throw new Error("server_not_configured");
  const res = await fetchFn(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
      encodeURIComponent(env.FIREBASE_WEB_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken })
    }
  );
  if (!res.ok) throw new Error("firebase_auth_invalid");
  const data = await res.json();
  if (!data || !Array.isArray(data.users) || data.users.length !== 1) throw new Error("firebase_auth_invalid");
  const user = data.users[0];
  const uid = user && user.localId;
  if (user && user.disabled === true) throw new Error("firebase_auth_invalid");
  if (typeof uid !== "string" || !/^tg_\d+$/.test(uid)) throw new Error("firebase_auth_invalid");
  return uid;
}

function validFirebasePathAtom(value, maxLen) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLen && !/[.#$\[\]\/]/.test(value);
}

function settlementPublicError(error) {
  const code = error && error.message ? String(error.message) : "settlement_failed";
  const allowed = new Set([
    "room_not_found", "not_a_player", "room_not_active", "room_not_ready",
    "not_first_match", "match_number_jump", "registration_conflict",
    "stale_generation", "match_not_registered", "match_not_rated",
    "not_a_participant", "match_not_finished", "card_mismatch",
    "receipt_mismatch", "nothing_to_resume", "legacy_receipt_room_missing",
    "stats_init_conflict",
    // №23: protected event log / replay errors
    "wrong_actor_turn", "illegal_segment", "incomplete_chain",
    "extra_landing_after_completion", "match_already_terminal",
    "idempotency_conflict", "event_limit_exceeded", "invalid_request_id",
    "invalid_event_type", "invalid_path", "invalid_offer_seq",
    "stale_or_missing_offer", "self_accept_rejected", "stale_offer",
    "event_log_corrupt", "append_conflict_retry_exhausted",
    "unknown_event_type", "match_id_invalid", "projection_sync_denied_unexpected",
    "draw_action_limit_exceeded"
  ]);
  return allowed.has(code) ? code : "settlement_failed";
}

function settlementDeps() {
  return {
    fetch: (...args) => fetch(...args),
    now: () => Date.now(),
    signCustomToken: createFirebaseCustomToken
  };
}

async function handleSettlement(request, env, url) {
  if (!originAllowed(request, env)) {
    return jsonSettlementResponse(request, env, 403, { ok: false, error: "origin_denied" });
  }
  if (!env.FIREBASE_SERVICE_ACCOUNT_EMAIL || !env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY ||
      !env.FIREBASE_WEB_API_KEY || !env.FIREBASE_DB_URL) {
    return jsonSettlementResponse(request, env, 503, { ok: false, error: "server_not_configured" });
  }

  let callerUid;
  try {
    callerUid = await verifyCallerFirebaseIdToken(env, extractBearer(request));
  } catch (error) {
    const code = error && error.message === "server_not_configured" ? "server_not_configured" : "firebase_auth_invalid";
    return jsonSettlementResponse(request, env, code === "server_not_configured" ? 503 : 401, { ok: false, error: code });
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonSettlementResponse(request, env, 400, { ok: false, error: "invalid_json" }); }

  try {
    const roomCode = body && body.roomCode;
    if (!validFirebasePathAtom(roomCode, 50)) {
      return jsonSettlementResponse(request, env, 400, { ok: false, error: "room_code_invalid" });
    }

    if (url.pathname === "/rated/join") {
      const result = await joinRatedMatch(env, settlementDeps(), callerUid, roomCode);
      return jsonSettlementResponse(request, env, 200, { ok: true, ...result });
    }
    if (url.pathname === "/rated/settle") {
      const knownMatchId = body && body.matchId;
      if (knownMatchId !== undefined && knownMatchId !== null && !validFirebasePathAtom(knownMatchId, 149)) {
        return jsonSettlementResponse(request, env, 400, { ok: false, error: "match_id_invalid" });
      }
      const result = await settleMatch(env, settlementDeps(), callerUid, roomCode, knownMatchId || null);
      return jsonSettlementResponse(request, env, 200, { ok: true, ...result });
    }
    if (url.pathname === "/rated/event") {
      const matchId = body && body.matchId;
      if (!validFirebasePathAtom(matchId, 149)) {
        return jsonSettlementResponse(request, env, 400, { ok: false, error: "match_id_invalid" });
      }
      const token = await getServerIdToken(env, settlementDeps());
      const card = await dbGet(env, settlementDeps(), token, "matches/" + matchId);
      if (!card || card.roomCode !== roomCode) {
        return jsonSettlementResponse(request, env, 409, { ok: false, error: "match_not_registered" });
      }
      const claim = {
        requestId: body && body.requestId,
        type: body && body.type,
        path: body && body.path,
        offerSeq: body && body.offerSeq
      };
      const result = await commitRatedEvent(env, settlementDeps(), token, matchId, card, callerUid, claim);
      return jsonSettlementResponse(request, env, 200, { ok: true, ...result });
    }
    return jsonSettlementResponse(request, env, 404, { ok: false, error: "not_found" });
  } catch (error) {
    const publicCode = settlementPublicError(error);
    const forbidden = publicCode === "not_a_player" || publicCode === "not_a_participant";
    return jsonSettlementResponse(request, env, forbidden ? 403 : 409, { ok: false, error: publicCode });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      if (!originAllowed(request, env)) {
        return jsonResponse(request, env, 403, { ok: false, error: "origin_denied" });
      }
      // Authorization is needed only by settlement endpoints, but allowing it on
      // the shared preflight does not change /auth/telegram semantics.
      return new Response(null, { status: 204, headers: settlementCorsHeaders(request, env) });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(request, env, 200, { ok: true });
    }

    if (request.method === "POST" && (url.pathname === "/rated/join" || url.pathname === "/rated/settle" || url.pathname === "/rated/event")) {
      return handleSettlement(request, env, url);
    }

    if (request.method !== "POST" || url.pathname !== "/auth/telegram") {
      return jsonResponse(request, env, 404, { ok: false, error: "not_found" });
    }

    // Everything below is the existing Telegram auth path, kept semantically unchanged.
    if (!originAllowed(request, env)) {
      return jsonResponse(request, env, 403, { ok: false, error: "origin_denied" });
    }

    if (!env.TELEGRAM_BOT_TOKEN ||
        !env.FIREBASE_SERVICE_ACCOUNT_EMAIL ||
        !env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY) {
      return jsonResponse(request, env, 503, { ok: false, error: "server_not_configured" });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(request, env, 400, { ok: false, error: "invalid_json" });
    }

    const maxAge = Number(env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 3600);
    if (!Number.isFinite(maxAge) || maxAge < 60 || maxAge > 86400) {
      return jsonResponse(request, env, 503, { ok: false, error: "server_not_configured" });
    }

    try {
      const identity = await validateTelegramInitData(
        body && body.initData,
        env.TELEGRAM_BOT_TOKEN,
        Math.floor(Date.now() / 1000),
        maxAge
      );

      const customToken = await createFirebaseCustomToken(
        identity.uid,
        env.FIREBASE_SERVICE_ACCOUNT_EMAIL,
        env.FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY
      );

      return jsonResponse(request, env, 200, {
        ok: true,
        customToken,
        uid: identity.uid,
        name: identity.name
      });
    } catch (error) {
      return jsonResponse(request, env, 401, {
        ok: false,
        error: publicErrorCode(error)
      });
    }
  }
};

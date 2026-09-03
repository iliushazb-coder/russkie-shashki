if (window.Telegram && window.Telegram.WebApp) {
    Telegram.WebApp.ready();
    Telegram.WebApp.expand();
}

// ===== FIREBASE =====

const firebaseConfig = {
    apiKey: "AIzaSyBZzxmmgRxNe1b-MFG4zIlCFTI7D3lStiA",
    authDomain: "russkie-shashki-online.firebaseapp.com",
    databaseURL: "https://russkie-shashki-online-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "russkie-shashki-online",
    storageBucket: "russkie-shashki-online.firebasestorage.app",
    messagingSenderId: "225166276271",
    appId: "1:225166276271:web:f15906ebc83350b002c65a"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const appCheck = firebase.appCheck();
appCheck.activate('6LdveXstAAAAAEH1UUtHVPTzlUOx-b82D5eWDXNw', true);

const database = firebase.database();

// ===== ГЛОБАЛЬНЫЙ СЛУШАТЕЛЬ ПЕРЕПОДКЛЮЧЕНИЯ FIREBASE =====
// Решает проблему ложных статусов "Офлайн" при кратковременных морганиях сети.
// Когда сеть возвращается, мы мгновенно бьём пульс присутствия (online: true),
// не дожидаясь ближайшего интервала (4 секунды). Это сбрасывает таймер 
// "checkOpponentAbsence" у соперника и не даёт комнате удалиться.
// Текущее состояние Firebase-соединения. Обновляется существующей подпиской
// .info/connected — НОВОГО трафика не добавляет.
// ВАЖНО: false означает "точно есть проблема связи", но true НЕ означает, что
// отправленный ход уже подтверждён сервером. Подтверждение определяется только
// реальным серверным состоянием (promise транзакции / listener комнаты).
let isFirebaseConnected = true;
// Момент, с которого связь держится НЕПРЕРЫВНО (null — связи нет).
// Это и есть наш способ убедиться, что данные о сопернике свежие: если мы
// уверенно на связи дольше CONNECTION_SETTLE_MS, а heartbeat соперника за это
// время так и не пришёл, значит он молчит по-настоящему, а не мы его не слышим.
// ВАЖНО: время держится по МОНОТОННЫМ часам (performance.now), а не по
// Date.now(). Весь этот патч защищается от скачков системного времени при
// выключении авиарежима — было бы нелепо мерить им же собственный интервал
// «связь стабильна 15 секунд»: прыжок часов вперёд мгновенно «состарил» бы
// соединение и разрешил удаление раньше срока.
let connectedSinceMono = null;
function getMonotonicNow() {
    return (typeof performance !== "undefined" && performance && typeof performance.now === "function")
        ? performance.now()
        : Date.now();
}
// Номер текущего подключения. Растёт при каждом восстановлении связи, чтобы
// поздний ответ сервера от ПРЕДЫДУЩЕГО подключения не засчитался как
// подтверждение для нового.
let connectionGeneration = 0;
// НАСТОЯЩЕЕ подтверждение сервера после этого подключения: promise нашей
// собственной записи presence разрешается только когда сервер её принял,
// то есть это доказанный круговой обмен с сервером, а не локальное событие.
let serverAckSinceConnect = false;
// Номер текущей ПОДПИСКИ на комнату. Растёт при каждой новой подписке на
// rooms/<код> — то есть при входе в другую комнату, при переоткрытии той же
// комнаты и при переходе в режим зрителя. Firebase-соединение при этом может
// не разрываться вовсе, поэтому доказательства, привязанные только к
// подключению, могли бы «протечь» из предыдущей комнаты в новую.
// Доказательство свежести обязано относиться к ТЕКУЩЕЙ комнате.
let listenerGeneration = 0;
// Обнуляет доказательства и открывает новое поколение подписки.
function resetRoomFreshnessProof() {
    listenerGeneration++;
    serverAckSinceConnect = false;
    roomSnapshotSeenSinceConnect = false;
}
function noteServerAck(connGen, listenerGen) {
    if (connGen !== connectionGeneration) return;      // ответ от прошлого подключения
    if (listenerGen !== listenerGeneration) return;    // ответ, относящийся к прошлой комнате
    if (!isFirebaseConnected) return;
    serverAckSinceConnect = true;
}
// Получил ли room-listener хотя бы один настоящий снапшот комнаты ПОСЛЕ
// последнего восстановления связи. Само по себе "соединение живо 15 секунд"
// доказывает только состояние транспорта Firebase, но НЕ то, что подписка на
// комнату пересинхронизировалась и наши presence-данные свежие. Флаг закрывает
// именно этот разрыв: он ставится только в колбэке listener'а с валидной
// комнатой и сбрасывается при каждом обрыве.
// Нормально взводится за ~4 секунды: мой собственный heartbeat пишет в
// rooms/<код>/presence/<мой цвет>, и listener сразу приносит обновление.
let roomSnapshotSeenSinceConnect = false;
// Три цикла heartbeat соперника (4с) с запасом: живой соперник за это время
// обязан был бы дать о себе знать хотя бы трижды.
const CONNECTION_SETTLE_MS = 15000;

const connectedRef = database.ref(".info/connected");
connectedRef.on("value", function(snap) {
    const wasConnected = isFirebaseConnected;
    isFirebaseConnected = (snap.val() === true);
    if (isFirebaseConnected && !wasConnected) {
        // Связь только что вернулась — всё доказательное состояние обнуляется:
        // ни прежний серверный ответ, ни прежние снапшоты комнаты больше не
        // считаются доказательством свежести, нужны новые.
        connectionGeneration++;
        connectedSinceMono = getMonotonicNow();
        serverAckSinceConnect = false;
        roomSnapshotSeenSinceConnect = false;
    } else if (!isFirebaseConnected) {
        connectedSinceMono = null;
        serverAckSinceConnect = false;
        roomSnapshotSeenSinceConnect = false;
    } else if (connectedSinceMono === null) {
        connectionGeneration++;
        connectedSinceMono = getMonotonicNow();
    }
    if (snap.val() === true) {
        // Дополнительная защита: оживляем presence, только если человек
        // ДЕЙСТВИТЕЛЬНО сейчас участвует в какой-то партии как игрок —
        // а не когда myPresenceRef случайно остался от уже неактуальной комнаты.
        // !document.hidden (v171) — та же защита, что у обычного heartbeat:
        // скрытый, но ещё живой WebView (Telegram сворачивает Mini App, не
        // убивая его сразу) не должен "оживлять" presence ушедшего игрока и
        // сбрасывать отсчёт absence у соперника. Настоящее возвращение в игру
        // покрыто тремя путями: visibilitychange (ветка visible пишет
        // online:true мгновенно), heartbeat (≤4с) и setupPresence при
        // полном перезапуске приложения.
        if (myPresenceRef && isOnlineGame && !isSpectator && roomCode && !document.hidden) {
            revivePresenceAfterReconnect();
        }
    }
});

// ===== ЭКОНОМИКА =====



// ===== ЗВУКИ =====

const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Современные браузеры блокируют звук, пока человек не коснётся экрана —
// это разблокирует звуковую систему при самом первом касании/клике.
function unlockAudioContext() {
    if (audioContext.state === "suspended") {
        audioContext.resume();
    }
}
document.addEventListener("touchstart", unlockAudioContext, { once: true });
document.addEventListener("click", unlockAudioContext, { once: true });

function playTone(frequency, duration, volume) {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.frequency.value = frequency;
    oscillator.type = "sine";
    gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + duration);
}

function playWoodKnock(duration, volume, filterFreq) {
    const bufferSize = Math.floor(audioContext.sampleRate * duration);
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
    }
    const noise = audioContext.createBufferSource();
    noise.buffer = buffer;

    const filter = audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterFreq;
    filter.Q.value = 1.1;

    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(volume, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(audioContext.destination);
    noise.start();
}

function playMoveSound() { playWoodKnock(0.09, 0.32, 1700); }
function playCaptureSound() {
    playWoodKnock(0.13, 0.5, 850);
    setTimeout(function () { playWoodKnock(0.1, 0.32, 650); }, 55);
}
function playKingSound() {
    playTone(523, 0.1, 0.22);
    setTimeout(function () { playTone(659, 0.1, 0.24); }, 90);
    setTimeout(function () { playTone(784, 0.22, 0.26); }, 180);
}
function playKingCaptureSound() {
    playWoodKnock(0.18, 0.6, 600);
    setTimeout(function () { playWoodKnock(0.13, 0.42, 480); }, 65);
    setTimeout(function () { playTone(880, 0.14, 0.18); }, 150);
}
function playWinSound() {
    playTone(392, 0.15, 0.3);
    setTimeout(function () { playTone(523, 0.15, 0.3); }, 150);
    setTimeout(function () { playTone(659, 0.3, 0.3); }, 300);
}
function playSoundForMoveType(type, wasKing) {
    if (type === "king") {
        playKingSound();
    } else if (type === "capture") {
        if (wasKing) {
            playKingCaptureSound();
        } else {
            playCaptureSound();
        }
    } else if (type === "move") {
        playMoveSound();
    }
}

// ===== ТЕЛЕГРАМ-ПОЛЬЗОВАТЕЛЬ =====

// ===== ВОРОТА ДОСТУПА К FIREBASE =====
//
// До подтверждённого входа через Telegram НИ ОДНА запись в Firebase не
// выполняется. Правила v12 всё равно отклонят такие записи, но полагаться
// на отказ сервера нельзя: сейчас правила ещё не опубликованы, и клиент
// обязан молчать сам.
//
// Локальная часть игры при этом работает: доска, ходы, бот. Не сохраняется
// только то, что живёт в Firebase — сессия партии с ботом, статистика,
// лобби и приглашения.
let firebaseAuthReady = false;
// Фаза входа. Двоичного флага не хватало: пока вход ещё шёл,
// requireFirebaseAuth() показывал терминальную ошибку «закройте и снова
// откройте игру», хотя закрывать ничего было не нужно. Игрок нажимал
// кнопку второй раз — и всё работало.
//   "pending" — вход выполняется, действие надо ДОЖДАТЬСЯ
//   "ready"   — вход состоялся
//   "failed"  — вход действительно не удался, ошибка честная
let authPhase = "pending";
let authPromise = null;
let localOnlyBotGame = false;
let pendingFirebaseIdentity = null;
let firebaseFlowsStarted = false;
function canUseFirebase() {
    const currentUser = auth && auth.currentUser;
    return firebaseAuthReady === true && !localOnlyBotGame
        && typeof myTelegramId === "string" && /^tg_\d+$/.test(myTelegramId)
        && !!currentUser && currentUser.uid === myTelegramId;
}

// Единая точка отказа для онлайновых разделов меню.
//
// Синхронная проверка осталась для мест, где ждать нельзя. Она НЕ
// показывает ошибку, если вход ещё идёт, — иначе получалось ложное
// сообщение при быстром нажатии сразу после запуска.
function requireFirebaseAuth() {
    if (canUseFirebase()) return true;
    if (authPhase !== "pending") showInfoModal(t("err_auth_required"), false);
    return false;
}

// Асинхронные ворота для кнопок меню: если вход ещё идёт, дожидаемся его
// и продолжаем действие сами. Никаких таймеров и никакого ослабления
// проверки: canUseFirebase() остаётся единственным решающим условием.
async function requireFirebaseAuthAsync() {
    if (canUseFirebase()) return true;
    if (authPhase === "pending" && authPromise) {
        try { await authPromise; } catch (e) {}
        if (canUseFirebase()) return true;
    }
    showInfoModal(t("err_auth_required"), false);
    return false;
}

let myTelegramId = null;
let myTelegramName = null;

// ===== ЛОКАЛИЗАЦИЯ (i18n) =====
let currentLang = localStorage.getItem("shashki_lang");
if (!currentLang) {
    let tgLang = (window.Telegram && window.Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.user && Telegram.WebApp.initDataUnsafe.user.language_code) ? Telegram.WebApp.initDataUnsafe.user.language_code : "ru";
    if (tgLang === "ru" || tgLang === "en" || tgLang === "it") {
        currentLang = tgLang;
    } else {
        currentLang = "ru"; // Для всех остальных языков по умолчанию русский
    }
    localStorage.setItem("shashki_lang", currentLang);
}

// Словарь переводов
const translations = {
    ru: {
        h1_title: "Русские Шашки 🎮",
        no_active_game: "Нет активной игры",
        active_games: "Активные игры",
        btn_play_online: "👥 Кто играет?",
        btn_play_friend: "👥 Играть с другом",
        btn_play_bot: "🤖 Играть с ботом",
        btn_continue: "▶️ Продолжить",
        btn_show_stats: "📊 Моя статистика",
        time_control_prompt: "Выбери контроль времени на ход:",
        time_0: "Без ограничения",
        time_30: "30 секунд на ход",
        time_60: "1 минута на ход",
        time_120: "2 минуты на ход",
        time_180: "3 минуты на ход",
        time_300: "5 минут на ход",
        btn_back: "Назад",
        waiting_link_prompt: "Отправь эту ссылку другу:",
        btn_share_link: "📤 Отправить другу",
        waiting_friend: "Ожидание подключения друга...",
        btn_draw: "🤝 Ничья",
        btn_resign: "🏳 Сдаться",
        timer_move: "Ход",
        timer_time_left: "осталось",
        whites: "Белые",
        blacks: "Чёрные",
        spectators: "Смотрят",
        status_in_game: "В игре",
        status_offline: "Оффлайн",
        status_left: "осталось",
        sec: "с",
        status_connecting: "подключение...",
        status_game_interrupted: "Игра прервана",
        status_confirming_result: "Подтверждение результата…",
        sync_sending_move: "Отправляю ход…",
        sync_no_connection: "Нет связи. Подождите восстановления соединения",
        sync_checking: "Проверяю соединение…",
        sync_failed: "Не удалось обновить игру",
        btn_sync_retry: "Повторить",
        draw_agreed: "🤝 Ничья!\nОба игрока согласились закончить партию.",
        draw_manual_header: "🤝 НИЧЬЯ",
        draw_manual_text: "Оба игрока согласились на ничью.",
        draw_by_rule_header: "🤝 НИЧЬЯ ПО ПРАВИЛАМ",
        draw_reason_unknown: "Партия завершена автоматически по правилу ничьей",
        win_reason_disconnect: "Соперник не вернулся в игру",
        draw_reason_threefold: "Троекратное повторение позиции",
        draw_reason_kings15: "Лимит 15 ходов только дамками, без взятий",
        draw_reason_np5: "Лимит 5 ходов в окончании с 2\u20133 фигурами",
        draw_reason_np30: "Лимит 30 ходов в окончании с 4\u20135 фигурами",
        draw_reason_np60: "Лимит 60 ходов в окончании с 6\u20137 фигурами",
        draw_reason_longroad: "Лимит 5 ходов: дамка на большой дороге",
        btn_to_menu: "В меню",
        btn_close: "Закрыть",
        btn_ok: "ОК",
        waiting_rematch: "⏳ Ждём ответа соперника на реванш...",
        offers_rematch: " предлагает сыграть ещё раз",
        waiting_draw: "⏳ Ждём ответа соперника на ничью...",
        offers_draw: " предлагает ничью",
        btn_cancel: "Отменить",
        opponent_default: "Соперник",
        rematch_no_response: "Соперник не ответил на реванш (пропал).",
        left_game: " покинул игру 👋",
        game_over: "\nПартия завершена.",
        err_resync_failed: "Потеряно соединение с сервером. Попробуйте перезайти в игру.",
        err_load_game: "Не удалось загрузить игру. Проверьте интернет-соединение.",
        err_no_active_game: "Нет активной игры",
        err_play_self: "Нельзя играть против самого себя",
        err_opponent_offline: "Соперник оффлайн\n\n",
        err_opponent_offline_2: " больше не находится в игре.",
        err_join_failed: "Не удалось подключиться к игре. Попробуйте ещё раз.",
        err_auth_required: "Онлайн доступен только после входа через Telegram. Закройте и снова откройте игру.",
        rating_unrated: "Без рейтинга",
        rating_confirming: "Подтверждаем рейтинг…",
        rating_change_unconfirmed: "Изменение рейтинга не подтверждено",
        rating_check_in_stats: "Проверьте актуальный рейтинг в статистике",
        stats_your_rank: "Ваше место",
        stats_rank_of: "из",
        rating_settlement_failed: "Реванш пока недоступен: результат рейтинга не подтверждён.",
        err_room_taken: "Комната уже занята или не существует.",
        err_search_failed: "Не удалось начать поиск. Проверьте интернет-соединение.",
        err_game_closed: "Игра была завершена или закрыта.",
        err_resign_failed: "Не удалось сдаться. Попробуйте ещё раз.",
        err_resign_connection: "Ошибка соединения при сдаче.",
        err_draw_failed: "Не удалось принять ничью. Возможно, игра уже завершена.",
        err_draw_connection: "Ошибка соединения при принятии ничьей.",
        err_rematch_failed: "Не удалось начать реванш. Возможно, потеряно соединение.",
        loading: "Загрузка...",
        lobby_empty: "Пока никто не играет",
        btn_back_bot: "👈 Назад",
        confirm_back_bot: "Вы точно хотите выйти?",
        confirm_resign: "Вы уверены, что хотите сдаться?",
        btn_yes: "Да",
        btn_no: "Нет",
        btn_rematch: "Реванш",
        btn_new_game: "Новая игра",
        btn_start_new_game: "Начать новую игру",
        stats_top_online: "📊 Топ игроков (Онлайн)",
        stats_top_bot: "🤖 Топ игроков (Против бота)",
        stats_tab_online: "🌐 Онлайн",
        stats_tab_bot: "🤖 С ботом",
        stats_label_wins: "Побед",
        stats_label_losses: "Поражений",
        stats_label_games: "Игр",
        stats_label_bylevel: "По уровням сложности",
        modal_offline_opp: "Соперник офлайн",
        modal_bot_difficulty: "Выберите сложность",
        modal_continue_or_new: "У вас уже есть партия с ботом",
        btn_continue_existing: "▶️ Продолжить текущую",
        btn_start_new_session: "🆕 Начать новую",
        btn_difficulty_easy: "🌱 Лёгкий",
        btn_difficulty_medium: "⚖️ Средний",
        btn_difficulty_hard: "🔥 Сложный",
        btn_play_bot_offline: "🤖 Играть с ботом",
        btn_invite_other: "👥 Пригласить другого друга",
        btn_accept: "✅ Принять",
        btn_decline: "❌ Отклонить",
        btn_cancel_offer: "Отменить предложение",
        checking_game: "Проверяем игру...",
        connecting_to_friend: "Подключаемся к другу...",
        game_against: "Игра против",
        remove_from_list: "Убрать из списка",
        stats_no_online_games: "Пока никто не сыграл ни одной партии",
        stats_load_error: "Не удалось загрузить рейтинг",
        stats_no_bot_games: "Пока никто не играл с ботом",
        bot_details_total: "Всего",
        stats_games_word: "партий",
        lobby_waiting: "Ждут игру",
        lobby_active: "Идут игры",
        matchmaking_searching: "Поиск соперника...",
        matchmaking_count_one: "Сейчас в поиске: {count} игрок",
        matchmaking_count_few: "Сейчас в поиске: {count} игрока",
        matchmaking_count_many: "Сейчас в поиске: {count} игроков",
        matchmaking_cancel: "🔴 Отменить поиск"
    },
    en: {
        h1_title: "Russian Checkers 🎮",
        no_active_game: "No active games",
        active_games: "Active games",
        btn_play_online: "👥 Who is playing?",
        btn_play_friend: "👥 Play with a friend",
        btn_play_bot: "🤖 Play with bot",
        btn_continue: "▶️ Continue",
        btn_show_stats: "📊 My statistics",
        time_control_prompt: "Choose time control per move:",
        time_0: "No limit",
        time_30: "30 seconds per move",
        time_60: "1 minute per move",
        time_120: "2 minutes per move",
        time_180: "3 minutes per move",
        time_300: "5 minutes per move",
        btn_back: "Back",
        waiting_link_prompt: "Send this link to a friend:",
        btn_share_link: "📤 Send to friend",
        waiting_friend: "Waiting for friend to connect...",
        btn_draw: "🤝 Draw",
        btn_resign: "🏳 Resign",
        timer_move: "Move",
        timer_time_left: "left",
        whites: "White",
        blacks: "Black",
        spectators: "Watching",
        status_in_game: "In game",
        status_offline: "Offline",
        status_left: "left",
        sec: "s",
        status_connecting: "connecting...",
        status_game_interrupted: "Game interrupted",
        status_confirming_result: "Confirming result…",
        sync_sending_move: "Sending your move…",
        sync_no_connection: "No connection. Please wait until it is restored",
        sync_checking: "Checking the connection…",
        sync_failed: "Could not refresh the game",
        btn_sync_retry: "Retry",
        draw_agreed: "🤝 Draw!\nBoth players agreed to end the game.",
        draw_manual_header: "🤝 DRAW",
        draw_manual_text: "Both players agreed to a draw.",
        draw_by_rule_header: "🤝 DRAW BY RULE",
        draw_reason_unknown: "The game ended automatically by a draw rule",
        win_reason_disconnect: "Opponent did not return",
        draw_reason_threefold: "Threefold repetition of the position",
        draw_reason_kings15: "15-move limit: kings only, no captures",
        draw_reason_np5: "5-move limit in a 2\u20133 piece ending",
        draw_reason_np30: "30-move limit in a 4\u20135 piece ending",
        draw_reason_np60: "60-move limit in a 6\u20137 piece ending",
        draw_reason_longroad: "5-move limit: lone king on the long diagonal",
        btn_to_menu: "To menu",
        btn_close: "Close",
        btn_ok: "OK",
        waiting_rematch: "⏳ Waiting for opponent's response to rematch...",
        offers_rematch: " offers a rematch",
        waiting_draw: "⏳ Waiting for opponent's response to draw...",
        offers_draw: " offers a draw",
        btn_cancel: "Cancel",
        opponent_default: "Opponent",
        rematch_no_response: "Opponent didn't respond to rematch (disconnected).",
        left_game: " left the game 👋",
        game_over: "\nGame over.",
        err_resync_failed: "Lost connection to server. Try rejoining the game.",
        err_load_game: "Failed to load game. Check your internet connection.",
        err_no_active_game: "No active game",
        err_play_self: "Cannot play against yourself",
        err_opponent_offline: "Opponent is offline\n\n",
        err_opponent_offline_2: " is no longer in the game.",
        err_join_failed: "Failed to join the game. Try again.",
        err_auth_required: "Online is available only after signing in via Telegram. Close and reopen the game.",
        rating_unrated: "Unrated",
        rating_confirming: "Confirming rating…",
        rating_change_unconfirmed: "Rating change not confirmed",
        rating_check_in_stats: "Check your current rating in statistics",
        stats_your_rank: "Your rank",
        stats_rank_of: "of",
        rating_settlement_failed: "Rematch is temporarily unavailable: the rating result was not confirmed.",
        err_room_taken: "Room is already taken or doesn't exist.",
        err_search_failed: "Failed to start search. Check your internet connection.",
        err_game_closed: "The game was ended or closed.",
        err_resign_failed: "Failed to resign. Try again.",
        err_resign_connection: "Connection error during resignation.",
        err_draw_failed: "Failed to accept draw. The game might be over.",
        err_draw_connection: "Connection error during draw acceptance.",
        err_rematch_failed: "Failed to start rematch. Connection might be lost.",
        loading: "Loading...",
        lobby_empty: "Nobody is playing right now",
        btn_back_bot: "👈 Back",
        confirm_back_bot: "Are you sure you want to exit?",
        confirm_resign: "Are you sure you want to resign?",
        btn_yes: "Yes",
        btn_no: "No",
        btn_rematch: "Rematch",
        btn_new_game: "New game",
        btn_start_new_game: "Start new game",
        stats_top_online: "📊 Top players (Online)",
        stats_top_bot: "🤖 Top players (vs Bot)",
        stats_tab_online: "🌐 Online",
        stats_tab_bot: "🤖 vs Bot",
        stats_label_wins: "Wins",
        stats_label_losses: "Losses",
        stats_label_games: "Games",
        stats_label_bylevel: "By difficulty",
        modal_offline_opp: "Opponent offline",
        modal_bot_difficulty: "Choose difficulty",
        modal_continue_or_new: "You already have a game with the bot",
        btn_continue_existing: "▶️ Continue current",
        btn_start_new_session: "🆕 Start new",
        btn_difficulty_easy: "🌱 Easy",
        btn_difficulty_medium: "⚖️ Medium",
        btn_difficulty_hard: "🔥 Hard",
        btn_play_bot_offline: "🤖 Play with bot",
        btn_invite_other: "👥 Invite another friend",
        btn_accept: "✅ Accept",
        btn_decline: "❌ Decline",
        btn_cancel_offer: "Cancel offer",
        checking_game: "Checking game...",
        connecting_to_friend: "Connecting to friend...",
        game_against: "Game against",
        remove_from_list: "Remove from list",
        stats_no_online_games: "No online games have been played yet",
        stats_load_error: "Failed to load leaderboard",
        stats_no_bot_games: "No games against the bot have been played yet",
        bot_details_total: "Total",
        stats_games_word: "games",
        lobby_waiting: "Waiting for a game",
        lobby_active: "Games in progress",
        matchmaking_searching: "Searching for an opponent...",
        matchmaking_count_one: "Currently searching: {count} player",
        matchmaking_count_few: "Currently searching: {count} players",
        matchmaking_count_many: "Currently searching: {count} players",
        matchmaking_cancel: "🔴 Cancel search"
    },
    it: {
        h1_title: "Dama Russa 🎮",
        no_active_game: "Nessuna partita attiva",
        active_games: "Partite attive",
        btn_play_online: "👥 Chi sta giocando?",
        btn_play_friend: "👥 Gioca con un amico",
        btn_play_bot: "🤖 Gioca con il bot",
        btn_continue: "▶️ Continua",
        btn_show_stats: "📊 Le mie statistiche",
        time_control_prompt: "Scegli il tempo per mossa:",
        time_0: "Senza limiti",
        time_30: "30 secondi per mossa",
        time_60: "1 minuto per mossa",
        time_120: "2 minuti per mossa",
        time_180: "3 minuti per mossa",
        time_300: "5 minuti per mossa",
        btn_back: "Indietro",
        waiting_link_prompt: "Invia questo link a un amico:",
        btn_share_link: "📤 Invia ad un amico",
        waiting_friend: "In attesa che l'amico si connetta...",
        btn_draw: "🤝 Pareggio",
        btn_resign: "🏳 Abbandona",
        timer_move: "Turno",
        timer_time_left: "rimasti",
        whites: "Bianchi",
        blacks: "Neri",
        spectators: "Spettatori",
        status_in_game: "In gioco",
        status_offline: "Offline",
        status_left: "rimasti",
        sec: "s",
        status_connecting: "connessione...",
        status_game_interrupted: "Partita interrotta",
        status_confirming_result: "Conferma del risultato…",
        sync_sending_move: "Invio la mossa…",
        sync_no_connection: "Nessuna connessione. Attendi il ripristino",
        sync_checking: "Controllo la connessione…",
        sync_failed: "Impossibile aggiornare la partita",
        btn_sync_retry: "Riprova",
        draw_agreed: "🤝 Pareggio!\nEntrambi i giocatori hanno concordato di terminare.",
        draw_manual_header: "🤝 PATTA",
        draw_manual_text: "Entrambi i giocatori hanno accettato la patta.",
        draw_by_rule_header: "🤝 PATTA PER REGOLA",
        draw_reason_unknown: "Partita terminata automaticamente per una regola di patta",
        win_reason_disconnect: "L'avversario non è tornato",
        draw_reason_threefold: "Triplice ripetizione della posizione",
        draw_reason_kings15: "Limite di 15 mosse: solo dame, senza catture",
        draw_reason_np5: "Limite di 5 mosse in un finale con 2\u20133 pezzi",
        draw_reason_np30: "Limite di 30 mosse in un finale con 4\u20135 pezzi",
        draw_reason_np60: "Limite di 60 mosse in un finale con 6\u20137 pezzi",
        draw_reason_longroad: "Limite di 5 mosse: dama sulla diagonale principale",
        btn_to_menu: "Al menu",
        btn_close: "Chiudi",
        btn_ok: "OK",
        waiting_rematch: "⏳ In attesa di risposta per la rivincita...",
        offers_rematch: " offre una rivincita",
        waiting_draw: "⏳ In attesa di risposta per il pareggio...",
        offers_draw: " offre il pareggio",
        btn_cancel: "Annulla",
        opponent_default: "Avversario",
        rematch_no_response: "L'avversario non ha risposto alla rivincita (disconnesso).",
        left_game: " ha lasciato la partita 👋",
        game_over: "\nPartita terminata.",
        err_resync_failed: "Connessione al server persa. Prova a rientrare nella partita.",
        err_load_game: "Impossibile caricare la partita. Controlla la connessione.",
        err_no_active_game: "Nessuna partita attiva",
        err_play_self: "Non puoi giocare contro te stesso",
        err_opponent_offline: "L'avversario è offline\n\n",
        err_opponent_offline_2: " non è più in gioco.",
        err_join_failed: "Impossibile unirsi alla partita. Riprova.",
        err_auth_required: "L'online è disponibile solo dopo l'accesso tramite Telegram. Chiudi e riapri il gioco.",
        rating_unrated: "Senza punteggio",
        rating_confirming: "Conferma del punteggio…",
        rating_change_unconfirmed: "Variazione del punteggio non confermata",
        rating_check_in_stats: "Controlla il punteggio attuale nelle statistiche",
        stats_your_rank: "La tua posizione",
        stats_rank_of: "su",
        rating_settlement_failed: "La rivincita non è disponibile: il risultato del punteggio non è stato confermato.",
        err_room_taken: "La stanza è già occupata o non esiste.",
        err_search_failed: "Impossibile avviare la ricerca. Controlla la connessione.",
        err_game_closed: "La partita è stata terminata o chiusa.",
        err_resign_failed: "Impossibile abbandonare. Riprova.",
        err_resign_connection: "Errore di connessione durante l'abbandono.",
        err_draw_failed: "Impossibile accettare il pareggio. La partita potrebbe essere finita.",
        err_draw_connection: "Errore di connessione durante il pareggio.",
        err_rematch_failed: "Impossibile avviare la rivincita. Connessione persa.",
        loading: "Caricamento...",
        lobby_empty: "Nessuno sta giocando",
        btn_back_bot: "👈 Indietro",
        confirm_back_bot: "Sei sicuro di voler uscire?",
        confirm_resign: "Sei sicuro di voler abbandonare?",
        btn_yes: "Sì",
        btn_no: "No",
        btn_rematch: "Rivincita",
        btn_new_game: "Nuova partita",
        btn_start_new_game: "Inizia nuova partita",
        stats_top_online: "📊 Migliori (Online)",
        stats_top_bot: "🤖 Migliori (vs Bot)",
        stats_tab_online: "🌐 Online",
        stats_tab_bot: "🤖 vs Bot",
        stats_label_wins: "Vittorie",
        stats_label_losses: "Sconfitte",
        stats_label_games: "Partite",
        stats_label_bylevel: "Per difficoltà",
        modal_offline_opp: "Avversario offline",
        modal_bot_difficulty: "Scegli la difficoltà",
        modal_continue_or_new: "Hai già una partita con il bot",
        btn_continue_existing: "▶️ Continua quella attuale",
        btn_start_new_session: "🆕 Inizia una nuova",
        btn_difficulty_easy: "🌱 Facile",
        btn_difficulty_medium: "⚖️ Medio",
        btn_difficulty_hard: "🔥 Difficile",
        btn_play_bot_offline: "🤖 Gioca con il bot",
        btn_invite_other: "👥 Invita un altro amico",
        btn_accept: "✅ Accetta",
        btn_decline: "❌ Rifiuta",
        btn_cancel_offer: "Annulla offerta",
        checking_game: "Controllo della partita...",
        connecting_to_friend: "Connessione all'amico...",
        game_against: "Partita contro",
        remove_from_list: "Rimuovi dall'elenco",
        stats_no_online_games: "Non è stata ancora giocata nessuna partita online",
        stats_load_error: "Impossibile caricare la classifica",
        stats_no_bot_games: "Non è stata ancora giocata nessuna partita contro il bot",
        bot_details_total: "Totale",
        stats_games_word: "partite",
        lobby_waiting: "In attesa di una partita",
        lobby_active: "Partite in corso",
        matchmaking_searching: "Ricerca di un avversario...",
        matchmaking_count_one: "Attualmente in ricerca: {count} giocatore",
        matchmaking_count_few: "Attualmente in ricerca: {count} giocatori",
        matchmaking_count_many: "Attualmente in ricerca: {count} giocatori",
        matchmaking_cancel: "🔴 Annulla ricerca"
    }
};

// Функция получения перевода по ключу
function t(key) {
    return (translations[currentLang] && translations[currentLang][key]) || (translations['ru'] && translations['ru'][key]) || key;
}

// Функция применения переводов к HTML-элементам с атрибутом data-i18n
function applyTranslationsToDOM() {
    document.querySelectorAll("[data-i18n]").forEach(function(el) {
        const key = el.getAttribute("data-i18n");
        el.textContent = t(key);
    });
    // Обновляем подсветку активного флага
    document.querySelectorAll(".lang-btn").forEach(function(btn) {
        if (btn.getAttribute("data-lang") === currentLang) {
            btn.classList.add("active");
        } else {
            btn.classList.remove("active");
        }
    });
}

// Обработчики кнопок ручного переключения языка (три отдельных флага)
document.querySelectorAll(".lang-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
        currentLang = btn.getAttribute("data-lang");
        localStorage.setItem("shashki_lang", currentLang);
        applyTranslationsToDOM(); // Применяем новый язык сразу
    });
});

// ===== ЭКРАНЫ =====

const menuScreen = document.getElementById("menu-screen");
const timeControlScreen = document.getElementById("time-control-screen");
const waitingScreen = document.getElementById("waiting-screen");
const gameScreen = document.getElementById("game-screen");
const matchmakingScreen = document.getElementById("matchmaking-screen");
const btnPlayOnline = document.getElementById("btn-play-online");
const btnCancelMatchmaking = document.getElementById("btn-cancel-matchmaking");
const matchmakingCount = document.getElementById("matchmaking-count");
const btnPlayFriend = document.getElementById("btn-play-friend");
const btnPlayBot = document.getElementById("btn-play-bot");
const inviteLinkBox = document.getElementById("invite-link-box");
const btnShareLink = document.getElementById("btn-share-link");
const waitingText = document.getElementById("waiting-text");
const btnResign = document.getElementById("btn-resign");
const resignConfirmModal = document.getElementById("resign-confirm-modal");
const btnResignYes = document.getElementById("btn-resign-yes");
const btnResignNo = document.getElementById("btn-resign-no");
const btnBackBot = document.getElementById("btn-back-bot");
const btnBackSpectator = document.getElementById("btn-back-spectator");
const backConfirmModal = document.getElementById("back-confirm-modal");
const btnBackBotYes = document.getElementById("btn-back-bot-yes");
const btnBackBotNo = document.getElementById("btn-back-bot-no");
const endGameModal = document.getElementById("end-game-modal");
const endGameSubtext = document.getElementById("end-game-subtext");
const playerTopRating = document.getElementById("player-top-rating");
const playerBottomRating = document.getElementById("player-bottom-rating");
const endGameRating = document.getElementById("end-game-rating");
const statsYourRank = document.getElementById("stats-your-rank");
const rematchWaitNote = document.getElementById("rematch-wait-note");
const endGameText = document.getElementById("end-game-text");
const btnNewGame = document.getElementById("btn-new-game");
const btnCloseGame = document.getElementById("btn-close-game");
const turnTimerDiv = document.getElementById("turn-timer");
const playerTopName = document.getElementById("player-top-name");
const playerBottomName = document.getElementById("player-bottom-name");
const playerTopCaptured = document.getElementById("player-top-captured");
const playerBottomCaptured = document.getElementById("player-bottom-captured");
const playerTopStatus = document.getElementById("player-top-status");
const playerBottomStatus = document.getElementById("player-bottom-status");
const playerTopPanel = document.getElementById("player-top");
const playerBottomPanel = document.getElementById("player-bottom");
const opponentLeftModal = document.getElementById("opponent-left-modal");
const opponentLeftText = document.getElementById("opponent-left-text");
const btnNewGameAfterLeave = document.getElementById("btn-new-game-after-leave");
const btnCloseAfterLeave = document.getElementById("btn-close-after-leave");
const infoModal = document.getElementById("info-modal");
const infoModalText = document.getElementById("info-modal-text");
const btnInfoNewGame = document.getElementById("btn-info-new-game");
const btnInfoClose = document.getElementById("btn-info-close");
const spectatorInterruptedModal = document.getElementById("spectator-interrupted-modal");
const btnSpectatorInterruptedOk = document.getElementById("btn-spectator-interrupted-ok");
const btnShowStats = document.getElementById("btn-show-stats");
const statsModal = document.getElementById("stats-modal");
const statsMySummary = document.getElementById("stats-my-summary");
const statsLeaderboard = document.getElementById("stats-leaderboard");
const statsLeaderboardLosses = document.getElementById("stats-leaderboard-losses");
const btnStatsClose = document.getElementById("btn-stats-close");
const offlineOpponentModal = document.getElementById("offline-opponent-modal");
const botDifficultyModal = document.getElementById("bot-difficulty-modal");
const btnDifficultyEasy = document.getElementById("btn-difficulty-easy");
const btnDifficultyMedium = document.getElementById("btn-difficulty-medium");
const btnDifficultyHard = document.getElementById("btn-difficulty-hard");
const btnDifficultyBack = document.getElementById("btn-difficulty-back");
const continueOrNewModal = document.getElementById("continue-or-new-modal");
const btnContinueExistingSession = document.getElementById("btn-continue-existing-session");
const btnStartNewSession = document.getElementById("btn-start-new-session");
const btnContinueOrNewBack = document.getElementById("btn-continue-or-new-back");
const offlineOpponentText = document.getElementById("offline-opponent-text");
const btnOfflinePlayBot = document.getElementById("btn-offline-play-bot");
const btnOfflineInviteFriend = document.getElementById("btn-offline-invite-friend");
const rematchRequestModal = document.getElementById("rematch-request-modal");
const rematchRequestText = document.getElementById("rematch-request-text");
const btnRematchAccept = document.getElementById("btn-rematch-accept");
const btnRematchDecline = document.getElementById("btn-rematch-decline");
const btnOfferDraw = document.getElementById("btn-offer-draw");
const drawOfferModal = document.getElementById("draw-offer-modal");
const drawOfferText = document.getElementById("draw-offer-text");
const btnDrawAccept = document.getElementById("btn-draw-accept");
const btnDrawDecline = document.getElementById("btn-draw-decline");
const btnDrawCancel = document.getElementById("btn-draw-cancel");
const reactionsRow = document.getElementById("reactions-row");
const btnReactLaugh = document.getElementById("btn-react-laugh");
const btnReactFire = document.getElementById("btn-react-fire");
const btnReactShock = document.getElementById("btn-react-shock");
const btnReactAngry = document.getElementById("btn-react-angry");
const emojiBurstContainer = document.getElementById("emoji-burst-container");
let lastReactionTs = 0;

// ===== ONLINE ELO =====
// Рейтинг существует ТОЛЬКО для online-партий человек-против-человека.
// Бот в Elo не участвует вообще (см. isRatedMatchReadyForSettlement).
// Старый игрок без поля rating считается имеющим ELO_START_RATING —
// массовой миграции базы сознательно нет, отсутствующее поле
// доинициализируется лениво, при первой же рейтинговой партии.
const ELO_START_RATING = 1000;
// Сколько раз пытаться записать receipt одной партии. Отказ — ШТАТНАЯ
// ситуация: из двух клиентов receipt успевает записать ровно один, второй
// получает permission denied от Rules (!data.exists()). Отличить "соперник
// уже записал" от настоящей ошибки нельзя: eloMatches сознательно закрыт на
// чтение (.read: false), чтобы не публиковать связку id↔id↔время. Поэтому
// ограничиваем число попыток вместо бесконечного повтора.
const ELO_MAX_WRITE_ATTEMPTS = 3;

// Уникальный ID текущей партии с ботом.
// Для онлайн-игры ID будет строиться из roomCode + matchNumber.
let currentBotMatchId = null;

// Локальная защита от повторного запроса выплаты
// для одной и той же партии в текущей открытой сессии.
// Настоящая защита от двойной выплаты будет находиться

let roomCode = null;
let myPendingFriendRoomCode = null; // Отдельная, "неприкосновенная" переменная именно для ссылки-приглашения — защита от того, что общая roomCode может смениться где-то в фоне между созданием комнаты и нажатием "Отправить другу"
let myColor = "light";
let isOnlineGame = false;
let pendingTimeControlSeconds = 0;
let roomListenerRef = null;
let myPresenceRef = null;
let presenceHeartbeatInterval = null;
// (v171) Я — создатель waiting-комнаты, и второй игрок ещё НЕ подключился.
// Единственное назначение флага: разрешить heartbeat'у обновлять lastSeen
// даже при document.hidden — для нормального сценария "нажал Поделиться →
// ушёл в чат Telegram отправить ссылку другу". Без этого lastSeen замерзает
// и lobby-sweep удалил бы комнату через ~60с, пока создатель просто
// отправляет приглашение. Взводится ТОЛЬКО в живых точках входа создателя
// (createRoomAndShowWaiting и повторное открытие своей waiting-комнаты по
// invite-ссылке), снимается в startOnlineGame() и detachMyPresence() —
// т.е. как только партия реально началась либо участие в комнате кончилось.
// Во время active-партии document.hidden по-прежнему останавливает heartbeat.
let myWaitingRoomNoOpponent = false;
let opponentAbsenceHandled = false;
const STALE_MS = 20000; 
const RECONNECT_GRACE_MS = 60000; // Перенесли наверх для порядка
// v180. Единственный код причины технического поражения. Отдельная константа,
// чтобы клиент и Firebase Rules описывали ОДНО И ТО ЖЕ слово, а опечатка в
// одном из мест не создавала второй, никем не проверяемый вид результата.
const TECHNICAL_WIN_REASON = "disconnect";
// Порог "возможно офлайн" по времени с последнего lastSeen — нужен ТОЛЬКО
// потому, что у bot-зеркала сознательно нет onDisconnect() (небезопасно
// при двух owner-устройствах — см. mirrorCommittedStateToSpectateRoom),
// значит presence.online для bot-игр никогда не становится false сам по
// себе. Заметно больше heartbeat-интервала (4с), чтобы обычный джиттер
// сети не мигал "офлайн" на каждый пропущенный тик.
const PRESENCE_STALE_WARNING_MS = 12000;
// Показана ли уже модалка "Игра прервана" в ТЕКУЩЕЙ spectator-сессии — не
// даёт показывать её повторно на каждый тик updatePresenceOnly() (раз в
// секунду), пока зритель не уйдёт сам. Сбрасывается на новый вход в
// watchGroupRoomAsSpectator().
let spectatorInterruptedModalShown = false;
const BOT_USERNAME = "russkie_shashki_bot";

let matchmakingQueueRef = null;
let myPendingOnlineRoom = null; // код комнаты, которую я создал через "Играть онлайн" и ещё жду соперника
let activeMatchRef = null;
let matchmakingDecisionMade = false; // защита от гонки условий: решение "создать/присоединиться" принимается один раз
let isBotGame = false;
let botColor = "dark"; // Больше не константа, меняется от игры к игре
// Уровень сложности текущей партии с ботом. Устанавливается заново при
// каждом новом запуске (см. promptBotDifficultyThenStart) — намеренно НЕ
// сохраняется ни в localStorage, ни в Firebase, ни между партиями.
let botDifficulty = "hard";

// Флаг для защиты от гонки условий в матчмейкинге
let isMatchmakingResolved = false;

// ПЕРЕМЕННЫЕ ДЛЯ ЛОББИ ГРУППЫ:
let groupLobbyListener = null;
// ===== ЛОББИ: child-события вместо единого value-listener'а на весь rooms =====
// Раньше любое изменение ЛЮБОЙ комнаты (обычный ход, heartbeat) скачивало
// и обрабатывало ВСЮ коллекцию rooms целиком у каждого, у кого открыто
// "Кто играет". child_added/child_changed/child_removed отдают снимок
// только ОДНОЙ изменившейся комнаты (подтверждено официальной документацией
// Firebase) — localCache/signature ниже реализуют ту же семантику списка,
// что и раньше, просто без полного root value listener'а.
let lobbyRoomsByCode = {}; // последний известный room-объект по коду — чисто локальный UI-кеш
let lobbySignatureByCode = {}; // последняя "видимая" сигнатура на комнату — для пропуска лишних DOM-рендеров
let lobbyStaleCheckTimer = null; // локальный JS-таймер (не Firebase-read) для комнат, переставших слать события вообще
const LOBBY_STALE_CHECK_INTERVAL_MS = 8000;
// Не null, когда уже запланирован (но ещё не выполнен) один кадр рендера —
// не даёт нескольким child_added/changed/removed подряд (burst) вызвать
// несколько отдельных render'ов; requestAnimationFrame сам естественно
// ограничивает частоту частотой кадров экрана и приостанавливается, когда
// вкладка/приложение не видны — уместно именно для чисто визуальной задачи.
let lobbyRenderFrameId = null;
let myCurrentSpectatorRef = null; // ссылка на мою собственную запись "я смотрю эту партию"
let botSpectateRoomCode = null; // код "зеркальной" комнаты для игры с ботом, чтобы её было видно в "Играть онлайн"
let botSpectateListenerRef = null; // Слушатель зрителей для игры с ботом
let botSpectatePresenceInterval = null;
let botMoveTimer = null; // Защита от накопления таймеров хода бота

// ===== CROSS-DEVICE OWNER BOT SESSION =====
// Уникальный на конкретный запуск Mini App, НЕ сохраняется ни в localStorage,
// ни где-либо ещё — каждая полная перезагрузка получает новый.
const botClientInstanceId = (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : "inst_" + Date.now() + "_" + Math.random().toString(36).slice(2, 10);
let ownerSessionAttached = false; // подключены ли мы сейчас к общей botSessions/<uid>
let ownerSessionHandle = null;    // { ref, listener } — для detach
let ownerSessionRevision = null;
let ownerSessionHeartbeatInterval = null; // presence-heartbeat ИМЕННО этого устройства
// Listener зрителей ДЛЯ SYNCED-OWNER ПУТИ — раньше существовал только у
// старого legacy startBotSpectateRoom() (botSpectateListenerRef выше);
// новый (текущий основной) путь его не имел вообще, поэтому владелец не
// видел "Смотрят: ..." для своей же партии. ownerSpectatorsListenerCode
// хранит код комнаты, для которого СЕЙЧАС реально навешан listener —
// нужно, чтобы корректно переподключаться при реванше/замене серии
// (новый spectateRoomCode), не плодя listener на каждый onOwnerSessionUpdate.
let ownerSpectatorsListenerRef = null;
let ownerSpectatorsListenerCode = null;
// currentState ПОЛНОСТЬЮ заменяется на каждый onOwnerSessionUpdate (обычный
// ход, heartbeat-триггер, что угодно) — новый объект строится из
// botSessions, где ПОНЯТИЯ spectators нет вообще (это mirror-state, не
// owner gameplay state — сознательно НЕ добавляем его в botSessions).
// Значит currentState.spectators, выставленный listener'ом ниже, стирается
// при СЛЕДУЮЩЕМ же ходе, даже если реальный список зрителей в Firebase не
// менялся. Раз сам listener подключается ОДИН раз (пока spectateRoomCode
// не меняется) — его callback не перевызовется просто от смены currentState
// и не восстановит поле сам. ownerSpectatorsCache — отдельный, переживающий
// замену currentState кеш; подмешивается обратно в onOwnerSessionUpdate
// после КАЖДОГО applyRemoteOwnerState(), не только при реальном изменении
// списка зрителей.
let ownerSpectatorsCache = null;
// Локальный retry-таймер для протухшего botMoveLock — единственный способ
// живому устройству продолжить ход бота, если владевшее lock'ом устройство
// закрылось ДО commit и никогда больше не пришлёт новое Firebase-событие.
let ownerBotMoveRetryTimer = null;
// Worst-case до фикса (15с): BOT_MOVE_LOCK_TTL_MS (12с) + полный интервал
// (15с) = 27 секунд от смерти устройства-владельца до реального хода бота
// на живом устройстве, в наихудшем выравнивании тика таймера относительно
// момента истечения lock'а. 8с — тот же прецедент "не агрессивно", что уже
// используется в этом же коде для LOBBY_STALE_CHECK_INTERVAL_MS — даёт
// worst-case 20с вместо 27с. Более частый тик безопасен: первая строка
// triggerBotMove() — чисто локальная проверка (currentState.turn !==
// botColor), без единого обращения к Firebase; в норме бот успевает
// походить за секунды, и подавляющее большинство тиков этого таймера
// просто немедленно выходят, ничего не запрашивая у Firebase вообще.
const OWNER_BOT_MOVE_RETRY_INTERVAL_MS = 8000;
const BOT_MOVE_LOCK_TTL_MS = 12000;
const STATS_RECENT_MATCH_IDS_LIMIT = 10;

// --- Единый временной базис против рассинхронизации локальных часов PC/Phone.
// ServerValue.TIMESTAMP нельзя сравнивать внутри transaction (это просто
// сентинел, разрешаемый сервером только В МОМЕНТ записи, не число для
// сравнения "на лету"). Стандартный путь RTDB — .info/serverTimeOffset:
// Firebase сам поддерживает и обновляет разницу между часами клиента и
// сервера. getEstimatedServerNow() — то, что нужно использовать ВМЕСТО
// голого Date.now() везде, где сравнивается expiresAt между устройствами. ---
let cachedServerTimeOffsetMs = 0;
// --- Startup race: Mini App могла только что загрузиться, и Firebase ещё
// не доставил ПЕРВОЕ значение .info/serverTimeOffset (cachedServerTimeOffsetMs
// пока честный 0) — если бот попытается взять lock именно в этот момент,
// getEstimatedServerNow() выродится в голый Date.now(), и clock-skew риск
// вернётся именно для самого первого lock.
//
// НЕТ fallback по таймауту: захват botMoveLock ждёт НАСТОЯЩЕЙ первой
// доставки offset, сколько бы это ни заняло. Это осознанно безопасно —
// если Firebase/сеть недоступны, сама lock-транзакция ВСЁ РАВНО не
// пройдёт, так что деградация на локальные часы здесь ничего не выиграла
// бы, только вернула бы clock-skew риск ради иллюзии прогресса. ---
let serverTimeOffsetReady = false;
let resolveServerTimeOffsetReady;
const serverTimeOffsetReadyPromise = new Promise(function (resolve) { resolveServerTimeOffsetReady = resolve; });
database.ref(".info/serverTimeOffset").on("value", function (snapshot) {
    cachedServerTimeOffsetMs = snapshot.val() || 0;
    if (!serverTimeOffsetReady) {
        serverTimeOffsetReady = true;
        resolveServerTimeOffsetReady();
    }
});
function getEstimatedServerNow() {
    return Date.now() + cachedServerTimeOffsetMs;
}
function waitForServerTimeOffsetReady() {
    if (serverTimeOffsetReady) return Promise.resolve();
    return serverTimeOffsetReadyPromise;
}

let isSpectator = false;
// Используем chat_instance для определения группы при открытии по прямой ссылке
const GROUP_ID = (window.Telegram && window.Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.chat_instance != null) ? Telegram.WebApp.initDataUnsafe.chat_instance.toString() : "private_chat";

function generateRoomCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function escapeHtml(name) {
    const chars = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return name.replace(/[&<>"']/g, function (ch) { return chars[ch]; });
}

function showScreen(screen) {
    menuScreen.classList.add("hidden");
    timeControlScreen.classList.add("hidden");
    waitingScreen.classList.add("hidden");
    gameScreen.classList.add("hidden");
    matchmakingScreen.classList.add("hidden");
    
    const groupLobbyScreen = document.getElementById("group-lobby-screen");
    if (groupLobbyScreen) groupLobbyScreen.classList.add("hidden");
    
    screen.classList.remove("hidden");
}

// ===== ИГРОВОЙ ДВИЖОК =====

function createInitialPieces() {
    const pieces = {};
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            if ((row + col) % 2 !== 0) {
                if (row < 3) {
                    pieces[row + "_" + col] = { color: "dark", king: false };
                } else if (row > 4) {
                    pieces[row + "_" + col] = { color: "light", king: false };
                }
            }
        }
    }
    return pieces;
}

function pieceAt(pieces, row, col) {
    return pieces[row + "_" + col] || null;
}

function countPiecesOfColor(pieces, color) {
    let count = 0;
    for (const key in pieces) {
        if (pieces[key].color === color) count++;
    }
    return count;
}

function canCaptureAt(pieces, row, col, color, king) {
    const opponent = color === "light" ? "dark" : "light";
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const maxDistance = king ? 7 : 2;

    for (let d = 0; d < directions.length; d++) {
        const dRow = directions[d][0];
        const dCol = directions[d][1];
        let foundOpponent = false;
        for (let dist = 1; dist <= maxDistance; dist++) {
            const r = row + dRow * dist;
            const c = col + dCol * dist;
            if (r < 0 || r > 7 || c < 0 || c > 7) break;
            const p = pieceAt(pieces, r, c);
            if (!foundOpponent) {
                if (p && p.color === opponent) {
                    foundOpponent = true;
                } else if (p) {
                    break;
                }
            } else {
                if (!p) {
                    return true;
                } else {
                    break;
                }
            }
        }
    }
    return false;
}

function getCaptureJumps(pieces, row, col, color, king) {
    const opponent = color === "light" ? "dark" : "light";
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const maxDistance = king ? 7 : 2;
    const jumps = [];

    for (let d = 0; d < directions.length; d++) {
        const dRow = directions[d][0];
        const dCol = directions[d][1];
        let foundRow = -1;
        let foundCol = -1;
        let foundOpponent = false;
        let potentialLandings = []; // Клетки приземления дамки за одной побитой шашкой
        for (let dist = 1; dist <= maxDistance; dist++) {
            const r = row + dRow * dist;
            const c = col + dCol * dist;
            if (r < 0 || r > 7 || c < 0 || c > 7) break;
            const p = pieceAt(pieces, r, c);
            if (!foundOpponent) {
                if (p && p.color === opponent) {
                    foundOpponent = true;
                    foundRow = r;
                    foundCol = c;
                } else if (p) {
                    break;
                }
            } else {
                if (!p) {
                    if (!king) {
                        jumps.push({ toRow: r, toCol: c, capturedRow: foundRow, capturedCol: foundCol });
                        break;
                    } else {
                        potentialLandings.push({ toRow: r, toCol: c, capturedRow: foundRow, capturedCol: foundCol });
                    }
                } else {
                    break;
                }
            }
        }

        // ПРАВИЛО РУССКИХ ШАШЕК: если дамка бьёт шашку, и за ней несколько свободных полей,
        // с одного из которых можно продолжить бой, а с других нет — дамка обязана
        // стать на то поле, с которого бой продолжается.
        if (king && potentialLandings.length > 0) {
            const validLandings = [];
            for (const landing of potentialLandings) {
                const tempPieces = {};
                for (const k in pieces) tempPieces[k] = pieces[k];
                const capKey = landing.capturedRow + "_" + landing.capturedCol;
                const fromKey = row + "_" + col;
                const toKey = landing.toRow + "_" + landing.toCol;
                tempPieces[capKey] = { color: "blocked", king: false };
                delete tempPieces[fromKey];
                tempPieces[toKey] = { color: color, king: true };
                if (canCaptureAt(tempPieces, landing.toRow, landing.toCol, color, true)) {
                    validLandings.push(landing);
                }
            }
            if (validLandings.length > 0) {
                jumps.push(...validLandings);
            } else {
                jumps.push(...potentialLandings);
            }
        }
    }
    return jumps;
}

function withPendingBlockers(pieces, pendingRemovals) {
    if (!pendingRemovals || pendingRemovals.length === 0) return pieces;
    const blocked = {};
    for (const k in pieces) blocked[k] = pieces[k];
    pendingRemovals.forEach(function (key) {
        if (!blocked[key]) blocked[key] = { color: "blocked", king: false };
    });
    return blocked;
}

function filterJumpsByMajorityRule(pieces, row, col, color, king, jumps) {
    // В русских шашках (в отличие от международных) нет правила
    // "обязан бить максимум" — выбор направления взятия свободный,
    // независимо от того, сколько шашек собьёт каждый вариант.
    // Поэтому здесь просто возвращаем все варианты без фильтрации.
    return jumps;
}

function canMoveNormally(pieces, row, col, color, king) {
    const forwardDirection = color === "light" ? -1 : 1;
    const directions = king
        ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
        : [[forwardDirection, -1], [forwardDirection, 1]];
    const maxDistance = king ? 7 : 1;

    for (let d = 0; d < directions.length; d++) {
        const dRow = directions[d][0];
        const dCol = directions[d][1];
        for (let dist = 1; dist <= maxDistance; dist++) {
            const r = row + dRow * dist;
            const c = col + dCol * dist;
            if (r < 0 || r > 7 || c < 0 || c > 7) break;
            const p = pieceAt(pieces, r, c);
            if (!p) {
                return true;
            } else {
                break;
            }
        }
    }
    return false;
}

function hasMandatoryCapture(pieces, color) {
    for (const key in pieces) {
        const p = pieces[key];
        if (p.color === color) {
            const parts = key.split("_");
            const r = parseInt(parts[0]);
            const c = parseInt(parts[1]);
            if (canCaptureAt(pieces, r, c, color, !!p.king)) return true;
        }
    }
    return false;
}

function hasAnyLegalMove(pieces, color) {
    if (hasMandatoryCapture(pieces, color)) return true;
    for (const key in pieces) {
        const p = pieces[key];
        if (p.color === color) {
            const parts = key.split("_");
            const r = parseInt(parts[0]);
            const c = parseInt(parts[1]);
            if (canMoveNormally(pieces, r, c, color, !!p.king)) return true;
        }
    }
    return false;
}

function checkWinCondition(pieces, opponentColor) {
    if (countPiecesOfColor(pieces, opponentColor) === 0) {
        return { winner: opponentColor === "light" ? "dark" : "light", reason: "no_pieces" };
    }
    if (!hasAnyLegalMove(pieces, opponentColor)) {
        return { winner: opponentColor === "light" ? "dark" : "light", reason: "no_moves" };
    }
    return null;
}

// ===== АВТОМАТИЧЕСКАЯ НИЧЬЯ (IDF 7.2.3 / 7.2.5 / 7.2.6) — ТОЛЬКО ДЛЯ РЕАЛЬНОЙ ПАРТИИ =====
// ВАЖНО: эти три функции вызываются ТОЛЬКО из performMove(), никогда из attemptMove()
// или minimax() — draw-счётчики/история не должны участвовать в симуляциях бота.
// Ключ позиции здесь намеренно ОТДЕЛЬНЫЙ от getTTKey() бота — это разные задачи,
// хранится как строковое ЗНАЧЕНИЕ внутри массива, а не как ключ узла Firebase
// (запрещённые символы Firebase — ".", "$", "#", "[", "]", "/" — недопустимы именно
// в именах узлов, но полностью разрешены внутри строковых значений).
function getDrawPositionKey(pieces, turn) {
    let s = "";
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            if ((row + col) % 2 === 0) continue;
            const p = pieces[row + "_" + col];
            if (!p) { s += "."; continue; }
            if (p.color === "light") s += p.king ? "L" : "l";
            else s += p.king ? "D" : "d";
        }
    }
    return s + "_" + turn;
}

// --- Большая дорога (диагональ a1-h8). В нашей системе координат это
// РОВНО клетки, где row + col === 7 — проверено сверкой с нотацией ФШР:
// (7,0)=a1, (6,1)=b2, (5,2)=c3, (4,3)=d4, (3,4)=e5, (2,5)=f6, (1,6)=g7,
// (0,7)=h8. Все 8 клеток игровые (тёмные). Контроль: начальная расстановка
// белых по ФШР (a1,a3,b2,c1,c3,d2,e1,e3,f2,g1,g3,h2) ложится ровно на
// rows 5,6,7 — совпадает с createInitialPieces(). ---
function isOnLongRoad(row, col) {
    return (row + col) === 7;
}

// --- Специальное окончание ФШР: "участник, имея в окончании партии три
// шашки (три дамки, две дамки и простую шашку, дамку и две простые шашки,
// три простые шашки) против одинокой дамки соперника, находящейся на
// «большой дороге», своим 5-м ходом не сможет совершить взятие дамки
// соперника". Перечисление в тексте покрывает ВСЕ составы из трёх фигур,
// поэтому проверяем именно количество (ровно 3), не качество. У слабой
// стороны — ровно одна фигура, и она обязана быть дамкой НА большой дороге.
// Возвращает null, если позиция не соответствует; иначе { attacker }. ---
function analyzeLongRoadEnding(pieces) {
    let lightCount = 0, darkCount = 0;
    let lastLightKey = null, lastDarkKey = null;
    for (const key in pieces) {
        if (pieces[key].color === "light") { lightCount++; lastLightKey = key; }
        else { darkCount++; lastDarkKey = key; }
    }
    function loneKingOnRoad(key) {
        const p = pieces[key];
        if (!p || !p.king) return false;
        const parts = key.split("_");
        return isOnLongRoad(parseInt(parts[0], 10), parseInt(parts[1], 10));
    }
    if (lightCount === 3 && darkCount === 1 && loneKingOnRoad(lastDarkKey)) {
        return { attacker: "light" };
    }
    if (darkCount === 3 && lightCount === 1 && loneKingOnRoad(lastLightKey)) {
        return { attacker: "dark" };
    }
    return null;
}

// Проверяет пороги: 15 ходов только дамками; 5/30/60 ходов без изменения
// соотношения сил (2-3 / 4-5 / 6-7 фигур, у обеих сторон есть дамки);
// специальное окончание "3 фигуры против одинокой дамки на большой дороге"
// (5 СОБСТВЕННЫХ ходов сильной стороны); троекратное повторение.
// Ничего не мутирует, только читает переданные значения.
function checkAutomaticDraw(pieces, kingOnlyStreak, noProgressStreak, positionHistory, newPositionKey, longRoadStreak) {
    // Специальное окончание "3 фигуры против одинокой дамки на большой
    // дороге" проверяется ПЕРВЫМ как наиболее частное (lex specialis).
    // ВАЖНО, честная оговорка: официального порядка применения ничейных
    // правил в текстах ФШР/Минспорта НЕТ (проверено). Порядок здесь влияет
    // ТОЛЬКО на код причины, но не на исход — во всех пересекающихся
    // случаях обе нормы дают одну и ту же ничью. Практически пересечение
    // возможно лишь когда одинокая дамка ВСТУПАЕТ на большую дорогу
    // (без взятия и превращения), поэтому kingOnlyStreak к этому моменту
    // мог быть уже накоплен; при обычном же установлении соотношения
    // через взятие kingOnlyStreak обнуляется и конфликта не возникает.
    if (longRoadStreak >= 5 && analyzeLongRoadEnding(pieces)) {
        return "long_road_5";
    }

    // 15 полностью завершённых ходов только дамками, без взятий и без
    // движения простых шашек.
    if (kingOnlyStreak >= 15) {
        return "kings_only_15";
    }

    // 7.2.6 — материальный баланс не менялся заданное число ходов, при условии,
    // что у ОБЕИХ сторон сейчас есть хотя бы одна дамка.
    let totalPieces = 0;
    let lightHasKing = false;
    let darkHasKing = false;
    for (const key in pieces) {
        totalPieces++;
        const p = pieces[key];
        if (p.king) {
            if (p.color === "light") lightHasKing = true;
            else darkHasKing = true;
        }
    }
    if (lightHasKing && darkHasKing) {
        // Диапазон 2-3 фигуры — естественное продолжение того же
        // noProgress-механизма, что уже применяется для 4-5 и 6-7.
        // Единица счёта та же самая (отдельный ход одной стороны), как и
        // требовалось: не создаём параллельную систему подсчёта.
        if (totalPieces >= 2 && totalPieces <= 3 && noProgressStreak >= 5) {
            return "no_progress_5";
        }
        if (totalPieces >= 4 && totalPieces <= 5 && noProgressStreak >= 30) {
            return "no_progress_30";
        }
        if (totalPieces >= 6 && totalPieces <= 7 && noProgressStreak >= 60) {
            return "no_progress_60";
        }
    }

    // 7.2.3 — троекратное повторение одной и той же позиции при ходе одной
    // и той же стороны. Ключ уже включает turn, поэтому условие "тот же
    // игрок должен ходить" выполняется автоматически.
    let repeatCount = 0;
    for (let i = 0; i < positionHistory.length; i++) {
        if (positionHistory[i] === newPositionKey) repeatCount++;
    }
    if (repeatCount >= 3) {
        return "threefold_repetition";
    }

    return null;
}

// Главная точка входа — вызывается ИСКЛЮЧИТЕЛЬНО из performMove(), один раз,
// ровно в момент завершения РЕАЛЬНОГО хода (не на промежуточных прыжках цепочки).
// prevState — состояние ДО этого конкретного прыжка; result — то, что вернул
// attemptMove для этого прыжка; movingPieceWasKing — была ли шашка дамкой ДО хода.
function computeNextDrawState(prevState, result, movingPieceWasKing) {
    const prevKingOnlyStreak = prevState.kingOnlyStreak || 0;
    const prevNoProgressStreak = prevState.noProgressStreak || 0;
    const prevHistory = prevState.positionHistory || [];
    const prevLongRoadAttacker = prevState.longRoadAttacker || null;
    const prevLongRoadStreak = prevState.longRoadStreak || 0;

    // Цепочка взятия ещё не закончена — многоходовое взятие целиком считается
    // ОДНИМ ходом, поэтому счётчики трогать рано, ждём финального прыжка.
    if (result.mustContinueFrom !== null) {
        return {
            kingOnlyStreak: prevKingOnlyStreak,
            noProgressStreak: prevNoProgressStreak,
            positionHistory: prevHistory,
            longRoadAttacker: prevLongRoadAttacker,
            longRoadStreak: prevLongRoadStreak,
            drawReason: null
        };
    }

    const prevCapturedTotal = (prevState.capturedDark || 0) + (prevState.capturedLight || 0);
    const newCapturedTotal = (result.capturedDark || 0) + (result.capturedLight || 0);
    const wasCapture = newCapturedTotal > prevCapturedTotal;

    const destKey = result.lastMove.to.row + "_" + result.lastMove.to.col;
    const movedPieceNowKing = !!(result.pieces[destKey] && result.pieces[destKey].king);
    const becamePromoted = !movingPieceWasKing && movedPieceNowKing;

    let newKingOnlyStreak;
    if (wasCapture || !movingPieceWasKing) {
        // Взятие, либо ходила простая шашка (независимо от превращения) —
        // серия "только дамки без взятий" прерывается.
        newKingOnlyStreak = 0;
    } else {
        // Ходила именно дамка, и взятия не было.
        newKingOnlyStreak = prevKingOnlyStreak + 1;
    }

    let newNoProgressStreak;
    if (wasCapture || becamePromoted) {
        newNoProgressStreak = 0;
    } else {
        newNoProgressStreak = prevNoProgressStreak + 1;
    }

    // Специальное окончание "3 фигуры против одинокой дамки на большой
    // дороге": считаем ТОЛЬКО собственные ходы сильной стороны.
    // prevState.turn — цвет, который только что СДЕЛАЛ этот ход (result.turn
    // уже переключён на соперника). Устанавливающий соотношение ход в счёт
    // пяти НЕ входит — отсчёт стартует со следующего хода сильной стороны
    // (по аналогии с формулировкой "считая с момента установления
    // соотношения сил"; сам текст этого частного пункта момент старта
    // явно не оговаривает).
    //
    // Пока позиция соответствует условию правила (3 фигуры сильной стороны
    // против одинокой дамки соперника НА большой дороге) — специальный
    // счётчик идёт; как только позиция перестаёт ему соответствовать,
    // режим прекращается и счётчик обнуляется.
    //
    // ЭТО ИНТЕРПРЕТАЦИЯ ДЛЯ АВТОМАТИЗАЦИИ, а НЕ предписание ФШР. Текст
    // правил описывает дамку как "находящуюся на большой дороге", но
    // НИЧЕГО не говорит о том, что делать со счётчиком, если она оттуда
    // ушла; момент старта отсчёта в этом пункте тоже не оговорён.
    // Положение на большаке трактуется как часть условия правила наравне
    // с материальным соотношением: специальный счётчик действует ровно
    // столько, сколько существует описанная в правиле позиция.
    const moverColor = prevState.turn;
    const longRoadNow = analyzeLongRoadEnding(result.pieces);
    let newLongRoadAttacker;
    let newLongRoadStreak;
    if (!longRoadNow) {
        newLongRoadAttacker = null;
        newLongRoadStreak = 0;
    } else if (prevLongRoadAttacker !== longRoadNow.attacker) {
        newLongRoadAttacker = longRoadNow.attacker;
        newLongRoadStreak = 0;
    } else if (moverColor === longRoadNow.attacker) {
        newLongRoadAttacker = longRoadNow.attacker;
        newLongRoadStreak = prevLongRoadStreak + 1;
    } else {
        newLongRoadAttacker = longRoadNow.attacker;
        newLongRoadStreak = prevLongRoadStreak;
    }

    const newPositionKey = getDrawPositionKey(result.pieces, result.turn);
    const newHistory = prevHistory.concat([newPositionKey]);

    const drawReason = result.winner
        ? null // Партия уже закончилась обычной победой — автоматическую ничью не проверяем поверх неё
        : checkAutomaticDraw(result.pieces, newKingOnlyStreak, newNoProgressStreak, newHistory, newPositionKey, newLongRoadStreak);

    return {
        kingOnlyStreak: newKingOnlyStreak,
        noProgressStreak: newNoProgressStreak,
        positionHistory: newHistory,
        longRoadAttacker: newLongRoadAttacker,
        longRoadStreak: newLongRoadStreak,
        drawReason: drawReason
    };
}

function attemptMove(state, fromRow, fromCol, toRow, toCol, actingColor) {
    const pieces = {};
    for (const k in state.pieces) {
        pieces[k] = { color: state.pieces[k].color, king: !!state.pieces[k].king };
    }

    let turn = state.turn;
    let mustContinueFrom = state.mustContinueFrom || null;
    let capturedDark = state.capturedDark || 0;
    let capturedLight = state.capturedLight || 0;
    let moveCount = state.moveCount || 0;

    let lastMovePath = (!mustContinueFrom) ? [{ row: fromRow, col: fromCol }] : (state.lastMovePath || [{ row: fromRow, col: fromCol }]).slice();
    let lastCapturedSquares = (!mustContinueFrom) ? [] : (state.lastCapturedSquares || []).slice();

    let pendingRemovals = (!mustContinueFrom) ? [] : (state.pendingRemovals || []).slice();

    if (turn !== actingColor) return null;

    const fromKey = fromRow + "_" + fromCol;
    const toKey = toRow + "_" + toCol;
    const moving = pieces[fromKey];
    if (!moving || moving.color !== actingColor) return null;

    if (mustContinueFrom && (mustContinueFrom.row !== fromRow || mustContinueFrom.col !== fromCol)) return null;
    if (toRow < 0 || toRow > 7 || toCol < 0 || toCol > 7) return null;
    if (pieces[toKey]) return null;

    const rowDiff = Math.abs(toRow - fromRow);
    const colDiff = Math.abs(toCol - fromCol);
    if (rowDiff !== colDiff || rowDiff === 0) return null;

    const dRow = (toRow - fromRow) / rowDiff;
    const dCol = (toCol - fromCol) / colDiff;
    const king = !!moving.king;
    if (!king && rowDiff > 2) return null;

    const scanPieces = withPendingBlockers(pieces, pendingRemovals);

    let opponentsOnPath = 0;
    let capturedKey = null;
    for (let dist = 1; dist < rowDiff; dist++) {
        const key = (fromRow + dRow * dist) + "_" + (fromCol + dCol * dist);
        const scanPiece = scanPieces[key];
        if (scanPiece) {
            if (scanPiece.color === "blocked") return null;
            opponentsOnPath++;
            capturedKey = key;
            if (scanPiece.color === actingColor) return null;
        }
    }
    if (opponentsOnPath > 1) return null;

    const forwardDirection = actingColor === "light" ? -1 : 1;
    const actualDirection = toRow - fromRow > 0 ? 1 : -1;

    let becameKing = false;
    let moveType;

    if (opponentsOnPath === 0) {
        if (mustContinueFrom) return null;
        if (hasMandatoryCapture(pieces, actingColor)) return null;
        if (!king && rowDiff !== 1) return null;
        if (!king && actualDirection !== forwardDirection) return null;

        delete pieces[fromKey];
        if (!king) {
            if (actingColor === "light" && toRow === 0) { moving.king = true; becameKing = true; }
            if (actingColor === "dark" && toRow === 7) { moving.king = true; becameKing = true; }
        }
        pieces[toKey] = moving;

        turn = actingColor === "light" ? "dark" : "light";
        mustContinueFrom = null;
        moveCount++;
        moveType = becameKing ? "king" : "move";
        lastMovePath.push({ row: toRow, col: toCol });
    } else {
        if (!king && rowDiff !== 2) return null;

        {
            const allJumps = getCaptureJumps(scanPieces, fromRow, fromCol, actingColor, king);
            const bestJumps = filterJumpsByMajorityRule(scanPieces, fromRow, fromCol, actingColor, king, allJumps);
            let isOptimalJump = false;
            for (let i = 0; i < bestJumps.length; i++) {
                if (bestJumps[i].toRow === toRow && bestJumps[i].toCol === toCol) { isOptimalJump = true; break; }
            }
            if (!isOptimalJump) return null;
        }

        const capturedPiece = pieces[capturedKey];
        delete pieces[capturedKey];
        delete pieces[fromKey];
        pendingRemovals.push(capturedKey);

        const capturedParts = capturedKey.split("_");
        lastCapturedSquares.push({ row: parseInt(capturedParts[0]), col: parseInt(capturedParts[1]) });

        if (capturedPiece.color === "dark") {
            capturedDark++;
        } else {
            capturedLight++;
        }

        if (!king) {
            if (actingColor === "light" && toRow === 0) { moving.king = true; becameKing = true; }
            if (actingColor === "dark" && toRow === 7) { moving.king = true; becameKing = true; }
        }
        pieces[toKey] = moving;
        lastMovePath.push({ row: toRow, col: toCol });

        const continuationScanPieces = withPendingBlockers(pieces, pendingRemovals);
        const canContinue = canCaptureAt(continuationScanPieces, toRow, toCol, actingColor, !!moving.king);

        if (canContinue) {
            mustContinueFrom = { row: toRow, col: toCol };
        } else {
            mustContinueFrom = null;
            turn = actingColor === "light" ? "dark" : "light";
        }
        moveCount++;
        moveType = becameKing ? "king" : "capture";
    }

    let winner = null;
    let winReason = null;
    if (mustContinueFrom === null) {
        const opponentColor = actingColor === "light" ? "dark" : "light";
        const winResult = checkWinCondition(pieces, opponentColor);
        if (winResult) {
            winner = winResult.winner;
            winReason = winResult.reason;
        }
    }

    return {
        pieces: pieces,
        turn: turn,
        mustContinueFrom: mustContinueFrom,
        capturedDark: capturedDark,
        capturedLight: capturedLight,
        moveCount: moveCount,
        moveType: moveType,
        lastMove: { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } },
        lastMovePath: lastMovePath,
        lastCapturedSquares: lastCapturedSquares,
        pendingRemovals: (mustContinueFrom === null) ? [] : pendingRemovals,
        winner: winner,
        winReason: winReason
    };
}

// ===== СОСТОЯНИЕ НА ЭКРАНЕ =====

let currentState = null;
let selectedFrom = null;
let flipped = false;
let lastSeenMoveCount = -1;
let isLocalStateOptimistic = false; // Флаг: сделали ли мы локальный ход, который ещё не подтверждён сервером

// ===== ONLINE MOVE SYNC =====
// Момент отправки online-хода, ожидающего ответа сервера (null — ожидания нет).
// Живёт РОВНО столько же, сколько promise транзакции хода: ставится рядом с
// отправкой, снимается в её .then и .catch. Сознательно не заводим набор
// setTimeout с clearTimeout в performMove/reconnect/rematch/exit — весь UI
// выводится из этого одного значения существующим секундным тиком.
let pendingMoveStartedAt = null;
// Идёт ли сейчас восстановление (защита от параллельных запусков).
let syncRecoveryInFlight = false;
// Последнее восстановление не удалось — спокойное сообщение и кнопка «Повторить».
let syncRecoveryFailed = false;
// Через сколько молчания сервера считать ход застрявшим. Обоснование:
// heartbeat presence ходит раз в 4 секунды, а Firebase считает соединение
// потерянным примерно через 30 секунд. Порог должен быть заметно больше трёх
// heartbeat-циклов (иначе ложные срабатывания на медленной мобильной сети)
// и заметно меньше 30 секунд (иначе бесполезен).
const MOVE_CONFIRM_STALL_MS = 12000;

// Ход отправлен и ещё не получил ответа сервера.
function isMoveAwaitingConfirmation() {
    return isOnlineGame && !isSpectator && pendingMoveStartedAt !== null;
}
let endGameShownForRoom = null;
let pieceElements = {};
let lastRenderedSignature = null;

// ===== ГОСТЬ-АНИМАЦИЯ ХОДА — чисто UI-состояние, НЕ часть игрового состояния =====
// lastAnimatedMoveCount: moveCount последнего хода, для которого уже
// проигран (или сознательно пропущен) ghost. null означает "ещё не было
// ни одного рендера с момента подключения к этой партии" — в этом случае
// НЕ анимируем (иначе спектейтор/reconnect увидел бы анимацию "из ниоткуда"
// для хода, который случился ДО подключения). moveCount инкрементируется
// на КАЖДОМ отдельном прыжке (проверено в attemptMove — и quiet-move,
// и capture-ветка увеличивают его безусловно), поэтому уникален per-hop
// и корректно различает прыжки одной цепочки взятия.
let lastAnimatedMoveCount = null;
// Список функций отмены активных ghost-анимаций — вызываются, если новый
// рендер приходит раньше, чем предыдущая анимация закончилась, либо при
// resize/orientationchange. Каждая функция гарантированно восстанавливает
// видимость спрятанной реальной фигуры перед удалением ghost'а.
let activeGhostCancelFns = [];
const MOVE_GHOST_DURATION_MS = 150;
const CAPTURE_FADE_DURATION_MS = 90;

function getLabels() {
    if (!flipped) {
        return { letters: ["a", "b", "c", "d", "e", "f", "g", "h"], numbers: [8, 7, 6, 5, 4, 3, 2, 1] };
    }
    return { letters: ["h", "g", "f", "e", "d", "c", "b", "a"], numbers: [1, 2, 3, 4, 5, 6, 7, 8] };
}


// ===== СОСТОЯНИЕ РЕГИСТРАЦИИ РЕЙТИНГОВОЙ ПАРТИИ =====
//
// Room listener срабатывает на каждое изменение присутствия. Без явного
// состояния клиент слал бы joinRatedMatch на каждый снимок.
//
// Ключ — ПОКОЛЕНИЕ комнаты: roomCode + createdAt + matchNumber. Смена
// matchNumber при реванше сама обесценивает старое состояние, поэтому «Без рейтинга» от
// прошлой партии не протекает в следующую и сбрасывать вручную нечего.
//
//   idle           регистрация не начиналась
//   inFlight       запрос в пути, повторно не слать
//   retryWait      временный сбой, ждём паузу
//   success        матч зарегистрирован
//   terminalFailed отказ по существу, повторять нечего
// Пауза между попытками растёт и упирается в потолок. Числа попыток НЕТ:
// пока то же поколение комнаты активно, регистрацию имеет смысл повторять.
// Ограничиваем ЧАСТОТУ, а не количество — иначе четыре сетевых сбоя
// подряд навсегда лишали бы живую партию рейтинга.
const RATED_JOIN_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];
const RATED_JOIN_BACKOFF_MAX_MS = 30000;

// Отказы, после которых повторять бессмысленно: партия уже не подходит
// для регистрации. Всё остальное — сеть, 5xx, таймаут — временное.
// Сверено с кодами, которые реально бросает Worker v3. Классификация
// строго по коду ошибки, а НЕ по HTTP-статусу: один и тот же 409 бывает
// и смысловым отказом, и временной гонкой.
//
// Смысловые: партия для регистрации не подходит, повтор ничего не изменит.
const RATED_JOIN_TERMINAL_ERRORS = [
    "room_not_active", "stale_generation", "match_number_jump",
    "not_first_match", "not_a_player", "room_not_ready", "room_not_found",
    "card_mismatch", "card_conflict", "not_a_participant", "match_not_rated"
];

// Временные: гонка или сбой инфраструктуры, повтор оправдан.
// registration_conflict и stats_init_conflict — именно гонки: другой
// вызов опередил, следующая попытка увидит согласованное состояние.
const RATED_JOIN_TRANSIENT_ERRORS = [
    "registration_conflict", "stats_init_conflict",
    "db_read_failed", "db_write_failed",
    "server_identity_failed", "server_signer_missing"
];

let ratedJoinState = {};   // "<roomCode>_<createdAt>_<matchNumber>" -> { phase, attempts }

function ratedGenerationKey(code, matchNumber, createdAt) {
    const n = (typeof matchNumber === "number") ? matchNumber : 0;
    const stamp = (typeof createdAt === "number" && isFinite(createdAt)) ? createdAt : 0;
    // roomCode в норме уникален, но после удаления код теоретически может
    // выпасть снова в той же WebView-сессии. createdAt уже является частью
    // канонического matchId, поэтому используем его и для client state key:
    // локальный success/failed от старой комнаты не должен протечь в новую.
    return code + "_" + stamp + "_" + n;
}

function expectedRatedMatchIdForState(state, code) {
    if (!state || !code || typeof state.createdAt !== "number") return null;
    return buildEloMatchId(code, state.createdAt, state.matchNumber);
}

// Серверная регистрация поколения считается видимой только когда в комнате
// одновременно есть канонический pointer ЭТОГО matchNumber и полный snapshot.
// Это позволяет восстановить локальный join-state после reload/второго устройства
// и не принять stale ratedMatchId прошлого реванша за текущий.
function registeredMatchIdForState(state, code) {
    if (!state || !code) return null;
    const rs = state.ratingsAtStart;
    if (!rs || typeof rs.light !== "number" || typeof rs.dark !== "number") return null;
    const expected = expectedRatedMatchIdForState(state, code);
    if (!expected || state.ratedMatchId !== expected) return null;
    return expected;
}

function currentRatedGenerationKey() {
    if (!roomCode || !currentState) return null;
    return ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt);
}

function getRatedJoinPhase(key) {
    if (!key) return "idle";
    const st = ratedJoinState[key];
    return st ? st.phase : "idle";
}



// ===== СЕГМЕНТ РЕЙТИНГА =====
//
// Отдельная функция, а НЕ часть statusForColor. Причина: statusForColor
// имеет семь возвратов, и в трёх из них прежний префикс терялся — панель
// схлопывалась в пустую строку. Отдельный сегмент исчезнуть не может: он
// вычисляется один раз и не зависит от того, сколько веток будет
// у статуса дальше.
//
// Приоритет строго такой:
//   1. канонический ratedMatchId ЭТОГО поколения + полный snapshot -> ⭐<число>
//   2. регистрация окончательно failed                              -> ⭐ Без рейтинга
//   3. иначе                                                        -> ⭐…
//
// Bare ratingsAtStart недостаточен: cached v193 тоже умеет писать snapshot.
// Если Worker опубликовал канонический pointer позже локального failed-флага,
// pointer сильнее и рейтинг снова показывается корректно.
function ratingSegmentForColor(color) {
    if (!isOnlineGame || !currentState) return "";

    // Bare ratingsAtStart недостаточен: cached v193 тоже умеет писать этот
    // snapshot сам. Показываем стартовый Elo как рейтинг ЭТОЙ rated-партии
    // только после канонического server pointer текущего поколения. Иначе
    // legacy/частичный snapshot мог бы замаскировать terminalFailed и создать
    // впечатление, что нерейтинговая партия всё же зарегистрирована.
    const registered = registeredMatchIdForState(currentState, roomCode);
    if (registered) {
        const rs = currentState.ratingsAtStart;
        const value = rs && typeof rs[color] === "number" ? rs[color] : null;
        if (value !== null) return "⭐" + value;
    }

    if (getRatedJoinPhase(currentRatedGenerationKey()) === "terminalFailed") {
        return "⭐ " + t("rating_unrated");
    }
    return "⭐…";
}

// Собирает содержимое панели из двух частей. Узлы переиспользуются, если
// уже созданы, — перерисовка идёт на каждый ход, лишние аллокации ни к чему.
// Имя и рейтинг лежат в РАЗНЫХ ячейках сетки, поэтому длина одного не
// сдвигает другой. Только textContent: имя приходит из Telegram.
function renderPlayerNameCell(cell, marker, name, rating, ratingCell) {
    if (cell) {
        // Кружок цвета — отдельный элемент, а не два знака в тексте: как
        // эмодзи он съедал треть колонки на узком экране, и от имени
        // оставалось три буквы. Многоточие теперь только на имени.
        let dot = cell.querySelector(".player-color-dot");
        let label = cell.querySelector(".player-name-label");
        if (!dot || !label) {
            cell.textContent = "";
            dot = document.createElement("span");
            dot.className = "player-color-dot";
            label = document.createElement("span");
            label.className = "player-name-label";
            cell.appendChild(dot);
            cell.appendChild(label);
        }
        dot.className = "player-color-dot " + (marker === "light" ? "light-dot" : "dark-dot");
        label.textContent = name;
    }
    if (ratingCell) ratingCell.textContent = rating ? rating : "";
}

// Стопка взятых шашек. Показываем не больше шести — дальше стопка
// перестаёт читаться, а точное число всё равно говорит значок.
const CAPTURED_STACK_MAX = 6;

// Глубина стопки: передняя шашка чёткая, дальние уходят назад.
// Дальше четвёртой не бледнеем, иначе стопка выглядит грязной.
const CAPTURED_DEPTH_OPACITY = [1, 0.82, 0.66, 0.52, 0.45];

function capturedDepthOpacity(fromFront) {
    const i = Math.min(fromFront, CAPTURED_DEPTH_OPACITY.length - 1);
    return CAPTURED_DEPTH_OPACITY[i];
}

function renderCapturedStack(container, count, iconClass) {
    if (!container) return;
    container.textContent = "";
    const total = (typeof count === "number" && count > 0) ? count : 0;
    if (total === 0) return;
    const shown = Math.min(total, CAPTURED_STACK_MAX);
    for (let i = 0; i < shown; i++) {
        const icon = document.createElement("div");
        icon.classList.add("captured-icon", iconClass);
        // Глубина считается ОТ ПЕРЕДНЕЙ шашки, то есть от последней
        // добавленной. Позиционным селекторам это доверить нельзя:
        // значок с числом добавляется после иконок и стал бы для CSS
        // последним ребёнком, сдвинув всю последовательность.
        const fromFront = shown - 1 - i;
        icon.style.setProperty("--depth-opacity", String(capturedDepthOpacity(fromFront)));
        icon.style.setProperty("--depth-order", String(i + 1));
        container.appendChild(icon);
    }
    const badge = document.createElement("span");
    badge.className = "captured-count";
    badge.textContent = String(total);
    container.appendChild(badge);
}

function statusForColor(color) {
    if (!currentState) return { text: "", cls: "" };
    if (!isOnlineGame) {
        return { text: "", cls: "" };
    }

    // Победы и поражения из панели убраны: они остались в статистике.
    // Рейтинг рисует
    // отдельный сегмент, поэтому здесь префикса больше нет вовсе.

    const presence = (currentState.presence && currentState.presence[color]) || null;
    if (!presence) {
        return { text: t("status_connecting"), cls: "status-neutral" };
    }

    // Пока связи нет У МЕНЯ САМОГО, судить о сопернике нельзя: его lastSeen в
    // моей памяти замирает не потому, что он ушёл, а потому что я перестал
    // получать данные. Показываем нейтральное «Соединение…» — этот статус
    // сознательно НЕ равен "status-left", поэтому отсчёт отсутствия не идёт.
    if (!isFirebaseConnected) {
        return { text: t("status_connecting"), cls: "status-neutral" };
    }

    // Пока серверное время ещё не получено, offset честно равен нулю, и
    // elapsed посчитался бы по голым часам телефона. Это не разрушительно
    // (удаление комнаты и так требует serverTimeOffsetReady), но может дать
    // ложный «Оффлайн» в первые мгновения. Показываем нейтральное состояние.
    if (!serverTimeOffsetReady) {
        return { text: t("status_connecting"), cls: "status-neutral" };
    }

    // POST-RECONNECT FRESHNESS (v178). Соединение может быть уже восстановлено
    // (isFirebaseConnected === true), но данные ТЕКУЩЕЙ комнаты ещё не
    // подтверждены после реконнекта. Судить об уходе соперника по таким данным
    // нельзя: его lastSeen в нашей памяти мог остаться с момента обрыва.
    // Пока доказательство свежести не получено — нейтральный статус, который
    // сознательно не равен "ушёл" и потому не запускает отсчёт отсутствия.
    if (!roomSnapshotSeenSinceConnect) {
        return { text: t("status_connecting"), cls: "status-neutral" };
    }

    // ВАЖНО: lastSeen — СЕРВЕРНЫЙ timestamp, поэтому сравнивать его с голым
    // Date.now() нельзя: часы телефона могут разойтись с сервером (классика —
    // переключение авиарежима, после которого телефон переустанавливает время).
    // getEstimatedServerNow() = Date.now() + .info/serverTimeOffset — тот самый
    // единый временной базис, который в проекте уже описан именно для этого.
    const lastSeenElapsed = getEstimatedServerNow() - (presence.lastSeen || getEstimatedServerNow());
    // v180: НАДПИСЬ И РЕШЕНИЕ ЧИТАЮТ ОДНО И ТО ЖЕ ЧИСЛО. Если есть серверный
    // absentSince, обратный отсчёт на экране ведётся именно от него — ровно
    // от той же величины, по которой присуждается техническое поражение.
    // Иначе (старый клиент, bot-зеркало) остаётся прежний возраст lastSeen.
    const authoritativeAbsence = getAuthoritativeAbsenceMs(presence);
    const elapsed = (authoritativeAbsence !== null) ? authoritativeAbsence : lastSeenElapsed;
    // presence.online === false — настоящий disconnect для online-партий
    // (onDisconnect().update там есть и срабатывает почти сразу). elapsed —
    // единственный источник истины для bot-зеркала, где onDisconnect
    // сознательно не установлен: presence.online там навсегда останется
    // true, даже когда владелец давно закрыл Mini App — двигается только
    // lastSeen (последний heartbeat), пока он писался.
    const isStale = presence.online === false || lastSeenElapsed > PRESENCE_STALE_WARNING_MS;

    if (elapsed > RECONNECT_GRACE_MS) {
        // v181: ИЗМЕНЁН ТОЛЬКО ТЕКСТ. Условие, момент его появления и cls —
        // прежние. Для ИГРОКА эти секунды не поломка партии: минута истекла,
        // и клиент ждёт, пока СЕРВЕР подтвердит технический результат по
        // своим часам. «Игра прервана» об этом врало.
        // ЗРИТЕЛЮ формулировка остаётся прежней: у него на экране своя
        // модалка "Игра прервана" (тот же ключ в index.html), и он ничего
        // не подтверждает — для bot-зеркала результата вообще не будет.
        return { text: t(isSpectator ? "status_game_interrupted" : "status_confirming_result"), cls: "status-left" };
    }
    if (isStale) {
        // Считаем оставшееся время до конца "минуты форы"
        let remaining = Math.ceil((RECONNECT_GRACE_MS - elapsed) / 1000);
        if (remaining < 0) remaining = 0;
        // «Оффлайн (осталось 45с)» не помещалось в свою колонку и резалось.
        // Смысл тот же, скобки и «осталось» ничего не добавляли.
        // Отдельный класс: отсчёт до технического поражения должен быть
        // заметен боковым зрением, а не читаться.
        return { text: t("status_offline") + " " + remaining + t("sec"), cls: "status-countdown" };
    }
    return { text: t("status_in_game"), cls: "status-online" };
}

function applyStatusToElement(el, panelEl, statusInfo) {
    el.className = "player-status";
    if (statusInfo.cls) el.classList.add(statusInfo.cls);
    // Текст лежит во вложенном элементе, а не прямо в контейнере: обрезать
    // многоточием нужно только его. Когда обрезал контейнер, вместе с
    // текстом срезалось свечение точки, и кружок выглядел подрезанным.
    let textEl = el.querySelector(".player-status-text");
    if (!textEl) {
        el.textContent = "";
        textEl = document.createElement("span");
        textEl.className = "player-status-text";
        el.appendChild(textEl);
    }
    textEl.textContent = statusInfo.text;
    // Панель бледнеет, когда соперника нет за доской. До v196 отсчёт
    // возвращал класс status-left и попадал сюда; после разделения классов
    // затухание пропало бы — соперник ушёл, а панель выглядит как обычно.
    if (statusInfo.cls === "status-left" || statusInfo.cls === "status-countdown") {
        panelEl.classList.add("player-faded");
    } else {
        panelEl.classList.remove("player-faded");
    }
}

function renderSpectatorsList() {
    const el = document.getElementById("spectators-list");
    if (!el) return;
    if (isSpectator || !currentState || !currentState.spectators) {
        el.classList.add("hidden");
        el.textContent = "";
        return;
    }
    const names = Object.values(currentState.spectators).filter(Boolean);
    if (names.length === 0) {
        el.classList.add("hidden");
        el.textContent = "";
        return;
    }
    el.textContent = "👁 " + t("spectators") + ": " + names.join(", ");
    el.classList.remove("hidden");
}

function renderPlayerPanels() {
    if (!currentState) return;
    const lightName = (currentState.players && currentState.players.light && currentState.players.light.name) || "Белые";
    const darkName = (currentState.players && currentState.players.dark && currentState.players.dark.name) || "Чёрные";

    const topColor = flipped ? "light" : "dark";
    const bottomColor = flipped ? "dark" : "light";

    // Имя и рейтинг: «⚪ Татьяна · ⭐1108». Сегмент рейтинга добавляется
    // здесь, а не в статусе, поэтому он не исчезает ни в одной ветке
    // статуса присутствия.
    const topRating = ratingSegmentForColor(topColor);
    const bottomRating = ratingSegmentForColor(bottomColor);
    // Имя и рейтинг кладутся в РАЗНЫЕ элементы: сокращать многоточием
    // разрешено только имя, рейтинг обрезаться не должен никогда. Раньше
    // это была одна строка, и ellipsis съел бы вместе с именем и Elo.
    //
    // Только textContent, без innerHTML: имя приходит из Telegram, то есть
    // это внешние данные.
    renderPlayerNameCell(playerTopName,
        topColor,
        (topColor === "light" ? lightName : darkName),
        topRating, playerTopRating);
    renderPlayerNameCell(playerBottomName,
        bottomColor,
        (bottomColor === "light" ? lightName : darkName),
        bottomRating, playerBottomRating);

    if (topColor === "light") {
        renderCapturedStack(playerTopCaptured, currentState.capturedDark, "dark-icon");
        renderCapturedStack(playerBottomCaptured, currentState.capturedLight, "light-icon");
    } else {
        renderCapturedStack(playerTopCaptured, currentState.capturedLight, "light-icon");
        renderCapturedStack(playerBottomCaptured, currentState.capturedDark, "dark-icon");
    }

    applyStatusToElement(playerTopStatus, playerTopPanel, statusForColor(topColor));
    applyStatusToElement(playerBottomStatus, playerBottomPanel, statusForColor(bottomColor));

    // Скрываем игровые действия (Сдаться/Ничья) для зрителей. Раньше здесь
    // был слепой querySelectorAll('#game-screen .menu-button'), который
    // заодно перезаписывал btnBackBot/btnBackSpectator — их видимость уже
    // ПОЛНОСТЬЮ и корректно управляется в renderBoard() через
    // backButtonMode (структурно взаимоисключающий выбор), несколькими
    // строками раньше. Слепой sweep СРАЗУ ЖЕ переопределял этот результат
    // одинаково для обеих кнопок разом, никак их не различая: у зрителя
    // обе тут же скрывались (0 кнопок «Назад»), у игрока с ботом обе тут
    // же показывались (2 кнопки «Назад»). Точечное управление — только
    // теми двумя кнопками, для которых эта логика реально предназначалась.
    if (btnOfferDraw) btnOfferDraw.classList.toggle("hidden", isSpectator);
    if (btnResign) btnResign.classList.toggle("hidden", isSpectator);

    checkOpponentAbsence();
}

let opponentGraceTimer = null;

function checkOpponentAbsence() {
    // ВАЖНАЯ ЗАЩИТА: Если игрок — зритель, функция немедленно останавливается. 
    // Зритель не может удалить игру, которую смотрит.
    if (isSpectator) return; 
    
    if (!isOnlineGame || !currentState) return;
    
    // Если игра закончилась, мы продолжаем проверять присутствие ТОЛЬКО если мы 
    // ожидаем ответа на реванш. В остальных случаях выходим.
    if (currentState.winner && !(currentState.rematchProposal && currentState.rematchProposal.by === myColor)) return;
    
    if (opponentAbsenceHandled) return;

    const oppColor = myColor === "light" ? "dark" : "light";

    // ЕДИНАЯ ШКАЛА ВРЕМЕНИ. Раньше здесь заводился отдельный setTimeout на 60
    // секунд в момент, когда соперник ВПЕРВЫЕ выглядел офлайн (то есть на 12-й
    // секунде), из-за чего экран показывал «Игра прервана» на 60-й секунде, а
    // реальное решение приходило только на 72-й. Теперь и надпись, и решение
    // читают одно и то же число — возраст серверного lastSeen соперника.
    // Побочный и важный эффект: после возврата связи сопернику НЕ выдаётся
    // новая минута. Если он отсутствует уже 50 секунд, ему остаётся 10.
    const absenceMs = getOpponentAbsenceMs(oppColor);
    if (absenceMs === null || absenceMs < RECONNECT_GRACE_MS) return;

    // Минута истекла. Прежде чем разрушать живую партию, требуем уверенности
    // (см. canTrustAbsenceForCleanup). Не подтвердилось — просто выходим:
    // функция вызывается каждую секунду и попробует снова.
    if (!canTrustAbsenceForCleanup()) return;

    if (currentState.winner && currentState.rematchProposal) {
        // Соперник пропал во время ожидания ответа на реванш. Но finished-room
        // всё ещё является единственным authoritative outcome для Worker.
        // Не удаляем её, пока rated settlement не закреплён.
        if (!isFinishedGenerationSafeToDestroy()) {
            requestSettlement();
            return;
        }
        opponentAbsenceHandled = true;
        showInfoModal(t("rematch_no_response"), false);
        showScreen(menuScreen);
        loadActiveRooms();
        cleanupAbandonedRoom();
        return;
    }

    // v180: ТЕХНИЧЕСКОЕ ПОРАЖЕНИЕ вместо простого удаления комнаты. Раньше
    // партия просто исчезала — без winner, без Elo и без статистики
    // для обоих. Теперь подтверждённое отсутствие длиннее минуты завершает
    // партию как обычная победа и проходит через существующий pipeline.
    //
    // ЕДИНСТВЕННЫЙ путь завершения по отсутствию. Второго пути нет: если
    // технический результат назначить нельзя (нет доказанного серверного
    // absentSince, моя собственная online-сессия ещё моложе минуты, связь
    // не подтверждена), решение просто ОТКЛАДЫВАЕТСЯ — функция вызывается
    // каждую секунду и попробует снова. Лучше не назначить результат, чем
    // назначить ложное поражение по одному лишь молчащему heartbeat.
    // Поэтому и флаг взводится ТОЛЬКО когда попытка реально отправлена.
    if (writeTechnicalResult(oppColor)) {
        opponentAbsenceHandled = true;
    }
}

// Возраст последнего heartbeat соперника по СЕРВЕРНОМУ времени.
// null — судить нельзя (нет данных, нет связи, время сервера ещё не известно).
// ===== v180: ЕДИНАЯ МАШИНА ОТСУТСТВИЯ =====

// Возраст ДОКАЗАННОГО отсутствия. Считается ТОЛЬКО от absentSince —
// серверной отметки момента, когда игрок физически перестал быть перед
// доской. Её ставит либо сам клиент при сворачивании, либо серверный
// onDisconnect при настоящем обрыве, поэтому причина ухода роли не играет.
// null означает «судить нельзя», и для технического результата это ЗАПРЕТ:
// лучше подождать дольше, чем присудить ложное поражение. Отката на lastSeen
// здесь НЕТ СОЗНАТЕЛЬНО — молчащий heartbeat не доказывает уход.
function getAuthoritativeAbsenceMs(presence) {
    if (!presence) return null;
    if (presence.online !== false) return null;
    if (typeof presence.absentSince !== "number") return null;
    return getEstimatedServerNow() - presence.absentSince;
}

// Длительность ТЕКУЩЕЙ непрерывной online-сессии игрока.
// Нужна победителю: присудить победу за отсутствие вправе только тот, кто
// сам непрерывно присутствует уже целую минуту. Пока я сам отсутствовал, я
// никого не ждал, поэтому после каждого моего возвращения соперник получает
// новую полную минуту. Heartbeat onlineSince не обновляет.
function getOnlineSessionMs(presence) {
    if (!presence) return null;
    if (presence.online !== true) return null;
    if (typeof presence.onlineSince !== "number") return null;
    return getEstimatedServerNow() - presence.onlineSince;
}

// Технический результат уже отправлен и ждёт ответа сервера.
let technicalResultInFlight = false;

// ЗАПИСЬ ТЕХНИЧЕСКОГО РЕЗУЛЬТАТА — ОДНОЙ АТОМАРНОЙ ОПЕРАЦИЕЙ.
//
// update() на конкретные дочерние пути rooms/<код>/{result,winner,winReason,
// status}. Это НЕ запись всей комнаты и НЕ транзакция на весь узел: presence
// обоих игроков эта операция не касается вообще — урок v178, где whole-room
// транзакция подменяла присутствие соперника устаревшим слепком.
//
// Одной операцией комната получает привычные winner/winReason/status, поэтому
// весь существующий pipeline (renderEndGameModal, recordGameResult,
// расчёт партии на сервере, resolveMyOnlineResult, UID-
// атрибуция, серверный settlement, статистика, лобби, реванш,
// зрители) срабатывает сам. Второго пути результата не создаётся.
//
// Комната СОЗНАТЕЛЬНО не удаляется: она нужна, чтобы записались Elo,
// статистика, и чтобы вернувшийся проигравший увидел результат.
//
// Возвращает true, только если попытка действительно отправлена. Все проверки
// ниже — fail-fast: окончательный арбитраж делает Firebase .validate по
// СЕРВЕРНОМУ времени, а не часами телефона.
function writeTechnicalResult(absentColor) {
    if (!canUseFirebase()) return false;
    // --- контекст: только живая online-партия между людьми ---
    if (!isOnlineGame || isBotGame || isSpectator) return false;
    if (!roomCode || !currentState || !currentState.players) return false;
    // Собственная связь и доказанная свежесть ТЕКУЩЕЙ комнаты обязательны:
    // без них мои presence-данные могли остаться с момента до обрыва.
    if (!isFirebaseConnected) return false;
    if (!canTrustAbsenceForCleanup()) return false;
    // Партия уже закончена любым способом — второго исхода быть не может.
    if (currentState.winner || currentState.result) return false;
    if (technicalResultInFlight) return true;

    // --- состав участников по UID, а не по цвету ---
    const winnerColor = absentColor === "light" ? "dark" : "light";
    const winnerPlayer = currentState.players[winnerColor];
    const loserPlayer = currentState.players[absentColor];
    if (!winnerPlayer || !winnerPlayer.id) return false;
    if (!loserPlayer || !loserPlayer.id) return false;
    if (winnerPlayer.id === loserPlayer.id) return false;
    // Победитель — ТОТ, КТО ОСТАЛСЯ, а он это я. Чужой результат не пишем
    // никогда, и отсутствующий не может присудить победу самому себе.
    if (!myTelegramId || winnerPlayer.id !== myTelegramId) return false;
    if (winnerColor !== myColor) return false;

    // --- обе временные границы, обе по серверному времени ---
    const presence = currentState.presence || {};
    const loserAbsenceMs = getAuthoritativeAbsenceMs(presence[absentColor]);
    if (loserAbsenceMs === null || loserAbsenceMs < RECONNECT_GRACE_MS) return false;
    const myOnlineMs = getOnlineSessionMs(presence[winnerColor]);
    if (myOnlineMs === null || myOnlineMs < RECONNECT_GRACE_MS) return false;

    const targetRoom = roomCode;
    technicalResultInFlight = true;
    database.ref("rooms/" + targetRoom).update({
        result: {
            winnerColor: winnerColor,
            loserColor: absentColor,
            winnerId: winnerPlayer.id,
            loserId: loserPlayer.id,
            winReason: TECHNICAL_WIN_REASON,
            status: "finished",
            decidedAt: firebase.database.ServerValue.TIMESTAMP
        },
        winner: winnerColor,
        winReason: TECHNICAL_WIN_REASON,
        status: "finished"
    }).then(function () {
        technicalResultInFlight = false;
    }).catch(function (error) {
        // Отказ — штатная ситуация: сервер увидел возвращение соперника
        // раньше нас, партия уже закончилась другим способом, либо серверные
        // часы ещё не дошли до порога. Снимаем флаг обработки, чтобы решение
        // было принято заново на актуальных данных, а не потеряно молча.
        technicalResultInFlight = false;
        opponentAbsenceHandled = false;
        console.log("Technical result not applied:", error && error.message);
    });
    return true;
}

function getOpponentAbsenceMs(oppColor) {
    if (!isFirebaseConnected) return null; // я сам не на связи — состояние UNKNOWN
    if (!currentState || !currentState.presence) return null;
    const presence = currentState.presence[oppColor];
    // v180: отсчёт ведётся от absentSince — момента, когда игрок ФАКТИЧЕСКИ
    // покинул партию. Его ставит серверным временем либо сам клиент при
    // сворачивании, либо серверный onDisconnect при обрыве. Это делает
    // отсчёт одинаковым для всех причин отсутствия и не зависящим от того,
    // как долго молчал heartbeat.
    if (!presence) return null;
    if (presence.online !== false) return null; // игрок в игре — отсутствия нет
    if (typeof presence.absentSince === "number") {
        return getEstimatedServerNow() - presence.absentSince;
    }
    // Запасной путь для клиентов старых версий и bot-зеркала, где absentSince
    // не пишется: прежнее поведение по возрасту последнего heartbeat.
    if (typeof presence.lastSeen !== "number") return null;
    return getEstimatedServerNow() - presence.lastSeen;
}

// FAIL-SAFE перед разрушительным действием (удалением живой комнаты).
// Возвращает true, только если мы ДЕЙСТВИТЕЛЬНО уверены в свежести данных.
// Любое сомнение — false, и тогда решение просто откладывается до следующей
// секунды: «не удалось подтвердить» НИКОГДА не означает «всё равно удалить».
//
// Почему проверка построена так, а не на once("value"): в RTDB обычный
// once() на пути, за которым уже следит listener, может быть обслужен из
// ЛОКАЛЬНОГО КЕША и вернуть ровно те же устаревшие данные — то есть дать
// ложное подтверждение ухода. Строгого «только с сервера» чтения в SDK нет.
// Поэтому доказательством служит другое, и оно сильнее: если наша связь
// держится непрерывно дольше CONNECTION_SETTLE_MS, а heartbeat соперника за
// это время так и не пришёл — значит он молчит по-настоящему. Живой соперник
// за 15 секунд написал бы в комнату трижды, и listener принёс бы это нам.
function canTrustAbsenceForCleanup() {
    if (!isFirebaseConnected || connectedSinceMono === null) return false;
    // Связь должна держаться устойчиво, а не «только что мигнула».
    // Измеряем МОНОТОННЫМИ часами: коррекция системного времени телефона
    // (обычное дело после авиарежима) не должна укорачивать этот интервал.
    if (getMonotonicNow() - connectedSinceMono < CONNECTION_SETTLE_MS) return false;
    // Доказанный круговой обмен с сервером после этого подключения.
    // Локальные события собственной записи сюда не годятся.
    if (!serverAckSinceConnect) return false;
    // Для разрушительного решения голые часы телефона недопустимы: пока
    // серверное время неизвестно, возраст lastSeen посчитан ненадёжно.
    if (!serverTimeOffsetReady) return false;
    // Транспорт может быть жив, а подписка на комнату — ещё не пересинхронизирована.
    // Без свежего снапшота наши presence-данные могли остаться от момента до обрыва.
    if (!roomSnapshotSeenSinceConnect) return false;
    return true;
}

function cleanupAbandonedRoom() {
    if (!canUseFirebase()) return;
    if (!roomCode) return;
    const codeToClean = roomCode;
    if (myTelegramId) {
        database.ref("users/" + myTelegramId + "/rooms/" + codeToClean).remove();
    }
    const oppColor = myColor === "light" ? "dark" : "light";
    if (currentState && currentState.players && currentState.players[oppColor] && currentState.players[oppColor].id) {
        database.ref("users/" + currentState.players[oppColor].id + "/rooms/" + codeToClean).remove();
    }
    database.ref("rooms/" + codeToClean).remove();
    detachMyPresence();
    isOnlineGame = false;
    roomCode = null;
}

// ===== СИСТЕМА ПРИСУТСТВИЯ (ONLINE / OFFLINE) =====

function handleVisibilityChange() {
    if (!canUseFirebase()) return;
    if (!myPresenceRef) return;

    if (document.hidden) {
        // v184: при отсутствии связи НЕ пишем. Иначе absentSince уйдёт в
        // очередь и после реконнекта запишется задним числом — минута
        // начнётся заново, хотя человека не было всё это время. Настоящее
        // отсутствие уже зафиксирует серверный onDisconnect.
        if (!isFirebaseConnected) return;
        // ЕДИНАЯ МАШИНА ОТСУТСТВИЯ (v180). Свернул, переключился в другое
        // приложение, ответил на звонок — для партии это одно и то же:
        // игрока нет перед доской. Правило игры: минута на возвращение.
        // absentSince ставится СЕРВЕРНЫМ временем, чтобы отсчёт не зависел
        // от часов телефона; ровно то же значение пишет серверный
        // onDisconnect при настоящем обрыве — состояние получается общее.
        myPresenceRef.update({
            online: false,
            absentSince: firebase.database.ServerValue.TIMESTAMP,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        });
    } else {
        // v184: без связи не пишем — иначе online:true и absentSince:null
        // уйдут в очередь и воскресят партию после реконнекта. Возвращение
        // в игру доведёт до конца обработчик .info/connected.
        if (!isFirebaseConnected) return;

        // v184 BOTH-OFFLINE: возвращение к доске идёт ТЕМ ЖЕ свежим путём,
        // что и реконнект.
        //
        // Раньше здесь стояла проверка isRoomAbandonedNow(currentState), и она
        // была бесполезна: currentState собирается в слушателе комнаты из
        // фиксированного списка полей, и поля status там НЕТ вообще. Значит
        // room.status === undefined, предикат всегда возвращал false, и
        // ветка спокойно писала online:true — воскрешая брошенную партию.
        //
        // Кешу здесь доверять нельзя в принципе: он собран для отрисовки
        // доски, а не для решения о жизни комнаты. Читаем настоящее
        // состояние с сервера, и только оно решает.
        revivePresenceAfterReconnect();
    }
}

function setupPresence() {
    if (!canUseFirebase()) return;
    if (!myTelegramId || !roomCode) return;

    // Перед перенастройкой presence отменяем старый onDisconnect.
    // Иначе старое подключение позже может ошибочно записать online:false,
    // хотя игрок уже снова находится в игре.
    if (myPresenceRef) {
        myPresenceRef.onDisconnect().cancel();
    }

    stopPresenceHeartbeat();

    const presenceRef = database.ref("rooms/" + roomCode + "/presence/" + myColor);
    myPresenceRef = presenceRef;

    const setupGen = connectionGeneration;
    const setupListenerGen = listenerGeneration;
    // ПОРЯДОК ВАЖЕН (v178): СНАЧАЛА взводим onDisconnect, и только ПОСЛЕ его
    // успешной регистрации объявляем себя online. Иначе существует окно, в
    // котором игрок уже помечен online, а серверный обработчик отключения ещё
    // не установлен: обрыв ровно в этот момент оставил бы presence навсегда
    // «в игре». onDisconnect — одноразовая серверная операция, поэтому её
    // нужно взводить заново при КАЖДОЙ настройке присутствия (в том числе
    // после каждого реконнекта, когда setupPresence вызывается снова).
    // Настоящий обрыв связи ведёт в ТУ ЖЕ машину отсутствия, что и
    // сворачивание: absentSince серверным временем, от него идёт отсчёт.
    presenceRef.onDisconnect().update({
            online: false,
            absentSince: firebase.database.ServerValue.TIMESTAMP
        })
        .then(function () {
            if (!canUseFirebase()) return;
            return presenceRef.set({
                online: true,
                absentSince: null,
                onlineSince: firebase.database.ServerValue.TIMESTAMP,
                lastSeen: firebase.database.ServerValue.TIMESTAMP
            });
        })
        .then(function () { noteServerAck(setupGen, setupListenerGen); })
        .catch(function () {
            // v184: если связи нет — НЕ объявляем себя online. Прежний код
            // сознательно ставил эту запись в очередь, и она воскрешала
            // партию после реконнекта. Объявление online доведёт до конца
            // обработчик .info/connected, предварительно перевооружив
            // onDisconnect и проверив, не брошена ли партия.
            if (!isFirebaseConnected) return;
            if (!canUseFirebase()) return;
            // Связь есть, но регистрация не прошла (транзиентная ошибка) —
            // прежнее поведение сохраняется.
            presenceRef.set({
                online: true,
                absentSince: null,
                onlineSince: firebase.database.ServerValue.TIMESTAMP,
                lastSeen: firebase.database.ServerValue.TIMESTAMP
            })
                .then(function () { noteServerAck(setupGen, setupListenerGen); })
                .catch(function () {});
        });
    // ВАЖНО (v171): onDisconnect сознательно НЕ трогает lastSeen — см. выше,
    // регистрация перенесена ПЕРЕД объявлением online.

    presenceHeartbeatInterval = setInterval(function () {
        if (!canUseFirebase()) return;
        // ЕДИНОЕ ПРАВИЛО (v184): при отсутствии связи обычные клиентские
        // записи присутствия НЕ выполняются вообще. Firebase ставит их в
        // очередь и отправляет после реконнекта, а там они перезаписывают
        // серверное состояние, поставленное onDisconnect. За offline на
        // сервере отвечает onDisconnect, и только он.
        if (!isFirebaseConnected) return;
        if (document.hidden) {
            // Фоновое исключение (v171) — ТОЛЬКО для создателя waiting-комнаты
            // без соперника (см. myWaitingRoomNoOpponent). Пишем ТОЛЬКО
            // lastSeen: online:false, выставленный visibilitychange, остаётся
            // честным — комната живая для лобби и sweep'а, но игрок не
            // выглядит "в игре". Для active-партии поведение прежнее:
            // при document.hidden heartbeat молчит.
            if (myWaitingRoomNoOpponent && myColor === "light") {
                presenceRef.update({ lastSeen: firebase.database.ServerValue.TIMESTAMP });
            }
            return;
        }
        const beatGen = connectionGeneration;
        const beatListenerGen = listenerGeneration;
        // Heartbeat пишет ТОЛЬКО lastSeen. Раньше он писал ещё online:true, и
        // именно эта запись, накопившись в offline-очереди, воскрешала
        // присутствие ушедшего игрока после реконнекта. Флаг online ставят
        // три других пути: setupPresence, ветка visible и реконнект.
        presenceRef.update({ lastSeen: firebase.database.ServerValue.TIMESTAMP })
            .then(function () { noteServerAck(beatGen, beatListenerGen); })
            .catch(function () {});
    }, 4000);

    document.addEventListener("visibilitychange", handleVisibilityChange);
}

function stopPresenceHeartbeat() {
    if (presenceHeartbeatInterval) {
        clearInterval(presenceHeartbeatInterval);
        presenceHeartbeatInterval = null;
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
}

// v184: тихий выход из брошенной партии. Никакого результата, никаких
// начислений — просто закрываем экран и возвращаемся в меню.
function leaveAbandonedRoomToMenu() {
    detachMyPresence();
    roomCode = null;
    isOnlineGame = false;
    isSpectator = false;
    showScreen(menuScreen);
    loadActiveRooms();
    showInfoModal(t("err_no_active_game"), false);
}

// v184: возвращение присутствия ПОСЛЕ реального реконнекта.
//
// Прежний код писал online:true сразу, и это давало сразу три проблемы:
//   1. партия объявлялась живой раньше, чем кто-либо мог проверить, не
//      истекли ли both-offline 60 секунд;
//   2. onDisconnect — одноразовая серверная операция; после срабатывания её
//      никто не перевооружал, и следующий обрыв не отмечался вовсе,
//      оставляя игрока навсегда online:true;
//   3. writeTechnicalResult требует online === false, поэтому из-за пункта 2
//      техническое поражение переставало наступать в принципе.
//
// Правильный порядок: свежее состояние комнаты -> проверка брошенности ->
// перевооружение onDisconnect -> и только потом online:true.
function revivePresenceAfterReconnect() {
    if (!canUseFirebase()) return;
    const gen = connectionGeneration;
    const lgen = listenerGeneration;
    const targetRoom = roomCode;
    const presenceRef = myPresenceRef;

    const roomRef = database.ref("rooms/" + targetRoom);
    // get() отдаёт максимально свежее серверное значение; на старых сборках
    // SDK его может не быть — тогда обычный once("value").
    const read = (typeof roomRef.get === "function")
        ? roomRef.get()
        : roomRef.once("value");

    read.then(function (snapshot) {
        // Пока читали, человек мог уйти в другую комнату или стать зрителем.
        if (roomCode !== targetRoom || myPresenceRef !== presenceRef) return;
        if (!isFirebaseConnected) return;

        const room = snapshot && snapshot.val ? snapshot.val() : null;
        if (isRoomAbandonedNow(room)) {
            leaveAbandonedRoomToMenu();
            return;
        }

        // Перевооружаем ОДНОРАЗОВЫЙ onDisconnect и только после его
        // подтверждения объявляем себя online — тот же порядок, что в
        // setupPresence.
        presenceRef.onDisconnect().update({
            online: false,
            absentSince: firebase.database.ServerValue.TIMESTAMP
        }).then(function () {
            if (roomCode !== targetRoom || myPresenceRef !== presenceRef) return;
            if (!isFirebaseConnected) return;
            return presenceRef.update({
                online: true,
                absentSince: null,
                onlineSince: firebase.database.ServerValue.TIMESTAMP,
                lastSeen: firebase.database.ServerValue.TIMESTAMP
            }).then(function () { noteServerAck(gen, lgen); });
        }).catch(function () {});
    }).catch(function () {});
}

// Общая функция: полностью "отвязываемся" от presence текущей комнаты.
// Вызывать её нужно везде, где человек по-настоящему перестаёт участвовать
// в партии (обычное завершение игры, явный выход, брошенная комната,
// переход в режим зрителя) — иначе глобальный слушатель .info/connected
// может позже "оживить" presence уже неактуальной, старой комнаты.
function detachMyPresence() {
    if (myPresenceRef && canUseFirebase()) {
        myPresenceRef.onDisconnect().cancel();
    }
    stopPresenceHeartbeat();
    myPresenceRef = null;
    myWaitingRoomNoOpponent = false; // (v171) участие в комнате закончилось
}

function markMyselfLeftExplicitly() {
    if (myPresenceRef && canUseFirebase()) {
        // v180: явный выход — та же машина отсутствия, что и сворачивание.
        myPresenceRef.update({
            online: false,
            absentSince: firebase.database.ServerValue.TIMESTAMP,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        });
    }
    detachMyPresence();
}

let squareElements = {};
let boardBuilt = false;
let builtFlipped = null;

function ensureBoardBuilt() {
    if (boardBuilt && builtFlipped === flipped) return;

    const wrapper = document.getElementById("board-wrapper");
    wrapper.innerHTML = "";
    pieceElements = {};
    squareElements = {};
    hintedSquares = [];

    const labels = getLabels();
    const boardDiv = document.createElement("div");
    boardDiv.id = "board";

    const topLabels = document.createElement("div");
    topLabels.classList.add("labels", "labels-top");
    labels.letters.forEach(function (letter) {
        const label = document.createElement("div");
        label.classList.add("label");
        label.textContent = letter;
        topLabels.appendChild(label);
    });

    const bottomLabels = document.createElement("div");
    bottomLabels.classList.add("labels", "labels-bottom");
    labels.letters.forEach(function (letter) {
        const label = document.createElement("div");
        label.classList.add("label");
        label.textContent = letter;
        bottomLabels.appendChild(label);
    });

    const leftLabels = document.createElement("div");
    leftLabels.classList.add("labels", "labels-left");
    labels.numbers.forEach(function (number) {
        const label = document.createElement("div");
        label.classList.add("label");
        label.textContent = number;
        leftLabels.appendChild(label);
    });

    const rightLabels = document.createElement("div");
    rightLabels.classList.add("labels", "labels-right");
    labels.numbers.forEach(function (number) {
        const label = document.createElement("div");
        label.classList.add("label");
        label.textContent = number;
        rightLabels.appendChild(label);
    });

    wrapper.appendChild(topLabels);
    wrapper.appendChild(bottomLabels);
    wrapper.appendChild(leftLabels);
    wrapper.appendChild(rightLabels);
    wrapper.appendChild(boardDiv);

    for (let dispRow = 0; dispRow < 8; dispRow++) {
        for (let dispCol = 0; dispCol < 8; dispCol++) {
            let row, col;
            if (flipped) {
                row = 7 - dispRow;
                col = 7 - dispCol;
            } else {
                row = dispRow;
                col = dispCol;
            }

            const square = document.createElement("div");
            square.classList.add("square");
            square.dataset.row = row;
            square.dataset.col = col;

            const isDark = (row + col) % 2 !== 0;
            square.classList.add(isDark ? "dark" : "light");

            square.addEventListener("click", function () { handleClick(row, col); });
            boardDiv.appendChild(square);
            squareElements[row + "_" + col] = square;
        }
    }

    const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    arrowSvg.setAttribute("id", "last-move-arrow-svg");
    
    // Создаем SVG-фильтр свечения один раз при постройке доски, 
    // чтобы не пересоздавать его на каждый ход.
    const svgNS = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(svgNS, "defs");
    const filter = document.createElementNS(svgNS, "filter");
    filter.setAttribute("id", "last-move-glow");
    filter.setAttribute("x", "-60%");
    filter.setAttribute("y", "-60%");
    filter.setAttribute("width", "220%");
    filter.setAttribute("height", "220%");
    const blur = document.createElementNS(svgNS, "feGaussianBlur");
    blur.setAttribute("stdDeviation", "2.4");
    blur.setAttribute("result", "blurred");
    const merge = document.createElementNS(svgNS, "feMerge");
    const mergeBlur = document.createElementNS(svgNS, "feMergeNode");
    mergeBlur.setAttribute("in", "blurred");
    const mergeSource = document.createElementNS(svgNS, "feMergeNode");
    mergeSource.setAttribute("in", "SourceGraphic");
    merge.appendChild(mergeBlur);
    merge.appendChild(mergeSource);
    filter.appendChild(blur);
    filter.appendChild(merge);
    defs.appendChild(filter);
    arrowSvg.appendChild(defs);
    
    boardDiv.appendChild(arrowSvg);

    boardBuilt = true;
    builtFlipped = flipped;
}

function updateBoardPieces() {
    if (!currentState) return;
    const lastMove = currentState.lastMove;

    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const key = row + "_" + col;
            const square = squareElements[key];
            if (!square) continue;

            const isLastMove = !!(lastMove && (
                (lastMove.from.row === row && lastMove.from.col === col) ||
                (lastMove.to.row === row && lastMove.to.col === col)
            ));
            square.classList.toggle("last-move", isLastMove);

            const pieceData = pieceAt(currentState.pieces, row, col);
            const existingPieceEl = pieceElements[key];
            const isSelected = !!(selectedFrom && selectedFrom.row === row && selectedFrom.col === col);

            if (!pieceData) {
                if (existingPieceEl) {
                    existingPieceEl.remove();
                    delete pieceElements[key];
                }
                continue;
            }

            const desiredIsKing = !!pieceData.king;
            const existingIsKing = existingPieceEl ? existingPieceEl.classList.contains("king") : null;
            const existingColor = existingPieceEl ? existingPieceEl.dataset.pieceColor : null;

            if (existingPieceEl && existingColor === pieceData.color && existingIsKing === desiredIsKing) {
                existingPieceEl.classList.toggle("selected", isSelected);
                continue;
            }

            if (existingPieceEl) {
                existingPieceEl.remove();
            }
            const piece = document.createElement("div");
            piece.classList.add("piece", pieceData.color === "light" ? "piece-light" : "piece-dark");
            piece.dataset.pieceColor = pieceData.color;
            if (desiredIsKing) {
                piece.classList.add("king");
            }
            if (isSelected) piece.classList.add("selected");
            square.appendChild(piece);
            pieceElements[key] = piece;
        }
    }
}

// ===== ГОСТЬ-АНИМАЦИЯ ХОДА =====
// Чисто визуальный слой поверх уже обновлённой authoritative доски.
// Ничего здесь не читает и не пишет currentState, не участвует в
// определении легальности хода, не трогает Firebase. При любой ошибке —
// просто не анимирует; реальная доска (updateBoardPieces()) уже корректна
// независимо от этого кода.

// Отменяет все ещё летящие ghost-анимации немедленно — вызывается перед
// стартом новой анимации (быстрый следующий ход) и на resize/orientationchange.
// Каждая cancel-функция гарантированно возвращает видимость спрятанной
// реальной фигуре перед удалением своего ghost'а — доска не может остаться
// с "пропавшей" фигурой из-за прерванной анимации.
function cancelActiveGhostAnimations() {
    const fns = activeGhostCancelFns.slice();
    activeGhostCancelFns = [];
    fns.forEach(function (fn) { fn(); });
}

// --- Точечное чтение существующего DOM ДО того, как updateBoardPieces()
// удалит сбитые фигуры. Единственная цель — сохранить UI-метаданные
// (color, king) для captured-ghost эффекта, чтобы сбитая дамка визуально
// не показалась на 90мс обычной шашкой. НЕ пишет и не читает
// currentState/game logic, никаких новых игровых полей — чисто временный
// локальный снимок для рендера, живущий один вызов renderBoard(). ---
function captureCapturedPieceSnapshotsBeforeUpdate() {
    if (!currentState || currentState.moveType !== "capture" || !Array.isArray(currentState.lastCapturedSquares)) {
        return [];
    }
    const snapshots = [];
    currentState.lastCapturedSquares.forEach(function (sq) {
        const key = sq.row + "_" + sq.col;
        const el = pieceElements[key];
        if (!el) return; // защитный выход — просто не будет captured-ghost для этой клетки
        snapshots.push({
            key: key,
            color: el.dataset.pieceColor || "light",
            king: el.classList.contains("king")
        });
    });
    return snapshots;
}

// Вызывается ПОСЛЕ updateBoardPieces() — authoritative доска уже полностью
// корректна к этому моменту. Для ДВИЖУЩЕЙСЯ фигуры всё выводится из уже
// обновлённого currentState через правила игры (moveType==="king"
// однозначно значит "дамкой не была до этого хода"), а не из DOM "до" —
// это надёжнее и не зависит от таймингов. Для СБИТЫХ фигур используется
// заранее снятый (см. captureCapturedPieceSnapshotsBeforeUpdate) DOM-снимок,
// поскольку у уже удалённой из pieces фигуры не осталось игровых данных.
function playMoveGhostAnimation(capturedSnapshots) {
    cancelActiveGhostAnimations();

    if (!currentState || !currentState.lastMove) {
        lastAnimatedMoveCount = currentState ? currentState.moveCount : null;
        return;
    }

    const isFirstRenderSinceAttach = (lastAnimatedMoveCount === null);
    const isGenuinelyNewMove = !isFirstRenderSinceAttach && currentState.moveCount !== lastAnimatedMoveCount;
    lastAnimatedMoveCount = currentState.moveCount;
    if (!isGenuinelyNewMove) return;

    const move = currentState.lastMove;
    const fromKey = move.from.row + "_" + move.from.col;
    const toKey = move.to.row + "_" + move.to.col;

    const fromSquareEl = squareElements[fromKey];
    const toSquareEl = squareElements[toKey];
    const realPieceEl = pieceElements[toKey];
    if (!fromSquareEl || !toSquareEl || !realPieceEl) return; // защитный выход — доска уже корректна без анимации

    const pieceData = currentState.pieces[toKey];
    if (!pieceData) return;

    const wasKingBeforeThisHop = (currentState.moveType === "king") ? false : !!pieceData.king;
    const colorClass = pieceData.color === "light" ? "piece-light" : "piece-dark";

    // Минимум измерений — ровно два прямоугольника на ход.
    const fromRect = fromSquareEl.getBoundingClientRect();
    const toRect = toSquareEl.getBoundingClientRect();
    const deltaX = fromRect.left - toRect.left;
    const deltaY = fromRect.top - toRect.top;

    realPieceEl.classList.add("piece-hidden-for-ghost");

    const ghost = document.createElement("div");
    ghost.className = "piece " + colorClass + " move-ghost-piece" + (wasKingBeforeThisHop ? " king" : "");
    ghost.style.transform = "translate(" + deltaX + "px, " + deltaY + "px)";
    toSquareEl.appendChild(ghost);

    let cancelled = false;
    function cleanupMoveGhost() {
        if (cancelled) return;
        cancelled = true;
        realPieceEl.classList.remove("piece-hidden-for-ghost");
        if (ghost.parentNode) ghost.remove();
        activeGhostCancelFns = activeGhostCancelFns.filter(function (fn) { return fn !== cleanupMoveGhost; });
    }
    activeGhostCancelFns.push(cleanupMoveGhost);

    requestAnimationFrame(function () {
        if (cancelled) return;
        ghost.style.transition = "transform " + MOVE_GHOST_DURATION_MS + "ms ease-out";
        ghost.style.transform = "translate(0px, 0px)";
    });
    ghost.addEventListener("transitionend", cleanupMoveGhost);
    setTimeout(cleanupMoveGhost, MOVE_GHOST_DURATION_MS + 60); // страховка, если transitionend не сработал

    // --- Эффект сбитых фигур: отдельный, независимый ghost на каждую
    // клетку из lastCapturedSquares. Настоящая фигура там УЖЕ удалена
    // authoritative-рендером — этот ghost её не возвращает в реальный DOM,
    // это чисто декоративная копия для fade-эффекта, построенная по
    // заранее снятым (до updateBoardPieces()) UI-метаданным color/king.
    // pendingRemovals сознательно не используется — это чисто rules-логика,
    // к визуалу отношения не имеет. ---
    if (Array.isArray(capturedSnapshots)) {
        capturedSnapshots.forEach(function (snap) {
            const capturedSquareEl = squareElements[snap.key];
            if (!capturedSquareEl) return;

            const capturedColorClass = snap.color === "light" ? "piece-light" : "piece-dark";
            const capturedGhost = document.createElement("div");
            capturedGhost.className = "piece " + capturedColorClass + " move-ghost-captured" + (snap.king ? " king" : "");
            capturedSquareEl.appendChild(capturedGhost);

            let capCancelled = false;
            function cleanupCapturedGhost() {
                if (capCancelled) return;
                capCancelled = true;
                if (capturedGhost.parentNode) capturedGhost.remove();
                activeGhostCancelFns = activeGhostCancelFns.filter(function (fn) { return fn !== cleanupCapturedGhost; });
            }
            activeGhostCancelFns.push(cleanupCapturedGhost);

            requestAnimationFrame(function () {
                if (capCancelled) return;
                capturedGhost.style.transition = "opacity " + CAPTURE_FADE_DURATION_MS + "ms ease-out, transform " + CAPTURE_FADE_DURATION_MS + "ms ease-out";
                capturedGhost.style.opacity = "0";
                capturedGhost.style.transform = "scale(0.4)";
            });
            capturedGhost.addEventListener("transitionend", cleanupCapturedGhost);
            setTimeout(cleanupCapturedGhost, CAPTURE_FADE_DURATION_MS + 60);
        });
    }
}

window.addEventListener("resize", cancelActiveGhostAnimations);
window.addEventListener("orientationchange", cancelActiveGhostAnimations);

function renderBoard() {
    // Единая надёжная точка пересчёта ориентации доски — myColor
    // устанавливается более чем в 15 разных местах (новая партия, реванш,
    // resume, cross-device takeover, разные online-пути), и полагаться на
    // то, что КАЖДОЕ из них не забудет обновить flipped, было ненадёжно —
    // именно так наблюдатель/владелец после resume/реванша видел доску
    // перевёрнутой. renderBoard() — единственная точка, вызываемая перед
    // КАЖДОЙ фактической отрисовкой, поэтому пересчёт здесь гарантированно
    // покрывает все существующие и будущие пути установки myColor. Для
    // зрителя (myColor === null) выражение корректно даёт false — та же
    // ориентация, что и раньше.
    flipped = (myColor === "dark");
    // Единая структурно взаимоисключающая точка выбора кнопки "Назад".
    // Раньше здесь было два НЕЗАВИСИМЫХ условия (isSpectator&&... для одной
    // кнопки, isBotGame&&!isSpectator&&!ownerSessionAttached&&... для
    // другой) — по булевой алгебре они действительно взаимоисключающие, но
    // такая схема хрупкая: любое неучтённое сочетание флагов (например,
    // если какой-то путь входа забудет сбросить isBotGame/ownerSessionAttached,
    // как это уже случалось с flipped) может привести к тому, что обе
    // покажутся или обе спрячутся. if/else-if ниже выбирает РОВНО ОДИН режим
    // структурно — гарантия "не может быть двух" не зависит от того,
    // насколько аккуратно отдельные модули поддерживают свои флаги.
    let backButtonMode = "none";
    if (isSpectator && currentState && !currentState.winner) {
        backButtonMode = "spectator";
    } else if (isBotGame && !isSpectator && currentState && !currentState.winner) {
        // Игрок с ботом — и текущий основной synced-owner путь
        // (ownerSessionAttached===true), и старый legacy-путь. Раньше
        // здесь стояло дополнительное условие !ownerSessionAttached,
        // которое ИСКЛЮЧАЛО именно основной, реально используемый путь —
        // владелец synced-игры не видел вообще ни одной кнопки "Назад".
        // Для завершённой партии уже есть кнопка "В меню" внутри модалки
        // конца игры (renderEndGameModal), эта кнопка её не дублирует.
        backButtonMode = "bot";
    }
    if (btnBackSpectator) {
        btnBackSpectator.classList.toggle("hidden", backButtonMode !== "spectator");
    }
    if (btnBackBot) {
        btnBackBot.classList.toggle("hidden", backButtonMode !== "bot");
    }
    ensureBoardBuilt();
    const capturedSnapshotsForGhost = captureCapturedPieceSnapshotsBeforeUpdate();
    updateBoardPieces();
    playMoveGhostAnimation(capturedSnapshotsForGhost);
    renderPlayerPanels();
    renderSpectatorsList();
    renderEndGameModal();
    showMoveHints(selectedFrom);
    resetMustCaptureHintTimer();
    renderLastMoveArrow();
    checkRematchProposal();
    checkDrawProposal();

    if (isBotGame && currentState && !currentState.winner && currentState.turn === botColor) {
        // Если таймер уже стоит — не ставим второй. 
        // Задержка 150мс вместо 500мс, чтобы многоходовые взятия бота 
        // не создавали иллюзию зависания (3 прыжка = 0.45с вместо 1.5с).
        if (!botMoveTimer) {
            botMoveTimer = setTimeout(function() {
                botMoveTimer = null;
                triggerBotMove();
            }, 150);
        }
    }
}

function renderLastMoveArrow() {
    const svg = document.getElementById("last-move-arrow-svg");
    if (!svg) return;
    
    // Очищаем только линии и круги, НЕ трогая <defs> с фильтром
    const linesAndCircles = svg.querySelectorAll("line, circle");
    linesAndCircles.forEach(function(el) { el.remove(); });

    const path = currentState && currentState.lastMovePath;
    if (!path || path.length < 2) return;

    const points = [];
    for (let i = 0; i < path.length; i++) {
        const sq = squareElements[path[i].row + "_" + path[i].col];
        if (!sq) return;
        points.push({
            x: sq.offsetLeft + sq.offsetWidth / 2,
            y: sq.offsetTop + sq.offsetHeight / 2
        });
    }

    const svgNS = "http://www.w3.org/2000/svg";

    for (let i = 0; i < points.length - 1; i++) {
        const line = document.createElementNS(svgNS, "line");
        line.setAttribute("x1", points[i].x);
        line.setAttribute("y1", points[i].y);
        line.setAttribute("x2", points[i + 1].x);
        line.setAttribute("y2", points[i + 1].y);
        line.setAttribute("stroke", "rgba(178, 214, 128, 0.22)");
        line.setAttribute("stroke-width", "2.5");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("filter", "url(#last-move-glow)");
        svg.appendChild(line);
    }

    const capturedSquares = currentState.lastCapturedSquares || [];
    capturedSquares.forEach(function (cap) {
        const sq = squareElements[cap.row + "_" + cap.col];
        if (!sq) return;
        const circle = document.createElementNS(svgNS, "circle");
        circle.setAttribute("cx", sq.offsetLeft + sq.offsetWidth / 2);
        circle.setAttribute("cy", sq.offsetTop + sq.offsetHeight / 2);
        circle.setAttribute("r", Math.max(4, sq.offsetWidth * 0.08));
        circle.setAttribute("class", "last-move-capture-mark");
        circle.setAttribute("filter", "url(#last-move-glow)");
        svg.appendChild(circle);
    });
}

// ===== ПОДСКАЗКА "НУЖНО БИТЬ" ПОСЛЕ 5 СЕКУНД БЕЗДЕЙСТВИЯ =====

let mustCaptureHintTimer = null;
let hintedMustCapturePieces = [];
const MUST_CAPTURE_HINT_DELAY_MS = 5000;

function clearMustCaptureHint() {
    hintedMustCapturePieces.forEach(function (el) { el.classList.remove("must-capture-hint"); });
    hintedMustCapturePieces = [];
}

function showMustCaptureHint() {
    mustCaptureHintTimer = null;
    if (!currentState || currentState.winner || selectedFrom) return;
    const myTurnColor = isOnlineGame ? myColor : (isBotGame ? myColor : currentState.turn);
    if (currentState.turn !== myTurnColor) return;
    if (!hasMandatoryCapture(currentState.pieces, currentState.turn)) return;

    for (const key in currentState.pieces) {
        const p = currentState.pieces[key];
        if (p.color !== currentState.turn) continue;
        const parts = key.split("_");
        const r = parseInt(parts[0]);
        const c = parseInt(parts[1]);
        if (canCaptureAt(currentState.pieces, r, c, currentState.turn, !!p.king)) {
            const el = pieceElements[key];
            if (el) {
                el.classList.add("must-capture-hint");
                hintedMustCapturePieces.push(el);
            }
        }
    }
}

function resetMustCaptureHintTimer() {
    if (mustCaptureHintTimer) {
        clearTimeout(mustCaptureHintTimer);
        mustCaptureHintTimer = null;
    }
    clearMustCaptureHint();

    if (!currentState || currentState.winner || selectedFrom) return;
    const myTurnColor = isOnlineGame ? myColor : (isBotGame ? myColor : currentState.turn);
    if (currentState.turn !== myTurnColor) return;

    mustCaptureHintTimer = setTimeout(showMustCaptureHint, MUST_CAPTURE_HINT_DELAY_MS);
}

let hintedSquares = [];

function clearMoveHints() {
    hintedSquares.forEach(function (sq) { sq.classList.remove("move-hint"); });
    hintedSquares = [];
}

function getLegalDestinations(pieces, row, col, color, king, pendingRemovals) {
    const scanPieces = withPendingBlockers(pieces, pendingRemovals);
    const captureJumps = getCaptureJumps(scanPieces, row, col, color, king);
    const allowedJumps = filterJumpsByMajorityRule(scanPieces, row, col, color, king, captureJumps);
    if (allowedJumps.length > 0) {
        return allowedJumps.map(function (j) { return { row: j.toRow, col: j.toCol }; });
    }

    const destinations = [];
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

    const forwardDirection = color === "light" ? -1 : 1;
    const moveDirections = king ? directions : [[forwardDirection, -1], [forwardDirection, 1]];
    const maxMoveDist = king ? 7 : 1;
    for (let d = 0; d < moveDirections.length; d++) {
        const dRow = moveDirections[d][0];
        const dCol = moveDirections[d][1];
        for (let dist = 1; dist <= maxMoveDist; dist++) {
            const r = row + dRow * dist;
            const c = col + dCol * dist;
            if (r < 0 || r > 7 || c < 0 || c > 7) break;
            const p = pieceAt(scanPieces, r, c);
            if (!p) {
                destinations.push({ row: r, col: c });
            } else {
                break;
            }
        }
    }
    return destinations;
}

function showMoveHints(sel) {
    clearMoveHints();
    if (!sel || !currentState) return;
    const pieceData = pieceAt(currentState.pieces, sel.row, sel.col);
    if (!pieceData) return;
    const destinations = getLegalDestinations(currentState.pieces, sel.row, sel.col, pieceData.color, !!pieceData.king, currentState.pendingRemovals);
    destinations.forEach(function (d) {
        const sq = squareElements[d.row + "_" + d.col];
        if (sq) {
            sq.classList.add("move-hint");
            hintedSquares.push(sq);
        }
    });
}

function formatTime(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return m + ":" + (rem < 10 ? "0" : "") + rem;
}

function updateTimerDisplay() {
    if (!currentState || currentState.winner) {
        turnTimerDiv.textContent = "";
        return;
    }
    // Статус синхронизации имеет приоритет над таймером хода и живёт в том же
    // элементе: у #turn-timer уже есть min-height, поэтому доска НЕ прыгает,
    // новых элементов и правок CSS не требуется.
    const sync = computeSyncStatus();
    if (sync) {
        turnTimerDiv.textContent = t(sync.key);
        renderSyncRetryButton(sync.showRetry);
        return;
    }
    renderSyncRetryButton(false);

    if (!currentState.timeControlSeconds || !currentState.turnStartedAt) {
        turnTimerDiv.textContent = "";
        return;
    }
    // CLOCK SAFETY: turnStartedAt приходит с сервера через
    // ServerValue.TIMESTAMP, поэтому сравнивать его можно только с серверным
    // временем. Голые часы телефона расходятся с сервером (классика —
    // авиарежим, после которого время переустанавливается), и таймер тогда
    // показывал бы чужое время.
    // Отображение НЕ делаем fail-closed: пока смещение не получено,
    // getEstimatedServerNow() вырождается в Date.now() — то есть в прежнее
    // поведение. Пустой таймер выглядел бы поломкой, а показ ничего
    // необратимого не решает.
    const elapsed = (getEstimatedServerNow() - currentState.turnStartedAt) / 1000;
    let remaining = currentState.timeControlSeconds - elapsed;
    if (remaining > currentState.timeControlSeconds) remaining = currentState.timeControlSeconds;
    const whoseTurn = currentState.turn === "light" ? t("whites") : t("blacks");
    turnTimerDiv.textContent = "⏱ " + t("timer_move") + ": " + whoseTurn + " — " + t("timer_time_left") + " " + formatTime(remaining);
}

// --- ПРЕЗЕНТАЦИОННЫЙ слой окна ничьей. Намеренно отделён от игровой
// логики: checkAutomaticDraw()/computeNextDrawState() продолжают хранить
// ТОЛЬКО стабильные коды причин и о текстах ничего не знают. Здесь код
// превращается в заголовок + человекочитаемую строку.
//
// Код "draw" (ручное согласие сторон, см. обработчик btnDrawAccept) в этот
// словарь СОЗНАТЕЛЬНО не входит: только он вправе показывать текст про
// согласие игроков, и наоборот — ни одна автоматическая причина (включая
// нераспознанную) этот текст показать не должна. ---
const DRAW_REASON_DISPLAY = {
    threefold_repetition: "draw_reason_threefold",
    kings_only_15: "draw_reason_kings15",
    no_progress_5: "draw_reason_np5",
    no_progress_30: "draw_reason_np30",
    no_progress_60: "draw_reason_np60",
    long_road_5: "draw_reason_longroad"
};

// Возвращает { header, subtext } для текущего ничейного исхода.
function buildDrawResultText(winReason) {
    if (winReason === "draw") {
        // ЕДИНСТВЕННАЯ ветка, где допустим текст про согласие игроков.
        return { header: t("draw_manual_header"), subtext: t("draw_manual_text") };
    }
    const key = DRAW_REASON_DISPLAY[winReason];
    return {
        header: t("draw_by_rule_header"),
        // Нераспознанный автоматический код -> нейтральный текст, но НИКОГДА
        // не текст про согласие игроков.
        subtext: key ? t(key) : t("draw_reason_unknown")
    };
}

function renderEndGameModal() {
    if (currentState && currentState.winner) {
        if (currentState.winner === "draw") {
            const drawText = buildDrawResultText(currentState.winReason);
            endGameText.textContent = drawText.header;
            if (endGameSubtext) endGameSubtext.textContent = drawText.subtext;
        } else {
            const winnerColor = currentState.winner;
            const loserColor = winnerColor === "light" ? "dark" : "light";
            const winnerName = (currentState.players && currentState.players[winnerColor] && currentState.players[winnerColor].name) || (winnerColor === "light" ? t("whites") : t("blacks"));
            const loserName = (currentState.players && currentState.players[loserColor] && currentState.players[loserColor].name) || (loserColor === "light" ? t("whites") : t("blacks"));
            const winnerIcon = "✅";
            const loserIcon = "❌";

            let text = winnerIcon + " " + winnerName + "\n" + loserIcon + " " + loserName;

            endGameText.textContent = text;
            // Обязательно очищаем: иначе причина ПРОШЛОЙ ничьей осталась бы
            // висеть под результатом победы (элемент переиспользуется).
            // v180: единственная победа, у которой есть пояснение — техническая.
            // Без него исход выглядел бы необъяснимо для обеих сторон.
            if (endGameSubtext) {
                endGameSubtext.textContent =
                    (currentState.winReason === TECHNICAL_WIN_REASON) ? t("win_reason_disconnect") : "";
            }
        }

        // Изменение рейтинга. Показывается ТОЛЬКО когда сервер подтвердил,
        // что начисление действительно применено. Иначе честно сообщаем,
        // что подтверждения нет, и не выдумываем число.
        if (endGameRating) {
            // Рейтинг относится только к моей online-партии. Зритель или
            // следующая bot-партия не должны унаследовать строку прошлого матча.
            if (!isOnlineGame || isBotGame || isSpectator) {
                endGameRating.textContent = "";
            } else {
                const d = lastSettlementDisplay;
                if (d && d.confirmed) {
                    const sign = d.delta > 0 ? "+" : "";
                    endGameRating.textContent =
                        "⭐" + d.before + " → " + d.after + "  (" + sign + d.delta + ")";
                } else if (d) {
                    const beforeLine = (typeof d.before === "number") ? ("⭐" + d.before + "\n") : "";
                    endGameRating.textContent = beforeLine + t("rating_change_unconfirmed")
                        + "\n" + t("rating_check_in_stats");
                } else {
                    endGameRating.textContent = "";
                }
            }
        }

        endGameModal.classList.remove("hidden");
        
        // Настраиваем кнопки: зритель видит только "В меню", игрок видит обе
        const buttonsRow = endGameModal.querySelector(".modal-buttons");
        if (buttonsRow) {
            if (isSpectator) {
                btnNewGame.classList.add("hidden");
                btnCloseGame.classList.remove("hidden");
                btnCloseGame.textContent = t("btn_to_menu");
            } else {
                btnNewGame.classList.remove("hidden");
                btnCloseGame.classList.remove("hidden");
                // Для игры с ботом кнопка ведёт в меню (не закрывает Mini App) —
                // текст должен соответствовать реальному поведению.
                btnCloseGame.textContent = isBotGame ? t("btn_to_menu") : t("btn_close");
            }
        }

        // Для bot game используем уникальный currentBotMatchId, а не roomCode —
        // "зеркальная" bot-комната может переиспользовать тот же roomCode при
        // реванше, и тогда marker мог бы случайно совпасть с прошлой партией
        // (если moveCount тоже совпадёт), пропустив recordGameResult() второй
        // раз. currentBotMatchId уникален на каждый вызов startOfflineGame().
        // Для online-игр ничего не меняем — roomCode там honestly уникален per match.
        // ONLINE: roomCode НЕ уникален для партии — реванш переиспользует ту же
        // комнату (performRematchReset пишет в rooms/<тот же roomCode>), а
        // moveCount сбрасывается в 0. Две партии в одной комнате, закончившиеся
        // на одинаковом ходу, давали ОДИНАКОВЫЙ маркер, и вторая не засчитывалась.
        // Бьёт асимметрично: принявший реванш проходит через startOnlineGame()
        // (маркер сбрасывается), а предложивший получает реванш через listener
        // "без startOnlineGame()" — у него оставался старый маркер.
        // matchNumber инкрементируется в performRematchReset на каждый реванш и
        // matchNumber уже является стабильным номером партии внутри комнаты
        // и растёт на каждый реванш.
        const onlineMatchNumber = (typeof currentState.matchNumber === "number") ? currentState.matchNumber : 0;
        const marker = isBotGame
            ? (currentBotMatchId || "offline") + "_" + currentState.moveCount + (currentState.winner === "draw" ? "_draw" : "")
            : (roomCode || "offline") + "_" + onlineMatchNumber + "_" + currentState.moveCount + (currentState.winner === "draw" ? "_draw" : "");
        if (endGameShownForRoom !== marker) {
            playWinSound();
            endGameShownForRoom = marker;
        }
        if (isBotGame && !localOnlyBotGame) {
            // Bot-ветка: НЕ ставим statsRecordedForRoom заранее — только
            // после того, как Firebase реально подтвердил результат (успех
            // ИЛИ committed:false из-за уже засчитанного matchId — оба это
            // легитимное "готово", в отличие от network reject). Пока запрос
            // ещё летит — statsInFlightForRoom не даёт запустить второй
            // параллельный запрос при повторном renderEndGameModal().
            if (statsRecordedForRoom !== currentBotMatchId && statsInFlightForRoom !== currentBotMatchId) {
                statsInFlightForRoom = currentBotMatchId;
                recordGameResult();
            }
        } else if (statsRecordedForRoom !== marker && statsInFlightOnlineMarker !== marker) {
            // Online-ветка: маркер "записано" ставится ТОЛЬКО после подтверждения
            // Firebase (см. recordGameResult). Раньше он ставился здесь, до
            // вызова, и любой сбой записи означал НАВСЕГДА потерянный результат
            // в этой сессии — повторный render уже не пытался. Теперь на время
            // запроса действует statsInFlightOnlineMarker, не дающий запустить
            // второй параллельный запрос, а при ошибке он снимается и повтор
            // становится возможен. Та же схема, что уже работала у bot-ветки.
            statsInFlightOnlineMarker = marker;
            recordGameResult(marker);
        }

    } else {
        endGameModal.classList.add("hidden");
    }
}

let statsRecordedForRoom = null;
let statsInFlightForRoom = null; // только для bot-ветки — см. recordGameResult()
// Отдельный in-flight маркер ИМЕННО для online. Сознательно не переиспользуем
// statsInFlightForRoom: он хранит currentBotMatchId, а здесь — roomCode-маркер,
// смешивать разные пространства идентификаторов нельзя.
let statsInFlightOnlineMarker = null;

// ===== АТРИБУЦИЯ РЕЗУЛЬТАТА ONLINE-ПАРТИИ =====
// Возвращает "win" | "loss" | "draw" — мой результат в законченной
// online-партии, определённый по UID участника, а НЕ по цвету клиента.
// Возвращает null, если результат определять нельзя (я не участник).
//
// ПОЧЕМУ ИМЕННО UID. Раньше клиентская статистика считалась как
// currentState.winner === myColor. Цвет клиента меняется при каждом реванше
// (performRematchReset меняет стороны местами), и если локальный myColor хоть
// по какой-то причине разошёлся с реальным составом комнаты — например у
// клиента со старым закэшированным script.js, — результат записывался
// ЗЕРКАЛЬНО: проигравшему победа, победителю поражение. Ровно это и произошло
// в реальной партии с реваншем. UID при смене сторон не меняется никогда,
// поэтому такая рассинхронизация больше не способна перевернуть результат.
//
// Elo этой уязвимости никогда не имел: квитанция eloMatches всегда писалась
// по lightId/darkId из players. Здесь мы приводим к тому же принципу
// серверная атрибуция теперь придерживается того же принципа.
function resolveMyOnlineResult(state) {
    if (!state || !state.winner) return null;
    if (state.winner === "draw") return "draw";

    const players = state.players;
    // players нет вовсе — теоретическая старая комната. Молча терять результат
    // хуже, чем посчитать его по-старому: откатываемся на прежнее поведение.
    if (!players || !players.light || !players.dark) {
        return (state.winner === myColor) ? "win" : "loss";
    }

    const lightId = players.light.id;
    const darkId = players.dark.id;
    // ID отсутствуют (некорректная/очень старая комната) — сверять не с чем,
    // работаем по-старому, чтобы не потерять результат молча.
    if (!lightId || !darkId) {
        return (state.winner === myColor) ? "win" : "loss";
    }
    // ID есть и НИ ОДИН из них не мой: я не участник этой комнаты (устаревшее
    // локальное состояние, чужая комната). Записывать чужой результат себе
    // нельзя ни при каких условиях.
    if (myTelegramId !== lightId && myTelegramId !== darkId) return null;

    const winnerId = (state.winner === "light") ? lightId : darkId;
    return (winnerId === myTelegramId) ? "win" : "loss";
}

// ===== ELO: чистая математика =====

// Отсутствующий/битый рейтинг = ELO_START_RATING. Единая точка правды:
// используется при отображении и при сортировке топа,
// чтобы старый игрок везде выглядел одинаково.
function normalizeEloRating(value) {
    if (typeof value !== "number" || !isFinite(value) || value < 0) return ELO_START_RATING;
    return value;
}

// Стабильный ID партии. roomCode сам по себе НЕ уникален во времени
// (генератор может повторить код через месяцы) и не уникален внутри комнаты
// (реванш переиспользует ту же комнату), поэтому в ключ входят оба
// дополнения: createdAt комнаты (пишется один раз при создании и не меняется
// ни при reconnect, ни при реванше) и matchNumber (растёт на каждый реванш).
// Комнаты, созданные до появления createdAt, дают 0 — такие партии всё равно
// различаются по roomCode+matchNumber.
function buildEloMatchId(code, createdAt, matchNumber) {
    const stamp = (typeof createdAt === "number" && isFinite(createdAt)) ? createdAt : 0;
    const num = (typeof matchNumber === "number" && isFinite(matchNumber)) ? matchNumber : 0;
    return "elo_" + code + "_" + stamp + "_" + num;
}

// Проверяет только факт, что завершённая партия является серверно
// зарегистрированной рейтинговой партией, готовой к settlement. Клиент
// НЕ рассчитывает Elo: единственный источник рейтинговой математики — Worker.
// Все прежние guards сохранены намеренно:
//   - только online между двумя РАЗНЫМИ людьми (бот и зритель исключены);
//   - я сам обязан быть одним из игроков;
//   - в комнате обязан лежать канонический ratedMatchId ТЕКУЩЕГО поколения
//     и полный ratingsAtStart обеих сторон.
// Один snapshot без pointer не считается доказательством: cached v193 способен
// писать его сам, поэтому legacy-состояние не принимается за server-rated матч.
function isRatedMatchReadyForSettlement() {
    if (!isOnlineGame || isBotGame || isSpectator) return false;
    if (!roomCode || !myTelegramId) return false;
    if (!currentState || !currentState.winner) return false;

    const players = currentState.players;
    if (!players || !players.light || !players.dark) return false;
    const lightId = players.light.id;
    const darkId = players.dark.id;
    if (!lightId || !darkId || lightId === darkId) return false;
    if (myTelegramId !== lightId && myTelegramId !== darkId) return false;

    // Полного snapshot недостаточно: нужен канонический server pointer
    // текущего поколения + полный snapshot обеих сторон.
    const registeredMatchId = registeredMatchIdForState(currentState, roomCode);
    if (!registeredMatchId) return false;

    const result = (currentState.winner === "draw") ? "draw" : currentState.winner;
    return result === "light" || result === "dark" || result === "draw";
}

// ===== РАСЧЁТ ПАРТИИ НА СЕРВЕРЕ =====
//
// Клиент больше не пишет рейтинг и статистику сам. Он регистрирует матч
// и просит сервер рассчитать результат. Канонический идентификатор
// elo_<roomCode>_<createdAt>_<matchNumber> остаётся общим замком со
// старыми клиентами: по нему сервер видит чужую квитанцию и не начисляет
// второй раз.

async function callWorker(path, payload) {
    const user = auth && auth.currentUser;
    if (!user) throw new Error("not_authenticated");
    const idToken = await user.getIdToken();
    const response = await fetch(AUTH_WORKER_URL + path, {
        method: "POST",
        headers: { "Content-Type": "application/json",
                   "Authorization": "Bearer " + idToken },
        body: JSON.stringify(payload)
    });
    let data = null;
    try { data = await response.json(); } catch (e) {}
    if (!response.ok || !data || data.ok !== true) {
        const err = new Error((data && data.error) || ("http_" + response.status));
        err.httpStatus = response.status;
        throw err;
    }
    return data;
}

function workerErrorCode(error) {
    return error && error.message ? String(error.message) : "unknown_error";
}

function isRatedJoinTerminalError(error) {
    return RATED_JOIN_TERMINAL_ERRORS.indexOf(workerErrorCode(error)) !== -1;
}

// /rated/settle имеет другой набор смысловых ошибок, чем /rated/join.
// В частности match_not_finished — временное состояние: локальный listener
// мог уже увидеть winner, а серверный read Worker ещё попасть в окно до
// финального status=finished. Поэтому один общий error.terminal для обоих
// маршрутов здесь опасен.
const SETTLEMENT_TERMINAL_ERRORS = [
    "room_not_found", "not_a_player", "stale_generation",
    "match_not_registered", "match_not_rated", "not_a_participant",
    "card_mismatch", "receipt_mismatch", "nothing_to_resume",
    "legacy_receipt_room_missing"
];

function isSettlementTerminalError(error) {
    return SETTLEMENT_TERMINAL_ERRORS.indexOf(workerErrorCode(error)) !== -1;
}

// Регистрация рейтинговой партии. Вызывается там же, где раньше стоял
// прежний ensureMyRatingSnapshot: партия активна, вызывающий — игрок, цвета после
// реванша уже пересчитаны.
//
// Состояние привязано к поколению, поэтому повторные срабатывания room
// listener не порождают новых запросов, а «Без рейтинга» от прошлой
// партии не протекает в реванш.
function resetSettlementDisplay() { lastSettlementDisplay = null; }

// Партия завершена: повторять регистрацию больше незачем.
function roomOutcomeFinished(state) {
    if (!state) return true;
    return state.status === "finished" || !!state.winner;
}

function requestRatedJoin(room) {
    if (!canUseFirebase() || !roomCode || !room) return;
    if (isSpectator) return;

    const key = ratedGenerationKey(roomCode, room.matchNumber, room.createdAt);
    const st = ratedJoinState[key] || { phase: "idle", attempts: 0, matchId: null };
    if (st.phase === "inFlight" || st.phase === "retryWait"
        || st.phase === "success" || st.phase === "terminalFailed") return;

    // Полный ratingsAtStart сам по себе НЕ доказывает регистрацию Worker:
    // cached v193 тоже умеет записывать снимок. Авторитетный shortcut —
    // только серверный ratedMatchId + обе стороны снимка.
    const roomMatchId = registeredMatchIdForState(room, roomCode);
    if (roomMatchId) {
        ratedJoinState[key] = { phase: "success", attempts: st.attempts, matchId: roomMatchId };
        return;
    }

    st.phase = "inFlight";
    ratedJoinState[key] = st;
    const codeAtStart = roomCode;

    callWorker("/rated/join", { roomCode: codeAtStart })
        .then(function (data) {
            ratedJoinState[key] = {
                phase: "success",
                attempts: st.attempts,
                matchId: (data && typeof data.matchId === "string") ? data.matchId : roomMatchId
            };
            renderPlayerPanels();
        })
        .catch(function (error) {
            const attempts = st.attempts + 1;
            // «Без рейтинга» — ТОЛЬКО смысловой отказ. Временные сбои
            // повторяются, пока то же поколение комнаты живо: счётчик
            // попыток больше не переводит партию в terminalFailed.
            if (isRatedJoinTerminalError(error)) {
                ratedJoinState[key] = { phase: "terminalFailed", attempts: attempts, matchId: null };
                renderPlayerPanels();
                return;
            }
            ratedJoinState[key] = { phase: "retryWait", attempts: attempts, matchId: st.matchId || null };
            const wait = (attempts - 1 < RATED_JOIN_BACKOFF_MS.length)
                ? RATED_JOIN_BACKOFF_MS[attempts - 1]
                : RATED_JOIN_BACKOFF_MAX_MS;
            setTimeout(function () {
                const st2 = ratedJoinState[key];
                if (!st2 || st2.phase !== "retryWait") return;

                const sameGeneration = roomCode === codeAtStart && currentState
                    && ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) === key;
                if (!sameGeneration) return;

                // После конца партии Worker уже не имеет права публиковать
                // ratedMatchId/ratingsAtStart. Если мы были именно в retryWait,
                // регистрационное окно закрыто окончательно — не оставляем ⭐…
                // висеть вечно.
                if (roomOutcomeFinished(currentState)) {
                    ratedJoinState[key] = {
                        phase: "terminalFailed",
                        attempts: attempts,
                        matchId: st2.matchId || null
                    };
                    renderPlayerPanels();
                    return;
                }

                ratedJoinState[key] = {
                    phase: "idle",
                    attempts: attempts,
                    matchId: st2.matchId || null
                };
                requestRatedJoin(currentState);
            }, wait);
        });
}

// ЗАМОРОЖЕННЫЙ КОНТЕКСТ.
//
// Пока запрос летит, может начаться реванш: matchNumber увеличится,
// стороны поменяются, ratingsAtStart обнулится. Считать before и after
// по текущему состоянию нельзя — получится правдоподобное, но неверное
// число. Поэтому контекст завершённого поколения замораживается в момент
// ЗАПУСКА расчёта.
function freezeSettlementContext() {
    if (!currentState || !roomCode) return null;
    const rs = currentState.ratingsAtStart || {};
    const matchNumber = (typeof currentState.matchNumber === "number") ? currentState.matchNumber : 0;
    const createdAt = (typeof currentState.createdAt === "number") ? currentState.createdAt : null;
    const key = ratedGenerationKey(roomCode, matchNumber, createdAt);
    const joinState = ratedJoinState[key] || null;

    // ratedMatchId приходит из комнаты после server join. Для узкого окна,
    // когда HTTP-ответ join уже пришёл, а room-listener ещё не принёс pointer,
    // берём matchId из generation-scoped join state. Канонический fallback
    // нужен для восстановления после удаления комнаты.
    const expectedMatchId = (createdAt !== null)
        ? buildEloMatchId(roomCode, createdAt, matchNumber) : null;
    let ratedMatchId = (typeof currentState.ratedMatchId === "string"
        && currentState.ratedMatchId === expectedMatchId)
        ? currentState.ratedMatchId
        : (joinState && typeof joinState.matchId === "string" ? joinState.matchId : null);
    if (!ratedMatchId) ratedMatchId = expectedMatchId;

    const players = currentState.players || {};
    const lightId = players.light && players.light.id;
    const darkId = players.dark && players.dark.id;
    // Для отображения дельты цвет фиксируем по UID из самой комнаты, а не
    // доверяем локальному myColor. Исторически myColor уже расходился после
    // реваншей; серверный settlement от этого не страдал, но UI мог бы
    // приписать игроку дельту соперника.
    let frozenMyColor = null;
    if (lightId === myTelegramId) frozenMyColor = "light";
    else if (darkId === myTelegramId) frozenMyColor = "dark";
    if (!frozenMyColor) return null;

    return {
        roomCode: roomCode,
        matchNumber: matchNumber,
        ratedMatchId: ratedMatchId,
        createdAt: createdAt,
        myUid: myTelegramId,
        myColor: frozenMyColor,
        playerIds: { light: lightId, dark: darkId },
        ratingsAtStart: { light: rs.light, dark: rs.dark }
    };
}

// Состояние расчёта, привязанное к поколению.
//   idle / inFlight / retryWait / completed / terminalFailed
//
// completed означает именно УСПЕШНЫЙ ответ Worker (в том числе
// ratingConfirmed:false для валидной legacy receipt). terminalFailed —
// смысловой отказ, который повтором не исправить. Временные сбои никогда
// сами по себе не разрешают разрушить finished-room: outcome нужен Worker.
const SETTLE_BACKOFF_MS = [1000, 2000, 5000, 10000, 20000];
const SETTLE_BACKOFF_MAX_MS = 30000;
let settleState = {};          // ключ поколения -> { phase, attempts }
let lastSettlementDisplay = null;

function getSettlePhase(key) {
    const st = settleState[key];
    return st ? st.phase : "idle";
}

function isSettlementSettled(key) {
    return getSettlePhase(key) === "completed";
}

function isSettlementTerminalFailed(key) {
    return getSettlePhase(key) === "terminalFailed";
}

function finishOnlineResultMarkerForGeneration(key) {
    // Settlement callbacks are asynchronous. A late response from match N
    // must never consume the UI-marker of an already-finished match N+1.
    // Only touch the global marker while the visible room is still the exact
    // generation that this settlement belongs to.
    if (!currentState || !roomCode) return;
    const currentKey = ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt);
    if (currentKey !== key) return;
    if (statsInFlightOnlineMarker !== null) {
        statsRecordedForRoom = statsInFlightOnlineMarker;
        statsInFlightOnlineMarker = null;
    }
}

// Единственная проверка перед ЛЮБОЙ destructive mutation завершённой
// online-партии (rematch reset / room cleanup). Если поколение было
// зарегистрировано Worker, стирать outcome можно только после completed
// settlement. Терминальный settle-error НЕ считается разрешением на удаление.
function isFinishedGenerationSafeToDestroy() {
    if (!isOnlineGame || isSpectator || !currentState || !currentState.winner || !roomCode) return true;
    const key = ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt);
    if (getRatedJoinPhase(key) !== "success") {
        const registered = registeredMatchIdForState(currentState, roomCode);
        if (registered) {
            ratedJoinState[key] = { phase: "success", attempts: 0, matchId: registered };
        }
    }
    if (getRatedJoinPhase(key) !== "success") return true;
    return isSettlementSettled(key);
}

// Расчёт партии. Идемпотентен на сервере, но лишние вызовы не шлём.
function requestSettlement() {
    if (!canUseFirebase() || isSpectator) return;
    const ctx = freezeSettlementContext();
    if (!ctx || !ctx.ratedMatchId) return;
    const key = ratedGenerationKey(ctx.roomCode, ctx.matchNumber, ctx.createdAt);
    const phase = getSettlePhase(key);
    if (phase === "inFlight" || phase === "retryWait") return;
    if (phase === "completed" || phase === "terminalFailed") {
        finishOnlineResultMarkerForGeneration(key);
        return;
    }

    // Локальный join-state может потеряться после reload или отстать от room-listener.
    // Канонический pointer + полный snapshot в самой комнате — достаточное
    // доказательство, что Worker уже зарегистрировал это поколение.
    if (getRatedJoinPhase(key) !== "success") {
        const registered = registeredMatchIdForState(currentState, roomCode);
        if (!registered) return;
        ratedJoinState[key] = { phase: "success", attempts: 0, matchId: registered };
        ctx.ratedMatchId = registered;
    }

    const st = settleState[key] || { phase: "idle", attempts: 0 };
    st.phase = "inFlight";
    settleState[key] = st;

    callWorker("/rated/settle", {
        roomCode: ctx.roomCode,
        matchId: ctx.ratedMatchId
    })
        .then(function (data) {
            settleState[key] = { phase: "completed", attempts: st.attempts };
            // Помечаем именно текущий UI-marker как законченный ДО повторного
            // renderEndGameModal(), иначе applySettlementResult() вызовет
            // рендер, тот снова выставит in-flight marker, а requestSettlement
            // уже молча выйдет по phase=completed.
            finishOnlineResultMarkerForGeneration(key);
            applySettlementResult(ctx, data);
        })
        .catch(function (error) {
            const attempts = st.attempts + 1;

            if (isSettlementTerminalError(error)) {
                settleState[key] = { phase: "terminalFailed", attempts: attempts };
                finishOnlineResultMarkerForGeneration(key);
                applySettlementResult(ctx, null);
                return;
            }

            settleState[key] = { phase: "retryWait", attempts: attempts };
            statsInFlightOnlineMarker = null;
            const wait = (attempts - 1 < SETTLE_BACKOFF_MS.length)
                ? SETTLE_BACKOFF_MS[attempts - 1] : SETTLE_BACKOFF_MAX_MS;
            setTimeout(function () {
                const cur = settleState[key];
                if (!cur || cur.phase !== "retryWait") return;

                const sameGeneration = currentState && roomCode
                    && ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) === key;
                if (!sameGeneration) return;

                settleState[key] = { phase: "idle", attempts: attempts };
                requestSettlement();
            }, wait);
        });
}


// Отрисовка изменения рейтинга. Ответ прошлого поколения интерфейс новой
// партии не трогает.
function applySettlementResult(ctx, data) {
    if (!currentState) return;
    const currentKey = ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt);
    if (currentKey !== ratedGenerationKey(ctx.roomCode, ctx.matchNumber, ctx.createdAt)) return;

    // ratingConfirmed:false означает, что квитанцию писал не сервер. Под
    // BRIDGE-A такую квитанцию мог создать кто угодно, и статистика могла
    // не измениться вовсе. Выдавать это за подтверждённое изменение нельзя.
    const before = ctx.ratingsAtStart[ctx.myColor];
    if (!data || data.ratingConfirmed !== true || !data.deltas) {
        lastSettlementDisplay = {
            confirmed: false,
            before: (typeof before === "number") ? before : null
        };
        renderEndGameModal();
        return;
    }
    const delta = data.deltas[ctx.myColor];
    if (typeof before !== "number" || typeof delta !== "number") {
        lastSettlementDisplay = { confirmed: false };
        renderEndGameModal();
        return;
    }
    lastSettlementDisplay = { confirmed: true, before: before,
                              after: before + delta, delta: delta };
    renderEndGameModal();
}


function recordGameResult(onlineMarker) {
    if (isSpectator) return;
    if (!canUseFirebase()) { statsInFlightForRoom = null; statsInFlightOnlineMarker = null; return; }
    if (isBotGame && localOnlyBotGame) { statsInFlightForRoom = null; return; } // Зритель никогда не участвует в статистике
    // В онлайн-игре НЕ пишем статистику по локальному оптимистичному
    // состоянию: currentState.winner мог быть выставлен из ещё не
    // подтверждённого хода, а Firebase-транзакция способна его отклонить —
    // тогда в stats попал бы результат несуществующей партии. Такая же
    // защита стоит на стороне сервера: квитанция создаётся однократно.
    // In-flight маркер снимаем сами: запрос не отправлен, и следующий
    // render — уже по подтверждённому состоянию — должен попробовать снова.
    if (isOnlineGame && isLocalStateOptimistic) {
        statsInFlightOnlineMarker = null;
        return;
    }
    if (!isOnlineGame && !isBotGame) return; // Если это не онлайн и не бот — выходим
    if (!currentState || !currentState.winner) return;

    // ELO-ПАРТИЯ: если в комнате есть ПОЛНЫЙ снимок ratingsAtStart, значит оба
    // клиента на новом коде и результат пишется ТОЛЬКО через атомарный receipt
    // (рейтинг + wins/losses/draws одним update). Старый путь ниже при этом не
    // выполняется — иначе те же wins прибавились бы дважды. Ничья тоже идёт
    // сюда, поэтому проверка на "draw" стоит НИЖЕ этой ветки.
    if (!isBotGame) {
        if (isRatedMatchReadyForSettlement()) {
            requestSettlement();
            return;
        }
        // C1 online никогда не пишет stats напрямую. Если server pointer /
        // ratings snapshot ещё не приехали (или регистрация не состоялась),
        // освобождаем UI-marker и ждём следующего room snapshot. Это важно и
        // для ничьей: ранний return на draw раньше оставлял marker навечно,
        // поэтому поздний ratedMatchId уже не запускал settlement.
        statsInFlightOnlineMarker = null;
        return;
    }

    if (currentState.winner === "draw") return;
    if (!myTelegramId) return;
    // Лёгкий — тренировочный режим, полностью исключён из публичной статистики.
    if (isBotGame && botDifficulty === "easy") return;

    // Бот: прежнее поведение без изменений — в bot-партии players в комнате
    // нет вовсе, и любая UID-логика тут неприменима.
    // Online: результат берётся по UID участника (см. resolveMyOnlineResult).
    let didIWin;
    if (isBotGame) {
        didIWin = currentState.winner === myColor;
    } else {
        const myResult = resolveMyOnlineResult(currentState);
        // null = я не участник этой комнаты. Ничего не записываем и снимаем
        // in-flight маркер, чтобы не блокировать возможную повторную попытку.
        if (myResult === null) {
            statsInFlightOnlineMarker = null;
            return;
        }
        didIWin = (myResult === "win");
    }

    if (isBotGame) {
        // Medium/Hard считаются раздельно в byLevel, но верхнеуровневые
        // wins/losses продолжают обновляться параллельно — это сохраняет
        // существующий leaderboard (сортировка идёт именно по ним) без
        // единой правки в коде чтения. Старые накопленные результаты (до
        // появления уровней) остаются как есть — честно разделить их между
        // Medium/Hard задним числом невозможно, и мы не пытаемся это сделать.
        // Идемпотентность от ЗАДВОЕНИЯ обеспечивает САМА транзакция
        // (recentMatchIds). Но statsRecordedForRoom/statsInFlightForRoom
        // здесь — не просто UI-оптимизация: раньше statsRecordedForRoom
        // ставился ДО результата записи, и network-сбой без второго
        // устройства означал НАВСЕГДА потерянный +1 (recentMatchIds спасает
        // от ЗАДВОЕНИЯ, но не от ПОТЕРИ). Теперь statsRecordedForRoom
        // ставится только по факту подтверждённого исхода (успех ИЛИ
        // committed:false из-за уже известного matchId — оба легитимны),
        // а reject оставляет возможность повтора на следующем render.
        const level = (botDifficulty === "medium") ? "medium" : "hard";
        const thisMatchId = currentBotMatchId;
        recordBotGameResultIdempotent(thisMatchId, didIWin, level).then(function () {
            statsRecordedForRoom = thisMatchId;
            statsInFlightForRoom = null;
        }).catch(function (error) {
            console.error("Stats write failed:", error);
            // НЕ помечаем как записанную — statsInFlightForRoom освобождаем,
            // чтобы следующий renderEndGameModal() смог повторить попытку.
            statsInFlightForRoom = null;
        });
        return;
    }

}

function updateSelectionDom(oldSel, newSel) {
    for (const key in pieceElements) {
        pieceElements[key].classList.remove("selected");
    }
    if (newSel) {
        const newEl = pieceElements[newSel.row + "_" + newSel.col];
        if (newEl) newEl.classList.add("selected");
    }
    showMoveHints(newSel);
    resetMustCaptureHintTimer();
}

function handleClick(row, col) {
    if (!currentState || currentState.winner) return;
    const state = currentState;

    // Если мы зритель, вообще запрещаем клики по доске
    if (isSpectator) return; 

    if (isOnlineGame && state.turn !== myColor) return;
    // БЛОКИРОВКА ХОДА БЕЗ СВЯЗИ (v178, Фаза 1).
    // Если Firebase ТОЧНО сообщает, что соединения нет, online-ход не
    // выполняется вовсе: не применяется оптимистичное состояние, не двигаются
    // moveCount/lastSeenMoveCount, не создаётся транзакция и не заводится
    // ожидание подтверждения. Причина: собственный ход без сети создавал
    // незавершённую транзакцию на ВЕСЬ узел комнаты (вместе с presence обоих
    // игроков) и оптимистичное состояние, которого на сервере никогда не было.
    // Для шашек в реальном времени офлайн-ход бесполезен — соперник всё равно
    // не увидит его до восстановления связи. Статус «Нет связи…» уже показан
    // существующим индикатором синхронизации.
    if (isOnlineGame && !isFirebaseConnected) return;
    // Пока отправленный ход не получил ответа сервера, второй ход запрещён.
    // Без этого возникало бы окно: восстановление откатило доску к серверному
    // состоянию, игрок сходил заново, а следом «оживала» первая транзакция.
    // Порчи данных и так не будет (attemptMove внутри транзакции заново сверяет
    // ход с СЕРВЕРНЫМИ turn и mustContinueFrom и отменяется), но игрок увидел бы
    // необъяснимый прыжок доски. Проще и честнее не пускать второй ход вовсе:
    // ожидание всё равно снимается ответом сервера или восстановлением.
    if (isOnlineGame && isMoveAwaitingConfirmation()) return;
    if (isBotGame && state.turn === botColor) return; 

    const selectableColor = isOnlineGame ? myColor : (isBotGame ? myColor : state.turn);
    const pieceHere = pieceAt(state.pieces, row, col);

    if (pieceHere && pieceHere.color === state.turn && pieceHere.color === selectableColor) {
        if (state.mustContinueFrom) return;
        if (hasMandatoryCapture(state.pieces, state.turn) && !canCaptureAt(state.pieces, row, col, state.turn, !!pieceHere.king)) return;

        const oldSel = selectedFrom;
        let newSel;
        if (selectedFrom && selectedFrom.row === row && selectedFrom.col === col) {
            newSel = null;
        } else {
            newSel = { row: row, col: col };
        }
        updateSelectionDom(oldSel, newSel);
        selectedFrom = newSel;
        return;
    }

    if (selectedFrom) {
        if (isBotGame && ownerSessionAttached) {
            attemptOwnerHumanMove(selectedFrom.row, selectedFrom.col, row, col);
        } else {
            performMove(selectedFrom.row, selectedFrom.col, row, col);
        }
    }
}

let pendingSyncChain = Promise.resolve();

// silent === true: вызов из автоматического восстановления. Тогда ошибка НЕ
// показывает модалку (спокойный статус под доской вместо испуга), а
// пробрасывается наверх, чтобы вызывающий показал «Повторить».
// Поведение существующих вызовов без аргумента не меняется.
function forceResyncFromServer(silent) {
    if (!roomCode) return Promise.resolve();
    return database.ref("rooms/" + roomCode).once("value").then(function(snapshot) {
        const room = snapshot.val();
        if (!room || !room.pieces) return;
        const newState = {
            pieces: room.pieces,
            turn: room.turn,
            mustContinueFrom: room.mustContinueFrom || null,
            capturedDark: room.capturedDark || 0,
            capturedLight: room.capturedLight || 0,
            moveCount: room.moveCount || 0,
            matchNumber: room.matchNumber || 0,
            ratedMatchId: (typeof room.ratedMatchId === "string") ? room.ratedMatchId : null,
            // ELO: снимок рейтингов на начало партии и стабильная метка
            // создания комнаты. Оба поля только ЧИТАЮТСЯ здесь — снимок
            // публикует сервер при регистрации, createdAt ставится один раз при
            // создании комнаты и не меняется ни при reconnect, ни при реванше.
            ratingsAtStart: room.ratingsAtStart || null,
            createdAt: (typeof room.createdAt === "number") ? room.createdAt : null,
            status: room.status || null,
            kingOnlyStreak: room.kingOnlyStreak || 0,
            noProgressStreak: room.noProgressStreak || 0,
            positionHistory: room.positionHistory || [],
            longRoadAttacker: room.longRoadAttacker || null,
            longRoadStreak: room.longRoadStreak || 0,
            lastMove: room.lastMove || null,
            moveType: room.moveType || null,
            lastMovePath: room.lastMovePath || null,
            lastCapturedSquares: room.lastCapturedSquares || null,
            pendingRemovals: room.pendingRemovals || null,
            players: room.players || null,
            presence: room.presence || null,
            spectators: room.spectators || null,
            timeControlSeconds: room.timeControlSeconds || 0,
            turnStartedAt: room.turnStartedAt || null,
            winner: room.winner || null,
            winReason: room.winReason || null,
            // v180: технический результат читается ТОЛЬКО как признак уже
            // принятого решения — второй pipeline на нём не строится.
            result: room.result || null,
            rematchProposal: room.rematchProposal || null,
            drawProposal: room.drawProposal || null
        };
        
        // ЗАЩИТА ОТ УСТАРЕВШИХ ОТВЕТОВ: Если сервер вернул состояние, которое 
        // МЕНЬШЕ того, что мы уже знаем (например, мы уже получили ход 6, а сервер 
        // с опозданием вернул ход 5) — полностью игнорируем этот ответ.
        if (newState.moveCount < lastSeenMoveCount) {
            // Если мы НЕ в оптимистичном состоянии — это реальное устаревшее эхо, игнорируем.
            if (!isLocalStateOptimistic) {
                console.log("Force resync ignored stale state.");
                return;
            }
            // Если мы В оптимистичном состоянии, но сервер вернул старый ход —
            // значит наш ход провалился. Мы ОБЯЗАНЫ откатиться назад.
            console.log("Force resync rolling back optimistic move...");
        }

        currentState = newState;
        isLocalStateOptimistic = false; // Откатились к серверной реальности, сбрасываем флаг
        
        // ОБЯЗАТЕЛЬНО обновляем lastSeenMoveCount, чтобы основной слушатель 
        // не сбился и не заблокировал будущие обновления.
        lastSeenMoveCount = currentState.moveCount;
        
        if (currentState.turn === myColor && currentState.mustContinueFrom) {
            selectedFrom = { row: currentState.mustContinueFrom.row, col: currentState.mustContinueFrom.col };
        } else {
            selectedFrom = null;
        }
        lastRenderedSignature = computeGameSignature(currentState);
        renderBoard();
    }).catch(function(err) {
        console.error("Resync error", err);
        if (silent) throw err;
        showInfoModal(t("err_resync_failed"), false);
    });
}

function performMove(fromRow, fromCol, toRow, toCol) {
    if (isOnlineGame && !canUseFirebase()) { showInfoModal(t("err_auth_required"), false); return; }
    if (isOnlineGame) {
        const optimisticResult = attemptMove(currentState, fromRow, fromCol, toRow, toCol, myColor);
        if (!optimisticResult) return;

        const movingPieceWasKing = !!(currentState.pieces[fromRow + "_" + fromCol] && currentState.pieces[fromRow + "_" + fromCol].king);

        const drawState = computeNextDrawState(currentState, optimisticResult, movingPieceWasKing);

        currentState.pieces = optimisticResult.pieces;
        currentState.turn = optimisticResult.turn;
        currentState.mustContinueFrom = optimisticResult.mustContinueFrom;
        currentState.capturedDark = optimisticResult.capturedDark;
        currentState.capturedLight = optimisticResult.capturedLight;
        currentState.moveCount = optimisticResult.moveCount;
        currentState.moveType = optimisticResult.moveType;
        currentState.lastMove = optimisticResult.lastMove;
        currentState.lastMovePath = optimisticResult.lastMovePath;
        currentState.lastCapturedSquares = optimisticResult.lastCapturedSquares;
        currentState.pendingRemovals = optimisticResult.pendingRemovals;
        currentState.kingOnlyStreak = drawState.kingOnlyStreak;
        currentState.noProgressStreak = drawState.noProgressStreak;
        currentState.positionHistory = drawState.positionHistory;
        currentState.longRoadAttacker = drawState.longRoadAttacker;
        currentState.longRoadStreak = drawState.longRoadStreak;

        if (optimisticResult.mustContinueFrom === null && currentState.timeControlSeconds > 0) {
            // CLOCK SAFETY. Оптимистичная метка обязана быть в ТОМ ЖЕ базисе,
            // что и серверная, которую пришлёт слушатель.
            //
            // STARTUP RACE. Пока .info/serverTimeOffset не получен,
            // getEstimatedServerNow() равен часам телефона, и метка вышла бы
            // недостоверной. Дальше события складывались так: смещение
            // приходит РАНЬШЕ серверного снимка комнаты, checkTimeout
            // разблокируется и сравнивает серверное «сейчас» с локальной
            // меткой. При телефоне, отстающем на 10 минут, это даёт elapsed
            // около 600 секунд и ложное поражение по времени.
            //
            // Поэтому недостоверную метку НЕ СТАВИМ ВОВСЕ. Настоящее значение
            // принесёт слушатель комнаты: транзакция пишет туда
            // ServerValue.TIMESTAMP, а не эту локальную величину.
            // До его прихода обе читающие функции выходят по собственной
            // охране !currentState.turnStartedAt — таймер пуст, таймаут не
            // срабатывает. Это доли секунды после подключения.
            //
            // Сам ход НЕ блокируем: он обратим, а поражение по времени — нет.
            currentState.turnStartedAt = serverTimeOffsetReady
                ? getEstimatedServerNow()
                : null;
        }

        if (optimisticResult.winner) {
            currentState.winner = optimisticResult.winner;
            currentState.winReason = optimisticResult.winReason;
        } else if (drawState.drawReason) {
            currentState.winner = "draw";
            currentState.winReason = drawState.drawReason;
        }
        selectedFrom = optimisticResult.mustContinueFrom
            ? { row: optimisticResult.mustContinueFrom.row, col: optimisticResult.mustContinueFrom.col }
            : null;

        lastSeenMoveCount = currentState.moveCount;
        lastRenderedSignature = computeGameSignature(currentState);
        isLocalStateOptimistic = true; // Ставим флаг, что мы ушли в оптимистичное состояние
        // Ход ушёл на сервер и ждёт ответа: с этой секунды показываем
        // «Отправляю ход…» вместо молчащей доски.
        pendingMoveStartedAt = Date.now();
        syncRecoveryFailed = false;

        playSoundForMoveType(optimisticResult.moveType, movingPieceWasKing);
        renderBoard();

        pendingSyncChain = pendingSyncChain.then(function () {
            return database.ref("rooms/" + roomCode).transaction(function (room) {
                // v180 ГОНКА ОБЫЧНОГО И ТЕХНИЧЕСКОГО ИСХОДА. Если технический
                // результат уже создан, обычное завершение ОТМЕНЯЕТСЯ: одна партия —
                // ровно один исход. Проверка стоит первой строкой каждой whole-room
                // транзакции, а транзакция перечитывает СЕРВЕРНЫЕ данные при гонке,
                // поэтому подмена уже записанного результата невозможна.
                if (!room || !room.pieces || room.winner || room.result) return;

                const state = {
                    pieces: room.pieces,
                    turn: room.turn,
                    mustContinueFrom: room.mustContinueFrom || null,
                    capturedDark: room.capturedDark || 0,
                    capturedLight: room.capturedLight || 0,
                    moveCount: room.moveCount || 0,
                    lastMovePath: room.lastMovePath || null,
                    lastCapturedSquares: room.lastCapturedSquares || null,
                    pendingRemovals: room.pendingRemovals || null,
                    kingOnlyStreak: room.kingOnlyStreak || 0,
                    noProgressStreak: room.noProgressStreak || 0,
                    positionHistory: room.positionHistory || [],
                    longRoadAttacker: room.longRoadAttacker || null,
                    longRoadStreak: room.longRoadStreak || 0,
                };

                const movingPieceWasKing = !!(room.pieces[fromRow + "_" + fromCol] && room.pieces[fromRow + "_" + fromCol].king);

                const result = attemptMove(state, fromRow, fromCol, toRow, toCol, myColor);
                if (!result) return;

                const drawState = computeNextDrawState(state, result, movingPieceWasKing);

                const newRoom = {};
                for (const key in room) newRoom[key] = room[key];
                newRoom.pieces = result.pieces;
                newRoom.turn = result.turn;
                newRoom.mustContinueFrom = result.mustContinueFrom;
                newRoom.capturedDark = result.capturedDark;
                newRoom.capturedLight = result.capturedLight;
                newRoom.moveCount = result.moveCount;
                newRoom.moveType = result.moveType;
                newRoom.lastMove = result.lastMove;
                newRoom.lastMovePath = result.lastMovePath;
                newRoom.lastCapturedSquares = result.lastCapturedSquares;
                newRoom.pendingRemovals = result.pendingRemovals;
                newRoom.kingOnlyStreak = drawState.kingOnlyStreak;
                newRoom.noProgressStreak = drawState.noProgressStreak;
                newRoom.positionHistory = drawState.positionHistory;
                newRoom.longRoadAttacker = drawState.longRoadAttacker;
                newRoom.longRoadStreak = drawState.longRoadStreak;
                
                if (result.mustContinueFrom === null) newRoom.turnStartedAt = firebase.database.ServerValue.TIMESTAMP;
                
                if (result.winner) {
                    newRoom.winner = result.winner;
                    newRoom.winReason = result.winReason;
                    newRoom.status = "finished";
                } else if (drawState.drawReason) {
                    newRoom.winner = "draw";
                    newRoom.winReason = drawState.drawReason;
                    newRoom.status = "finished";
                }
                return newRoom;
            }).then(function(result) {
                // Ответ сервера получен (принят или отклонён) — ожидание
                // закончилось в любом случае, доска снова доступна.
                pendingMoveStartedAt = null;
                if (!result.committed) {
                    console.log("Move rejected by server, resyncing...");
                    forceResyncFromServer();
                }
            });
        }).catch(function () {
            pendingMoveStartedAt = null;
            forceResyncFromServer();
        });
    } else {
        const result = attemptMove(currentState, fromRow, fromCol, toRow, toCol, currentState.turn);
        if (result) {
            const movingPieceWasKing = !!(currentState.pieces[fromRow + "_" + fromCol] && currentState.pieces[fromRow + "_" + fromCol].king);
            const drawState = computeNextDrawState(currentState, result, movingPieceWasKing);
            currentState.pieces = result.pieces;
            currentState.turn = result.turn;
            currentState.mustContinueFrom = result.mustContinueFrom;
            currentState.capturedDark = result.capturedDark;
            currentState.capturedLight = result.capturedLight;
            currentState.moveCount = result.moveCount;
            currentState.moveType = result.moveType;
            currentState.lastMove = result.lastMove;
            currentState.lastMovePath = result.lastMovePath;
            currentState.lastCapturedSquares = result.lastCapturedSquares;
            currentState.pendingRemovals = result.pendingRemovals;
            currentState.kingOnlyStreak = drawState.kingOnlyStreak;
            currentState.noProgressStreak = drawState.noProgressStreak;
            currentState.positionHistory = drawState.positionHistory;
            currentState.longRoadAttacker = drawState.longRoadAttacker;
            currentState.longRoadStreak = drawState.longRoadStreak;
            if (result.winner) {
                currentState.winner = result.winner;
                currentState.winReason = result.winReason;
            } else if (drawState.drawReason) {
                currentState.winner = "draw";
                currentState.winReason = drawState.drawReason;
            }
            selectedFrom = result.mustContinueFrom ? { row: result.mustContinueFrom.row, col: result.mustContinueFrom.col } : null;
            playSoundForMoveType(result.moveType, movingPieceWasKing);
            renderBoard();
            if (isBotGame && !localOnlyBotGame) syncBotStateToFirebase();
        }
    }
}

// ===== ЗАПУСК / ПЕРЕЗАПУСК ИГРЫ =====

function computeGameSignature(state) {
    const winnerPart = state.winner || "";
    const winReasonPart = state.winReason || "";
    const playersPart = JSON.stringify(state.players || null);
    const rematchPart = JSON.stringify(state.rematchProposal || null);
    const drawPart = JSON.stringify(state.drawProposal || null);
    const turnStartedAtPart = state.turnStartedAt || 0;
    // C1: регистрация рейтинговой партии меняет только ratedMatchId /
    // ratingsAtStart. Если не включить их в подпись, room-listener сочтёт
    // серверный snapshot "тем же состоянием", отбросит рейтинг и панель
    // останется на ⭐… до первого хода.
    const matchNumberPart = (typeof state.matchNumber === "number") ? state.matchNumber : 0;
    const ratedMatchIdPart = state.ratedMatchId || "";
    const ratingsAtStartPart = JSON.stringify(state.ratingsAtStart || null);
    const statusPart = state.status || "";
    return state.moveCount + "_" + matchNumberPart + "_" + winnerPart + "_" + winReasonPart
        + "_" + playersPart + "_" + rematchPart + "_" + drawPart + "_" + turnStartedAtPart
        + "_" + ratedMatchIdPart + "_" + ratingsAtStartPart + "_" + statusPart;
}

function startOnlineGame() {
    isBotGame = false; 
    isOnlineGame = true;
    flipped = (myColor === "dark");
    lastSeenMoveCount = -1;
    isLocalStateOptimistic = false; // Сбрасываем флаг при новой игре
    selectedFrom = null;
    lastAnimatedMoveCount = null; // Новая партия — не анимируем "ход из ниоткуда"
    endGameShownForRoom = null;
    statsRecordedForRoom = null;
    statsInFlightOnlineMarker = null; // симметрично сбрасываем и in-flight
    resetSettlementDisplay();
    if (rematchWaitNote) rematchWaitNote.textContent = "";
    myWaitingRoomNoOpponent = false; // (v171) партия началась — фоновое waiting-исключение heartbeat больше не действует
    opponentAbsenceHandled = false;
    lastRenderedSignature = null;
    boardBuilt = false;
    pendingSyncChain = Promise.resolve();
    // Ожидание хода и состояние восстановления не должны протекать
    // в новую партию/реванш.
    pendingMoveStartedAt = null;
    syncRecoveryInFlight = false;
    syncRecoveryFailed = false;
    if (opponentGraceTimer) {
        clearTimeout(opponentGraceTimer);
        opponentGraceTimer = null;
    }
    if (mustCaptureHintTimer) {
        clearTimeout(mustCaptureHintTimer);
        mustCaptureHintTimer = null;
    }

    // ПОРЯДОК ВАЖЕН (v178): поколение подписки открывается ДО setupPresence().
    // Иначе setupPresence захватывал бы ещё СТАРЫЙ listenerGeneration, и
    // серверное подтверждение его записи presence отбрасывалось бы функцией
    // noteServerAck как относящееся к прошлой комнате. Доказательство свежести
    // тогда откладывалось бы до следующего heartbeat (до 4 секунд), а вместе
    // с ним — и переход статуса соперника из нейтрального в реальный.
    resetRoomFreshnessProof();
    setupPresence();
    
    // Показываем кнопки реакций только для онлайн-игр
    if (reactionsRow) reactionsRow.classList.remove("hidden");
    // btnBackBot видимость теперь полностью пересчитывается в renderBoard()
    // на каждом рендере (backButtonMode) — отдельный прямой toggle здесь
    // больше не нужен и был убран как источник избыточной сложности.

    if (roomListenerRef) roomListenerRef.off();
    // Новая подписка на комнату — прежние доказательства свежести больше не
    // действуют: они относились к другой комнате/другому listener'у.
    const myListenerGen = listenerGeneration;
    roomListenerRef = database.ref("rooms/" + roomCode);
    roomListenerRef.on("value", function (snapshot) {
        // Запоздалый колбэк уже отписанного listener'а не должен ничего
        // подтверждать для текущей комнаты.
        if (myListenerGen !== listenerGeneration) return;
        const room = snapshot.val();
        if (!room || !room.pieces) {
            // Если комната была удалена (соперник закрыл игру или отменил реванш)
            if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
            // Комнаты больше нет — отвязываемся от её presence ПОЛНОСТЬЮ.
            // detachMyPresence() и останавливает heartbeat, и отменяет ранее
            // взведённый onDisconnect (cancel() ничего не записывает, поэтому
            // сам создать удалённый путь не может). Иначе старый onDisconnect
            // при закрытии приложения воскрешал rooms/<code> в виде огрызка
            // {presence:{...}}. Дополнительно сбрасываем isOnlineGame/roomCode,
            // чтобы глобальный слушатель .info/connected при следующем
            // реконнекте не записал presence в уже удалённую комнату.
            detachMyPresence();
            isOnlineGame = false;
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            // Показываем сообщение, только если игра ещё не была завершена нормально, 
            // либо если мы ждали реванша. Если игра завершена и мы не ждём реванша — просто выходим.
            if (!currentState || !currentState.winner || currentState.rematchProposal) {
                showInfoModal("Соперник покинул игру.", false);
            }
            return;
        }

        const newState = {
            pieces: room.pieces,
            turn: room.turn,
            mustContinueFrom: room.mustContinueFrom || null,
            capturedDark: room.capturedDark || 0,
            capturedLight: room.capturedLight || 0,
            moveCount: room.moveCount || 0,
            matchNumber: room.matchNumber || 0,
            ratedMatchId: (typeof room.ratedMatchId === "string") ? room.ratedMatchId : null,
            // ELO: снимок рейтингов на начало партии и стабильная метка
            // создания комнаты. Оба поля только ЧИТАЮТСЯ здесь — снимок
            // публикует сервер при регистрации, createdAt ставится один раз при
            // создании комнаты и не меняется ни при reconnect, ни при реванше.
            ratingsAtStart: room.ratingsAtStart || null,
            createdAt: (typeof room.createdAt === "number") ? room.createdAt : null,
            status: room.status || null,
            kingOnlyStreak: room.kingOnlyStreak || 0,
            noProgressStreak: room.noProgressStreak || 0,
            positionHistory: room.positionHistory || [],
            longRoadAttacker: room.longRoadAttacker || null,
            longRoadStreak: room.longRoadStreak || 0,
            lastMove: room.lastMove || null,
            moveType: room.moveType || null,
            lastMovePath: room.lastMovePath || null,
            lastCapturedSquares: room.lastCapturedSquares || null,
            pendingRemovals: room.pendingRemovals || null,
            players: room.players || null,
            presence: room.presence || null,
            spectators: room.spectators || null,
            timeControlSeconds: room.timeControlSeconds || 0,
            turnStartedAt: room.turnStartedAt || null,
            winner: room.winner || null,
            winReason: room.winReason || null,
            // v180: технический результат читается ТОЛЬКО как признак уже
            // принятого решения — второй pipeline на нём не строится.
            result: room.result || null,
            rematchProposal: room.rematchProposal || null,
            drawProposal: room.drawProposal || null
        };

        // Снапшот комнаты засчитывается как доказательство свежести ТОЛЬКО
        // после подтверждённого сервером обмена (serverAckSinceConnect).
        // Причина: RTDB вызывает value-listener и на СОБСТВЕННУЮ локальную
        // запись (наш же presence-heartbeat после реконнекта), ещё до реальной
        // пересинхронизации комнаты с сервером. Такое локальное эхо само по
        // себе доказательством не является и разрешать удаление живой партии
        // не должно.
        if (serverAckSinceConnect && myListenerGen === listenerGeneration) {
            roomSnapshotSeenSinceConnect = true;
        }

        // Проверка реакции: если пришёл новый ts — запускаем анимацию
        if (room.reaction && room.reaction.ts && room.reaction.ts !== lastReactionTs) {
            lastReactionTs = room.reaction.ts;
            triggerEmojiBurst(room.reaction.emoji);
        }

        const newSignature = computeGameSignature(newState);

        const isMidGameStaleEcho = currentState && !currentState.winner && newState.moveCount < lastSeenMoveCount;
        if (isMidGameStaleEcho) {
            currentState.presence = newState.presence;
            updatePresenceOnly();
            return;
        }

        if (newSignature !== lastRenderedSignature) {
            const piecesBeforeThisUpdate = currentState ? currentState.pieces : null;

            if (currentState && currentState.winner && !newState.winner && newState.moveCount === 0) {
                resetSettlementDisplay();
                if (rematchWaitNote) rematchWaitNote.textContent = "";
                // Предложивший реванш получает N+1 через listener без
                // startOnlineGame(). Не переносим UI-маркеры результата N в
                // новое поколение; generation-scoped settleState продолжает
                // жить отдельно и поздний ответ N не сможет тронуть N+1.
                statsRecordedForRoom = null;
                statsInFlightOnlineMarker = null;
                if (newState.players && newState.players.light && newState.players.light.id === myTelegramId) {
                    myColor = "light";
                } else if (newState.players && newState.players.dark && newState.players.dark.id === myTelegramId) {
                    myColor = "dark";
                }
                flipped = (myColor === "dark");
                boardBuilt = false;
                // ВАЖНО: при реванше цвета меняются местами. Нужно заново
                // настроить "пульс присутствия" на новый цвет — иначе он
                // продолжит стучать в старую (уже не свою) ячейку presence,
                // и игрок будет ложно казаться офлайн в новой партии.
                setupPresence();
            }

            currentState = newState;

            if (currentState.turn === myColor && currentState.mustContinueFrom) {
                selectedFrom = { row: currentState.mustContinueFrom.row, col: currentState.mustContinueFrom.col };
            } else {
                selectedFrom = null;
            }

            if (lastSeenMoveCount >= 0 && currentState.moveCount > lastSeenMoveCount) {
                let movingPieceWasKing = false;
                if (piecesBeforeThisUpdate && currentState.lastMove) {
                    const fromKey = currentState.lastMove.from.row + "_" + currentState.lastMove.from.col;
                    movingPieceWasKing = !!(piecesBeforeThisUpdate[fromKey] && piecesBeforeThisUpdate[fromKey].king);
                }
                playSoundForMoveType(currentState.moveType, movingPieceWasKing);
            }
            lastSeenMoveCount = currentState.moveCount;
            lastRenderedSignature = newSignature;
            isLocalStateOptimistic = false; // Сервер прислал реальный апдейт, сбрасываем флаг
            renderBoard();
        } else if (currentState) {
            currentState.presence = newState.presence;
            updatePresenceOnly();
        }

        // ELO: доложить свою половину снимка рейтингов, если её ещё нет.
        // Вызывается ИМЕННО здесь, в конце слушателя, а не в startOnlineGame:
        // предложивший реванш получает новую партию через listener и
        // startOnlineGame() у него НЕ вызывается (см. комментарий в
        // renderEndGameModal), иначе его половина снимка никогда бы не
        // появилась. Здесь же myColor уже пересчитан после смены сторон.
        // Функция сама идемпотентна и молча выходит, если писать не нужно.
        requestRatedJoin(room);
    });
}

// ===== CROSS-DEVICE OWNER BOT SESSION (botSessions/<telegramId>) =====
// Общая для нескольких устройств одного Telegram ID сессия bot-игры.
// Firebase — source of truth: локальный currentState обновляется ТОЛЬКО
// через applyRemoteOwnerState() (слушатель), никогда не мутируется напрямую
// в обход transaction, пока ownerSessionAttached === true.

// --- Сериализация: RTDB не различает "пустой массив" и "отсутствует" —
// при обратном чтении пустой массив часто становится null. deserialize
// обязан явно превращать null обратно в [] для всех массивных полей. ---
function serializeOwnerBotState(state) {
    function orNull(v) { return (v === undefined) ? null : v; }
    return {
        pieces: orNull(state.pieces) || {},
        turn: orNull(state.turn),
        mustContinueFrom: orNull(state.mustContinueFrom),
        pendingRemovals: orNull(state.pendingRemovals) || [],
        capturedDark: orNull(state.capturedDark) || 0,
        capturedLight: orNull(state.capturedLight) || 0,
        moveCount: orNull(state.moveCount) || 0,
        moveType: orNull(state.moveType),
        lastMove: orNull(state.lastMove),
        lastMovePath: orNull(state.lastMovePath) || [],
        lastCapturedSquares: orNull(state.lastCapturedSquares) || [],
        kingOnlyStreak: orNull(state.kingOnlyStreak) || 0,
        noProgressStreak: orNull(state.noProgressStreak) || 0,
        positionHistory: orNull(state.positionHistory) || [],
        longRoadAttacker: orNull(state.longRoadAttacker),
        longRoadStreak: orNull(state.longRoadStreak) || 0,
        winner: orNull(state.winner),
        winReason: orNull(state.winReason),
        players: orNull(state.players) || {}
    };
}

function deserializeOwnerBotState(raw) {
    function arr(v) { return Array.isArray(v) ? v : []; }
    function num(v) { return (typeof v === "number") ? v : 0; }
    return {
        pieces: raw.pieces || {},
        turn: raw.turn || "light",
        mustContinueFrom: raw.mustContinueFrom || null,
        pendingRemovals: arr(raw.pendingRemovals),
        capturedDark: num(raw.capturedDark),
        capturedLight: num(raw.capturedLight),
        moveCount: num(raw.moveCount),
        moveType: raw.moveType || null,
        lastMove: raw.lastMove || null,
        lastMovePath: arr(raw.lastMovePath),
        lastCapturedSquares: arr(raw.lastCapturedSquares),
        kingOnlyStreak: num(raw.kingOnlyStreak),
        noProgressStreak: num(raw.noProgressStreak),
        positionHistory: arr(raw.positionHistory),
        longRoadAttacker: raw.longRoadAttacker || null,
        longRoadStreak: num(raw.longRoadStreak),
        winner: raw.winner || null,
        winReason: raw.winReason || null,
        players: raw.players || {}
    };
}

// --- Создание новой owner-сессии (первая партия серии или явная замена).
// ВАЖНО: через transaction, не set() — два устройства могут почти
// одновременно не увидеть активную сессию и оба попытаться создать свою
// (с разными matchId/spectateRoomCode). transaction гарантирует, что
// реально запишется только ОДНА — вторая попытка увидит уже записанную
// active-сессию и корректно abort'ится вместо слепой перезаписи. ---
function createOwnerBotSession(chosenDifficulty, initialGameState) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve({ committed: false, authRequired: true });
    const newBotColor = "dark";
    const newMyColor = "light";
    const matchId = "bot_" + myTelegramId + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const spectCode = generateRoomCode();
    const botName = "🤖 Компьютер";
    const humanName = myTelegramName || "Игрок";
    const stateWithCorrectPlayers = Object.assign({}, initialGameState, {
        players: newBotColor === "light" ? { light: { name: botName }, dark: { name: humanName } } : { light: { name: humanName }, dark: { name: botName } }
    });
    const candidateSession = {
        status: "active",
        matchId: matchId,
        revision: 0,
        spectateRoomCode: spectCode,
        botDifficulty: chosenDifficulty,
        botColor: newBotColor,
        myColor: newMyColor,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
        state: serializeOwnerBotState(stateWithCorrectPlayers),
        botMoveLock: null
    };

    return database.ref("botSessions/" + myTelegramId).transaction(function (existing) {
        // Разрешаем создание, если сейчас пусто ИЛИ прошлая сессия уже
        // завершена. Отказываем, только если там уже ЖИВАЯ active-сессия —
        // именно её нельзя перетирать вслепую.
        if (existing && existing.status === "active") return; // abort — кто-то уже успел
        return candidateSession;
    }).then(function (result) {
        // committed=true: РЕАЛЬНО мы создали (candidateSession записан).
        // committed=false: кто-то другой уже успел раньше — используем ТО,
        // что реально в Firebase (result.snapshot.val()), а не свой
        // локальный candidateSession, который не был записан.
        return { committed: result.committed, session: result.snapshot.val() };
    });
}

// --- Подписка на общую сессию. onUpdate вызывается при каждом новом
// значении, включая самое первое. ---
function attachToOwnerBotSession(onUpdate) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return null;
    const ref = database.ref("botSessions/" + myTelegramId);
    const listener = ref.on("value", function (snapshot) { onUpdate(snapshot.val()); });
    return { ref: ref, listener: listener };
}

function detachOwnerBotSessionListener(handle) {
    if (handle && handle.ref && handle.listener) handle.ref.off("value", handle.listener);
}

// --- Применение того, что реально пришло из Firebase, локально. Не пишет
// обратно, не вызывает triggerBotMove напрямую — решение "мой ли сейчас ход
// бота" принимает вызывающий код снаружи, глядя на уже применённое
// состояние (см. onOwnerSessionUpdate). ---
function applyRemoteOwnerState(session) {
    if (!session) return;
    const gameState = deserializeOwnerBotState(session.state);
    currentState = gameState;
    botDifficulty = session.botDifficulty;
    botColor = session.botColor;
    myColor = session.myColor;
    currentBotMatchId = session.matchId;
    ownerSessionRevision = session.revision;
    botSpectateRoomCode = session.spectateRoomCode;
}

// --- Human move через shared transaction. Callback ЧИСТ: использует только
// доказанно чистую attemptMove(), не мутирует ничего снаружи, не делает
// побочных эффектов — Firebase может вызвать его больше одного раза. ---
function applyHumanMoveViaSession(fromRow, fromCol, toRow, toCol) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve({ committed: false, authRequired: true });
    const expectedMatchId = currentBotMatchId;
    const expectedRevision = ownerSessionRevision;
    const myColorAtCallTime = myColor;

    return database.ref("botSessions/" + myTelegramId).transaction(function (session) {
        if (!session) return;
        if (session.status !== "active") return;
        if (session.matchId !== expectedMatchId) return;
        if (session.revision !== expectedRevision) return;

        const gameState = deserializeOwnerBotState(session.state);
        if (gameState.turn !== myColorAtCallTime) return;
        if (gameState.winner) return;

        const result = attemptMove(gameState, fromRow, fromCol, toRow, toCol, myColorAtCallTime);
        if (!result) return;

        const movingPieceWasKing = !!(gameState.pieces[fromRow + "_" + fromCol] && gameState.pieces[fromRow + "_" + fromCol].king);
        const drawState = computeNextDrawState(gameState, result, movingPieceWasKing);
        const newGameState = Object.assign({}, gameState, result, {
            kingOnlyStreak: drawState.kingOnlyStreak,
            noProgressStreak: drawState.noProgressStreak,
            positionHistory: drawState.positionHistory,
            longRoadAttacker: drawState.longRoadAttacker,
            longRoadStreak: drawState.longRoadStreak,
        });
        if (!result.winner && drawState.drawReason) {
            newGameState.winner = "draw";
            newGameState.winReason = drawState.drawReason;
        }

        const newSession = Object.assign({}, session);
        newSession.state = serializeOwnerBotState(newGameState);
        newSession.revision = session.revision + 1;
        newSession.status = newGameState.winner ? "finished" : "active";
        newSession.botMoveLock = null;
        newSession.updatedAt = firebase.database.ServerValue.TIMESTAMP;
        return newSession;
    });
}

// --- Сдача партии в synced-режиме — раньше этого пути не было вообще: сдача
// молча мутировала только локальный currentState и уходила через старый
// syncBotStateToFirebase(), полностью в обход общей сессии, так что второе
// устройство никогда бы не узнало о сдаче. Callback чист — использует
// только gameState.turn из свежего session, ничего внешнего. ---
function attemptOwnerSurrender() {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve({ committed: false, authRequired: true });
    const expectedMatchId = currentBotMatchId;
    const expectedRevision = ownerSessionRevision;

    return database.ref("botSessions/" + myTelegramId).transaction(function (session) {
        if (!session) return;
        if (session.status !== "active") return;
        if (session.matchId !== expectedMatchId) return;
        if (session.revision !== expectedRevision) return;

        const gameState = deserializeOwnerBotState(session.state);
        if (gameState.winner) return;

        const newGameState = Object.assign({}, gameState);
        newGameState.winner = gameState.turn === "light" ? "dark" : "light";
        newGameState.winReason = "resign";

        const newSession = Object.assign({}, session);
        newSession.state = serializeOwnerBotState(newGameState);
        newSession.revision = session.revision + 1;
        newSession.status = "finished";
        newSession.botMoveLock = null;
        newSession.updatedAt = firebase.database.ServerValue.TIMESTAMP;
        return newSession;
    });
}

// --- Bot move: lock через ВСЮ сессию (не только child) — устаревшее
// локальное представление отсеивается СРАЗУ, не тратя впустую Hard-поиск. ---
function tryAcquireBotMoveLock(expectedMatchId, expectedRevision, expectedBotColor) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve({ acquired: false, authRequired: true });
    return database.ref("botSessions/" + myTelegramId).transaction(function (session) {
        if (!session) return;
        if (session.status !== "active") return;
        if (session.matchId !== expectedMatchId) return;
        if (session.revision !== expectedRevision) return;

        const gameState = deserializeOwnerBotState(session.state);
        if (gameState.turn !== expectedBotColor) return;
        if (gameState.winner) return;

        const now = getEstimatedServerNow();
        if (session.botMoveLock && session.botMoveLock.expiresAt > now) return;

        const newSession = Object.assign({}, session);
        newSession.botMoveLock = { holder: botClientInstanceId, matchId: expectedMatchId, revision: expectedRevision, expiresAt: now + BOT_MOVE_LOCK_TTL_MS };
        return newSession;
    }).then(function (result) {
        if (!result.committed) return { acquired: false };
        const session = result.snapshot.val();
        if (!session.botMoveLock || session.botMoveLock.holder !== botClientInstanceId) return { acquired: false };
        return { acquired: true, sessionSnapshot: session };
    });
}

function commitBotMove(expectedMatchId, expectedRevision, expectedBotColor, bestMove) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve({ committed: false, authRequired: true });
    return database.ref("botSessions/" + myTelegramId).transaction(function (session) {
        if (!session) return;
        if (session.matchId !== expectedMatchId) return;
        if (session.revision !== expectedRevision) return;
        if (!session.botMoveLock || session.botMoveLock.holder !== botClientInstanceId) return;
        if (session.botMoveLock.revision !== expectedRevision) return;
        // Технически на данный момент недостижимо иначе (rematch/replace —
        // единственные операции, меняющие session.matchId, и обе тут же
        // обнуляют botMoveLock в null) — session.matchId уже проверен выше,
        // и lock не может пережить смену matchId. Проверяем явно как
        // самодокументирующийся инвариант и защиту от будущих изменений,
        // которые могли бы случайно нарушить это соответствие.
        if (session.botMoveLock.matchId !== expectedMatchId) return;

        const gameState = deserializeOwnerBotState(session.state);
        if (gameState.turn !== expectedBotColor) return;
        if (gameState.winner) return;

        const result = attemptMove(gameState, bestMove.from.row, bestMove.from.col, bestMove.to.row, bestMove.to.col, expectedBotColor);
        if (!result) return;

        const movingPieceWasKing = !!(gameState.pieces[bestMove.from.row + "_" + bestMove.from.col] && gameState.pieces[bestMove.from.row + "_" + bestMove.from.col].king);
        const drawState = computeNextDrawState(gameState, result, movingPieceWasKing);
        const newGameState = Object.assign({}, gameState, result, {
            kingOnlyStreak: drawState.kingOnlyStreak,
            noProgressStreak: drawState.noProgressStreak,
            positionHistory: drawState.positionHistory,
            longRoadAttacker: drawState.longRoadAttacker,
            longRoadStreak: drawState.longRoadStreak,
        });
        if (!result.winner && drawState.drawReason) {
            newGameState.winner = "draw";
            newGameState.winReason = drawState.drawReason;
        }

        const newSession = Object.assign({}, session);
        newSession.state = serializeOwnerBotState(newGameState);
        newSession.revision = session.revision + 1;
        newSession.status = newGameState.winner ? "finished" : "active";
        newSession.botMoveLock = null;
        newSession.updatedAt = firebase.database.ServerValue.TIMESTAMP;
        return newSession;
    });
}

// --- Rematch: atomic, цвет вычисляется из ПРЕДЫДУЩЕЙ общей session, не из
// localStorage — второе устройство могло иметь другую локальную историю.
// matchId генерируется ОДИН РАЗ здесь, а не внутри transaction callback —
// Firebase может вызвать callback повторно при конфликте, и Math.random()
// внутри дал бы РАЗНЫЕ значения на разных попытках; при optimistic-apply
// клиента это могло бы на мгновение "просветить" наружу matchId, который
// затем не станет финальным committed значением. botColor/players НАМЕРЕННО
// остаются внутри callback — они честно зависят от свежего session (какой
// цвет был у ПРЕДЫДУЩЕЙ партии), это чистая функция входа, не источник
// новой недетерминированности. ---
function applyRematchViaSession(expectedOldMatchId, freshInitialGameState) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve({ committed: false, authRequired: true });
    const newMatchId = "bot_" + myTelegramId + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    return database.ref("botSessions/" + myTelegramId).transaction(function (session) {
        if (!session) return;
        if (session.status !== "finished") return;
        if (expectedOldMatchId && session.matchId !== expectedOldMatchId) return;

        const newBotColor = session.botColor === "light" ? "dark" : "light";
        const newMyColor = newBotColor === "light" ? "dark" : "light";
        const botName = "🤖 Компьютер";
        const humanName = myTelegramName || "Игрок";
        const stateWithCorrectPlayers = Object.assign({}, freshInitialGameState, {
            players: newBotColor === "light" ? { light: { name: botName }, dark: { name: humanName } } : { light: { name: humanName }, dark: { name: botName } }
        });

        return {
            status: "active",
            matchId: newMatchId,
            revision: 0,
            spectateRoomCode: session.spectateRoomCode,
            botDifficulty: session.botDifficulty,
            botColor: newBotColor,
            myColor: newMyColor,
            createdAt: session.createdAt,
            updatedAt: firebase.database.ServerValue.TIMESTAMP,
            state: serializeOwnerBotState(stateWithCorrectPlayers),
            botMoveLock: null
        };
    });
}

// --- Замена активной сессии новой серией (после подтверждения пользователя).
// matchId/spectateRoomCode/весь candidateSession строятся ОДИН РАЗ здесь, а
// не внутри transaction callback — newBotColor для новой серии всегда
// фиксирован ("dark"), поэтому ничего в candidateSession не должно зависеть
// от свежего session на каждой попытке; единственное, что действительно
// нужно читать из session внутри callback — проверка expectedOldMatchIdOrNull.
// Старый spectateRoomCode здесь НЕ извлекается вообще (раньше это делалось
// мутацией closure-переменной изнутри callback — Firebase мог вызвать
// callback повторно и переписать её нечестно) — вызывающий код уже знает
// старый код заранее, из того же чтения, что дало ему expectedOldMatchIdOrNull. ---
function replaceOwnerBotSessionWithNew(expectedOldMatchIdOrNull, chosenDifficulty, freshInitialGameState) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve({ committed: false, authRequired: true });
    const newMatchId = "bot_" + myTelegramId + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const newSpectateRoomCode = generateRoomCode();
    const newBotColor = "dark";
    const newMyColor = "light";
    const botName = "🤖 Компьютер";
    const humanName = myTelegramName || "Игрок";
    const stateWithCorrectPlayers = Object.assign({}, freshInitialGameState, {
        players: { light: { name: humanName }, dark: { name: botName } } // newBotColor фиксирован "dark"
    });
    const candidateSession = {
        status: "active",
        matchId: newMatchId,
        revision: 0,
        spectateRoomCode: newSpectateRoomCode,
        botDifficulty: chosenDifficulty,
        botColor: newBotColor,
        myColor: newMyColor,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        updatedAt: firebase.database.ServerValue.TIMESTAMP,
        state: serializeOwnerBotState(stateWithCorrectPlayers),
        botMoveLock: null
    };

    return database.ref("botSessions/" + myTelegramId).transaction(function (session) {
        if (expectedOldMatchIdOrNull && session && session.matchId !== expectedOldMatchIdOrNull) return; // кто-то уже успел раньше
        return candidateSession;
    }).then(function (result) {
        return { committed: result.committed, newSession: result.committed ? result.snapshot.val() : null };
    });
}

// --- Статистика Medium/Hard: ограниченный (10) список matchId в ОДНОЙ
// атомарной транзакции — исключает и двойной +1, и crash-окно потери. ---
// --- RTDB не гарантирует, что "массив" вернётся именно как плотный JS
// Array — при определённых обстоятельствах (в частности, sparse-структура)
// snapshot.val() может дать обычный объект с числовыми строковыми ключами
// ({"0":"id1","1":"id2"}) вместо ["id1","id2"]. Array.isArray() на такое
// вернёт false — и наивная проверка "не массив -> считаем пустым" молча
// потеряла бы уже сохранённые matchId, что привело бы ИМЕННО к тому
// задвоению, от которого вся эта функция должна защищать. Нормализуем
// оба представления явно, плюс отфильтровываем нестроковый мусор. ---
function normalizeRecentMatchIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.filter(function (v) { return typeof v === "string"; });
    }
    if (typeof value === "object") {
        return Object.keys(value)
            .sort(function (a, b) { return Number(a) - Number(b); })
            .map(function (k) { return value[k]; })
            .filter(function (v) { return typeof v === "string"; });
    }
    return [];
}

function recordBotGameResultIdempotent(matchId, didIWin, level) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return Promise.resolve(null);
    return database.ref("statsBot/" + myTelegramId).transaction(function (current) {
        const result = current || { wins: 0, losses: 0, name: myTelegramName, recentMatchIds: [] };
        result.name = myTelegramName;
        const recent = normalizeRecentMatchIds(result.recentMatchIds);
        if (recent.indexOf(matchId) !== -1) return; // уже засчитано

        if (!result.byLevel) result.byLevel = {};
        if (!result.byLevel[level]) result.byLevel[level] = { wins: 0, losses: 0 };
        if (didIWin) {
            result.wins = (result.wins || 0) + 1;
            result.byLevel[level].wins = (result.byLevel[level].wins || 0) + 1;
        } else {
            result.losses = (result.losses || 0) + 1;
            result.byLevel[level].losses = (result.byLevel[level].losses || 0) + 1;
        }
        const newRecent = recent.concat([matchId]);
        while (newRecent.length > STATS_RECENT_MATCH_IDS_LIMIT) newRecent.shift();
        result.recentMatchIds = newRecent;
        return result;
    });
}

// --- "Кто играет": определить, что комната — это МОЯ собственная bot-игра,
// а не чужая (для которой поведение зрителя остаётся прежним). ---
function isMyOwnBotGameRoom(room) {
    if (!room || !room.players) return false;
    const lightP = room.players.light;
    const darkP = room.players.dark;
    const botSlot = (lightP && lightP.id === "bot") ? lightP : ((darkP && darkP.id === "bot") ? darkP : null);
    if (!botSlot) return false;
    const humanSlot = (lightP && lightP.id !== "bot") ? lightP : darkP;
    return !!(humanSlot && humanSlot.id === myTelegramId);
}

// --- Единственная точка, пишущая/обновляющая публичную spectate room из
// committed owner state. Вызывается тем устройством, чья owner-транзакция
// только что реально закоммитилась — оно уже держит свежий snapshot.
//
// КРИТИЧНО: реальные Firebase Rules для rooms/$room требуют при ЛЮБОЙ
// записи (когда newData.exists()) обязательные pieces/players/turn/status,
// players/light — id+name. Update() на пустую комнату БЕЗ players был бы
// отклонён Rules — именно поэтому players пишется здесь ВСЕГДА, на каждый
// вызов, не только при первом создании. Это же попутно решает обновление
// цветов после реванша: players пересчитывается из АКТУАЛЬНОГО
// committedSession.botColor на каждый вызов, а не кешируется один раз.
//
// НЕ ставим onDisconnect().remove() — уже установлено ранее, что это
// небезопасно при двух owner-устройствах (чужой поздний disconnect может
// стереть чужой, более новый lock/комнату). ---
function mirrorCommittedStateToSpectateRoom(spectateCode, committedSession) {
    if (!canUseFirebase()) return Promise.resolve();
    if (!spectateCode || !committedSession) return Promise.resolve();
    const gameState = deserializeOwnerBotState(committedSession.state);
    const botPlayer = { id: "bot", name: "🤖 Компьютер" };
    const humanPlayer = { id: myTelegramId, name: myTelegramName || "Игрок" };
    const playersObj = committedSession.botColor === "light"
        ? { light: botPlayer, dark: humanPlayer }
        : { light: humanPlayer, dark: botPlayer };
    const now = firebase.database.ServerValue.TIMESTAMP;

    return database.ref("rooms/" + spectateCode).update({
        pieces: gameState.pieces,
        turn: gameState.turn,
        mustContinueFrom: gameState.mustContinueFrom,
        pendingRemovals: gameState.pendingRemovals,
        capturedDark: gameState.capturedDark,
        capturedLight: gameState.capturedLight,
        moveCount: gameState.moveCount,
        moveType: gameState.moveType,
        lastMove: gameState.lastMove,
        lastMovePath: gameState.lastMovePath,
        lastCapturedSquares: gameState.lastCapturedSquares,
        winner: gameState.winner || null,
        winReason: gameState.winReason || null,
        status: gameState.winner ? "finished" : "active",
        players: playersObj,
        timeControlSeconds: 0,
        turnStartedAt: now,
        presence: {
            light: { online: true, lastSeen: now },
            dark: { online: true, lastSeen: now }
        }
    });
}

// --- Presence-heartbeat ИМЕННО этого устройства для owner-сессии — не
// трогает саму сессию/комнату, только поддерживает "я жив" на уже
// существующей spectate room. Останавливается независимо на каждом
// устройстве при локальном выходе в меню. ---
function startOwnerPresenceHeartbeat() {
    if (!canUseFirebase()) return;
    if (ownerSessionHeartbeatInterval) return;
    ownerSessionHeartbeatInterval = setInterval(function () {
        if (!canUseFirebase()) return;
        if (!botSpectateRoomCode) return;
        const now = firebase.database.ServerValue.TIMESTAMP;
        database.ref("rooms/" + botSpectateRoomCode + "/presence").update({
            light: { online: true, lastSeen: now },
            dark: { online: true, lastSeen: now }
        });
    }, 4000);
}
function stopOwnerPresenceHeartbeat() {
    if (ownerSessionHeartbeatInterval) { clearInterval(ownerSessionHeartbeatInterval); ownerSessionHeartbeatInterval = null; }
}

// --- Retry-таймер для протухшего botMoveLock. Единственная точка, где
// triggerBotMove() планируется — это renderBoard(), вызываемая только на
// НОВОЕ Firebase-событие. Если устройство, державшее lock, закрылось ДО
// commit — никакое новое событие никогда не придёт, и без этого таймера
// ход бота завис бы навсегда. НЕ агрессивный поллинг: не читает Firebase
// вообще (currentState уже в памяти), только пытается ЗАПИСАТЬ через ту же
// самую transaction-based защиту (tryAcquireBotMoveLock), что уже
// гарантирует невозможность двойного хода. Интервал сознательно больше
// BOT_MOVE_LOCK_TTL_MS (12с) — не дёргаем впустую, пока владелец лока
// потенциально ещё жив и может успеть закоммитить сам. triggerBotMove()
// сама по себе безопасна для повторного вызова — уже содержит собственную
// проверку "точно ли ещё ход бота". ---
function startOwnerBotMoveRetryTimer() {
    if (ownerBotMoveRetryTimer) return;
    ownerBotMoveRetryTimer = setInterval(function () {
        triggerBotMove();
    }, OWNER_BOT_MOVE_RETRY_INTERVAL_MS);
}
function stopOwnerBotMoveRetryTimer() {
    if (ownerBotMoveRetryTimer) { clearInterval(ownerBotMoveRetryTimer); ownerBotMoveRetryTimer = null; }
}

// --- Локальный выход из owner-сессии ("В меню") — НЕ трогает Firebase
// вообще: не удаляет сессию, не удаляет публичную комнату. Другое
// устройство (если открыто) продолжает как ни в чём не бывало. ---
function detachFromOwnerBotSessionLocally() {
    detachOwnerBotSessionListener(ownerSessionHandle);
    ownerSessionHandle = null;
    ownerSessionAttached = false;
    stopOwnerPresenceHeartbeat();
    stopOwnerBotMoveRetryTimer();
    detachOwnerSpectatorsListener();
    if (botMoveTimer) { clearTimeout(botMoveTimer); botMoveTimer = null; }
}

// --- Единая точка обработки любого обновления общей сессии — и от своего
// же успешного commit, и от действий другого устройства. Отличать их не
// нужно: revision однозначно определяет, действительно ли что-то новое. ---
let lastRenderedOwnerRevision = null;
// --- Listener зрителей для synced-owner пути — раньше отсутствовал
// вообще, поэтому владелец не видел "Смотрят: ...". Переподключается
// ТОЛЬКО когда botSpectateRoomCode реально изменился (реванш/замена
// серии создают новый spectateRoomCode) — не на каждый onOwnerSessionUpdate,
// иначе на каждый ход плодились бы новые listener'ы. ---
function ensureOwnerSpectatorsListener() {
    if (!canUseFirebase()) return;
    if (!botSpectateRoomCode) return;
    if (ownerSpectatorsListenerRef && ownerSpectatorsListenerCode === botSpectateRoomCode) return;
    if (ownerSpectatorsListenerRef) {
        ownerSpectatorsListenerRef.off();
        ownerSpectatorsListenerRef = null;
    }
    ownerSpectatorsListenerCode = botSpectateRoomCode;
    ownerSpectatorsListenerRef = database.ref("rooms/" + botSpectateRoomCode + "/spectators");
    ownerSpectatorsListenerRef.on("value", function (snapshot) {
        ownerSpectatorsCache = snapshot.val() || {};
        if (currentState) currentState.spectators = ownerSpectatorsCache;
        renderSpectatorsList();
    });
}

function detachOwnerSpectatorsListener() {
    if (ownerSpectatorsListenerRef) {
        ownerSpectatorsListenerRef.off();
        ownerSpectatorsListenerRef = null;
    }
    ownerSpectatorsListenerCode = null;
    ownerSpectatorsCache = null;
}

function onOwnerSessionUpdate(session) {
    if (!session) return;
    const isFirstDeliverySinceAttach = (lastRenderedOwnerRevision === null);

    applyRemoteOwnerState(session);
    // currentState только что полностью заменён applyRemoteOwnerState() —
    // подмешиваем обратно последний известный список зрителей СРАЗУ, не
    // дожидаясь нового Firebase-события в самом rooms/.../spectators
    // (которого может не быть ещё долго, если никто не входит/выходит).
    if (ownerSpectatorsCache) currentState.spectators = ownerSpectatorsCache;
    ensureOwnerSpectatorsListener();

    // При ПЕРВОЙ доставке после attach (свежий старт ИЛИ resume) явно
    // пересоздаём публичное зеркало, не дожидаясь ближайшего хода.
    // Причина: если владелец был offline дольше grace period, лобби могло
    // физически удалить rooms/<spectateRoomCode> (см. runLobbyStaleSweep).
    // startOwnerPresenceHeartbeat() сам по себе НЕ пересоздал бы комнату —
    // он пишет только presence, а реальные Firebase Rules требуют
    // pieces/players/turn/status на любую запись, создающую узел; запись
    // одного presence на отсутствующий путь была бы отклонена. Полный
    // mirror (тот же вызов, что и после каждого хода) гарантированно
    // восстанавливает комнату сразу при resume, не после первого хода.
    if (isFirstDeliverySinceAttach && session.status === "active") {
        mirrorCommittedStateToSpectateRoom(session.spectateRoomCode, session);
    }

    if (!isFirstDeliverySinceAttach && session.revision !== lastRenderedOwnerRevision) {
        playSoundForMoveType(currentState.moveType, currentState.moveType === "king");
    }
    lastRenderedOwnerRevision = session.revision;

    renderBoard(); // renderBoard() сама планирует triggerBotMove(), если сейчас ход бота
}

// --- Подключение к своей owner-сессии — используется и при обычном старте,
// и при attach через "Кто играет" со второго устройства. ---
function attachOwnerBotGame() {
    if (!canUseFirebase()) return false;
    localOnlyBotGame = false;
    isBotGame = true;
    isOnlineGame = false;
    isSpectator = false;
    ownerSessionAttached = true;
    lastRenderedOwnerRevision = null;
    lastAnimatedMoveCount = null; // Новая/возобновлённая сессия — не анимируем "ход из ниоткуда"
    showScreen(gameScreen);
    if (ownerSessionHandle) detachOwnerBotSessionListener(ownerSessionHandle);
    ownerSessionHandle = attachToOwnerBotSession(onOwnerSessionUpdate);
    startOwnerPresenceHeartbeat();
    startOwnerBotMoveRetryTimer();
}

// --- Human move в synced-режиме: НЕ мутирует currentState локально —
// Firebase единственный источник истины, собственный listener доставит
// подтверждённое состояние (или ничего не изменит при abort). ---
function attemptOwnerHumanMove(fromRow, fromCol, toRow, toCol) {
    applyHumanMoveViaSession(fromRow, fromCol, toRow, toCol).then(function (result) {
        if (result.committed) {
            // selectedFrom — чисто локальный UI-концепт, Firebase о нём не
            // знает и не обязан синхронизировать. Сбрасываем СРАЗУ после
            // успешного commit (не внутри transaction — там это было бы
            // побочным эффектом чистого callback'а), той же логикой, что и
            // старый performMove(): либо null, либо новая клетка, если
            // цепочка взятия ещё не завершена.
            const newGameState = deserializeOwnerBotState(result.snapshot.val().state);
            const oldSel = selectedFrom;
            selectedFrom = newGameState.mustContinueFrom
                ? { row: newGameState.mustContinueFrom.row, col: newGameState.mustContinueFrom.col }
                : null;
            updateSelectionDom(oldSel, selectedFrom);
            // Именно spectateRoomCode ИЗ committed snapshot, не глобальный
            // botSpectateRoomCode — между commit'ом и этим callback'ом
            // глобал мог уже относиться к другой/новой сессии (реванш,
            // замена серии), а эта запись обязана попасть в комнату ИМЕННО
            // той партии, которая только что реально закоммитилась.
            mirrorCommittedStateToSpectateRoom(result.snapshot.val().spectateRoomCode, result.snapshot.val());
        }
        // Если abort — ничего не делаем: локальный currentState/selectedFrom
        // не менялись, listener (если что-то реально изменилось у другого
        // устройства) сам доставит актуальное состояние.
    });
}

// ===== ЗЕРКАЛО ИГРЫ С БОТОМ (чтобы её было видно в "Играть онлайн") =====

function startBotSpectateRoom() {
    if (localOnlyBotGame || !canUseFirebase()) return;
    // Если кода ещё нет (первая игра) — генерируем.
    // Если уже есть (реванш) — переиспользуем СТАРЫЙ код, чтобы зрители
    // не потеряли комнату и автоматически "переехали" в новую партию.
    if (!botSpectateRoomCode) {
        botSpectateRoomCode = generateRoomCode();
    }

    // Динамически назначаем цвета в зависимости от того, кем играет бот в текущей партии
    const botPlayer = { id: "bot", name: "🤖 Компьютер" };
    const humanPlayer = { id: myTelegramId, name: myTelegramName };
    const playersObj = botColor === "light" 
        ? { light: botPlayer, dark: humanPlayer } 
        : { light: humanPlayer, dark: botPlayer };

    const initialState = {
        status: "active",
        turn: "light",
        mustContinueFrom: null,
        capturedDark: 0,
        capturedLight: 0,
        moveCount: 0,
        lastMove: null,
        lastMovePath: null,
        lastCapturedSquares: null,
        moveType: null,
        pieces: createInitialPieces(),
        players: playersObj,
        timeControlSeconds: 0,
        turnStartedAt: firebase.database.ServerValue.TIMESTAMP,
        winner: null,
        winReason: null,
        groupId: GROUP_ID,
        presence: {
            light: { online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP },
            dark: { online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP }
        }
    };
    // Используем update() вместо set(), чтобы при перезапуске комнаты (реванше)
    // не стирались данные о зрителях (spectators), которые уже могли быть в базе.
    database.ref("rooms/" + botSpectateRoomCode).update(initialState);

    // Если приложение закроется полностью (потеря связи с Firebase) —
    // комната должна удалиться сама, а не остаться висеть навсегда.
    database.ref("rooms/" + botSpectateRoomCode).onDisconnect().remove();

    if (!botSpectatePresenceInterval) {
        // Периодически подтверждаем "присутствие" за обе стороны, чтобы комната
        // не считалась заброшенной и автоматически не удалилась во время игры.
        botSpectatePresenceInterval = setInterval(function () {
            if (!canUseFirebase() || localOnlyBotGame) return;
            if (!botSpectateRoomCode) return;
            const now = firebase.database.ServerValue.TIMESTAMP;
            database.ref("rooms/" + botSpectateRoomCode + "/presence").update({
                light: { online: true, lastSeen: now },
                dark: { online: true, lastSeen: now }
            });
        }, 4000);
    }

    // Слушатель зрителей: обновляет список зрителей на экране игрока
    // без влияния на локальную логику игры с ботом.
    if (!botSpectateListenerRef) {
        botSpectateListenerRef = database.ref("rooms/" + botSpectateRoomCode + "/spectators");
        botSpectateListenerRef.on("value", function(snapshot) {
            if (!currentState) return;
            currentState.spectators = snapshot.val() || {};
            renderSpectatorsList();
        });
    }
}

function stopBotSpectateRoom() {
    if (botSpectatePresenceInterval) { clearInterval(botSpectatePresenceInterval); botSpectatePresenceInterval = null; }
    if (botSpectateListenerRef) { botSpectateListenerRef.off(); botSpectateListenerRef = null; }
    if (botSpectateRoomCode) {
        if (!localOnlyBotGame && canUseFirebase()) {
            database.ref("rooms/" + botSpectateRoomCode).onDisconnect().cancel();
            database.ref("rooms/" + botSpectateRoomCode).remove();
        }
        botSpectateRoomCode = null;
    }
}

function syncBotStateToFirebase() {
    if (localOnlyBotGame || !canUseFirebase()) return Promise.resolve();
    if (!botSpectateRoomCode || !currentState) return Promise.resolve();
    database.ref("rooms/" + botSpectateRoomCode).update({
        pieces: currentState.pieces,
        turn: currentState.turn,
        mustContinueFrom: currentState.mustContinueFrom,
        capturedDark: currentState.capturedDark,
        capturedLight: currentState.capturedLight,
        moveCount: currentState.moveCount,
        moveType: currentState.moveType,
        lastMove: currentState.lastMove,
        lastMovePath: currentState.lastMovePath,
        lastCapturedSquares: currentState.lastCapturedSquares,
        winner: currentState.winner || null,
        winReason: currentState.winReason || null,
        status: currentState.winner ? "finished" : "active"
    });
}

// Соответствие уровня сложности и максимальной глубины поиска. Единственное
// изменение силы бота — параметр maxDepth, уже принимаемый существующим
// findBestMove(state, color, maxDepth). Никакой новой поисковой логики,
// эвристик или ограничений времени здесь нет — Hard получает ровно то же
// значение (20), что и раньше, и ведёт себя идентично прежнему production.
function getMaxDepthForDifficulty(difficulty) {
    if (difficulty === "easy") return 2;
    if (difficulty === "medium") return 4;
    return 20; // hard — без изменений
}

// Единая точка показа выбора сложности — используется всеми путями запуска
// игры с ботом, чтобы не дублировать одну и ту же логику трижды. Сама
// партия стартует только после выбора одной из трёх кнопок; ничего не
// сохраняется между вызовами — botDifficulty выставляется заново каждый раз.
function promptBotDifficultyThenStart() {
    if (!canUseFirebase()) { pendingExistingSessionForResume = null; pendingReplaceExistingSession = null; pendingOldSpectateCodeForCleanup = null; botDifficultyModal.classList.remove("hidden"); return; }
    // Перед показом выбора уровня — проверяем, нет ли уже АКТИВНОЙ общей
    // сессии (например, партия начата на другом устройстве). Молча
    // уничтожать её нельзя — предлагаем явный выбор.
    if (!myTelegramId) { botDifficultyModal.classList.remove("hidden"); return; }
    database.ref("botSessions/" + myTelegramId).once("value").then(function (snapshot) {
        const existing = snapshot.val();
        if (existing && existing.status === "active") {
            pendingExistingSessionForResume = existing;
            continueOrNewModal.classList.remove("hidden");
        } else {
            // Сессии нет вообще, либо она уже FINISHED — пойдём через
            // createOwnerBotSession() напрямую. Но если это именно
            // FINISHED (не null), у неё есть spectateRoomCode, которую
            // showGroupLobby() НИКОГДА не удалит сама (lazy-очистка стоит
            // только на status==="active" — проверено по коду, не
            // предположение) — запоминаем заранее, чтобы аккуратно
            // подчистить ПОСЛЕ успешного создания новой сессии.
            pendingOldSpectateCodeForCleanup = (existing && existing.spectateRoomCode) ? existing.spectateRoomCode : null;
            botDifficultyModal.classList.remove("hidden");
        }
    }).catch(function () {
        botDifficultyModal.classList.remove("hidden"); // офлайн/ошибка — не блокируем игру
    });
}

let pendingOldSpectateCodeForCleanup = null;

let pendingExistingSessionForResume = null;
let pendingReplaceExistingSession = null;

btnContinueExistingSession.addEventListener("click", function () {
    continueOrNewModal.classList.add("hidden");
    const existing = pendingExistingSessionForResume;
    pendingExistingSessionForResume = null;
    if (!existing) return;
    attachOwnerBotGame(); // сама выставит isBotGame/isOnlineGame=false/showScreen(gameScreen)
});

btnStartNewSession.addEventListener("click", function () {
    continueOrNewModal.classList.add("hidden");
    pendingReplaceExistingSession = pendingExistingSessionForResume;
    pendingExistingSessionForResume = null;
    botDifficultyModal.classList.remove("hidden");
});

btnContinueOrNewBack.addEventListener("click", function () {
    continueOrNewModal.classList.add("hidden");
    pendingExistingSessionForResume = null;
    showScreen(menuScreen);
    loadActiveRooms();
});

btnDifficultyEasy.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    startOwnerBotGameWithDifficulty("easy");
});
btnDifficultyMedium.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    startOwnerBotGameWithDifficulty("medium");
});
btnDifficultyHard.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    startOwnerBotGameWithDifficulty("hard");
});
btnDifficultyBack.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    isBotGame = false;
    // Отменённый flow не должен переживать себя: если пользователь дошёл
    // сюда через "Начать новую" (pendingReplaceExistingSession уже
    // выставлен) и передумал — без этой очистки устаревшее значение могло
    // бы неожиданно повлиять на СОВЕРШЕННО ДРУГОЙ, более поздний запуск
    // startOwnerBotGameWithDifficulty(), заставив его ошибочно пойти по
    // ветке "замена", а не "создание с чистого места".
    pendingReplaceExistingSession = null;
    pendingExistingSessionForResume = null;
    pendingOldSpectateCodeForCleanup = null;
    showScreen(menuScreen);
    loadActiveRooms();
});

// --- Единая точка запуска новой bot-серии (и с чистого места, и как явная
// замена уже существующей активной сессии после подтверждения). ---
function startOwnerBotGameWithDifficulty(chosenDifficulty) {
    if (localOnlyBotGame || !canUseFirebase()) {
        pendingExistingSessionForResume = null; pendingReplaceExistingSession = null; pendingOldSpectateCodeForCleanup = null;
        localOnlyBotGame = true; ownerSessionAttached = false; botDifficulty = chosenDifficulty; isOnlineGame = false; isSpectator = false; isBotGame = true;
        showScreen(gameScreen); startOfflineGame(); return;
    }
    localOnlyBotGame = false;
    isOnlineGame = false;
    isSpectator = false;
    isBotGame = true;
    showScreen(gameScreen);

    const freshState = buildFreshBotGameState();

    if (pendingReplaceExistingSession) {
        const oldMatchId = pendingReplaceExistingSession.matchId;
        const oldSpectateCode = pendingReplaceExistingSession.spectateRoomCode;
        pendingReplaceExistingSession = null;
        replaceOwnerBotSessionWithNew(oldMatchId, chosenDifficulty, freshState).then(function (result) {
            if (!result.committed) {
                // Кто-то уже успел раньше (например, второе устройство тоже
                // нажало "Начать новую" почти одновременно) — не создаём
                // вторую, но и не оставляем пользователя ни с чем: тот, кто
                // реально выиграл гонку, уже что-то создал — подключаемся к
                // ЭТОЙ актуальной сессии как owner, а не показываем ошибку.
                attachOwnerBotGame();
                return;
            }
            // Старую публичную комнату удаляем ТОЛЬКО после успешной замены, не до неё.
            if (canUseFirebase() && oldSpectateCode && oldSpectateCode !== result.newSession.spectateRoomCode) {
                database.ref("rooms/" + oldSpectateCode).remove().catch(function () {
                    // Не критично: осиротевшая комната лениво подчистится
                    // существующим stale-room механизмом showGroupLobby()
                    // при следующем открытии "Кто играет" кем угодно —
                    // не блокируем и не откатываем уже успешную замену сессии из-за этого.
                });
            }
            // Публичную комнату для НОВОЙ серии создаём СРАЗУ, до первого
            // хода — иначе "Кто играет" не увидит партию, пока кто-то не
            // сходит (а по реальным Rules пустая комната без players вообще
            // не прошла бы первую запись через move-triggered mirror).
            if (!canUseFirebase()) return;
            mirrorCommittedStateToSpectateRoom(result.newSession.spectateRoomCode, result.newSession);
            attachOwnerBotGame();
        }).catch(function () {
            // Настоящая ошибка Firebase (не abort, а, например, сеть) —
            // не оставляем пользователя молча зависшим на gameScreen.
            // Явно сбрасываем isBotGame — тот же паттерн, что уже принят в
            // проекте для аналогичных error-путей (см. join-room/matchmaking).
            isBotGame = false;
            showInfoModal(t("err_join_failed"), false);
        });
    } else {
        const oldFinishedSpectateCode = pendingOldSpectateCodeForCleanup;
        pendingOldSpectateCodeForCleanup = null;
        createOwnerBotSession(chosenDifficulty, freshState).then(function (result) {
            // committed=false здесь означает то же самое: кто-то другой
            // (например, это же устройство, если пользователь дважды
            // быстро нажал) уже создал активную сессию раньше нас —
            // attachOwnerBotGame() всё равно корректно подключится к
            // РЕАЛЬНОЙ (не обязательно "нашей") сессии через listener.
            if (canUseFirebase() && result.committed && oldFinishedSpectateCode && oldFinishedSpectateCode !== result.session.spectateRoomCode) {
                // showGroupLobby() lazy-очистка стоит только на
                // status==="active" (проверено по коду) — finished-комнату
                // она никогда сама не удалит. Подчищаем здесь, ТОЛЬКО
                // после успешного создания новой сессии, не раньше.
                database.ref("rooms/" + oldFinishedSpectateCode).remove().catch(function () {
                    // Не критично — тот же принцип, что и в replace-ветке.
                });
            }
            if (!canUseFirebase()) return;
            if (result.committed) {
                // Публичную комнату создаём СРАЗУ, до первого хода. Пишем
                // только если ЭТО устройство реально выиграло гонку
                // создания — если committed=false, комнату уже создал
                // победитель гонки своим собственным вызовом, повторять не нужно.
                mirrorCommittedStateToSpectateRoom(result.session.spectateRoomCode, result.session);
            }
            attachOwnerBotGame();
        }).catch(function () {
            isBotGame = false;
            showInfoModal(t("err_join_failed"), false);
        });
    }
}

// --- Начальное состояние партии — та же форма, что и раньше в
// startOfflineGame(), вынесена отдельно, чтобы переиспользовать и здесь, и
// в реванше. Ничего в самих правилах/структуре не меняет. ---
function buildFreshBotGameState() {
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
        longRoadStreak: 0,
        lastMove: null,
        lastMovePath: null,
        lastCapturedSquares: null,
        moveType: null,
        winner: null,
        winReason: null,
        players: { light: { name: myTelegramName || "Игрок" }, dark: { name: "🤖 Компьютер" } }
    };
}

function startOfflineGame() {
    isOnlineGame = false;
    isSpectator = false;

    // Каждая новая партия с ботом имеет собственный ID.
    // Зеркальная bot-комната может использовать тот же roomCode при реванше,
    // поэтому roomCode нельзя использовать как уникальный ID партии.
    currentBotMatchId =
        "bot_" +
        (myTelegramId || "local") +
        "_" +
        Date.now() +
        "_" +
        Math.random().toString(36).slice(2, 8);

    // Новая партия должна иметь право сделать новую попытку выплаты.
    // Защита от реального двойного начисления всё равно находится в Firebase.
    
    // Чередование цвета: читаем из памяти, меняем на противоположный
    let lastBotColor = localStorage.getItem("shashki_last_bot_color");
    if (lastBotColor === "dark") {
        botColor = "light";
    } else {
        botColor = "dark";
    }
    localStorage.setItem("shashki_last_bot_color", botColor);
    
    myColor = botColor === "light" ? "dark" : "light";
    flipped = (myColor === "dark"); // Переворачиваем доску, если я играю чёрными
    
    selectedFrom = null;
    lastAnimatedMoveCount = null; // Новая партия — не анимируем "ход из ниоткуда"
    endGameShownForRoom = null;
    opponentAbsenceHandled = false;
    lastRenderedSignature = null;
    boardBuilt = false; // Обязательно перестраиваем доску при перевороте
    pendingSyncChain = Promise.resolve();
    // Ожидание хода и состояние восстановления не должны протекать
    // в новую партию/реванш.
    pendingMoveStartedAt = null;
    syncRecoveryInFlight = false;
    syncRecoveryFailed = false;
    if (opponentGraceTimer) {
        clearTimeout(opponentGraceTimer);
        opponentGraceTimer = null;
    }
    if (mustCaptureHintTimer) {
        clearTimeout(mustCaptureHintTimer);
        mustCaptureHintTimer = null;
    }
    if (botMoveTimer) {
        clearTimeout(botMoveTimer);
        botMoveTimer = null;
    }
    stopPresenceHeartbeat();
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    
    // Прячем кнопки реакций в игре с ботом
    if (reactionsRow) reactionsRow.classList.add("hidden");
    // btnBackBot видимость теперь полностью пересчитывается в renderBoard()
    // на каждом рендере (backButtonMode) — отдельный прямой toggle здесь
    // больше не нужен и был убран как источник избыточной сложности.
    
    // Сохраняем список зрителей перед пересозданием объекта состояния,
    // чтобы при реванше с ботом строчка "Смотрят: ..." не пропадала.
    const existingSpectators = (currentState && currentState.spectators) ? currentState.spectators : null;
    
    const botName = isBotGame ? "Компьютер" : "Игрок 2";
    currentState = {
        pieces: createInitialPieces(),
        turn: "light", // Белые всегда ходят первыми!
        mustContinueFrom: null,
        capturedDark: 0,
        capturedLight: 0,
        moveCount: 0,
        kingOnlyStreak: 0,
        noProgressStreak: 0,
        positionHistory: [getDrawPositionKey(createInitialPieces(), "light")],
        longRoadAttacker: null,
        longRoadStreak: 0,
        lastMove: null,
        lastMovePath: null,
        lastCapturedSquares: null,
        moveType: null,
        players: { 
            light: { name: botColor === "light" ? botName : (myTelegramName || "Игрок") }, 
            dark: { name: botColor === "dark" ? botName : (myTelegramName || "Игрок") } 
        },
        timeControlSeconds: 0,
        turnStartedAt: null,
        winner: null,
        winReason: null,
        spectators: existingSpectators // Переносим зрителей в новую партию
    };
    renderBoard();

    if (isBotGame) {
        if (!localOnlyBotGame && canUseFirebase()) startBotSpectateRoom();
        // Если бот играет белыми, он должен сделать первый ход
        if (botColor === "light" && currentState.turn === "light") {
            if (!botMoveTimer) {
                botMoveTimer = setTimeout(function() {
                    botMoveTimer = null;
                    triggerBotMove();
                }, 150);
            }
        }
    } else {
        stopBotSpectateRoom();
    }
}

// ===== АКТИВНЫЕ ИГРЫ =====

function loadActiveRooms() {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return;
    const sectionEl = document.getElementById("active-rooms-section");
    const listEl = document.getElementById("active-rooms-list");
    const noGameText = document.getElementById("no-active-game-text");
    if (!sectionEl || !listEl || !noGameText) return;
    database.ref("users/" + myTelegramId + "/rooms").once("value").then(function (snapshot) {
        const data = snapshot.val();
        if (!data) {
            sectionEl.classList.add("hidden");
            noGameText.classList.remove("hidden");
            return;
        }
        const codes = Object.keys(data);
        if (codes.length === 0) {
            sectionEl.classList.add("hidden");
            noGameText.classList.remove("hidden");
            return;
        }

        let pending = codes.length;
        const items = [];
        codes.forEach(function (code) {
            database.ref("rooms/" + code).once("value").then(function (roomSnap) {
                pending--;
                if (!canUseFirebase()) return;
                const room = roomSnap.val();

                const lightP = room && room.players && room.players.light;
                const darkP = room && room.players && room.players.dark;
                const bothPlayersExist = !!(lightP && darkP && lightP.id && darkP.id);
                const differentPlayers = bothPlayersExist && lightP.id !== darkP.id;
                const STALE_ROOM_MS = 48 * 60 * 60 * 1000;
                const isStaleRoom = room && room.turnStartedAt && (Date.now() - room.turnStartedAt > STALE_ROOM_MS);
                
                const lightPresence = room && room.presence && room.presence.light;
                const darkPresence = room && room.presence && room.presence.dark;
                const isLightStale = !lightPresence || lightPresence.online === false || (Date.now() - (lightPresence.lastSeen || 0)) > STALE_MS;
                const isDarkStale = !darkPresence || darkPresence.online === false || (Date.now() - (darkPresence.lastSeen || 0)) > STALE_MS;
                const isSomeoneOffline = isLightStale || isDarkStale;

                const isValidActiveGame = room && bothPlayersExist && differentPlayers && room.status !== "finished" && !room.winner && !isStaleRoom && !isSomeoneOffline;

                if (isValidActiveGame) {
                    items.push({ code: code, opponent: data[code].opponentName || "Соперник", color: data[code].myColor });
                } else {
                    database.ref("users/" + myTelegramId + "/rooms/" + code).remove();
                }

                if (pending === 0) {
                    listEl.innerHTML = "";
                    if (items.length === 0) {
                        sectionEl.classList.add("hidden");
                        noGameText.classList.remove("hidden");
                        return;
                    }
                    sectionEl.classList.remove("hidden");
                    noGameText.classList.add("hidden");
                    items.forEach(function (item) {
                        const row = document.createElement("div");
                        row.className = "room-item-row";

                        const btn = document.createElement("button");
                        btn.className = "menu-button room-item-button";
                        btn.textContent = t("game_against") + " " + item.opponent;
                        btn.addEventListener("click", function () {
                            roomCode = item.code;
                            myColor = item.color;
                            isOnlineGame = true;
                            showScreen(gameScreen);
                            startOnlineGame();
                        });

                        const removeBtn = document.createElement("button");
                        removeBtn.className = "room-item-remove";
                        removeBtn.textContent = "✕";
                        removeBtn.title = t("remove_from_list");
                        removeBtn.addEventListener("click", function (e) {
                            e.stopPropagation();
                            database.ref("users/" + myTelegramId + "/rooms/" + item.code).remove().then(function () {
                                loadActiveRooms();
                            });
                        });

                        row.appendChild(btn);
                        row.appendChild(removeBtn);
                        listEl.appendChild(row);
                    });
                }
            }).catch(function () {
                pending--;
            });
        });
    }).catch(function () {
        sectionEl.classList.add("hidden");
        noGameText.classList.remove("hidden");
    });
}

// ===== КНОПКИ МЕНЮ =====

function createOnlineRoom() {
    if (!canUseFirebase()) return;
    // Если у меня уже была своя незавершённая комната ожидания (например, я
    // вышел и нажал "Играть онлайн" ещё раз) — сначала удаляем старую,
    // чтобы не копились "призраки" вроде "Илюша ждёт соперника" по пять раз.
    if (myPendingOnlineRoom) {
        database.ref("rooms/" + myPendingOnlineRoom).remove();
        database.ref("users/" + myTelegramId + "/rooms/" + myPendingOnlineRoom).remove();
        myPendingOnlineRoom = null;
    }

    roomCode = generateRoomCode();
    myColor = "light";
    isOnlineGame = true;
    isSpectator = false;

    const initialState = {
        status: "waiting",
        turn: "light",
        mustContinueFrom: null,
        capturedDark: 0,
        capturedLight: 0,
        moveCount: 0,
        matchNumber: 0,
        kingOnlyStreak: 0,
        noProgressStreak: 0,
        positionHistory: [getDrawPositionKey(createInitialPieces(), "light")],
        longRoadAttacker: null,
        longRoadStreak: 0,
        lastMove: null,
        lastMovePath: null,
        lastCapturedSquares: null,
        moveType: null,
        pieces: createInitialPieces(),
        players: { light: { id: myTelegramId, name: myTelegramName }, dark: null },
        timeControlSeconds: 0,
        turnStartedAt: firebase.database.ServerValue.TIMESTAMP,
        winner: null,
        winReason: null,
        // ELO: стабильная метка создания комнаты. Пишется РОВНО один раз,
        // не трогается ни reconnect'ом, ни реваншем — входит в matchId,
        // чтобы повторно выданный через месяцы тот же roomCode не столкнулся
        // со старым receipt.
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        groupId: GROUP_ID
    };

    database.ref("rooms/" + roomCode).set(initialState).then(function () {
        if (!canUseFirebase()) return;
        myPendingOnlineRoom = roomCode;

        database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
            opponentName: "Ожидание соперника...",
            myColor: "light"
        });
        setupPresence();

        // Слушаем сигнал "тебя нашли" — сработает, когда кто-то нажмёт "Присоединиться"
        activeMatchRef = database.ref("users/" + myTelegramId + "/activeMatch");
        activeMatchRef.on("value", function (snapshot) {
            const matchedRoomCode = snapshot.val();
            if (matchedRoomCode) {
                activeMatchRef.off();
                if (!canUseFirebase()) { activeMatchRef = null; return; }
                activeMatchRef.remove();
                myPendingOnlineRoom = null;
                roomCode = matchedRoomCode;
                isOnlineGame = true;
                pendingTimeControlSeconds = 0;
                showScreen(gameScreen);
                startOnlineGame();
            }
        });

        // Сразу показываем список "Кто играет?" — там видно и свою запись, и остальных
        showGroupLobby();
    });
}

btnPlayOnline.addEventListener("click", async function () {
    if (!(await requireFirebaseAuthAsync())) return;
    isBotGame = false;
    showGroupLobby();
});

btnCancelMatchmaking.addEventListener("click", function () {
    cancelOnlineSearch();
});

btnPlayFriend.addEventListener("click", async function () {
    if (!(await requireFirebaseAuthAsync())) return;
    isBotGame = false;
    showScreen(timeControlScreen);
});

const timeOptionButtons = document.querySelectorAll(".time-option");
timeOptionButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
        pendingTimeControlSeconds = parseInt(btn.dataset.seconds);
        createRoomAndShowWaiting();
    });
});

const btnBackFromTimeControl = document.getElementById("btn-back-from-time-control");
if (btnBackFromTimeControl) {
    btnBackFromTimeControl.addEventListener("click", function() {
        showScreen(menuScreen);
    });
}

function createRoomAndShowWaiting() {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return;
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    stopPresenceHeartbeat();
    roomCode = generateRoomCode();
    myPendingFriendRoomCode = roomCode; // Запоминаем именно этот код надёжно, для ссылки
    myColor = "light";
    isOnlineGame = true;

    const initialState = {
        status: "waiting",
        turn: "light",
        mustContinueFrom: null,
        capturedDark: 0,
        capturedLight: 0,
        moveCount: 0,
        matchNumber: 0,
        kingOnlyStreak: 0,
        noProgressStreak: 0,
        positionHistory: [getDrawPositionKey(createInitialPieces(), "light")],
        longRoadAttacker: null,
        longRoadStreak: 0,
        lastMove: null,
        lastMovePath: null,
        lastCapturedSquares: null,
        moveType: null,
        pieces: createInitialPieces(),
        players: { light: { id: myTelegramId, name: myTelegramName }, dark: null },
        presence: {
            light: {
                online: true,
                lastSeen: firebase.database.ServerValue.TIMESTAMP
            }
        },
        timeControlSeconds: pendingTimeControlSeconds,
        turnStartedAt: firebase.database.ServerValue.TIMESTAMP,
        winner: null,
        winReason: null,
        // ELO: стабильная метка создания комнаты. Пишется РОВНО один раз,
        // не трогается ни reconnect'ом, ни реваншем — входит в matchId,
        // чтобы повторно выданный через месяцы тот же roomCode не столкнулся
        // со старым receipt.
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        groupId: GROUP_ID
    };

    database.ref("rooms/" + roomCode).set(initialState).then(function () {
        if (!canUseFirebase()) return;
        database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
            opponentName: "Ожидание подключения...",
            myColor: "light"
        });
        myWaitingRoomNoOpponent = true; // (v171) создатель ждёт друга, dark ещё нет
        setupPresence();

        const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + myPendingFriendRoomCode;
        inviteLinkBox.textContent = link;
        waitingText.textContent = "Ожидание подключения друга...";
        inviteLinkBox.classList.remove("hidden");
        btnShareLink.classList.remove("hidden");
        
        showScreen(waitingScreen);

        database.ref("rooms/" + roomCode + "/status").on("value", function (snapshot) {
            if (snapshot.val() === "active") {
                database.ref("rooms/" + roomCode + "/status").off();
                waitingText.textContent = "Друг подключился! Начинаем игру.";
                setTimeout(function () {
                    showScreen(gameScreen);
                    startOnlineGame();
                }, 1000);
            }
        });
    });
}

btnShareLink.addEventListener("click", function () {
    const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + myPendingFriendRoomCode;
    const shareUrl = "https://t.me/share/url?url=" + encodeURIComponent(link);
    if (window.Telegram && window.Telegram.WebApp) {
        Telegram.WebApp.openTelegramLink(shareUrl);
    } else {
        window.open(shareUrl, "_blank");
    }
});

btnPlayBot.addEventListener("click", function () {
    isBotGame = true;
    showScreen(gameScreen);
    promptBotDifficultyThenStart();
});

// ===== СДАТЬСЯ =====

btnResign.addEventListener("click", function () {
    resignConfirmModal.classList.remove("hidden");
});

btnResignNo.addEventListener("click", function () {
    resignConfirmModal.classList.add("hidden");
});

if (btnBackBot) {
    btnBackBot.addEventListener("click", function() {
        if (backConfirmModal) backConfirmModal.classList.remove("hidden");
    });
}
if (btnBackBotNo) {
    btnBackBotNo.addEventListener("click", function() {
        if (backConfirmModal) backConfirmModal.classList.add("hidden");
    });
}
function finishLocalOnlyBotSeries() { const wasLocalOnly = localOnlyBotGame; localOnlyBotGame = false; if (wasLocalOnly) activatePendingFirebaseFlows(); }

if (btnBackBotYes) {
    btnBackBotYes.addEventListener("click", function() {
        if (backConfirmModal) backConfirmModal.classList.add("hidden");
        // Ветвим по типу активной owner-сессии — synced (текущий основной
        // путь, ownerSessionAttached===true) и legacy используют РАЗНЫЙ
        // cleanup: detachFromOwnerBotSessionLocally() останавливает
        // heartbeat/retry-таймер/spectators-listener synced-сессии и
        // сознательно НЕ удаляет публичную комнату (её жизненный цикл —
        // отдельный, через lobby stale-sweep). stopBotSpectateRoom() —
        // legacy-специфичный cleanup совсем других (botSpectate*) полей,
        // явно удаляющий фантомную комнату. Раньше здесь вызывался ТОЛЬКО
        // stopBotSpectateRoom(), даже когда кнопка стала показываться и
        // для synced-владельца — оставляя heartbeat/retry-таймер
        // работать в фоне после ухода с экрана.
        if (ownerSessionAttached) {
            detachFromOwnerBotSessionLocally();
        } else {
            stopBotSpectateRoom(); // Удаляем фантомную комнату
        }
        isBotGame = false;
        finishLocalOnlyBotSeries();
        showScreen(menuScreen);
        loadActiveRooms();
    });
}

// --- Кнопка "Назад" для зрителя во время АКТИВНОЙ партии — без
// подтверждения, в отличие от btnBackBot: пассивный просмотр ничего не
// меняет в самой игре, спрашивать "вы уверены" не нужно. Общая для обоих
// spectator-сценариев (bot-зеркало и обычная online-партия) — оба идут
// через один и тот же watchGroupRoomAsSpectator()/roomListenerRef, спецкейса
// для ботов здесь нет и не нужно. ---
// --- Общий выход из spectator-режима: отписка от комнаты, удаление своей
// записи "я смотрю", возврат в лобби. Переиспользуется и кнопкой "Назад",
// и модалкой "Игра прервана" — оба места делают ровно одно и то же. ---
function leaveSpectatorAndReturnToLobby() {
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    if (myCurrentSpectatorRef) { if (canUseFirebase()) myCurrentSpectatorRef.remove(); myCurrentSpectatorRef = null; }
    isSpectator = false;
    isOnlineGame = false;
    isBotGame = false;
    currentState = null;
    showGroupLobby();
}

if (btnBackSpectator) {
    btnBackSpectator.addEventListener("click", function () {
        leaveSpectatorAndReturnToLobby();
    });
}

if (btnSpectatorInterruptedOk) {
    btnSpectatorInterruptedOk.addEventListener("click", function () {
        if (spectatorInterruptedModal) spectatorInterruptedModal.classList.add("hidden");
        leaveSpectatorAndReturnToLobby();
    });
}

btnResignYes.addEventListener("click", function () {
    resignConfirmModal.classList.add("hidden");
    if (!currentState) return;

    if (isOnlineGame) {
        if (!requireFirebaseAuth()) return;
    // ВРЕМЕННАЯ ИНВАРИАНТА ФАЗЫ 1: клиент без подтверждённой связи не создаёт
    // НОВУЮ транзакцию на весь узел комнаты, пока такая транзакция всё ещё
    // владеет presence обоих игроков. Причина техническая, а не игровая:
    // незавершённая whole-room транзакция накладывается на приходящие
    // серверные данные и способна подменить присутствие соперника устаревшим
    // слепком. Снимется в Фазе 2, когда игровое состояние будет физически
    // отделено от presence.
        // Локальный выход из партии этим guard'ом НЕ затрагивается —
        // защищается именно серверная транзакция сдачи.
        if (!isFirebaseConnected) return;
        database.ref("rooms/" + roomCode).transaction(function (room) {
            // v180 ГОНКА ОБЫЧНОГО И ТЕХНИЧЕСКОГО ИСХОДА. Если технический
            // результат уже создан, обычное завершение ОТМЕНЯЕТСЯ: одна партия —
            // ровно один исход. Проверка стоит первой строкой каждой whole-room
            // транзакции, а транзакция перечитывает СЕРВЕРНЫЕ данные при гонке,
            // поэтому подмена уже записанного результата невозможна.
            if (!room || room.winner || room.result) return;
            const newRoom = {};
            for (const key in room) newRoom[key] = room[key];
            newRoom.winner = myColor === "light" ? "dark" : "light";
            newRoom.winReason = "resign";
            newRoom.status = "finished";
            return newRoom;
        }).then(function(result) {
            if (!result.committed) {
                showInfoModal(t("err_resign_failed"), false);
            }
        }).catch(function() {
            showInfoModal(t("err_resign_connection"), false);
        });
    } else if (isBotGame && ownerSessionAttached) {
        attemptOwnerSurrender().then(function (result) {
            if (result.committed) {
                mirrorCommittedStateToSpectateRoom(result.snapshot.val().spectateRoomCode, result.snapshot.val());
            } else {
                showInfoModal(t("err_resign_failed"), false);
            }
        }).catch(function () {
            showInfoModal(t("err_resign_connection"), false);
        });
    } else {
        currentState.winner = currentState.turn === "light" ? "dark" : "light";
        currentState.winReason = "resign";
        renderBoard();
        if (isBotGame && !localOnlyBotGame) syncBotStateToFirebase();
    }
});

// ===== НИЧЬЯ =====

if (btnOfferDraw) {
    btnOfferDraw.addEventListener("click", function () {
        if (!isOnlineGame || !currentState || currentState.winner) return;
        if (!requireFirebaseAuth()) return;
        database.ref("rooms/" + roomCode + "/drawProposal").set({ by: myColor, name: myTelegramName });
    });
}

if (btnReactLaugh) {
    btnReactLaugh.addEventListener("click", function() { sendReaction("😂"); });
}
if (btnReactFire) {
    btnReactFire.addEventListener("click", function() { sendReaction("🔥"); });
}
if (btnReactShock) {
    btnReactShock.addEventListener("click", function() { sendReaction("😱"); });
}
if (btnReactAngry) {
    btnReactAngry.addEventListener("click", function() { sendReaction("😡"); });
}

function sendReaction(emoji) {
    if (isSpectator) return;
    if (!requireFirebaseAuth()) return;
    if (!isOnlineGame || !currentState || currentState.winner) return;
    // ts: Date.now() гарантирует, что каждое нажатие уникально
    database.ref("rooms/" + roomCode + "/reaction").set({
        emoji: emoji,
        from: myColor,
        ts: Date.now()
    }).catch(function(e) { console.error("Reaction send failed", e); });
}

function triggerEmojiBurst(emoji) {
    if (!emojiBurstContainer) return;
    const count = 5;
    for (let i = 0; i < count; i++) {
        const el = document.createElement("div");
        el.className = "burst-emoji";
        el.textContent = emoji;
        
        const startX = Math.random() * 100; // Случайная точка по ширине экрана
        const dxMid = (Math.random() - 0.5) * 100; // Отклонение в сторону
        const dxEnd = (Math.random() - 0.5) * 200; // Конечное отклонение
        
        el.style.left = startX + "vw";
        el.style.setProperty('--dx-mid', dxMid + "px");
        el.style.setProperty('--dx-end', dxEnd + "px");
        el.style.animationDuration = (1.5 + Math.random() * 1.0) + "s"; // От 1.5 до 2.5 сек
        el.style.animationDelay = (Math.random() * 0.3) + "s"; // Лёгкая рассинхронизация
        
        emojiBurstContainer.appendChild(el);
        
        // Удаляем элемент из DOM после окончания анимации
        el.addEventListener("animationend", function() {
            el.remove();
        });
    }
}

function checkDrawProposal() {
    if (!drawOfferModal) return;
    if (!isOnlineGame || !currentState || currentState.winner) {
        drawOfferModal.classList.add("hidden");
        return;
    }
    const proposal = currentState.drawProposal;
    if (!proposal) {
        drawOfferModal.classList.add("hidden");
        return;
    }
    if (proposal.by === myColor) {
        drawOfferText.textContent = t("waiting_draw");
        if (btnDrawAccept) btnDrawAccept.classList.add("hidden");
        if (btnDrawDecline) btnDrawDecline.classList.add("hidden");
        if (btnDrawCancel) btnDrawCancel.classList.remove("hidden");
    } else {
        drawOfferText.textContent = (proposal.name || t("opponent_default")) + t("offers_draw");
        if (btnDrawAccept) btnDrawAccept.classList.remove("hidden");
        if (btnDrawDecline) btnDrawDecline.classList.remove("hidden");
        if (btnDrawCancel) btnDrawCancel.classList.add("hidden");
    }
    drawOfferModal.classList.remove("hidden");
}

if (btnDrawAccept) {
    btnDrawAccept.addEventListener("click", function () {
        drawOfferModal.classList.add("hidden");
    // ВРЕМЕННАЯ ИНВАРИАНТА ФАЗЫ 1: клиент без подтверждённой связи не создаёт
    // НОВУЮ транзакцию на весь узел комнаты, пока такая транзакция всё ещё
    // владеет presence обоих игроков. Причина техническая, а не игровая:
    // незавершённая whole-room транзакция накладывается на приходящие
    // серверные данные и способна подменить присутствие соперника устаревшим
    // слепком. Снимется в Фазе 2, когда игровое состояние будет физически
    // отделено от presence.
        // Без связи согласие не отправляем: после восстановления игрок
        // подтвердит его при актуальном серверном состоянии.
        if (!requireFirebaseAuth()) return;
        if (!isFirebaseConnected) return;
        database.ref("rooms/" + roomCode).transaction(function (room) {
            // v180 ГОНКА ОБЫЧНОГО И ТЕХНИЧЕСКОГО ИСХОДА. Если технический
            // результат уже создан, обычное завершение ОТМЕНЯЕТСЯ: одна партия —
            // ровно один исход. Проверка стоит первой строкой каждой whole-room
            // транзакции, а транзакция перечитывает СЕРВЕРНЫЕ данные при гонке,
            // поэтому подмена уже записанного результата невозможна.
            if (!room || room.winner || room.result) return;
            const newRoom = {};
            for (const key in room) newRoom[key] = room[key];
            newRoom.winner = "draw";
            newRoom.winReason = "draw";
            newRoom.status = "finished";
            newRoom.drawProposal = null;
            return newRoom;
        }).then(function(result) {
            if (!result.committed) {
                showInfoModal(t("err_draw_failed"), false);
            }
        }).catch(function() {
            showInfoModal(t("err_draw_connection"), false);
        });
    });
}

if (btnDrawDecline) {
    btnDrawDecline.addEventListener("click", function () {
        drawOfferModal.classList.add("hidden");
        if (!requireFirebaseAuth()) return;
        database.ref("rooms/" + roomCode + "/drawProposal").remove();
    });
}

if (btnDrawCancel) {
    btnDrawCancel.addEventListener("click", function () {
        drawOfferModal.classList.add("hidden");
        if (!requireFirebaseAuth()) return;
        database.ref("rooms/" + roomCode + "/drawProposal").remove();
    });
}

// ===== НОВАЯ ИГРА / ЗАКРЫТЬ =====

btnCloseGame.addEventListener("click", function () {
    // Если мы зритель — просто отписываемся от комнаты и выходим в меню.
    if (isSpectator) {
        endGameModal.classList.add("hidden");
        if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
        if (myCurrentSpectatorRef) { if (canUseFirebase()) myCurrentSpectatorRef.remove(); myCurrentSpectatorRef = null; }
        showScreen(menuScreen);
        loadActiveRooms();
        return;
    }

    // ONLINE finished-room нельзя удалять, пока Worker ещё читает outcome.
    // Это та же гонка, что у быстрого реванша: cleanupFinishedRoom() стирает
    // единственный авторитетный результат партии.
    if (isOnlineGame && currentState && currentState.winner && roomCode) {
        const codeAtClick = roomCode;
        const generationAtClick = ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt);

        waitForSettlementBeforeRoomMutation().then(function (outcome) {
            endGameModal.classList.add("hidden");
            markMyselfLeftExplicitly();

            const stillSameFinished = outcome === "safe"
                && roomCode === codeAtClick
                && currentState
                && ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) === generationAtClick
                && !!currentState.winner;

            if (stillSameFinished) {
                cleanupFinishedRoom();
            } else {
                // changed/blocked: локально закрыться можно, но НЕЛЬЗЯ стирать
                // новую партию или finished outcome, который сервер не закрепил.
                detachMyPresence();
                isOnlineGame = false;
                roomCode = null;
            }

            if (window.Telegram && window.Telegram.WebApp) Telegram.WebApp.close();
        }).catch(function (error) {
            console.error("Close after settlement failed:", error);
            showInfoModal(t("err_join_failed"), false);
        });
        return;
    }

    endGameModal.classList.add("hidden");
    markMyselfLeftExplicitly();

    if (isOnlineGame) {
        cleanupFinishedRoom();
    }
    if (isBotGame) {
        if (ownerSessionAttached) {
            // Synced-сессия: НЕ трогаем Firebase вообще — ни саму сессию, ни
            // публичную spectate-комнату. Другое устройство (если открыто)
            // продолжает как ни в чём не бывало. Останавливаем только то,
            // что принадлежит именно этому устройству (listener, heartbeat,
            // локальный таймер хода бота).
            detachFromOwnerBotSessionLocally();
        } else {
            stopBotSpectateRoom();
        }
        isBotGame = false;
        finishLocalOnlyBotSeries();
        showScreen(menuScreen);
        return;
    }
    if (window.Telegram && window.Telegram.WebApp) Telegram.WebApp.close();
});

function cleanupFinishedRoom() {
    if (!canUseFirebase()) { detachMyPresence(); return false; }
    if (!roomCode) return false;
    if (!isFinishedGenerationSafeToDestroy()) {
        requestSettlement();
        return false;
    }
    const codeToClean = roomCode;
    if (myTelegramId) {
        database.ref("users/" + myTelegramId + "/rooms/" + codeToClean).remove();
    }
    const oppColor = myColor === "light" ? "dark" : "light";
    if (currentState && currentState.players && currentState.players[oppColor] && currentState.players[oppColor].id) {
        database.ref("users/" + currentState.players[oppColor].id + "/rooms/" + codeToClean).remove();
    }
    database.ref("rooms/" + codeToClean).remove();
    detachMyPresence();
    // Инвалидируем поколение СРАЗУ после постановки remove в очередь. Иначе
    // параллельный callback старой кнопки «Реванш» мог после удаления снова
    // записать rematchProposal и воскресить комнату огрызком.
    isOnlineGame = false;
    roomCode = null;
    return true;
}

btnNewGame.addEventListener("click", function () {
    if (isOnlineGame) {
        if (!requireFirebaseAuth()) return;
        const codeAtClick = roomCode;
        const generationAtClick = currentState
            ? ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) : null;

        // В mixed C1↔v193 старый соперник не умеет ждать settlement перед
        // accept. Поэтому C1 не публикует САМО предложение реванша, пока
        // результат старой rated-партии не закреплён сервером.
        waitForSettlementBeforeRoomMutation().then(function (outcome) {
            if (outcome === "blocked") {
                showInfoModal(t("rating_settlement_failed"), false);
                return;
            }
            if (outcome !== "safe") return;
            const stillSameFinished = roomCode === codeAtClick && currentState
                && ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) === generationAtClick
                && !!currentState.winner;
            if (!stillSameFinished) return;
            return database.ref("rooms/" + roomCode + "/rematchProposal")
                .set({ by: myColor, name: myTelegramName });
        }).catch(function (error) {
            console.error("Rematch proposal failed:", error);
            showInfoModal(t("err_rematch_failed"), false);
        });
    } else if (isBotGame && ownerSessionAttached) {
        endGameModal.classList.add("hidden");
        const oldMatchId = currentBotMatchId;
        applyRematchViaSession(oldMatchId, buildFreshBotGameState()).then(function (result) {
            if (result.committed) {
                // Обновляем публичную room СРАЗУ — players пересчитается с
                // НОВЫМ botColor (цвет меняется на реванше), не дожидаясь
                // первого хода новой партии. Тот же spectateRoomCode.
                mirrorCommittedStateToSpectateRoom(result.snapshot.val().spectateRoomCode, result.snapshot.val());
            }
            // committed=false — кто-то другой уже сделал реванш раньше;
            // его собственный вызов уже обновил комнату, повторять не нужно.
        }).catch(function () {
            // Настоящая ошибка Firebase — сообщаем, не оставляем молча на
            // статичной доске без обратной связи. abort (кто-то другой уже
            // сделал реванш раньше) сюда не попадает — это committed:false,
            // не reject; тогда listener просто доставит уже созданную им партию.
            showInfoModal(t("err_join_failed"), false);
        });
        // Ничего больше делать не нужно: и это же устройство, и второе (если
        // открыто) получат новое состояние через уже подключённый listener —
        // отдельного локального обновления currentState здесь не требуется.
    } else if (isBotGame) {
        endGameModal.classList.add("hidden");
        startOfflineGame();
    } else {
        endGameModal.classList.add("hidden");
        startOfflineGame();
    }
});

function performRematchReset(expectedGenerationKey) {
    if (!canUseFirebase()) return Promise.reject(new Error("firebase_auth_required"));
    // Defense-in-depth against double accept / stale async callbacks. If another
    // device (or an earlier click on this device) already started N+1, this
    // callback must join that generation, never manufacture N+2 from an active
    // board. The expected key is captured before waiting for settlement.
    if (!currentState || !currentState.winner || !roomCode) {
        return Promise.reject(new Error("rematch_generation_changed"));
    }
    const actualGenerationKey = ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt);
    if (expectedGenerationKey && actualGenerationKey !== expectedGenerationKey) {
        return Promise.reject(new Error("rematch_generation_changed"));
    }
    if (!isFinishedGenerationSafeToDestroy()) {
        requestSettlement();
        return Promise.reject(new Error("settlement_pending"));
    }
    // Используем .update() вместо .transaction().
    // Это избегает циклов retry, которые конфликтуют с App Check Enforce.
    // Мы берем цвета игроков из локального состояния (они 100% точные).
    const updates = {};
    updates["pieces"] = createInitialPieces();
    updates["turn"] = "light";
    updates["mustContinueFrom"] = null;
    updates["capturedDark"] = 0;
    updates["capturedLight"] = 0;
    updates["moveCount"] = 0;

    // Каждая партия внутри одной комнаты получает новый номер.
    // Первая партия = 0, первый реванш = 1, второй = 2 и т.д.
    updates["matchNumber"] = (currentState.matchNumber || 0) + 1;

    // Полный сброс автоматической ничьей — новая партия начинается с чистой
    // историей, стартовая позиция сразу считается первым появлением.
    updates["kingOnlyStreak"] = 0;
    updates["noProgressStreak"] = 0;
    updates["positionHistory"] = [getDrawPositionKey(createInitialPieces(), "light")];
    updates["longRoadAttacker"] = null;
    updates["longRoadStreak"] = 0;

    updates["moveType"] = null;
    updates["lastMove"] = null;
    updates["lastMovePath"] = null;
    updates["lastCapturedSquares"] = null;
    updates["pendingRemovals"] = null;
    updates["winner"] = null;
    updates["winReason"] = null;
    // v180: реванш — новая партия, поэтому технический результат прошлой
    // партии снимается ВМЕСТЕ с winner/winReason, одной операцией. Итоговое
    // состояние комнаты остаётся согласованным (нет result — нет и
    // winReason "disconnect"), поэтому инвариант уровня комнаты выполняется.
    updates["result"] = null;
    updates["status"] = "active";
    updates["turnStartedAt"] = firebase.database.ServerValue.TIMESTAMP;
    updates["rematchProposal"] = null;
    updates["drawProposal"] = null;
    updates["reaction"] = null;

    // ELO: реванш — это НОВАЯ партия (matchNumber выше, стороны меняются),
    // поэтому снимок рейтингов обнуляется. Обе стороны запишут свои
    // актуальные рейтинги заново при регистрации на сервере, и матч
    // получит новый matchId. Никогда не переиспользуем старый снимок.
    updates["ratingsAtStart"] = null;
    
    const oldLight = (currentState.players && currentState.players.light) ? currentState.players.light : null;
    const oldDark = (currentState.players && currentState.players.dark) ? currentState.players.dark : null;
    updates["players"] = { light: oldDark, dark: oldLight };
    
    return database.ref("rooms/" + roomCode).update(updates);
}

function checkRematchProposal() {
    if (!rematchRequestModal) return;
    if (!isOnlineGame || !currentState) {
        rematchRequestModal.classList.add("hidden");
        return;
    }
    const proposal = currentState.rematchProposal;
    const buttonsRow = endGameModal.querySelector(".modal-buttons");

    if (!proposal) {
        rematchRequestModal.classList.add("hidden");
        if (buttonsRow) buttonsRow.classList.remove("hidden");
        return;
    }

    if (proposal.by === myColor) {
        rematchRequestModal.classList.add("hidden");
        if (currentState.winner) {
            endGameText.textContent = endGameText.textContent.split("\n\n⏳")[0] + "\n\n" + t("waiting_rematch");
            if (buttonsRow) {
                buttonsRow.classList.remove("hidden");
                btnNewGame.classList.add("hidden"); // Прячем "Новая игра"
                btnCloseGame.classList.remove("hidden"); // Показываем "Закрыть"
                btnCloseGame.textContent = t("btn_cancel"); // Меняем текст
            }
        }
    } else {
        rematchRequestText.textContent = (proposal.name || t("opponent_default")) + t("offers_rematch");
        rematchRequestModal.classList.remove("hidden");
    }
}

// ЗАЩИТА ОТ ГОНКИ РАСЧЁТА И БЫСТРОГО РЕВАНША.
//
// Worker при расчёте читает ТЕКУЩУЮ комнату. performRematchReset стирает
// исход прошлой партии: winner обнуляется, matchNumber растёт, стороны
// меняются, ratingsAtStart исчезает. Если игрок примет реванш раньше,
// чем сервер успеет прочитать завершённую комнату, авторитетный исход
// прошлого поколения пропадёт — и партия останется без начисления.
//
// Замороженный контекст на клиенте от этого НЕ спасает: он защищает
// только отрисовку ответа, а не то, что увидит сервер.
//
// Поэтому реванш откладывается до подтверждённого ответа расчёта.
// ratingConfirmed:false — тоже успешный ответ: сервер квитанцию увидел
// и проверил, просто дельту не подтверждает.
function waitForSettlementBeforeRoomMutation() {
    if (!isOnlineGame || isSpectator || !currentState || !roomCode) {
        return Promise.resolve("safe");
    }

    const key = ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt);

    // Recovery after reload/other device: if the room already carries the
    // canonical server pointer, reconstruct local success before deciding.
    if (getRatedJoinPhase(key) !== "success") {
        const registered = registeredMatchIdForState(currentState, roomCode);
        if (registered) {
            ratedJoinState[key] = { phase: "success", attempts: 0, matchId: registered };
        }
    }

    // Нерейтинговая партия не имеет server outcome, который надо сохранять.
    if (getRatedJoinPhase(key) !== "success") return Promise.resolve("safe");
    if (isSettlementSettled(key)) return Promise.resolve("safe");

    // Смысловой отказ settlement НЕ даёт разрешения стереть outcome.
    // Закрыть приложение пользователь может локально, но реванш/cleanup
    // не должны превращать неподтверждённый rated-result в потерянный навсегда.
    if (isSettlementTerminalFailed(key)) return Promise.resolve("blocked");

    requestSettlement();
    if (rematchWaitNote) rematchWaitNote.textContent = t("rating_confirming");

    return new Promise(function (resolve) {
        const tick = setInterval(function () {
            const stillSame = currentState && roomCode
                && ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) === key;

            if (!stillSame) {
                clearInterval(tick);
                if (rematchWaitNote) rematchWaitNote.textContent = "";
                resolve("changed");
                return;
            }

            if (isSettlementSettled(key)) {
                clearInterval(tick);
                if (rematchWaitNote) rematchWaitNote.textContent = "";
                resolve("safe");
                return;
            }

            if (isSettlementTerminalFailed(key)) {
                clearInterval(tick);
                if (rematchWaitNote) rematchWaitNote.textContent = "";
                resolve("blocked");
                return;
            }

            // Для transient failure НЕТ тайм-аута, который молча уничтожает
            // authoritative outcome. requestSettlement сам держит backoff.
            if (getSettlePhase(key) === "idle") requestSettlement();
        }, 400);
    });
}

function waitForSettlementBeforeRematch() {
    return waitForSettlementBeforeRoomMutation();
}

btnRematchAccept.addEventListener("click", function () {
    rematchRequestModal.classList.add("hidden");
    const generationAtAccept = (currentState && roomCode)
        ? ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) : null;

    waitForSettlementBeforeRematch().then(function (outcome) {
        if (outcome === "blocked") {
            showInfoModal(t("rating_settlement_failed"), false);
            return "blocked";
        }
        if (outcome === "changed") return "changed";

        // Между resolve("safe") и этим callback другое устройство/другой
        // клик уже мог начать реванш. Проверяем поколение ЕЩЁ РАЗ до reset.
        const stillOurFinishedGeneration = generationAtAccept && currentState && roomCode
            && !!currentState.winner
            && ratedGenerationKey(roomCode, currentState.matchNumber, currentState.createdAt) === generationAtAccept;
        if (!stillOurFinishedGeneration) return "changed";

        return performRematchReset(generationAtAccept)
            .then(function () { return "reset"; })
            .catch(function (error) {
                // Если другой callback опередил нас и уже начал N+1, это не
                // ошибка реванша: ниже просто войдём в фактическое поколение.
                if (error && error.message === "rematch_generation_changed") return "changed";
                throw error;
            });
    }).then(function (outcome) {
        if (outcome === "blocked" || !roomCode) return;
        // После нашего reset либо после reset другого устройства читаем
        // фактические стороны и только затем входим в новую партию.
        return database.ref("rooms/" + roomCode + "/players").once("value").then(function (snap) {
            const players = snap.val() || {};
            if (players.light && players.light.id === myTelegramId) {
                myColor = "light";
            } else if (players.dark && players.dark.id === myTelegramId) {
                myColor = "dark";
            } else {
                throw new Error("rematch_not_a_player");
            }
            endGameModal.classList.add("hidden");
            showScreen(gameScreen);
            startOnlineGame();
        });
    }).catch(function(error) {
        console.error("Rematch update failed:", error);
        showInfoModal(t("err_rematch_failed"), false);
    });
});

btnRematchDecline.addEventListener("click", function () {
    rematchRequestModal.classList.add("hidden");
    if (canUseFirebase()) database.ref("rooms/" + roomCode + "/rematchProposal").remove();
});

// Кнопка «Повторить» создаётся лениво и существует только в состоянии
// неудавшегося восстановления — в обычной игре её в DOM нет вовсе.
let syncRetryButton = null;

function renderSyncRetryButton(show) {
    if (!show) {
        if (syncRetryButton && syncRetryButton.parentNode) {
            syncRetryButton.parentNode.removeChild(syncRetryButton);
        }
        syncRetryButton = null;
        return;
    }
    if (syncRetryButton) return;
    syncRetryButton = document.createElement("button");
    syncRetryButton.className = "reaction-btn";
    syncRetryButton.id = "btn-sync-retry";
    syncRetryButton.textContent = t("btn_sync_retry");
    syncRetryButton.addEventListener("click", function () {
        // Только повторная синхронизация. Шашечный ход НЕ переотправляется.
        syncRecoveryFailed = false;
        runSyncRecovery(true);
    });
    turnTimerDiv.appendChild(syncRetryButton);
}

// ===== СТАТУС СИНХРОНИЗАЦИИ ХОДА =====

// Возвращает { key, showRetry } либо null, если показывать нечего.
// Никаких сетевых запросов: всё выводится из уже имеющегося состояния.
// Только реальная online-партия игрока — бот, локальная игра, зритель, лобби,
// законченная партия и выход из комнаты сюда не попадают.
function computeSyncStatus() {
    if (!isOnlineGame || isBotGame || isSpectator) return null;
    if (!roomCode || !currentState || currentState.winner) return null;

    // Восстановление не удалось — единственное состояние с кнопкой.
    if (syncRecoveryFailed) return { key: "sync_failed", showRetry: true };
    if (!isMoveAwaitingConfirmation()) return null;

    // Связь потеряна — говорим правду сразу, не дожидаясь таймера.
    // Ход не потерян: Firebase отправит его сам при восстановлении связи.
    if (!isFirebaseConnected) return { key: "sync_no_connection", showRetry: false };

    // Связь есть, но сервер молчит слишком долго — редкий случай.
    if (Date.now() - pendingMoveStartedAt >= MOVE_CONFIRM_STALL_MS) {
        return { key: "sync_checking", showRetry: false };
    }
    return { key: "sync_sending_move", showRetry: false };
}

// Единственное безопасное восстановление: ЧИТАЕТ состояние комнаты.
// Сам ход не переотправляется никогда. Читать безопасно даже при живой
// медленной транзакции: она атомарна и при применении заново сверяется
// с серверным состоянием (attemptMove проверяет turn и mustContinueFrom).
function runSyncRecovery(isManual) {
    if (syncRecoveryInFlight) return; // ровно одно восстановление за раз
    if (!roomCode || !isOnlineGame || isSpectator) return;
    syncRecoveryInFlight = true;
    forceResyncFromServer(true).then(function () {
        syncRecoveryFailed = false;
        // ВАЖНО (v178): восстановление НЕ снимает ожидание подтверждения хода.
        // Раньше здесь стояло pendingMoveStartedAt = null — то есть успешное
        // ЧТЕНИЕ объявлялось признаком того, что транзакция хода завершилась.
        // Это неверно: чтение и судьба транзакции — независимые события, и при
        // незавершённой локальной записи прочитанное состояние вообще может
        // быть локальным представлением, а не каноническим серверным.
        // Ожидание снимает ТОЛЬКО реальный исход транзакции — её .then или
        // .catch в performMove. Так исключён сценарий «recovery объявил ход
        // законченным, а транзакция ожила и применилась позже».
        syncRecoveryInFlight = false;
        updateTimerDisplay();
    }).catch(function () {
        syncRecoveryFailed = true;
        syncRecoveryInFlight = false;
        updateTimerDisplay();
    });
    if (isManual) updateTimerDisplay();
}

// ===== ТАЙМЕР ХОДА =====

setInterval(function () {
    if (!gameScreen.classList.contains("hidden")) {
        updateTimerDisplay();
        checkTimeout();
        updatePresenceOnly();
        // Автоматическое восстановление — только при живой связи: без неё
        // чтение всё равно не пройдёт, а ход и так уедет сам при реконнекте.
        if (isMoveAwaitingConfirmation() && isFirebaseConnected &&
            !syncRecoveryInFlight && !syncRecoveryFailed &&
            Date.now() - pendingMoveStartedAt >= MOVE_CONFIRM_STALL_MS) {
            runSyncRecovery(false);
        }
    }
}, 1000);

// --- Специально для зрителя: полное истечение grace-периода у РЕАЛЬНОГO
// игрока (не бота — presence.online у bot-зеркала намеренно никогда не
// false, но lastSeen всё равно перестаёт обновляться, когда владелец ушёл
// — см. PRESENCE_STALE_WARNING_MS выше). Не читает Firebase заново — та
// же presence, что уже пришла с обычным room-listener'ом. checkOpponentAbsence()
// не подходит — она явно исключает зрителя (у неё другая, игровая
// семантика для самого игрока, не для наблюдателя). ---
function checkSpectatorGameInterrupted() {
    if (!isSpectator || !currentState || currentState.winner) return;
    if (spectatorInterruptedModalShown) return;
    const presence = currentState.presence;
    if (!presence) return;
    const lightElapsed = presence.light ? (Date.now() - (presence.light.lastSeen || 0)) : Infinity;
    const darkElapsed = presence.dark ? (Date.now() - (presence.dark.lastSeen || 0)) : Infinity;
    if (lightElapsed > RECONNECT_GRACE_MS || darkElapsed > RECONNECT_GRACE_MS) {
        spectatorInterruptedModalShown = true;
        if (spectatorInterruptedModal) spectatorInterruptedModal.classList.remove("hidden");
    }
}

function updatePresenceOnly() {
    if (!isOnlineGame || !currentState) return;
    const topColor = flipped ? "light" : "dark";
    const bottomColor = flipped ? "dark" : "light";
    applyStatusToElement(playerTopStatus, playerTopPanel, statusForColor(topColor));
    applyStatusToElement(playerBottomStatus, playerBottomPanel, statusForColor(bottomColor));
    checkOpponentAbsence();
    if (isSpectator) checkSpectatorGameInterrupted();
}

function checkTimeout() {
    if (isSpectator) return;
    if (!isOnlineGame || !currentState || currentState.winner) return;
    if (!canUseFirebase()) return;
    if (!currentState.timeControlSeconds || !currentState.turnStartedAt) return;

    // CLOCK SAFETY, FAIL CLOSED. Поражение по времени необратимо, поэтому без
    // подтверждённого .info/serverTimeOffset решение не принимается вовсе.
    // Пока смещение не получено, getEstimatedServerNow() равен часам телефона,
    // а по ним засчитывать поражение нельзя: при спешащих часах соперник
    // проигрывал бы раньше срока.
    // Цена отказа — партия живёт лишние доли секунды после подключения.
    // Цена ошибки — незаслуженное поражение. Размен очевиден.
    if (!serverTimeOffsetReady) return;

    const elapsed = (getEstimatedServerNow() - currentState.turnStartedAt) / 1000;
    if (elapsed <= currentState.timeControlSeconds) return;

    const loser = currentState.turn;
    // ВРЕМЕННАЯ ИНВАРИАНТА ФАЗЫ 1: клиент без подтверждённой связи не создаёт
    // НОВУЮ транзакцию на весь узел комнаты, пока такая транзакция всё ещё
    // владеет presence обоих игроков. Причина техническая, а не игровая:
    // незавершённая whole-room транзакция накладывается на приходящие
    // серверные данные и способна подменить присутствие соперника устаревшим
    // слепком. Снимется в Фазе 2, когда игровое состояние будет физически
    // отделено от presence.
    // Для таймаута это особенно важно: решение принимает АВТОМАТИКА по
    // локальному таймеру. Клиент без подтверждённой связи не должен запускать
    // серверно значимую транзакцию — тем более что его собственные данные о
    // партии могли устареть за время обрыва.
    if (!isFirebaseConnected) return;
    database.ref("rooms/" + roomCode).transaction(function (room) {
        // v180 ГОНКА ОБЫЧНОГО И ТЕХНИЧЕСКОГО ИСХОДА. Если технический
        // результат уже создан, обычное завершение ОТМЕНЯЕТСЯ: одна партия —
        // ровно один исход. Проверка стоит первой строкой каждой whole-room
        // транзакции, а транзакция перечитывает СЕРВЕРНЫЕ данные при гонке,
        // поэтому подмена уже записанного результата невозможна.
        if (!room || room.winner || room.result) return;
        if (room.turn !== loser) return room;
        const newRoom = {};
        for (const key in room) newRoom[key] = room[key];
        newRoom.winner = loser === "light" ? "dark" : "light";
        newRoom.winReason = "timeout";
        newRoom.status = "finished";
        return newRoom;
    }).catch(function(error) {
        console.error("Timeout transaction failed:", error);
    });
}

// ===== ПРИСОЕДИНЕНИЕ ПО ССЫЛКЕ =====

let infoModalShouldNavigate = true; // Флаг: возвращать ли в меню при закрытии

function showInfoModal(text, offerNewGame, navigateToMenu) {
    // Если параметр не передан — по умолчанию true (возвращаться в меню)
    infoModalShouldNavigate = (navigateToMenu === undefined) ? true : navigateToMenu;
    
    infoModalText.textContent = text;
    if (offerNewGame) {
        btnInfoNewGame.classList.remove("hidden");
        btnInfoClose.textContent = t("btn_close");
    } else {
        btnInfoNewGame.classList.add("hidden");
        btnInfoClose.textContent = t("btn_ok");
    }
    infoModal.classList.remove("hidden");
}

function checkForInviteLink() {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return false;
    let startParam = null;

    if (window.Telegram &&
        window.Telegram.WebApp &&
        Telegram.WebApp.initDataUnsafe &&
        Telegram.WebApp.initDataUnsafe.start_param) {
        startParam = Telegram.WebApp.initDataUnsafe.start_param;
    }

    if (!startParam) return false;

    roomCode = startParam;

    showScreen(waitingScreen);
    waitingText.textContent = t("checking_game");
    inviteLinkBox.classList.add("hidden");
    btnShareLink.classList.add("hidden");

    let settled = false;

    const inviteRoomCodeAtStart = roomCode;

    const timeoutId = setTimeout(function () {
        if (settled) return;

        settled = true;
        // В этой версии нет отдельного сохранённого seat-claim: место и
        // перевод комнаты в active выполняются одной root-транзакцией. Поэтому
        // таймауту нечего отдельно удалять и он не может повредить уже active
        // или finished комнату чтением устаревшего локального кеша.
        roomCode = null;
        myColor = "light";
        isOnlineGame = false;
        isSpectator = false;
        showScreen(menuScreen);
        loadActiveRooms();
        showInfoModal(t("err_load_game"), false);
    }, 10000);

    database.ref("rooms/" + roomCode).once("value").then(function (snapshot) {
        if (settled) return;

        const room = snapshot.val();

        // v184 BOTH-OFFLINE добавлен к тем же условиям, по которым ссылка уже
        // сегодня отказывается открывать завершённую партию: сообщение и
        // возврат в меню те же, новых текстов не вводим.
        if (!room || !room.pieces || room.status === "finished" || room.winner ||
            isRoomAbandonedNow(room)) {
            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal(t("err_no_active_game"), false);
            return;
        }

        const creatorId =
            room.players && room.players.light
                ? room.players.light.id
                : null;

        const creatorName =
            room.players && room.players.light
                ? room.players.light.name
                : t("opponent_default");

        if (creatorId && creatorId === myTelegramId) {
            // Моя собственная партия уже активна — возвращаемся как игрок.
            if (room.status === "active") {
                settled = true;
                clearTimeout(timeoutId);

                resumeOwnActiveRoom(roomCode).then(function (resumed) {
                    if (!resumed) {
                        roomCode = null;
                        showScreen(menuScreen);
                        loadActiveRooms();
                        showInfoModal(t("err_no_active_game"), false);
                    }
                });

                return;
            }

            // Моя собственная комната ещё ждёт друга — просто показываем
            // экран ожидания заново, а не ошибку "нельзя играть с собой".
            if (room.status === "waiting") {
                myColor = "light";
                isOnlineGame = true;
                isSpectator = false;
                myPendingFriendRoomCode = roomCode;

                settled = true;
                clearTimeout(timeoutId);

                myWaitingRoomNoOpponent = true; // (v171) моя waiting-комната, dark ещё нет
                setupPresence();

                const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
                inviteLinkBox.textContent = link;
                waitingText.textContent = "Ожидание подключения друга...";
                inviteLinkBox.classList.remove("hidden");
                btnShareLink.classList.remove("hidden");

                showScreen(waitingScreen);

                // Тот же слушатель, что и в createRoomAndShowWaiting() — без него
                // экран ожидания не переключится сам на игру, когда друг подключится.
                database.ref("rooms/" + roomCode + "/status").on("value", function (snapshot) {
                    if (snapshot.val() === "active") {
                        database.ref("rooms/" + roomCode + "/status").off();
                        waitingText.textContent = "Друг подключился! Начинаем игру.";
                        setTimeout(function () {
                            showScreen(gameScreen);
                            startOnlineGame();
                        }, 1000);
                    }
                });

                return;
            }

            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal(t("err_play_self"), false);
            return;
        }

        // Повторное открытие той же ссылки тем же приглашённым игроком.
        if (room.status === "active" &&
            room.players &&
            room.players.dark &&
            room.players.dark.id === myTelegramId) {

            myColor = "dark";
            isOnlineGame = true;
            isSpectator = false;

            settled = true;
            clearTimeout(timeoutId);

            showScreen(gameScreen);
            startOnlineGame();
            return;
        }

        // Для первого подключения комната должна именно ждать игрока.
        if (room.status !== "waiting") {
            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal(t("err_room_taken"), false);
            return;
        }

        // Дополнительная защита перед записью:
        // если место чёрных уже занял другой игрок — не подключаемся.
        if (room.players &&
            room.players.dark &&
            room.players.dark.id &&
            room.players.dark.id !== myTelegramId) {

            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            myColor = "light";
            isOnlineGame = false;
            isSpectator = false;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal(t("err_room_taken"), false);
            return;
        }

        myColor = "dark";
        isOnlineGame = true;
        isSpectator = false;
        waitingText.textContent = t("connecting_to_friend");

        // Один атомарный join по КОРНЮ комнаты. Здесь намеренно НЕТ отдельного
        // постоянного захвата players/dark перед активацией: именно промежуток
        // между двумя серверными операциями создавал все timeout-cleanup гонки.
        // Теперь либо waiting-комната одним commit становится active с нашим
        // dark, либо на сервере не меняется вообще ничего.
        const inviteRoomRef = database.ref("rooms/" + inviteRoomCodeAtStart);

        function finishInviteFailure(msgKey) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            myColor = "light";
            isOnlineGame = false;
            isSpectator = false;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal(t(msgKey), false);
        }

        function finishInviteSuccess() {
            if (settled) return;
            if (!canUseFirebase()) { finishInviteFailure("err_auth_required"); return; }
            settled = true;
            clearTimeout(timeoutId);

            database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
                opponentName: creatorName,
                myColor: "dark"
            });

            if (creatorId) {
                database.ref("users/" + creatorId + "/rooms/" + roomCode).update({
                    opponentName: myTelegramName
                });
            }

            setTimeout(function () {
                showScreen(gameScreen);
                startOnlineGame();
            }, 800);
        }

        // Старый root-transaction (44d3af0) ломался на холодном кеше: callback
        // получал null и сам же abort'ил транзакцию. Здесь корень уже прочитан
        // once() выше, а дополнительный value-listener удерживается ДО полного
        // завершения transaction, чтобы кеш комнаты не был выброшен в процессе.
        let warmHandler = null;
        let latestWarmRoom = null;
        function detachWarmListener() {
            if (!warmHandler) return;
            inviteRoomRef.off("value", warmHandler);
            warmHandler = null;
        }

        let inviteJoinAttempts = 0;
        const INVITE_JOIN_MAX_ATTEMPTS = 3;

        function startAtomicInviteJoin() {
            inviteJoinAttempts++;
            return new Promise(function (resolve) {
                let first = true;
                warmHandler = inviteRoomRef.on("value", function (snap) {
                    latestWarmRoom = snap ? snap.val() : null;
                    if (!first) return;
                    first = false;
                    resolve();
                });
            }).then(function () {
                // Если 10 секунд истекли ЕЩЁ ДО старта серверной транзакции,
                // ничего больше не запускаем. Это отличает «таймаут до join»
                // от «таймаут, пока уже отправленный атомарный join ждёт ACK».
                if (settled) {
                    detachWarmListener();
                    return null;
                }

                // applyLocally=false не даёт speculative active попасть в тот же
                // локальный кеш до server commit. Но главное здесь — сама запись
                // ОДНА: dark + status + turnStartedAt атомарны относительно всех
                // конкурирующих изменений комнаты.
                if (!canUseFirebase()) return Promise.resolve(null);
        return inviteRoomRef.transaction(function (currentRoom) {
                    return buildAtomicInviteJoin(currentRoom, myTelegramId, myTelegramName);
                }, undefined, false);
            }).then(function (result) {
                detachWarmListener();

                if (settled) {
                    // Таймаут уже вернул пользователя в меню. Отдельного seat,
                    // который нужно чистить, нет. Если commit состоялся — это
                    // полноценная active-комната с обоими игроками; повторный
                    // вход по ссылке восстановит dark. Если нет — сервер вообще
                    // не изменён.
                    return;
                }

                if (result && result.committed) {
                    finishInviteSuccess();
                    return;
                }

                // Прерывание само по себе НЕ означает "занято". Классифицируем
                // только по последнему подтверждённому состоянию удерживаемого
                // listener-а. Если оно не даёт однозначного ответа — общая
                // ошибка входа, а не ложный err_room_taken.
                const verdictRoom = result && result.snapshot && typeof result.snapshot.val === "function"
                    ? result.snapshot.val()
                    : latestWarmRoom;
                const verdict = classifyAtomicInviteJoinFailure(verdictRoom, myTelegramId);
                if (verdict === "occupied" || verdict === "not_waiting") {
                    finishInviteFailure("err_room_taken");
                    return;
                }
                if (verdict === "missing") { finishInviteFailure("err_no_active_game"); return; }
                if (verdict === "self") { finishInviteFailure("err_play_self"); return; }
                if (verdict === "won") { finishInviteSuccess(); return; }

                // verdict === "unknown": комната свободна и ждёт, значит
                // прерывание было ЛОЖНЫМ — транзакция не смогла договориться
                // с сервером, а не место занято.
                //
                // Повтор здесь обязателен. Без него единственное транзиентное
                // прерывание на неустойчивой сети превращается в отказ входа,
                // хотя комната свободна. В двухфазной версии такой повтор был,
                // и терять его вместе с лишними состояниями не нужно: он не
                // добавляет промежуточного состояния на сервере, потому что
                // неудавшаяся транзакция не оставляет следов.
                if (inviteJoinAttempts < INVITE_JOIN_MAX_ATTEMPTS) {
                    return startAtomicInviteJoin();
                }

                // Попытки исчерпаны, а комната всё ещё свободна. Это «не
                // смогли записать», а НЕ «место занято»: ровно на этой подмене
                // ломалась откаченная схема 44d3af0.
                finishInviteFailure("err_join_failed");
            }).catch(function (error) {
                detachWarmListener();
                console.error("Invite atomic join failed:", error);
                finishInviteFailure("err_join_failed");
            });
        }

        startAtomicInviteJoin();

    }).catch(function (error) {
        console.error("Invite room read failed:", error);

        if (settled) return;

        settled = true;
        clearTimeout(timeoutId);
        roomCode = null;
        showScreen(menuScreen);
        loadActiveRooms();
        showInfoModal(t("err_join_failed"), false);
    });

    return true;
}

// ===== МОДАЛКА "СОПЕРНИК ПОКИНУЛ ИГРУ" =====

btnNewGameAfterLeave.addEventListener("click", function () {
    opponentLeftModal.classList.add("hidden");
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    stopPresenceHeartbeat();
    roomCode = null;
    currentState = null;
    isOnlineGame = true;
    showScreen(timeControlScreen);
});

btnCloseAfterLeave.addEventListener("click", function () {
    opponentLeftModal.classList.add("hidden");
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    stopPresenceHeartbeat();
    if (window.Telegram && window.Telegram.WebApp) {
        Telegram.WebApp.close();
    } else {
        roomCode = null;
        currentState = null;
        showScreen(menuScreen);
        loadActiveRooms();
    }
});

// ===== МОДАЛКА "НЕТ ИГРЫ / НЕЛЬЗЯ ИГРАТЬ С СОБОЙ" =====

btnInfoNewGame.addEventListener("click", function () {
    infoModal.classList.add("hidden");
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    stopPresenceHeartbeat();
    roomCode = null;
    currentState = null;
    isOnlineGame = true;
    showScreen(timeControlScreen);
});

btnInfoClose.addEventListener("click", function () {
    infoModal.classList.add("hidden");
    // Если флаг разрешает навигацию — возвращаемся в меню.
    // Если нет (например, при отказе от ничьи) — просто остаемся на текущем экране.
    if (infoModalShouldNavigate) {
        showScreen(menuScreen);
        loadActiveRooms();
    }
});

// ===== МОДАЛКА "СОПЕРНИК ОФЛАЙН" =====

btnOfflinePlayBot.addEventListener("click", function () {
    offlineOpponentModal.classList.add("hidden");
    roomCode = null;
    showScreen(gameScreen);
    isBotGame = true;
    promptBotDifficultyThenStart();
});

btnOfflineInviteFriend.addEventListener("click", function () {
    offlineOpponentModal.classList.add("hidden");
    pendingTimeControlSeconds = 0;
    createRoomAndShowWaiting();
    setTimeout(function() {
        const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + myPendingFriendRoomCode;
        const shareUrl = "https://t.me/share/url?url=" + encodeURIComponent(link);
        if (window.Telegram && window.Telegram.WebApp) {
            Telegram.WebApp.openTelegramLink(shareUrl);
        } else {
            window.open(shareUrl, "_blank");
        }
    }, 500);
});

// ===== СТАТИСТИКА И РЕЙТИНГ =====

// Общий рендер "медаль/номер места + имя (кликабельная @ссылка, если есть)".
// Используется и Online-строкой, и Bot-карточкой, чтобы не дублировать логику.
function renderRankAndName(rank, name) {
    const rankSpan = document.createElement("span");
    rankSpan.className = "stats-name-block";

    const rankNumber = document.createElement("span");
    rankNumber.className = "stats-rank";
    const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
    rankNumber.textContent = medals[rank] || (rank + ".");
    rankSpan.appendChild(rankNumber);

    const maxNameLength = 14;
    const displayName = (typeof name === "string" && name.length > maxNameLength)
        ? name.substring(0, maxNameLength) + "…"
        : name;

    if (typeof name === 'string' && name.startsWith('@')) {
        const link = document.createElement("a");
        link.href = "https://t.me/" + name.substring(1);
        link.textContent = displayName;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "stats-user-link stats-name-text";
        rankSpan.appendChild(link);
    } else {
        // Обычное имя тоже заворачиваем в span с ellipsis-классом: в сетке
        // 50/50 имя обязано обрезаться внутри своей половины и НИКОГДА не
        // выталкивать статистику правее её фиксированной границы.
        const nameSpan = document.createElement("span");
        nameSpan.className = "stats-name-text";
        nameSpan.textContent = displayName;
        rankSpan.appendChild(nameSpan);
    }
    return rankSpan;
}

// Компактная строка для рейтинга Online: место, имя, ⭐ рейтинг, победы,
// поражения, игры. 🎮 = wins + losses + draws: с появлением Elo ничьи
// записываются (stats/<id>/draws) и обязаны попадать в число сыгранных
// партий. Отдельного поля games в Firebase нет — оно производное.
// Старые записи без rating/draws отображаются как рейтинг 1000 и 0 ничьих.
function renderOnlineStatsRow(rank, name, wins, losses, draws, rating) {
    const row = document.createElement("div");
    row.className = "stats-row";
    row.appendChild(renderRankAndName(rank, name));

    const infoSpan = document.createElement("span");
    infoSpan.className = "stats-info-block stats-info-online";
    const drawsValue = (typeof draws === "number") ? draws : 0;
    const total = wins + losses + drawsValue;
    // Каждый показатель — отдельная grid-ячейка: так ⭐/🏆/❌/🎮 у всех
    // строк начинаются строго на одних и тех же вертикалях, независимо от
    // длины имени и количества цифр у соседей.
    [
        "⭐" + normalizeEloRating(rating),
        "🏆" + wins,
        "❌" + losses,
        "🎮" + total
    ].forEach(function (text) {
        const cell = document.createElement("span");
        cell.className = "stats-stat";
        cell.textContent = text;
        infoSpan.appendChild(cell);
    });
    row.appendChild(infoSpan);
    return row;
}

// Отслеживаем единственную раскрытую строку bot-рейтинга за раз — это
// сбрасывается заново при каждом openStatsModal() (см. ниже), так что
// повторное открытие модалки всегда начинается со свёрнутого состояния.

// Компактная строка для рейтинга "С ботом": место, имя, победы, поражения,
// игры — визуально на одном уровне с Online-строкой. Если у записи
// есть byLevel (Medium/Hard появились после введения уровней сложности —
// у старых партий его нет, и это нормально), строка кликабельна и по
// нажатию раскрывает компактную панель разбивки. Easy никогда не пишет
// byLevel и здесь не появляется.
function renderBotStatsRow(rank, name, wins, losses, byLevel) {
    const row = document.createElement("div");
    row.className = "stats-row stats-row-expandable";
    row.appendChild(renderRankAndName(rank, name));

    const infoSpan = document.createElement("span");
    infoSpan.className = "stats-info-block stats-info-bot";
    const total = wins + losses;
    // ЭТАП 2: 🪙 здесь больше НЕ показываем. Раньше в этой строке стоял общий
    // Старую колонку внутренней валюты здесь больше не показываем,
    // хотя таковым не был — цифра вводила в заблуждение. Общий баланс остаётся
    // там, где он и означает общий баланс: в капсуле интерфейса и в игровой
    // панели рядом с именем игрока.
    // Каждый показатель — отдельная grid-ячейка (см. renderOnlineStatsRow):
    // 🏆/❌/🎮 у всех строк стоят на одних и тех же вертикалях.
    ["🏆" + wins, "❌" + losses, "🎮" + total].forEach(function (text) {
        const cell = document.createElement("span");
        cell.className = "stats-stat";
        cell.textContent = text;
        infoSpan.appendChild(cell);
    });
    row.appendChild(infoSpan);

    // Основная таблица остаётся чистой — никаких уровней сложности в строке.
    // ВСЯ строка кликабельна: по нажатию открывается модалка с разбивкой
    // Всего / Средний / Тяжёлый. Открывается всегда, даже если byLevel у
    // старого игрока отсутствует — тогда по уровням безопасно показываем 0.
    row.addEventListener("click", function (event) {
        if (event.target && event.target.classList && event.target.classList.contains("stats-user-link")) {
            return; // клик именно по ссылке-нику — она сама ведёт в Telegram
        }
        openBotDetailsModal(name, wins, losses, byLevel);
    });

    return row;
}

// Модалка подробностей игрока против ботов. Использует ТОЛЬКО данные, уже
// загруженные вместе с leaderboard (entry.byLevel из statsBot) — ни одного
// дополнительного Firebase-чтения здесь нет. Easy отдельно в statsBot не
// хранится, поэтому и не показывается — только Всего / Средний / Тяжёлый.
function openBotDetailsModal(name, wins, losses, byLevel) {
    const modal = document.getElementById("bot-details-modal");
    const title = document.getElementById("bot-details-title");
    const body = document.getElementById("bot-details-body");
    if (!modal || !title || !body) return;

    title.textContent = "🤖 " + name;
    body.innerHTML = "";

    const levels = byLevel || {};
    const medium = levels.medium || {};
    const hard = levels.hard || {};
    // games = wins + losses для каждой строки, включая "Всего" (общие
    // wins/losses берём из тех же данных leaderboard, что и сама таблица).
    const rows = [
        { label: t("bot_details_total"), w: wins || 0, l: losses || 0 },
        { label: t("btn_difficulty_medium"), w: medium.wins || 0, l: medium.losses || 0 },
        { label: t("btn_difficulty_hard"), w: hard.wins || 0, l: hard.losses || 0 }
    ];

    rows.forEach(function (lvl) {
        const labelCell = document.createElement("span");
        labelCell.className = "bot-details-level";
        labelCell.textContent = lvl.label;
        body.appendChild(labelCell);

        ["🏆 " + lvl.w, "❌ " + lvl.l, "🎮 " + (lvl.w + lvl.l)].forEach(function (text) {
            const cell = document.createElement("span");
            cell.className = "bot-details-stat";
            cell.textContent = text;
            body.appendChild(cell);
        });
    });

    modal.classList.remove("hidden");
}

// Отдельная строка для рейтинга "Заработано" — переиспользует те же
// CSS-классы обрезки имени, но показывает только rank/имя/результаты.

// Общая сортировка для обоих рейтингов (Online и Bot):
// 1) больше побед выше; 2) при равенстве — меньше поражений выше;
// 3) win rate НЕ используется отдельным шагом: если wins И losses уже
//    совпали на шагах 1-2, то и win rate (wins/(wins+losses)) у них
//    математически идентичен — как отдельный шаг он ничего не решает;
// 4) финальный детерминированный tie-break — по id, чтобы позиции
//    никогда не "прыгали" случайно между обновлениями страницы.
// Порядок online-топа: rating ↓ → wins ↓ → losses ↑ → id (стабильный tie-break).
// Записи без rating (игрок ещё не сыграл ни одной рейтинговой партии после
// перехода) считаются имеющими ELO_START_RATING — ровно как при расчёте Elo,
// иначе старые игроки провалились бы в самый низ топа.
// Bot-рейтинг использует тот же компаратор: там поля rating нет ни у кого,
// все получают одинаковый дефолт, и сортировка остаётся прежней (wins/losses/id).
function compareLeaderboardEntries(a, b) {
    const aRating = normalizeEloRating(a.rating);
    const bRating = normalizeEloRating(b.rating);
    if (bRating !== aRating) return bRating - aRating;
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return String(a.id).localeCompare(String(b.id));
}

function openStatsModal() {
    statsLeaderboard.innerHTML = "";
    if (statsYourRank) statsYourRank.textContent = "";

    const statsLeaderboardBot = document.getElementById("stats-leaderboard-bot");
    if (statsLeaderboardBot) statsLeaderboardBot.innerHTML = "";

    statsModal.classList.remove("hidden");

    // --- ОНЛАЙН РЕЙТИНГ: ВСЕ ИГРОКИ ---
    // Раньше здесь брались 50 кандидатов ДВУМЯ запросами и после честной
    // сортировки список обрезался до 10. Оба ограничения сняты: вкладка
    // показывает ВСЕХ существующих игроков.
    //
    // Вместе с обрезанием отпала и причина двух запросов. Она была такой:
    // limitToLast по одному полю мог потерять игрока, который по-настоящему
    // входит в верх таблицы, — Firebase при равных значениях упорядочивает
    // внутри группы по КЛЮЧУ, а не по нужному нам полю; второй запрос по
    // "wins" страховал старых игроков без поля rating, которые в
    // rating-запросе отсортировались бы как null и выпали бы из выборки.
    // Когда читается вся ветка, потерять некого: выборка полная по
    // построению, а порядок всё равно задаёт compareLeaderboardEntries.
    //
    // Чтение целиком разрешено правилами: у stats ".read": true без
    // ограничения на запрос. Индекс rating остаётся и работает для других
    // запросов, здесь он просто не нужен.
    //
    // ЦЕНА, называю честно: объём чтения растёт вместе с числом игроков.
    // Одна запись stats невелика (имя, wins, losses, draws, rating), поэтому
    // для проекта такого масштаба это незаметно. Если игроков станут тысячи,
    // понадобится постраничная подгрузка — но это отдельная задача, а не
    // повод и дальше прятать людей из таблицы.
    //
    // Promise.all с одним элементом сохранён намеренно: ниже идёт общий код
    // слияния snapshots, и переписывать его ради косметики значило бы менять
    // больше, чем требует задача.
    Promise.all([
        database.ref("stats").once("value")
    ]).then(function (snapshots) {
        const merged = {};
        snapshots.forEach(function (snapshot) {
            const data = snapshot.val();
            if (!data) return;
            Object.keys(data).forEach(function (key) { merged[key] = data[key]; });
        });
        statsLeaderboard.innerHTML = "";
        const keys = Object.keys(merged);
        if (keys.length === 0) {
            statsLeaderboard.textContent = t("stats_no_online_games");
            return;
        }
        const entries = keys.map(function (key) {
            return {
                id: key,
                name: merged[key].name || "Игрок",
                wins: merged[key].wins || 0,
                losses: merged[key].losses || 0,
                draws: merged[key].draws || 0,
                rating: merged[key].rating
            };
        });
        entries.sort(compareLeaderboardEntries);
        // ВСЕ игроки, без обрезания. Нумерация остаётся index + 1, поэтому
        // места идут подряд до последнего, а медали первым трём выдаёт
        // renderRankAndName по тому же rank. Прокрутка уже обеспечена
        // вёрсткой: .stats-modal-body имеет overflow-y: auto и min-height: 0.
        const top = entries;

        top.forEach(function (entry, index) {
            statsLeaderboard.appendChild(renderOnlineStatsRow(index + 1, entry.name, entry.wins, entry.losses, entry.draws, entry.rating));
        });

        // МЕСТО ИГРОКА. Считается из этого же массива — ни одного
        // дополнительного чтения. В главное меню место не выносим: туда
        // пришлось бы читать всю ветку при каждом открытии.
        if (statsYourRank) {
            let myIndex = -1;
            for (let i = 0; i < entries.length; i++) {
                if (entries[i].id === myTelegramId) { myIndex = i; break; }
            }
            statsYourRank.textContent = (myIndex >= 0)
                ? (t("stats_your_rank") + ": №" + (myIndex + 1) + " " + t("stats_rank_of") + " " + entries.length)
                : "";
        }
    }).catch(function () {
        statsLeaderboard.textContent = t("stats_load_error");
    });

    // --- РЕЙТИНГ ПРОТИВ БОТА ---
    if (statsLeaderboardBot) {
        // --- ВКЛАДКА «С БОТОМ»: ВСЕ ИГРОКИ ---
        // Та же правка: читаем ветку целиком и не обрезаем результат.
        // У statsBot ".read": true без ограничения на запрос, поэтому полное
        // чтение разрешено. Индекса по wins у statsBot нет вовсе, так что
        // orderByChild здесь и раньше исполнялся сортировкой на стороне
        // клиента Firebase — отказ от него ничего не замедляет.
        database.ref("statsBot").once("value").then(function (snapshot) {
            const data = snapshot.val();
            statsLeaderboardBot.innerHTML = "";
            if (!data) {
                statsLeaderboardBot.textContent = t("stats_no_bot_games");
                return;
            }
            const entries = Object.keys(data).map(function (key) {
                return {
                    id: key,
                    name: data[key].name || "Игрок",
                    wins: data[key].wins || 0,
                    losses: data[key].losses || 0,
                    byLevel: data[key].byLevel || null
                };
            });
            entries.sort(compareLeaderboardEntries);
            // ВСЕ игроки, без обрезания. Нумерация и медали — как в онлайне.
            const top = entries;

            // каждое открытие статистики уходило до 10 дополнительных запросов
            // ради колонки 🪙, которую мы убрали как вводящую в заблуждение.
            top.forEach(function (entry, index) {
                statsLeaderboardBot.appendChild(renderBotStatsRow(index + 1, entry.name, entry.wins, entry.losses, entry.byLevel));
            });
        }).catch(function () {
            if (statsLeaderboardBot) statsLeaderboardBot.textContent = t("stats_load_error");
        });
    }
}

if (btnShowStats) {
    btnShowStats.addEventListener("click", openStatsModal);
}


const statsTabOnline = document.getElementById("stats-tab-online");
const statsTabBot = document.getElementById("stats-tab-bot");
const statsViewOnline = document.getElementById("stats-view-online");
const statsViewBot = document.getElementById("stats-view-bot");
const statsTitleOnline = document.getElementById("stats-title-online");
const statsTitleBot = document.getElementById("stats-title-bot");

if (statsTabOnline && statsTabBot && statsViewOnline && statsViewBot) {
    statsTabOnline.addEventListener("click", function () {
        statsTabOnline.classList.add("stats-tab-active");
        statsTabBot.classList.remove("stats-tab-active");
        statsViewOnline.classList.remove("hidden");
        statsViewBot.classList.add("hidden");
        if (statsTitleOnline) statsTitleOnline.classList.remove("hidden");
        if (statsTitleBot) statsTitleBot.classList.add("hidden");
    });

    statsTabBot.addEventListener("click", function () {
        statsTabBot.classList.add("stats-tab-active");
        statsTabOnline.classList.remove("stats-tab-active");
        statsViewBot.classList.remove("hidden");
        statsViewOnline.classList.add("hidden");
        if (statsTitleBot) statsTitleBot.classList.remove("hidden");
        if (statsTitleOnline) statsTitleOnline.classList.add("hidden");
    });
}

if (btnStatsClose) {
    btnStatsClose.addEventListener("click", function () {
        statsModal.classList.add("hidden");
    });
}

const btnBotDetailsClose = document.getElementById("btn-bot-details-close");
if (btnBotDetailsClose) {
    btnBotDetailsClose.addEventListener("click", function () {
        const modal = document.getElementById("bot-details-modal");
        if (modal) modal.classList.add("hidden");
    });
}

// ===== ИГРАТЬ ОНЛАЙН (МАТЧМЕЙКИНГ) =====

function startOnlineSearch() {
    if (!canUseFirebase()) return;
    showScreen(matchmakingScreen);
    isMatchmakingResolved = false;

    // 1. Сначала создаём свою комнату и встаём в очередь.
    // ЖДЁМ полного завершения записи в базу (Promise), чтобы избежать гонки условий.
    addToMatchmakingQueue().then(function() {
        if (!canUseFirebase()) return;
        
        // 2. ТОЛЬКО ПОСЛЕ успешной записи — подключаем слушатель очереди
        matchmakingQueueRef = database.ref("matchmakingQueue");
        matchmakingQueueRef.on("value", function(snapshot) {
            const queue = snapshot.val() || {};
            const queueSize = Object.keys(queue).length;
            const countKey = queueSize === 1
                ? "matchmaking_count_one"
                : (currentLang === "ru" && queueSize > 1 && queueSize < 5
                    ? "matchmaking_count_few"
                    : "matchmaking_count_many");

            matchmakingCount.textContent = t(countKey).replace("{count}", queueSize);
            
            if (!isMatchmakingResolved) {
                const opponentIds = Object.keys(queue).filter(id => id !== myTelegramId);
                if (opponentIds.length > 0) {
                    tryMatchOpponent(opponentIds[0], queue[opponentIds[0]]);
                }
            }
        });

        // 3. Слушаем сигнал "тебя нашли" (если кто-то присоединился к нашей комнате)
        activeMatchRef = database.ref("users/" + myTelegramId + "/activeMatch");
        activeMatchRef.on("value", function(snapshot) {
            const matchedRoomCode = snapshot.val();
            if (matchedRoomCode) {
                if (!isMatchmakingResolved) {
                    if (!canUseFirebase()) return;
                    isMatchmakingResolved = true;
                    
                    if (matchmakingQueueRef) { 
                        matchmakingQueueRef.off("value"); 
                        matchmakingQueueRef = null; 
                    }
                    
                    database.ref("matchmakingQueue/" + myTelegramId).remove();
                    activeMatchRef.remove();
                    
                    roomCode = matchedRoomCode;
                    isOnlineGame = true;
                    pendingTimeControlSeconds = 0;
                    
                    showScreen(gameScreen);
                    startOnlineGame();
                }
            }
        });

    }).catch(function(error) {
        console.error("Ошибка при входе в очередь матчмейкинга:", error);
        showInfoModal(t("err_search_failed"), false);
        showScreen(menuScreen);
    });
}

function addToMatchmakingQueue() {
    if (!canUseFirebase()) return;
    // Возвращаем Promise, чтобы вызывающая функция могла дождаться завершения записи в базу
    return new Promise(function(resolve, reject) {
        roomCode = generateRoomCode();
        myColor = "light";
        isOnlineGame = true;
        isSpectator = false;

        const initialState = {
            status: "waiting",
            turn: "light",
            mustContinueFrom: null,
            capturedDark: 0,
            capturedLight: 0,
            moveCount: 0,
            matchNumber: 0,
            kingOnlyStreak: 0,
            noProgressStreak: 0,
            positionHistory: [getDrawPositionKey(createInitialPieces(), "light")],
            longRoadAttacker: null,
            longRoadStreak: 0,
            lastMove: null,
            lastMovePath: null,
            lastCapturedSquares: null,
            moveType: null,
            pieces: createInitialPieces(),
            players: { light: { id: myTelegramId, name: myTelegramName }, dark: null },
            timeControlSeconds: 0,
            turnStartedAt: firebase.database.ServerValue.TIMESTAMP,
            winner: null,
            winReason: null,
            // ELO: стабильная метка создания комнаты (см. buildEloMatchId).
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            groupId: GROUP_ID
        };

        // Создаём комнату в базе
        database.ref("rooms/" + roomCode).set(initialState).then(function() {
            if (!canUseFirebase()) throw new Error("firebase_auth_required");
            // После создания комнаты — записываем ссылку в профиль пользователя
            return database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
                opponentName: "Поиск соперника...",
                myColor: "light"
            });
        }).then(function() {
            if (!canUseFirebase()) throw new Error("firebase_auth_required");
            // После создания комнаты — включаем presence (сердцебиение)
            setupPresence();

            // И ТОЛЬКО ПОСЛЕ ЭТОГО — добавляем себя в очередь поиска
            const myQueueRef = database.ref("matchmakingQueue/" + myTelegramId);
            return myQueueRef.set({ name: myTelegramName, timestamp: Date.now(), roomCode: roomCode });
        }).then(function() {
            if (!canUseFirebase()) throw new Error("firebase_auth_required");
            // Устанавливаем onDisconnect для удаления из очереди при закрытии приложения
            database.ref("matchmakingQueue/" + myTelegramId).onDisconnect().remove();
            resolve(); // Готово! Сообщаем, что можно начинать слушать очередь
        }).catch(function(error) {
            console.error("Ошибка создания комнаты для матчмейкинга:", error);
            reject(error);
        });
    });
}

function tryMatchOpponent(opponentId, opponentData) {
    if (!canUseFirebase()) return;
    // Если мы уже нашли матч или нас уже нашли — выходим
    if (isMatchmakingResolved) return;

    // ДЕТЕРМИНИРОВАННЫЙ ВЫБОР: Игрок с МЕНЬШИМ ID (как число) — всегда "создатель" (ждёт).
    // Игрок с БОЛЬШИМ ID — всегда "присоединяющийся" (joiner).
    const myNumericId = parseInt(myTelegramId.replace("tg_", ""), 10);
    const oppNumericId = parseInt(opponentId.replace("tg_", ""), 10);

    if (myNumericId < oppNumericId) {
        // Я создатель, я просто жду, пока меня найдёт соперник с большим ID.
        return;
    }

    const matchedRoomCode = opponentData.roomCode;
    if (!matchedRoomCode) return;

    // Я — присоединяющийся (myNumericId > oppNumericId). Пытаюсь "забрать" комнату создателя.
    database.ref("rooms/" + matchedRoomCode).transaction(function(room) {
        if (!room || room.status !== "waiting") return; // Abort if room gone or not waiting
        room.status = "active";
        room.players = room.players || {};
        room.players.dark = { id: myTelegramId, name: myTelegramName };
        room.turnStartedAt = firebase.database.ServerValue.TIMESTAMP;
        return room;
    }).then(function(result) {
        if (!canUseFirebase()) return;
        if (result.committed) {
            // Успех! Мы победили в гонке — мы JOINER (присоединившийся)
            isMatchmakingResolved = true;
            if (matchmakingQueueRef) { 
                matchmakingQueueRef.off("value"); 
                matchmakingQueueRef = null; 
            }
            
            // Удаляем себя и соперника из очереди
            database.ref("matchmakingQueue/" + myTelegramId).remove();
            database.ref("matchmakingQueue/" + opponentId).remove();

            // Удаляем свою комнату ожидания (которую создали в addToMatchmakingQueue)
            if (roomCode && roomCode !== matchedRoomCode) {
                database.ref("rooms/" + roomCode).remove();
                database.ref("users/" + myTelegramId + "/rooms/" + roomCode).remove();
            }

            // Переходим в ЕГО комнату, значит мы "тёмные"
            roomCode = matchedRoomCode;
            myColor = "dark"; 
            isOnlineGame = true;
            pendingTimeControlSeconds = 0;

            database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
                opponentName: opponentData.name,
                myColor: "dark"
            });
            
            // Отправляем сигнал создателю комнаты, чтобы он зашёл в игру
            database.ref("users/" + opponentId + "/activeMatch").set(roomCode).then(function() {
                if (!canUseFirebase()) return;
                showScreen(gameScreen);
                startOnlineGame();
            });
        }
    }).catch(function(error) {
        console.error("Matchmaking transaction failed:", error);
        showInfoModal(t("err_join_failed"), false);
        showScreen(menuScreen);
        loadActiveRooms();
    });
}

function cancelOnlineSearch() {
    if (!canUseFirebase()) return;
    isMatchmakingResolved = true; // Останавливаем любые фоновые попытки матчмейкинга
    if (matchmakingQueueRef) { 
        matchmakingQueueRef.off("value"); 
        matchmakingQueueRef = null; 
    }
    if (activeMatchRef) { 
        activeMatchRef.off(); 
        activeMatchRef = null; 
    }
    database.ref("matchmakingQueue/" + myTelegramId).remove();
    
    // Удаляем созданную нами комнату ожидания, чтобы она сразу пропала из лобби группы
    if (roomCode) {
        database.ref("rooms/" + roomCode).remove();
        database.ref("users/" + myTelegramId + "/rooms/" + roomCode).remove();
        roomCode = null; // Сбрасываем, чтобы не удалить случайно чужую при следующей игре
    }
    
    showScreen(menuScreen);
    loadActiveRooms();
}

// ===== ИСКУССТВЕННЫЙ ИНТЕЛЛЕКТ (СУПЕР УМНЫЙ БОТ - ГРАНДМАСТЕР) =====

// ===== ДЕБЮТНАЯ КНИГА (OPENING BOOK v1) =====
// Три вручную проверенных, названных дебюта русских шашек:
// 1. Городская партия, 2. Косяк, 3. Обратная вилочка.
// Каждый полуход лично проверен через настоящую игровую логику
// (attemptMove/hasMandatoryCapture) — обязательного взятия ни на
// одном шаге не возникает, книга работает только в спокойных позициях.

// Ключ позиции: фиксированный обход всех 32 игровых клеток (не зависит
// от порядка ключей в объекте pieces) + чья сторона сейчас ходит.
function getPositionKey(pieces, turn) {
    let s = "";
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            if ((row + col) % 2 === 0) continue;
            const p = pieces[row + "_" + col];
            if (!p) { s += "."; continue; }
            if (p.color === "light") s += p.king ? "L" : "l";
            else s += p.king ? "D" : "d";
        }
    }
    return s + "_" + turn;
}

const OPENING_BOOK = {
    // Начальная позиция — три равновероятных варианта первого хода светлыми
    "dddddddddddd........llllllllllll_light": [
        { from: { row: 5, col: 2 }, to: { row: 4, col: 3 } }, // 1.cd4 — Городская партия
        { from: { row: 5, col: 2 }, to: { row: 4, col: 1 } }, // 1.cb4 — Косяк
        { from: { row: 5, col: 6 }, to: { row: 4, col: 5 } }  // 1.gf4 — Обратная вилочка
    ],
    // Ответ тёмными после 1.cd4
    "dddddddddddd.....l..l.llllllllll_dark": [
        { from: { row: 2, col: 3 }, to: { row: 3, col: 2 } } // dc5
    ],
    // Ответ тёмными после 1.cb4
    "dddddddddddd....l...l.llllllllll_dark": [
        { from: { row: 2, col: 5 }, to: { row: 3, col: 6 } } // fg5
    ],
    // Ответ тёмными после 1.gf4
    "dddddddddddd......l.lll.llllllll_dark": [
        { from: { row: 2, col: 5 }, to: { row: 3, col: 4 } } // fe5
    ],
    // Городская партия: светлые после 1...dc5
    "ddddddddd.dd.d...l..l.llllllllll_light": [
        { from: { row: 6, col: 1 }, to: { row: 5, col: 2 } } // bc3
    ],
    // Городская партия: тёмные после 2.bc3
    "ddddddddd.dd.d...l..llll.lllllll_dark": [
        { from: { row: 2, col: 5 }, to: { row: 3, col: 6 } } // fg5
    ],
    // Городская партия: светлые после 2...fg5 (конец линии)
    "ddddddddd..d.d.d.l..llll.lllllll_light": [
        { from: { row: 5, col: 2 }, to: { row: 4, col: 1 } } // cb4
    ],
    // Косяк: светлые после 1...fg5
    "dddddddddd.d...dl...l.llllllllll_light": [
        { from: { row: 5, col: 6 }, to: { row: 4, col: 5 } } // gf4
    ],
    // Косяк: тёмные после 2.gf4
    "dddddddddd.d...dl.l.l.l.llllllll_dark": [
        { from: { row: 1, col: 6 }, to: { row: 2, col: 5 } } // gf6
    ],
    // Косяк: светлые после 2...gf6 (конец линии)
    "ddddddd.dddd...dl.l.l.l.llllllll_light": [
        { from: { row: 6, col: 1 }, to: { row: 5, col: 2 } } // bc3
    ],
    // Обратная вилочка: светлые после 1...fe5 (конец линии)
    "dddddddddd.d..d...l.lll.llllllll_light": [
        { from: { row: 5, col: 2 }, to: { row: 4, col: 3 } } // cd4
    ]
};

// Возвращает ход из книги, либо null, если книгу нельзя использовать
// (не спокойная позиция, позиции нет в книге, или ход оказался нелегален).
function getOpeningBookMove(state, color) {
    // Книга работает только в полностью спокойной позиции —
    // без незакрытой цепочки взятия и без обязательного взятия вообще.
    if (state.mustContinueFrom) return null;
    if (hasMandatoryCapture(state.pieces, color)) return null;

    const key = getPositionKey(state.pieces, state.turn);
    const options = OPENING_BOOK[key];
    if (!options || options.length === 0) return null;

    const candidate = options[Math.floor(Math.random() * options.length)];

    // Обязательная проверка: книжный ход должен реально быть среди
    // легальных ходов, которые выдаёт уже существующий генератор ходов.
    // Второй, отдельный генератор ходов здесь не создаём.
    const legalMoves = getAllLegalMovesForBot(state, color);
    const isLegal = legalMoves.some(function (m) {
        return m.from.row === candidate.from.row && m.from.col === candidate.from.col &&
               m.to.row === candidate.to.row && m.to.col === candidate.to.col;
    });

    return isLegal ? candidate : null;
}

function triggerBotMove() {
    if (!isBotGame || !currentState || currentState.turn !== botColor || currentState.winner) return;

    if (ownerSessionAttached) {
        triggerOwnerSyncedBotMove();
        return;
    }

    // Сначала проверяем дебютную книгу — если применима, используем её ход
    // вместо запуска поиска. Ход из книги проходит через тот же самый
    // performMove(), что и обычный результат findBestMove() — второго,
    // отдельного пути выполнения хода здесь нет.
    const bookMove = getOpeningBookMove(currentState, botColor);

    // Максимальная глубина зависит от выбранной сложности партии — единственный
    // параметр, который меняется между уровнями. Для "hard" это ровно 20, как
    // было всегда; findBestMove() сам останавливается по лимиту времени —
    // логика не менялась. Opening Book/TT/QS/Killer/Move Ordering одинаковы
    // на всех уровнях.
    const maxDepthForThisMove = getMaxDepthForDifficulty(botDifficulty);
    const bestMove = bookMove || findBestMove(currentState, botColor, maxDepthForThisMove);
    if (bestMove) {
        performMove(bestMove.from.row, bestMove.from.col, bestMove.to.row, bestMove.to.col);
    }
}

// --- Synced-путь хода бота: сначала lock на ВСЮ сессию (устаревшее
// локальное представление отсеивается сразу, не тратя впустую Hard-поиск),
// затем ТЕ ЖЕ САМЫЕ getOpeningBookMove()/findBestMove() — AI не менялся —
// по snapshot'у именно той session/revision, на которой lock получен,
// и повторная проверка перед commit. ---
let botMoveWaitingForServerTime = false;
function triggerOwnerSyncedBotMove() {
    const expectedMatchId = currentBotMatchId;
    const expectedRevision = ownerSessionRevision;
    const expectedBotColor = botColor;

    // Если уже есть одна ожидающая доставки offset попытка на этом
    // устройстве — не плодим вторую параллельно. Актуально только в узком
    // startup-окне; как только offset доставлен, флаг больше не участвует.
    if (botMoveWaitingForServerTime) return;
    botMoveWaitingForServerTime = true;

    waitForServerTimeOffsetReady().then(function () {
        botMoveWaitingForServerTime = false;
        return tryAcquireBotMoveLock(expectedMatchId, expectedRevision, expectedBotColor);
    }).then(function (lockResult) {
        if (!lockResult.acquired) return; // другое устройство уже считает — просто ждём его commit через listener

        const lockedGameState = deserializeOwnerBotState(lockResult.sessionSnapshot.state);
        const lockedDifficulty = lockResult.sessionSnapshot.botDifficulty;

        const bookMove = getOpeningBookMove(lockedGameState, expectedBotColor);
        const maxDepthForThisMove = getMaxDepthForDifficulty(lockedDifficulty);
        const bestMove = bookMove || findBestMove(lockedGameState, expectedBotColor, maxDepthForThisMove);
        if (!bestMove) return;

        commitBotMove(expectedMatchId, expectedRevision, expectedBotColor, bestMove).then(function (commitResult) {
            if (commitResult.committed) {
                // Та же причина, что и в attemptOwnerHumanMove: берём
                // spectateRoomCode ИЗ committed snapshot, не из глобальной
                // переменной, которая могла успеть смениться за время поиска.
                mirrorCommittedStateToSpectateRoom(commitResult.snapshot.val().spectateRoomCode, commitResult.snapshot.val());
            }
            // Если commit не прошёл (state изменился за время поиска) —
            // посчитанный ход просто выбрасывается; listener доставит
            // актуальное состояние, и при необходимости всё повторится.
        });
    }).catch(function (error) {
        // Настоящая ошибка Firebase где-то в цепочке (не "не получилось
        // захватить lock" — это committed:false, штатный путь). Не
        // оставляем unhandled rejection; UI не зависает — если ход бота
        // всё ещё актуален, следующее обновление session (через listener
        // с другого устройства или после reconnect) естественно вызовет
        // renderBoard() -> triggerBotMove() заново.
        console.error("Bot move (synced) failed:", error);
    });
}

// ===== УПРАВЛЕНИЕ ВРЕМЕНЕМ БОТА =====
let botStartTime = 0;
let botNodesSearched = 0;
let botSearchCancelled = false;
// 5 секунд — идеальный компромисс: бот успевает глубоко просчитать 
// сложные позиции с дамками, но интерфейс не зависает настолько, 
// чтобы пользователь подумал, что приложение сломалось.
const BOT_MAX_THINK_TIME_MS = 5000; 

// Ключ позиции для Transposition Table. В отличие от ключа Opening Book,
// здесь ОБЯЗАТЕЛЬНО учитываем mustContinueFrom и pendingRemovals — без них
// две разные ситуации (например, разное состояние цепочки взятия при
// одинаковом расположении шашек) могли бы ошибочно склеиться в одну запись.
function getTTKey(state) {
    let s = "";
    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            if ((row + col) % 2 === 0) continue;
            const p = state.pieces[row + "_" + col];
            if (!p) { s += "."; continue; }
            if (p.color === "light") s += p.king ? "L" : "l";
            else s += p.king ? "D" : "d";
        }
    }
    s += "_" + state.turn;
    s += "_" + (state.mustContinueFrom ? (state.mustContinueFrom.row + "-" + state.mustContinueFrom.col) : "x");
    if (state.pendingRemovals && state.pendingRemovals.length > 0) {
        // Сортируем в стабильном порядке — одно и то же множество побитых
        // шашек не должно давать разные ключи из-за порядка в массиве.
        s += "_" + state.pendingRemovals.slice().sort().join(",");
    } else {
        s += "_x";
    }
    return s;
}

function findBestMove(state, color, maxDepth) {
    const moves = getAllLegalMovesForBot(state, color);
    if (moves.length === 0) return null;

    // ОПТИМИЗАЦИЯ: Если доступен только один ход — нет смысла думать, играем его сразу.
    if (moves.length === 1) return moves[0];

    // Новая пустая Transposition Table для ЭТОГО хода бота. Живёт через все
    // итерации iterative deepening внутри одного вызова findBestMove(),
    // но не сохраняется между разными ходами или партиями.
    const tt = {};

    // KILLER MOVES: та же логика жизненного цикла, что и у tt — новая пустая
    // таблица на каждый вызов findBestMove(), не сохраняется между ходами
    // бота или партиями. Индексируется по глубине, хранит максимум 2 тихих
    // хода на глубину, которые недавно вызвали отсечение.
    const killerTable = {};

    let bestMove = moves[0]; // Запасной ход на случай, если время выйдет сразу
    let previousBestMove = null;
    let stableIterations = 0; // Счётчик стабильности лучшего хода
    botStartTime = Date.now();
    botNodesSearched = 0;
    botSearchCancelled = false;

    // Итеративное углубление: считаем сначала на глубину 1, потом 2, 3... 
    // пока не кончится время. Это гарантирует, что у бота всегда есть ход.
    for (let depth = 1; depth <= maxDepth; depth++) {
        let currentBestMove = null;
        let currentBestScore = -Infinity;
        let alpha = -Infinity;
        let beta = Infinity;

        // Ставим лучший ход с прошлой глубины в начало списка (для лучшего отсечения)
        if (bestMove) {
            const idx = moves.indexOf(bestMove);
            if (idx > 0) {
                moves.splice(idx, 1);
                moves.unshift(bestMove);
            }
        }

        for (const move of moves) {
            const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, color);
            if (!newState) continue;

            // Если цепочка взятия не закончена, глубину не уменьшаем
            const nextDepth = (newState.turn === color) ? depth : depth - 1;
            const score = minimax(newState, nextDepth, alpha, beta, color, tt, killerTable);

            if (botSearchCancelled) break; // Время вышло, прерываем текущую глубину

            if (score > currentBestScore) {
                currentBestScore = score;
                currentBestMove = move;
            }
            alpha = Math.max(alpha, score);
        }

        if (!botSearchCancelled) {
            // РАННИЙ ВЫХОД: Минимальная глубина для выхода поднята до 6.
            // Глубина 6 — это тактический барьер в шашках. Если ход стабилен 
            // на глубине 6 и 7, значит тактических угроз (вроде продолжения 
            // цепочки взятия) там точно нет. Прерываем, чтобы не тратить время.
            if (depth >= 6) {
                if (currentBestMove === previousBestMove) {
                    stableIterations++;
                    if (stableIterations >= 2) break; 
                } else {
                    stableIterations = 0;
                }
            }
            previousBestMove = currentBestMove;
            bestMove = currentBestMove; // Сохраняем лучший ход с завершенной глубины
        } else {
            break; // Прерываем цикл углубления
        }
        
        // Если найден гарантированный выигрыш — нет смысла считать глубже
        if (currentBestScore >= 1000000) break;
    }
    
    return bestMove;
}

// ===== QUIESCENCE SEARCH v1 =====
// Продолжает поиск за пределы обычной глубины ТОЛЬКО пока позиция "неспокойная":
// либо продолжается цепочка взятия (mustContinueFrom), либо у стороны, чей ход,
// есть обязательное взятие. Никакого отдельного qDepth — расширение конечно,
// потому что одна и та же побитая фигура не может быть взята повторно благодаря
// pendingRemovals, а после завершения серии материал реально уменьшается —
// фигур на доске максимум 24, и это ограничение работает вместе с уже
// существующим общим лимитом времени (BOT_MAX_THINK_TIME_MS).
// Не читает и не пишет обычную Transposition Table — отдельный, изолированный путь.
// Настоящая проверка "является ли этот ход взятием" — сканирует путь между
// from и to на наличие фигуры соперника. Расстояние в клетках здесь НЕ
// показатель: у дамки обычный тихий ход тоже может быть на любое число клеток
// по диагонали, поэтому "distance > 1" ошибочно принял бы длинный тихий ход
// дамки за взятие и уходил в бесконечную рекурсию.
function isCaptureMove(pieces, move) {
    const dRow = move.to.row - move.from.row;
    const dCol = move.to.col - move.from.col;
    const dist = Math.abs(dRow);
    if (dist < 2) return false;
    const stepRow = dRow / dist;
    const stepCol = dCol / dist;
    for (let i = 1; i < dist; i++) {
        const key = (move.from.row + stepRow * i) + "_" + (move.from.col + stepCol * i);
        if (pieces[key]) return true; // По правилам между from и to может быть только одна фигура — соперника
    }
    return false;
}

function quiescenceSearch(state, alpha, beta, botColor) {
    botNodesSearched++;
    if (botNodesSearched % 128 === 0) {
        if (Date.now() - botStartTime > BOT_MAX_THINK_TIME_MS) {
            botSearchCancelled = true;
        }
    }
    if (botSearchCancelled) return 0;

    if (state.winner) {
        return evaluateBoard(state, botColor);
    }

    const currentColor = state.turn;
    const moves = getAllLegalMovesForBot(state, currentColor);

    // Позиция "неспокойная", если цепочка взятия ещё не закончена, либо среди
    // ходов есть хотя бы одно взятие — определяется через isCaptureMove(),
    // которая проверяет наличие фигуры на пути легального хода (не по дистанции,
    // так как у дамки обычный тихий ход тоже может быть на любое расстояние).
    // Не используем hasMandatoryCapture() напрямую — она не учитывает mustContinueFrom/
    // pendingRemovals и может ошибочно учитывать чужую, не относящуюся к делу
    // шашку. Список из getAllLegalMovesForBot() уже корректно ограничен одной
    // шашкой во время цепочки — этого достаточно для проверки.
    const isNoisy = state.mustContinueFrom !== null || moves.some(function (m) {
        return isCaptureMove(state.pieces, m);
    });

    if (!isNoisy) {
        // Тихий лист — никакого stand-pat не нужно, это и есть обычная оценка.
        return evaluateBoard(state, botColor);
    }

    // Рассматриваем только реальные взятия — тихие ходы в этом списке (если они
    // там есть при mustContinueFrom === null и живом взятии у другой шашки) всё
    // равно были бы отклонены attemptMove() как нелегальные, поэтому фильтруем
    // их здесь заранее, не тратя на них попытки впустую.
    const captureMoves = moves.filter(function (m) {
        return isCaptureMove(state.pieces, m);
    });

    const isMaximizing = (currentColor === botColor);

    if (isMaximizing) {
        let maxEval = -Infinity;
        for (const move of captureMoves) {
            const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, currentColor);
            if (!newState) continue;
            const evalScore = quiescenceSearch(newState, alpha, beta, botColor);
            if (botSearchCancelled) return 0;
            if (evalScore > maxEval) maxEval = evalScore;
            alpha = Math.max(alpha, evalScore);
            if (beta <= alpha) break;
        }
        // Защита: если по какой-то причине ни один ход не оказался легальным —
        // просто отдаём обычную статичную оценку, не оставляем -Infinity.
        return maxEval === -Infinity ? evaluateBoard(state, botColor) : maxEval;
    } else {
        let minEval = Infinity;
        for (const move of captureMoves) {
            const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, currentColor);
            if (!newState) continue;
            const evalScore = quiescenceSearch(newState, alpha, beta, botColor);
            if (botSearchCancelled) return 0;
            if (evalScore < minEval) minEval = evalScore;
            beta = Math.min(beta, evalScore);
            if (beta <= alpha) break;
        }
        return minEval === Infinity ? evaluateBoard(state, botColor) : minEval;
    }
}

function minimax(state, depth, alpha, beta, botColor, tt, killerTable) {
    // Проверка лимита времени (каждые 128 узлов, чтобы минимизировать 
    // отставание при просадках скорости или работе сборщика мусора)
    botNodesSearched++;
    if (botNodesSearched % 128 === 0) {
        if (Date.now() - botStartTime > BOT_MAX_THINK_TIME_MS) {
            botSearchCancelled = true;
        }
    }
    if (botSearchCancelled) return 0; // Возвращаем 0, результат будет проигнорирован

    if (state.winner) {
        return evaluateBoard(state, botColor);
    }

    if (depth === 0) {
        // QUIESCENCE SEARCH v1: не отдаём оценку сразу, если позиция "неспокойная" —
        // продолжаем ТОЛЬКО по обязательным взятиям, до полностью тихой позиции.
        // Не читает и не пишет обычную TT — отдельный, изолированный путь оценки.
        return quiescenceSearch(state, alpha, beta, botColor);
    }

    // Сохраняем ИСХОДНЫЕ границы окна поиска — тип записи TT (EXACT/LOWER/UPPER)
    // определяется относительно них, а не относительно alpha/beta, изменённых
    // уже внутри перебора ходов этого узла.
    const alphaOriginal = alpha;
    const betaOriginal = beta;

    const ttKey = getTTKey(state);
    const ttEntry = tt[ttKey];

    if (ttEntry && ttEntry.depth >= depth) {
        if (ttEntry.flag === "EXACT") {
            return ttEntry.score;
        } else if (ttEntry.flag === "LOWER") {
            alpha = Math.max(alpha, ttEntry.score);
        } else if (ttEntry.flag === "UPPER") {
            beta = Math.min(beta, ttEntry.score);
        }
        if (alpha >= beta) {
            return ttEntry.score;
        }
    }

    const currentColor = state.turn;
    const isMaximizing = (currentColor === botColor);
    let moves = getAllLegalMovesForBot(state, currentColor);

    if (moves.length === 0) return isMaximizing ? -1000000 : 1000000;

    // Подсказка порядка ходов из TT — используем сохранённый bestMove только
    // чтобы переставить его в начало списка. Move Ordering в остальном не трогаем.
    if (ttEntry && ttEntry.bestMove) {
        const bm = ttEntry.bestMove;
        const idx = moves.findIndex(function (m) {
            return m.from.row === bm.from.row && m.from.col === bm.from.col &&
                   m.to.row === bm.to.row && m.to.col === bm.to.col;
        });
        if (idx > 0) {
            const mv = moves.splice(idx, 1)[0];
            moves.unshift(mv);
        }
    }

    // KILLER MOVES: переставляем тихие ходы, недавно вызвавшие отсечение на
    // этой же глубине, ближе к началу списка тихих ходов — взятия не трогаем,
    // они уже впереди благодаря существующей сортировке getAllLegalMovesForBot.
    // TT bestMove (выше) уже стоит первым и остаётся приоритетнее.
    const killers = killerTable[depth];
    if (killers && (killers[0] || killers[1])) {
        const ttMoveAtFront = (ttEntry && ttEntry.bestMove && moves.length > 0 &&
            moves[0].from.row === ttEntry.bestMove.from.row && moves[0].from.col === ttEntry.bestMove.from.col &&
            moves[0].to.row === ttEntry.bestMove.to.row && moves[0].to.col === ttEntry.bestMove.to.col) ? moves[0] : null;
        const rest = ttMoveAtFront ? moves.slice(1) : moves.slice();

        const captureMoves = [];
        const quietMoves = [];
        for (const m of rest) {
            if (isCaptureMove(state.pieces, m)) captureMoves.push(m);
            else quietMoves.push(m);
        }
        quietMoves.sort(function (a, b) {
            const aIsKiller = (killers[0] && a.from.row === killers[0].from.row && a.from.col === killers[0].from.col && a.to.row === killers[0].to.row && a.to.col === killers[0].to.col) ||
                               (killers[1] && a.from.row === killers[1].from.row && a.from.col === killers[1].from.col && a.to.row === killers[1].to.row && a.to.col === killers[1].to.col) ? 1 : 0;
            const bIsKiller = (killers[0] && b.from.row === killers[0].from.row && b.from.col === killers[0].from.col && b.to.row === killers[0].to.row && b.to.col === killers[0].to.col) ||
                               (killers[1] && b.from.row === killers[1].from.row && b.from.col === killers[1].from.col && b.to.row === killers[1].to.row && b.to.col === killers[1].to.col) ? 1 : 0;
            return bIsKiller - aIsKiller;
        });

        moves = (ttMoveAtFront ? [ttMoveAtFront] : []).concat(captureMoves, quietMoves);
    }

    let bestMoveThisNode = null;

    if (isMaximizing) {
        let maxEval = -Infinity;
        for (const move of moves) {
            const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, currentColor);
            if (!newState) continue;
            
            // Не уменьшаем глубину, если ход не передан сопернику (идёт цепочка взятия)
            const nextDepth = (newState.turn === currentColor) ? depth : depth - 1;
            const evalScore = minimax(newState, nextDepth, alpha, beta, botColor, tt, killerTable);
            
            if (botSearchCancelled) return 0;
            
            if (evalScore > maxEval) {
                maxEval = evalScore;
                bestMoveThisNode = move;
            }
            alpha = Math.max(alpha, evalScore);
            if (beta <= alpha) {
                // KILLER MOVES: запоминаем тихий ход, вызвавший отсечение,
                // только для этой глубины. Взятия не запоминаем — они и так
                // уже приоритетны через существующую сортировку.
                if (!isCaptureMove(state.pieces, move)) {
                    if (!killerTable[depth]) killerTable[depth] = [null, null];
                    const k = killerTable[depth];
                    const already = (k[0] && k[0].from.row === move.from.row && k[0].from.col === move.from.col && k[0].to.row === move.to.row && k[0].to.col === move.to.col) ||
                                     (k[1] && k[1].from.row === move.from.row && k[1].from.col === move.from.col && k[1].to.row === move.to.row && k[1].to.col === move.to.col);
                    if (!already) { k[1] = k[0]; k[0] = move; }
                }
                break;
            }
        }

        // КРИТИЧНО: если мы дошли сюда, botSearchCancelled точно false —
        // выше уже был бы return 0 при первом же обнаружении отмены поиска.
        // Значит, узел досчитан полностью, и запись в TT безопасна.
        let flag;
        if (maxEval <= alphaOriginal) flag = "UPPER";
        else if (maxEval >= betaOriginal) flag = "LOWER";
        else flag = "EXACT";
        // Replacement policy: не затираем уже сохранённую запись более глубоким
        // расчётом более мелкой — сохраняем только если записи ещё нет,
        // либо новая depth не меньше уже имеющейся.
        if (!tt[ttKey] || tt[ttKey].depth <= depth) {
            tt[ttKey] = { depth: depth, score: maxEval, flag: flag, bestMove: bestMoveThisNode };
        }

        return maxEval;
    } else {
        let minEval = Infinity;
        for (const move of moves) {
            const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, currentColor);
            if (!newState) continue;
            
            // Не уменьшаем глубину, если ход не передан сопернику (идёт цепочка взятия)
            const nextDepth = (newState.turn === currentColor) ? depth : depth - 1;
            const evalScore = minimax(newState, nextDepth, alpha, beta, botColor, tt, killerTable);
            
            if (botSearchCancelled) return 0;
            
            if (evalScore < minEval) {
                minEval = evalScore;
                bestMoveThisNode = move;
            }
            beta = Math.min(beta, evalScore);
            if (beta <= alpha) {
                if (!isCaptureMove(state.pieces, move)) {
                    if (!killerTable[depth]) killerTable[depth] = [null, null];
                    const k = killerTable[depth];
                    const already = (k[0] && k[0].from.row === move.from.row && k[0].from.col === move.from.col && k[0].to.row === move.to.row && k[0].to.col === move.to.col) ||
                                     (k[1] && k[1].from.row === move.from.row && k[1].from.col === move.from.col && k[1].to.row === move.to.row && k[1].to.col === move.to.col);
                    if (!already) { k[1] = k[0]; k[0] = move; }
                }
                break;
            }
        }

        let flag;
        if (minEval <= alphaOriginal) flag = "UPPER";
        else if (minEval >= betaOriginal) flag = "LOWER";
        else flag = "EXACT";
        // Та же самая защита, что и в maximizing-ветке.
        if (!tt[ttKey] || tt[ttKey].depth <= depth) {
            tt[ttKey] = { depth: depth, score: minEval, flag: flag, bestMove: bestMoveThisNode };
        }

        return minEval;
    }
}

function evaluateBoard(state, botColor) {
    if (state.winner === "draw") return 0;
    if (state.winner === botColor) return 1000000;
    if (state.winner && state.winner !== botColor) return -1000000;

    let score = 0;
    const opponentColor = botColor === "light" ? "dark" : "light";
    
    let botMaterial = 0;
    let oppMaterial = 0;
    let botMobility = 0;
    let oppMobility = 0;

    for (const key in state.pieces) {
        const p = state.pieces[key];
        const parts = key.split('_');
        const r = parseInt(parts[0]);
        const c = parseInt(parts[1]);

        let pieceVal = p.king ? 450 : 100;
        let isBot = p.color === botColor;

        if (isBot) {
            botMaterial += pieceVal;
            score += pieceVal;
        } else {
            oppMaterial += pieceVal;
            score -= pieceVal;
        }

        // 1. Подвижность (Mobility) — считаем количество свободных диагоналей впереди
        let mobility = 0;
        if (!p.king) {
            const dir = isBot ? (botColor === "light" ? -1 : 1) : (opponentColor === "light" ? -1 : 1);
            if (r + dir >= 0 && r + dir <= 7) {
                if (c - 1 >= 0 && !pieceAt(state.pieces, r + dir, c - 1)) mobility++;
                if (c + 1 <= 7 && !pieceAt(state.pieces, r + dir, c + 1)) mobility++;
            }
        } else {
            // Для дамки считаем свободные клетки во всех 4 направлениях (по 1 шагу)
            if (r - 1 >= 0) {
                if (c - 1 >= 0 && !pieceAt(state.pieces, r - 1, c - 1)) mobility++;
                if (c + 1 <= 7 && !pieceAt(state.pieces, r - 1, c + 1)) mobility++;
            }
            if (r + 1 <= 7) {
                if (c - 1 >= 0 && !pieceAt(state.pieces, r + 1, c - 1)) mobility++;
                if (c + 1 <= 7 && !pieceAt(state.pieces, r + 1, c + 1)) mobility++;
            }
        }
        if (isBot) botMobility += mobility; else oppMobility += mobility;

        const colorForEval = isBot ? botColor : opponentColor;
        const sign = isBot ? 1 : -1;

        // Базовая позиционная оценка (продвижение, центр)
        if (!p.king) {
            let adv = (colorForEval === "dark" ? r : 7 - r);
            score += sign * adv * 4; 
            
            if ((colorForEval === "dark" && r === 6) || (colorForEval === "light" && r === 1)) {
                score += sign * 60;
            }
            if ((colorForEval === "light" && r === 7) || (colorForEval === "dark" && r === 0)) {
                score += sign * 10;
            }
        }
        
        if (r >= 2 && r <= 5 && c >= 2 && c <= 5) {
            score += sign * 4;
            if (r >= 3 && r <= 4 && c >= 3 && c <= 4) score += sign * 2;
        }

        // 5. Контроль "дорог" (длинные диагонали a1-h8 и h1-a8)
        if (r === c || r + c === 7) {
            score += sign * 6;
        }

        // 2 и 4. Безопасность крайних столбцов и штраф за застревание на краю
        if (c === 0 || c === 7) {
            if (!p.king) {
                // Если на задней линии (защита) или предпоследней (вот-вот дамка) — бонус за безопасность
                if ((colorForEval === "light" && r === 7) || (colorForEval === "dark" && r === 0) ||
                    (colorForEval === "dark" && r === 6) || (colorForEval === "light" && r === 1)) {
                    score += sign * 5; 
                } else {
                    // Если застряла на краю в середине (3-4 линии) — штраф за малоподвижность
                    score -= sign * 5; 
                }
            }
        }
    }
    
    // Добавляем оценку подвижности (за каждый лишний ход +3 очка)
    score += (botMobility - oppMobility) * 3;

    // 3. Логика размена (упрощение позиции при перевесе)
    const materialDiff = botMaterial - oppMaterial;
    const totalPiecesCount = Object.keys(state.pieces).length;
    if (materialDiff > 0) {
        // Бот выигрывает -> поощряем пустую доску (меньше фигур = больше очков)
        score += (24 - totalPiecesCount) * 5; 
    } else if (materialDiff < 0) {
        // Бот проигрывает -> избегаем пустой доски (больше фигур = больше очков)
        score -= (24 - totalPiecesCount) * 5;
    }

    return score;
}

function getAllLegalMovesForBot(state, color) {
    const moves = [];
    
    if (state.mustContinueFrom) {
        const r = state.mustContinueFrom.row;
        const c = state.mustContinueFrom.col;
        const p = state.pieces[r + "_" + c];
        if (p) {
            const dests = getLegalDestinations(state.pieces, r, c, color, !!p.king, state.pendingRemovals);
            for (const d of dests) {
                moves.push({ from: { row: r, col: c }, to: d });
            }
        }
        return moves;
    }

    for (const key in state.pieces) {
        const p = state.pieces[key];
        if (p.color !== color) continue;
        const [r, c] = key.split('_').map(Number);
        const dests = getLegalDestinations(state.pieces, r, c, color, !!p.king, state.pendingRemovals);
        for (const d of dests) {
            moves.push({ from: { row: r, col: c }, to: d });
        }
    }

    moves.sort((a, b) => {
        let valA = 0, valB = 0;
        const distA = Math.abs(a.to.row - a.from.row);
        const distB = Math.abs(b.to.row - b.from.row);
        
        if (distA > 1) {
            const dr = (a.to.row - a.from.row) / distA;
            const dc = (a.to.col - a.from.col) / distA;
            const capturedKey = (a.from.row + dr) + "_" + (a.from.col + dc);
            const capPiece = state.pieces[capturedKey];
            if (capPiece && capPiece.king) valA = 100;
            else if (capPiece) valA = 50;
        }
        
        if (distB > 1) {
            const dr = (b.to.row - b.from.row) / distB;
            const dc = (b.to.col - b.from.col) / distB;
            const capturedKey = (b.from.row + dr) + "_" + (b.from.col + dc);
            const capPiece = state.pieces[capturedKey];
            if (capPiece && capPiece.king) valB = 100;
            else if (capPiece) valB = 50;
        }
        
        return valB - valA;
    });

    return moves;
}

// ===== СТАРТ ПРИЛОЖЕНИЯ =====

// РАЗДЕЛЁННЫЙ СТАРТ.
//
// startApp() — только интерфейс: он обязан работать всегда, в том числе
// когда вход не удался. Язык и переводы инициализируются здесь же, как и
// раньше: initDataUnsafe.language_code для UI допустим, прав он не даёт.
//
// startFirebaseFlows() — всё, что обращается к Firebase. Вызывается ТОЛЬКО
// после подтверждённого входа.
function startApp() {
    applyTranslationsToDOM();
}

function startFirebaseFlows(me) {
    if (!me || typeof me.id !== "string" || !/^tg_\d+$/.test(me.id)) return false;
    if (!auth.currentUser || auth.currentUser.uid !== me.id) return false;
    if (localOnlyBotGame) { pendingFirebaseIdentity = me; firebaseAuthReady = false; return false; }
    myTelegramId = me.id; myTelegramName = me.name; firebaseAuthReady = true; firebaseFlowsStarted = true; pendingFirebaseIdentity = null;
    const greetingNameSpan = document.getElementById("user-greeting-name");
    if (greetingNameSpan) { let displayName = myTelegramName.length > 15 ? myTelegramName.substring(0, 15) + "..." : myTelegramName; greetingNameSpan.textContent = displayName; }
    const joinedViaLink = checkForInviteLink();
    if (!joinedViaLink) loadActiveRooms();
    return true;
}
function queueOrStartFirebaseFlows(me) {
    if (localOnlyBotGame) { pendingFirebaseIdentity = me; firebaseAuthReady = false; return false; }
    return startFirebaseFlows(me);
}
function activatePendingFirebaseFlows() {
    if (localOnlyBotGame || !pendingFirebaseIdentity) return false;
    const me = pendingFirebaseIdentity;
    if (!auth.currentUser || auth.currentUser.uid !== me.id) { pendingFirebaseIdentity = null; firebaseAuthReady = false; return false; }
    return startFirebaseFlows(me);
}

// Общая функция: возврат в свою собственную активную партию — как игрок,
// а не зритель. Используется и из списка "Кто играет?", и при повторном
// открытии своей же ссылки-приглашения.
function resumeOwnActiveRoom(code) {
    if (!canUseFirebase()) return Promise.resolve(false);
    return database.ref("rooms/" + code).once("value").then(function (snapshot) {
        if (!canUseFirebase()) return false;
        const room = snapshot.val();

        if (!room ||
            !room.pieces ||
            room.status !== "active" ||
            room.winner ||
            !room.players) {
            return false;
        }

        // v184 BOTH-OFFLINE: продолжить нельзя. Проверяем ДО startOnlineGame(),
        // потому что setupPresence там немедленно поставит online:true и
        // absentSince:null — то есть сотрёт улику, по которой партия мертва.
        if (isRoomAbandonedNow(room)) {
            return false;
        }

        let color = null;
        if (room.players.light && room.players.light.id === myTelegramId) {
            color = "light";
        } else if (room.players.dark && room.players.dark.id === myTelegramId) {
            color = "dark";
        }

        if (!color) {
            return false;
        }

        stopGroupLobbyListening();

        if (myCurrentSpectatorRef) {
            myCurrentSpectatorRef.remove();
            myCurrentSpectatorRef = null;
        }

        roomCode = code;
        myColor = color;
        isOnlineGame = true;
        isSpectator = false;

        showScreen(gameScreen);
        startOnlineGame();

        return true;
    }).catch(function (error) {
        console.error("Resume own room failed:", error);
        return false;
    });
}

// ===== ЛОББИ ГРУППЫ (Список комнат) =====

document.addEventListener('DOMContentLoaded', function() {
    const btnBackToMenu = document.getElementById("btn-back-to-menu");

    if (btnBackToMenu) {
        btnBackToMenu.addEventListener("click", function() {
            stopGroupLobbyListening();
            // Если я сам ждал соперника через "Играть онлайн" — убираем свою
            // запись СРАЗУ ЖЕ при явном выходе, чтобы у остальных она не
            // висела лишнее время. Аварийный выход (закрытие приложения,
            // потеря сети) по-прежнему обрабатывается через onDisconnect/presence.
            if (myPendingOnlineRoom) {
                const roomToRemove = myPendingOnlineRoom;
                if (canUseFirebase()) database.ref("rooms/" + roomToRemove).remove();
                if (canUseFirebase()) database.ref("users/" + myTelegramId + "/rooms/" + roomToRemove).remove();
                if (activeMatchRef) { activeMatchRef.off(); activeMatchRef = null; }
                myPendingOnlineRoom = null;
                stopPresenceHeartbeat();
                myPresenceRef = null;
            }
            showScreen(menuScreen);
            loadActiveRooms();
        });
    }
});

// ===== BOTH-OFFLINE ABANDONED (60 секунд) =====
//
// Единственный новый предикат. Отвечает на один вопрос: оба ли текущих игрока
// отсутствуют НЕПРЕРЫВНО не меньше минуты.
//
// Считаем от absentSince, а не от lastSeen. absentSince пишется СЕРВЕРНЫМ
// временем и только в момент реального ухода — сворачиванием или серверным
// onDisconnect. Любое возвращение ставит его в null. Значит непрерывность
// отсутствия закодирована самим полем, историю хранить не нужно. lastSeen для
// этого не годится: он дрожит на каждом heartbeat.
//
// Минута идёт с ухода ВТОРОГО игрока, то есть от МАКСИМУМА двух absentSince.
// Пока один в игре, предикат ложен по построению — существующее техническое
// поражение при одном отсутствующем не затрагивается.
//
// FAIL CLOSED: пока .info/serverTimeOffset не получен, getEstimatedServerNow()
// вырождается в часы телефона. Без подтверждённого смещения не судим вовсе.
function isRoomAbandonedNow(room) {
    if (!room) return false;
    if (!serverTimeOffsetReady) return false;
    if (room.status !== "active") return false;
    if (room.winner || room.result) return false;

    const p = room.presence;
    if (!p || !p.light || !p.dark) return false;
    if (p.light.online !== false || p.dark.online !== false) return false;

    const lightAbsent = p.light.absentSince;
    const darkAbsent = p.dark.absentSince;
    if (typeof lightAbsent !== "number" || typeof darkAbsent !== "number") return false;

    const secondLeftAt = Math.max(lightAbsent, darkAbsent);
    return (getEstimatedServerNow() - secondLeftAt) >= RECONNECT_GRACE_MS;
}

// Единый колбэк атомарного invite-join. В отличие от двухфазной схемы
// здесь нет промежуточного сохранённого players/dark: место и activation
// появляются на сервере одним commit.
function buildAtomicInviteJoin(currentRoom, uid, name) {
    if (!currentRoom || !currentRoom.pieces || !currentRoom.players) return undefined;
    if (currentRoom.winner || currentRoom.result || currentRoom.status === "finished") return undefined;

    const light = currentRoom.players.light;
    if (light && light.id === uid) return undefined;

    const dark = currentRoom.players.dark;
    if (dark && dark.id && dark.id !== uid) return undefined;

    // Идемпотентный повтор: комната уже active именно с нами.
    if (currentRoom.status === "active" && dark && dark.id === uid) return currentRoom;
    if (currentRoom.status !== "waiting") return undefined;

    currentRoom.players.dark = { id: uid, name: name };
    currentRoom.status = "active";
    currentRoom.turnStartedAt = firebase.database.ServerValue.TIMESTAMP;
    return currentRoom;
}

function classifyAtomicInviteJoinFailure(room, uid) {
    if (!room || !room.pieces || !room.players) return "missing";
    const light = room.players.light;
    if (light && light.id === uid) return "self";
    const dark = room.players.dark;
    if (dark && dark.id === uid && room.status === "active" && !room.winner && !room.result) return "won";
    if (dark && dark.id && dark.id !== uid) return "occupied";
    if (room.status !== "waiting") return "not_waiting";
    return "unknown";
}

// --- Была ли сторона комнаты "давно оффлайн" — та же семантика, что и
// раньше, но вынесена в отдельную функцию, чтобы переиспользовать и в
// рендере, и в периодическом sweep'е, не только внутри одного listener'а. ---
// CLOCK SAFETY: можно ли вообще судить о возрасте серверных меток.
// Пока .info/serverTimeOffset не получен, cachedServerTimeOffsetMs равен нулю
// и getEstimatedServerNow() вырождается в часы телефона — то есть ровно в ту
// ошибку, которую мы чиним. Без подтверждённого смещения не судим.
function canJudgeStaleByServerTime() {
    return serverTimeOffsetReady;
}

// CLOCK SAFETY: разрушительное удаление ЧУЖОЙ комнаты требует большего, чем
// просто скрытие карточки. Скрыть — обратимо, удалить — нет.
//
// Почему порог именно такой, а не строже.
//
// canTrustAbsenceForCleanup() неприменима: она требует
// roomSnapshotSeenSinceConnect, а этот флаг выставляет только слушатель
// КОМНАТЫ — в лобби он всегда false.
//
// serverAckSinceConnect тоже неприменим, хотя выглядит подходящим. Он
// выставляется ИСКЛЮЧИТЕЛЬНО из presence-путей: три места в setupPresence()
// и одно в revivePresenceAfterReconnect(). Человек, который просто открыл
// «Кто играет?» и ни в какую партию не заходил, presence не создаёт вовсе,
// поэтому флаг у него навсегда остаётся false. С этим условием обычный
// посетитель лобби не убрал бы НИ ОДНОЙ протухшей комнаты, и мусор копился
// бы до тех пор, пока кто-нибудь не сыграет партию.
//
// Остаются три условия, которые в лобби осмысленны и проверяемы:
//   isFirebaseConnected     связь есть прямо сейчас;
//   CONNECTION_SETTLE_MS    она держится дольше окна нестабильности,
//                           отсчёт по МОНОТОННЫМ часам — их нельзя сбить
//                           переводом системного времени;
//   serverTimeOffsetReady   смещение получено, то есть обмен с сервером
//                           реально состоялся, и меткам можно верить.
// Любое из них ложно — не удаляем. Fail closed сохранён.
function canDeleteStaleRoomFromLobby() {
    if (!isFirebaseConnected || connectedSinceMono === null) return false;
    if (getMonotonicNow() - connectedSinceMono < CONNECTION_SETTLE_MS) return false;
    if (!serverTimeOffsetReady) return false;
    return true;
}

function isRoomPlayerStale(room, color) {
    const p = room && room.presence && room.presence[color];
    if (!p) return true;
    // lastSeen — СЕРВЕРНЫЙ timestamp. Сравнение с голым Date.now() давало обе
    // ошибки сразу: при отстающих часах разность выходила меньше порога и
    // мёртвая комната висела в списке вечно, при спешащих — живую комнату
    // скрывало и физически удаляло из чужого лобби.
    if (!canJudgeStaleByServerTime()) return false;
    return (getEstimatedServerNow() - (p.lastSeen || 0)) > RECONNECT_GRACE_MS;
}

// --- Сигнатура ТОЛЬКО тех полей, что реально влияют на отображение строки
// в лобби. Сознательно НЕ включает pieces/moveCount/turn/lastMove (лобби их
// не показывает) и НЕ включает сырой lastSeen-timestamp (иначе сигнатура
// менялась бы на каждый heartbeat, сводя на нет всю экономию). Включает
// lightIsStale — единственный staleness-признак, реально влияющий на
// видимость waiting-комнаты; вычисляется каждый раз заново от Date.now(),
// поэтому даже без нового Firebase-события периодический пересчёт (см.
// runLobbyStaleSweep) корректно улавливает переход "была видна -> стала
// неактуальна". ---
function computeLobbyVisibleSignature(room) {
    if (!room) return null;
    if (room.status === "finished" || room.winner) return "finished";
    const lightId = (room.players && room.players.light && room.players.light.id) || "";
    const lightName = (room.players && room.players.light && room.players.light.name) || "";
    const darkId = (room.players && room.players.dark && room.players.dark.id) || "";
    const darkName = (room.players && room.players.dark && room.players.dark.name) || "";
    const lightIsStale = isRoomPlayerStale(room, "light");
    return [room.status || "", lightId, lightName, darkId, darkName, lightIsStale].join("|");
}

// --- Единая точка "мне нужно перерисовать список" — коалесцирует ЛЮБОЕ
// количество вызовов подряд (initial child_added burst на N существующих
// комнат, несколько child_changed/child_removed почти одновременно) в
// МАКСИМУМ один реальный render на кадр экрана. Ничего не теряет: сам
// renderLobbyListFromCache() всегда читает АКТУАЛЬНЫЙ на момент выполнения
// кеш, а не снимок на момент планирования — значит объединение нескольких
// "запланировать рендер" в один реальный вызов совершенно безопасно. ---
function scheduleLobbyRender() {
    if (lobbyRenderFrameId !== null) return;
    lobbyRenderFrameId = requestAnimationFrame(function () {
        lobbyRenderFrameId = null;
        renderLobbyListFromCache();
    });
}

// --- Полный рендер списка ИЗ УЖЕ ЗАГРУЖЕННОГО ЛОКАЛЬНОГО КЕША — никаких
// Firebase-чтений здесь нет вообще, это чистая клиентская операция. Не
// вызывать напрямую из lobby event-flow — использовать scheduleLobbyRender()
// выше, чтобы burst из нескольких событий не превращался в N рендеров.
// Логика фильтрации/HTML/кнопок — та же самая, что была в старом
// value-listener'е, просто источник данных — lobbyRoomsByCode вместо
// свежего snapshot.val(). ---
function renderLobbyListFromCache() {
    const groupRoomsList = document.getElementById("group-rooms-list");
    if (!groupRoomsList) return;

    let waitingHtml = "";
    let activeHtml = "";

    for (const code in lobbyRoomsByCode) {
        const room = lobbyRoomsByCode[code];
        if (!room) continue;

        // Не показываем завершенные игры
        if (room.status === "finished" || room.winner) continue;

        // v183 (BUG №1): waiting-комната — ВСЕГДА приватное приглашение.
        // Её создаёт только «Играть с другом», и войти в неё можно только по
        // Telegram-ссылке. Публичный список раньше показывал её всем подряд с
        // кнопкой «Играть», и посторонний занимал место приглашённого друга.
        // Публичный экран показывает ТОЛЬКО идущие партии с двумя игроками.
        //
        // Создатель при этом остаётся на своём экране ожидания, а вход по
        // ссылке идёт мимо лобби: checkForInviteLink() читает комнату сам.
        if (room.status === "waiting") {
            continue;
        }

        const lightIsStale = isRoomPlayerStale(room, "light");

        // Активная партия, где ОБЕ стороны давно оффлайн — гарантированно
        // заброшена (та же семантика, что и в runLobbyStaleSweep, которая
        // физически удаляет такую комнату). Скрываем здесь ДОПОЛНИТЕЛЬНО,
        // на самом рендере — не дожидаясь, пока чьё-то устройство реально
        // выполнит remove() и это дойдёт как child_removed. Так корректность
        // ОТОБРАЖЕНИЯ не зависит от того, успел ли где-то физически пройти
        // sweep — сам факт открытия/обновления лобби у ЛЮБОГО пользователя
        // уже достаточен, чтобы не показать заведомо мёртвую партию.
        if (room.status === "active" && lightIsStale && isRoomPlayerStale(room, "dark")) {
            continue;
        }

        // v184 BOTH-OFFLINE: логически мёртвая партия не показывается никому,
        // независимо от того, успел ли кто-нибудь физически её удалить.
        if (isRoomAbandonedNow(room)) {
            continue;
        }

        let lightName = (room.players && room.players.light && room.players.light.name) || "Ожидание...";
        let darkName = (room.players && room.players.dark && room.players.dark.name) || "Ожидание...";
        lightName = escapeHtml(lightName);
        darkName = escapeHtml(darkName);
        // v182: code — это КЛЮЧ УЗЛА Firebase, а не наш сгенерированный код.
        // Ключ задаёт тот, кто создаёт комнату, а RTDB запрещает в ключах
        // только . $ # [ ] / и управляющие символы — кавычка и угловые
        // скобки разрешены. Без экранирования такой ключ разрывал бы
        // атрибут data-code="..." и вносил в лобби чужую разметку через
        // innerHTML. Экранируем тем же escapeHtml, что и имена строкой выше.
        // Обратное чтение не меняется: getAttribute() отдаёт уже
        // раскодированную строку, поэтому обычный код комнаты приходит в
        // обработчик ровно таким же, как раньше.
        const codeAttr = escapeHtml(code);

        if (room.status === "active") {
            // Свою bot-партию не показываем себе вообще — единственный
            // официальный путь продолжить её: "Играть с ботом" -> "Продолжить"
            // (owner-synced flow через botSessions). Раньше "Кто играет" вела
            // на владельческий путь, который на практике оказался ненадёжен
            // при повторном входе — проще и безопаснее вообще не показывать
            // здесь свою же bot-игру, чем поддерживать два owner-flow.
            // Проверка по id ("bot" — жёстко прописанная строка, см.
            // mirrorCommittedStateToSpectateRoom, не пользовательское имя),
            // не по имени.
            const isMyBotGame =
                (room.players && room.players.light && room.players.light.id === "bot" &&
                    room.players.dark && room.players.dark.id === myTelegramId) ||
                (room.players && room.players.dark && room.players.dark.id === "bot" &&
                    room.players.light && room.players.light.id === myTelegramId);
            if (isMyBotGame) continue;

            const isMyActiveGame =
                (room.players && room.players.light && room.players.light.id === myTelegramId) ||
                (room.players && room.players.dark && room.players.dark.id === myTelegramId);

            if (isMyActiveGame) {
                activeHtml += `
                    <div class="group-room-card">
                        <div class="group-room-info active">⚫ ${lightName} vs ⚪ ${darkName}</div>
                        <button class="group-resume-btn" data-code="${codeAttr}">${t("btn_continue")}</button>
                    </div>
                `;
            } else {
                activeHtml += `
                    <div class="group-room-card">
                        <div class="group-room-info active">⚫ ${lightName} vs ⚪ ${darkName}</div>
                        <button class="group-watch-btn" data-code="${codeAttr}">Смотреть</button>
                    </div>
                `;
            }
        }
    }

    let finalHtml = "";
    if (waitingHtml) {
        finalHtml += '<p class="section-title">' + t("lobby_waiting") + '</p>' + waitingHtml;
    }
    if (activeHtml) {
        finalHtml += '<p class="section-title" style="margin-top: 15px;">' + t("lobby_active") + '</p>' + activeHtml;
    }
    if (!finalHtml) {
        finalHtml = '<p class="section-title">' + t("lobby_empty") + '</p>';
    }
    groupRoomsList.innerHTML = finalHtml;

    // Навешиваем обработчики на кнопки
    groupRoomsList.querySelectorAll('.group-join-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            joinGroupRoom(this.getAttribute('data-code'));
        });
    });

    groupRoomsList.querySelectorAll('.group-watch-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            watchGroupRoom(this.getAttribute('data-code'));
        });
    });

    groupRoomsList.querySelectorAll('.group-resume-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const code = this.getAttribute('data-code');
            resumeOwnActiveRoom(code).then(function (resumed) {
                if (!resumed) {
                    showInfoModal(t("err_no_active_game"), false);
                }
            });
        });
    });
}

// --- Периодический локальный sweep — НЕ Firebase-чтение, работает только
// по уже находящемуся в памяти lobbyRoomsByCode. Нужен, потому что
// комната, полностью переставшая слать события (закрыли приложение),
// больше не породит child_changed сама по себе — без этого таймера она
// зависла бы в кеше и в списке навсегда. Та же семантика cleanup, что была
// в старом value-listener'е (auto-очистка зависшего rematchProposal,
// ленивое удаление окончательно заброшенных active-комнат) — не вторая
// параллельная система, тот же самый порог RECONNECT_GRACE_MS. ---
function runLobbyStaleSweep() {
    // При потере подтверждённой Firebase Auth sweep может продолжать жить по
    // старому setInterval, но не имеет права делать ни одной серверной записи.
    // Рендер локального кеша безопасен и остаётся доступен.
    if (!canUseFirebase()) {
        scheduleLobbyRender();
        return;
    }
    // CLOCK SAFETY: удалять чужие комнаты можно только при доказанно надёжном
    // времени и живой связи. Скрытие в рендере остаётся мягче — оно обратимо.
    const mayDelete = canDeleteStaleRoomFromLobby();
    for (const code in lobbyRoomsByCode) {
        const room = lobbyRoomsByCode[code];
        if (!room) continue;

        // АВТО-ЧИСТКА: зависшее предложение реванша.
        //
        // CLOCK SAFETY. Это тоже РАЗРУШИТЕЛЬНАЯ запись в чужую комнату, и она
        // обязана идти под тем же порогом, что удаление самой комнаты.
        // Две причины, обе проверены:
        //   1. без связи remove() не отменяется, а уходит в offline-очередь
        //      Firebase и применяется позже — уже к другому состоянию;
        //   2. isRoomPlayerStale() отвечает true при ПОЛНОСТЬЮ отсутствующем
        //      presence (первая строка `if (!p) return true;`) — раньше, чем
        //      дойдёт до проверки серверного времени. То есть без порога
        //      отсутствие presence само по себе разрешало бы удаление даже
        //      при недостоверных часах.
        //
        // Саму строку `if (!p) return true;` не трогаем: она обслуживает ещё и
        // РЕНДЕР, где скрытие обратимо. Достаточно закрыть разрушительный путь.
        if (mayDelete && room.rematchProposal) {
            const proposerColor = room.rematchProposal.by;
            const answererColor = proposerColor === "light" ? "dark" : "light";
            if (isRoomPlayerStale(room, answererColor)) {
                database.ref("rooms/" + code + "/rematchProposal").remove();
            }
        }

        if (room.status === "finished" || room.winner) continue;

        const lightIsStale = isRoomPlayerStale(room, "light");
        const darkIsStale = isRoomPlayerStale(room, "dark");

        // НОВОЕ (v171): физическое удаление мёртвых waiting-комнат. Создатель
        // давно оффлайн (lastSeen старше RECONNECT_GRACE_MS) и второй игрок
        // так и не подключился — комната гарантированно никому не нужна.
        // Та же ленивая семантика, что у active-очистки ниже: выполняется у
        // любого, кто держит лобби открытым. ВАЖНО: критерий — только возраст
        // lastSeen, НЕ online:false (свернувший Telegram создатель тоже
        // online:false, но его lastSeen поддерживает фоновый heartbeat —
        // см. myWaitingRoomNoOpponent в setupPresence). joinGroupRoom входит
        // через транзакцию и при гонке с удалением чисто отменится.
        if (mayDelete &&
            room.status === "waiting" &&
            !(room.players && room.players.dark) &&
            lightIsStale) {
            if (room.players && room.players.light && room.players.light.id) {
                database.ref("users/" + room.players.light.id + "/rooms/" + code).remove();
            }
            database.ref("rooms/" + code).remove();
            continue;
        }

        // ЛЕНИВАЯ ОЧИСТКА: если партия активна, но оба игрока по-настоящему
        // давно оффлайн — партия гарантированно заброшена. child_removed
        // сам уберёт её из кеша/списка, когда remove() ниже реально пройдёт —
        // здесь кеш вручную не трогаем.
        // v184 BOTH-OFFLINE: best-effort физическая уборка. Не получится —
        // не страшно: видимость и возможность продолжить уже закрыты
        // предикатом на всех путях чтения.
        //
        // CLOCK SAFETY. Порог mayDelete нужен и здесь, хотя сам предикат
        // fail-closed по serverTimeOffsetReady. Этого мало: смещение,
        // однажды полученное, остаётся true и после обрыва связи, а
        // isRoomAbandonedNow не проверяет isFirebaseConnected вовсе.
        //
        // Гонка, которую это закрывает:
        //   лобби видело обоих offline и потеряло связь;
        //   один игрок вернулся раньше минуты, но отключённый клиент этого
        //   не видит — его кеш заморожен на старом состоянии;
        //   sweep продолжает крутиться по setInterval, через минуту предикат
        //   на устаревшем кеше становится true;
        //   remove() уходит в offline-очередь Firebase и применяется ПОСЛЕ
        //   реконнекта — к уже ЖИВОЙ комнате.
        //
        // Сам isRoomAbandonedNow и вся логическая блокировка abandoned на
        // resume, deep-link, рендере и реконнекте НЕ меняются: там решение
        // принимается по свежим данным, и порог связи им не нужен.
        // Здесь же речь о необратимой записи в чужую комнату.
        if (mayDelete && isRoomAbandonedNow(room)) {
            if (room.players && room.players.light && room.players.light.id) {
                database.ref("users/" + room.players.light.id + "/rooms/" + code).remove();
            }
            if (room.players && room.players.dark && room.players.dark.id) {
                database.ref("users/" + room.players.dark.id + "/rooms/" + code).remove();
            }
            database.ref("rooms/" + code).remove();
            continue;
        }

        if (mayDelete && room.status === "active" && lightIsStale && darkIsStale) {
            if (room.players && room.players.light && room.players.light.id) {
                database.ref("users/" + room.players.light.id + "/rooms/" + code).remove();
            }
            if (room.players && room.players.dark && room.players.dark.id) {
                database.ref("users/" + room.players.dark.id + "/rooms/" + code).remove();
            }
            database.ref("rooms/" + code).remove();
        }
    }

    // Нужен именно здесь, но НЕ по причине "обновить UI после remove() выше" —
    // это было бы избыточно с будущим child_removed, и раньше было бы
    // проблемой (рендер по ещё не обновлённому кешу). Но раз это теперь
    // scheduleLobbyRender() (коалесцирует), избыточность с будущим
    // child_removed уже не имеет значения — оба вызова просто схлопнутся
    // в один кадр, а renderLobbyListFromCache() всегда читает АКТУАЛЬНЫЙ
    // кеш на момент фактического исполнения, не снимок на момент вызова.
    //
    // Настоящая причина, по которой вызов необходим — waiting-комната,
    // молча пересекшая порог staleness ЧИСТО по часам (никто не выходил,
    // просто прошло время) — не порождает вообще НИКАКОГО Firebase-события,
    // значит НИЧТО, кроме этого периодического таймера, не заметит и не
    // скроет её из списка.
    scheduleLobbyRender();
}

// --- Единая точка остановки всего, что связано с лобби — снимает все три
// child-listener'а ОДНИМ вызовом .off() без аргументов на том же ref'е
// (подтверждено документацией Firebase — off() без аргументов снимает все
// типы событий на этой ссылке разом), останавливает локальный stale-таймер,
// очищает кеш. Используется и при обычном закрытии лобби, и при переходе в
// игру, реванш, старт бота — везде, где раньше был просто
// "if (groupLobbyListener) { groupLobbyListener.off(); groupLobbyListener = null; }". ---
function stopGroupLobbyListening() {
    if (groupLobbyListener) {
        groupLobbyListener.off();
        groupLobbyListener = null;
    }
    if (lobbyStaleCheckTimer) {
        clearInterval(lobbyStaleCheckTimer);
        lobbyStaleCheckTimer = null;
    }
    if (lobbyRenderFrameId !== null) {
        cancelAnimationFrame(lobbyRenderFrameId);
        lobbyRenderFrameId = null;
    }
    lobbyRoomsByCode = {};
    lobbySignatureByCode = {};
}

function showGroupLobby() {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return;
    const groupLobbyScreen = document.getElementById("group-lobby-screen");
    const groupRoomsList = document.getElementById("group-rooms-list");

    if (!groupLobbyScreen || !groupRoomsList) return;

    showScreen(groupLobbyScreen);
    groupRoomsList.innerHTML = '<p class="section-title">' + t("loading") + '</p>';

    // Важно: отключаем предыдущую "слежку" за списком, если она ещё была
    // активна (например, при повторном входе) — иначе они накапливаются
    // одна поверх другой и начинают работать непредсказуемо.
    stopGroupLobbyListening();

    // Показываем ВСЕХ, кто играет, без привязки к коду группы —
    // раньше здесь была фильтрация по GROUP_ID (Telegram chat_instance),
    // но она оказалась ненадёжной и разные люди получали разные коды,
    // из-за чего никто никого не видел.
    //
    // child_added/child_changed/child_removed вместо единого value —
    // каждое событие несёт снимок ТОЛЬКО одной изменившейся комнаты, а не
    // всей коллекции rooms целиком (подтверждено документацией Firebase).
    groupLobbyListener = database.ref("rooms");

    groupLobbyListener.on("child_added", function (snapshot) {
        const code = snapshot.key;
        const room = snapshot.val();
        lobbyRoomsByCode[code] = room;
        lobbySignatureByCode[code] = computeLobbyVisibleSignature(room);
        scheduleLobbyRender();
    });

    groupLobbyListener.on("child_changed", function (snapshot) {
        const code = snapshot.key;
        const room = snapshot.val();
        const newSignature = computeLobbyVisibleSignature(room);
        // Всегда обновляем сами данные в кеше (нужны свежие presence/players
        // для будущего sweep'а и для действий по клику), но DOM трогаем
        // ТОЛЬКО если что-то реально видимое изменилось — обычный ход
        // (pieces/moveCount/turn) или heartbeat, не меняющий online-статус,
        // не должны перерисовывать список.
        lobbyRoomsByCode[code] = room;
        if (newSignature === lobbySignatureByCode[code]) {
            return;
        }
        lobbySignatureByCode[code] = newSignature;
        scheduleLobbyRender();
    });

    groupLobbyListener.on("child_removed", function (snapshot) {
        const code = snapshot.key;
        delete lobbyRoomsByCode[code];
        delete lobbySignatureByCode[code];
        scheduleLobbyRender();
    });

    // Локальный таймер — единственный способ заметить комнату, которая
    // перестала слать вообще любые события (закрыли приложение), раз мы
    // больше не читаем всю коллекцию целиком на каждое чужое изменение.
    // Не Firebase-чтение — работает по уже загруженному кешу.
    if (!lobbyStaleCheckTimer) {
        lobbyStaleCheckTimer = setInterval(runLobbyStaleSweep, LOBBY_STALE_CHECK_INTERVAL_MS);
    }

    // ПЕРВЫЙ sweep — отдельно, с коротким timeout, НЕ дожидаясь первого
    // тика интервала (8с). Реальный сценарий бага: пользователь открывает
    // "Кто играет" и почти сразу кликает "Смотреть" — это останавливает
    // весь lobby listening (включая интервал) через stopGroupLobbyListening()
    // раньше, чем интервал успевает сработать хотя бы раз. 1500мс — запас,
    // чтобы initial child_added burst успел наполнить кеш, но заметно
    // быстрее типичного "открыл и сразу кликнул".
    setTimeout(function () {
        if (lobbyStaleCheckTimer) runLobbyStaleSweep();
    }, 1500);
}

// Функция присоединения к открытой комнате
function joinGroupRoom(code) {
    // Без подтверждённого входа НИ ОДНОЙ записи в Firebase.
    // Локальная игра при этом продолжает работать.
    if (!canUseFirebase()) return;
    roomCode = code;
    myColor = "dark";
    isOnlineGame = true;
    isSpectator = false;

    database.ref("rooms/" + roomCode).once("value").then(function(snapshot) {
        if (!canUseFirebase()) return;
        const room = snapshot.val();
        if (!room || room.status !== "waiting") {
            showInfoModal(t("err_room_taken"), false);
            return;
        }

        const creatorId = room.players.light.id;
        const creatorName = room.players.light.name;

        // ПРОВЕРКА: Защита от игры против самого себя
        if (creatorId && creatorId === myTelegramId) {
            showInfoModal(t("err_play_self"), false);
            return;
        }

        // ИСПОЛЬЗУЕМ ТРАНЗАКЦИЮ: гарантируем, что комната не удалена и имеет pieces
        database.ref("rooms/" + roomCode).transaction(function(currentRoom) {
            if (!currentRoom || !currentRoom.pieces || currentRoom.status !== "waiting") return; // Отмена, если комната битая/удалена
            currentRoom.status = "active";
            currentRoom.players = currentRoom.players || {};
            currentRoom.players.dark = { id: myTelegramId, name: myTelegramName };
            currentRoom.turnStartedAt = firebase.database.ServerValue.TIMESTAMP;
            return currentRoom;
        }).then(function(result) {
            if (!canUseFirebase()) return;
            if (!result.committed) {
                showInfoModal("Комната уже занята, удалена или не существует.", false);
                return;
            }

            // Если я сам в этот момент тоже ждал соперника в своей комнате —
            // убираем её, раз я теперь играю здесь (иначе останется "призраком").
            if (myPendingOnlineRoom && myPendingOnlineRoom !== roomCode) {
                database.ref("rooms/" + myPendingOnlineRoom).remove();
                database.ref("users/" + myTelegramId + "/rooms/" + myPendingOnlineRoom).remove();
                myPendingOnlineRoom = null;
            }

            database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
                opponentName: creatorName,
                myColor: "dark"
            });
            
            // Отправляем сигнал создателю комнаты (если он ждал в матчмейкинге)
            database.ref("users/" + creatorId + "/activeMatch").set(roomCode);
            // Безопасно убираем создателя из очереди матчмейкинга (если он там был)
            database.ref("matchmakingQueue/" + creatorId).remove();

            stopGroupLobbyListening();
            showScreen(gameScreen);
            startOnlineGame();
        }).catch(function(error) {
            console.error("Join room transaction failed:", error);
            showInfoModal(t("err_join_failed"), false);
            showScreen(menuScreen);
            loadActiveRooms();
        });
    });
}

// Функция просмотра чужой игры (Наблюдатель)
// Точка входа при клике по комнате в "Кто играет".
// Единственный официальный путь просмотра ЧУЖОЙ игры (online или bot) —
// свою активную bot-партию lobby теперь вообще не показывает и не даёт
// на неё кликнуть (см. renderLobbyListFromCache), поэтому отдельная
// owner-detection ветка здесь больше не нужна: раньше она вела на owner-
// attach через "Кто играет", который на практике оказался ненадёжным
// вторым owner-flow (синхронизация могла сломаться, бот — зависнуть).
// Единственный официальный способ продолжить свою bot-игру теперь —
// "Играть с ботом" -> "Продолжить" (owner-synced flow через botSessions).
function watchGroupRoom(code) {
    if (!requireFirebaseAuth()) return;
    // v184 BOTH-OFFLINE: смотреть мёртвую партию нельзя. Кеш лобби здесь
    // всегда заполнен — кнопка существует только на отрисованном списке.
    const cached = lobbyRoomsByCode ? lobbyRoomsByCode[code] : null;
    if (isRoomAbandonedNow(cached)) {
        showInfoModal(t("err_no_active_game"), false);
        scheduleLobbyRender();
        return;
    }
    watchGroupRoomAsSpectator(code);
}

function watchGroupRoomAsSpectator(code) {
    if (!canUseFirebase()) return;
    // Если я сам ждал соперника через "Играть онлайн" и решил пойти
    // посмотреть чужую партию вместо этого — убираем свою старую заявку,
    // чтобы она не висела в списке как будто я всё ещё жду.
    if (myPendingOnlineRoom) {
        const roomToRemove = myPendingOnlineRoom;
        database.ref("rooms/" + roomToRemove).remove();
        database.ref("users/" + myTelegramId + "/rooms/" + roomToRemove).remove();
        if (activeMatchRef) { activeMatchRef.off(); activeMatchRef = null; }
        myPendingOnlineRoom = null;
    }
    // Зритель никогда не создаёт свой presence — на всякий случай отвязываемся
    // от presence любой предыдущей роли (например, если до этого был игроком).
    detachMyPresence();

    // Защитный сброс — не полагаемся на то, что isSpectator=true где-то
    // ниже "перевесит" в условиях видимости кнопок/поведения. Если владелец
    // каким-то путём попал в spectator-режим, не пройдя через явный "В меню"
    // (который уже вызывает detachFromOwnerBotSessionLocally), полноценно
    // отвязываемся здесь — иначе heartbeat/retry-таймер/spectators-listener
    // owner-сессии продолжили бы фоново работать.
    if (ownerSessionAttached) {
        detachFromOwnerBotSessionLocally();
    }
    isBotGame = false;

    roomCode = code;
    myColor = null; // У наблюдателя нет цвета
    isOnlineGame = true;
    isSpectator = true; // ВАЖНО: Режим наблюдателя
    lastAnimatedMoveCount = null; // Начало просмотра — не анимируем ход, случившийся ДО подключения
    spectatorInterruptedModalShown = false; // Новая сессия просмотра — модалка ещё не показывалась

    stopGroupLobbyListening();

    // Регистрируем себя как зрителя этой партии (для счётчика "N зрителей"),
    // и сразу настраиваем автоматическое удаление при закрытии приложения.
    if (myTelegramId) {
        const myWatchRef = database.ref("rooms/" + roomCode + "/spectators/" + myTelegramId);
        myWatchRef.set(myTelegramName);
        myWatchRef.onDisconnect().remove();
        myCurrentSpectatorRef = myWatchRef;
    }

    showScreen(gameScreen);
    
    // Запускаем слушатель игры без установки Presence
    if (roomListenerRef) roomListenerRef.off();
    // Новая подписка на комнату — прежние доказательства свежести больше не
    // действуют: они относились к другой комнате/другому listener'у.
    resetRoomFreshnessProof();
    const myListenerGen = listenerGeneration;
    roomListenerRef = database.ref("rooms/" + roomCode);
    roomListenerRef.on("value", function (snapshot) {
        // Запоздалый колбэк уже отписанного listener'а не должен ничего
        // подтверждать для текущей комнаты.
        if (myListenerGen !== listenerGeneration) return;
        const room = snapshot.val();
        if (!room || !room.pieces) {
            if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
            if (myCurrentSpectatorRef) { if (canUseFirebase()) myCurrentSpectatorRef.remove(); myCurrentSpectatorRef = null; }
            showScreen(menuScreen);
            showInfoModal(t("err_game_closed"), false);
            return;
        }

        const newState = {
            pieces: room.pieces,
            turn: room.turn,
            mustContinueFrom: room.mustContinueFrom || null,
            capturedDark: room.capturedDark || 0,
            capturedLight: room.capturedLight || 0,
            moveCount: room.moveCount || 0,
            matchNumber: room.matchNumber || 0,
            ratedMatchId: (typeof room.ratedMatchId === "string") ? room.ratedMatchId : null,
            ratingsAtStart: room.ratingsAtStart || null,
            createdAt: (typeof room.createdAt === "number") ? room.createdAt : null,
            status: room.status || null,
            lastMove: room.lastMove || null,
            moveType: room.moveType || null,
            lastMovePath: room.lastMovePath || null,
            lastCapturedSquares: room.lastCapturedSquares || null,
            pendingRemovals: room.pendingRemovals || null,
            players: room.players || null,
            presence: room.presence || null,
            spectators: room.spectators || null,
            timeControlSeconds: room.timeControlSeconds || 0,
            turnStartedAt: room.turnStartedAt || null,
            winner: room.winner || null,
            winReason: room.winReason || null,
            // v180: технический результат читается ТОЛЬКО как признак уже
            // принятого решения — второй pipeline на нём не строится.
            result: room.result || null,
            rematchProposal: room.rematchProposal || null,
            drawProposal: room.drawProposal || null
        };

        currentState = newState;
        selectedFrom = null; // Зритель не может выбирать шашки
        renderBoard();
        
        if (currentState.winner) {
             renderEndGameModal();
        } else {
             endGameModal.classList.add("hidden");
        }
    });
}

// ===== ВХОД ЧЕРЕЗ TELEGRAM =====
//
// Подписанный initData уходит на Worker, тот проверяет подпись токеном бота
// и выдаёт Firebase Custom Token с uid ровно tg_<telegram id>. Клиент не
// придумывает личность и не берёт её из initDataUnsafe.
const AUTH_WORKER_URL = "https://russkie-shashki-auth.iliushazb.workers.dev";

async function authenticateTelegramUser() {
    const tg = window.Telegram && window.Telegram.WebApp;
    const initData = (tg && typeof tg.initData === "string") ? tg.initData : "";
    if (!initData) throw new Error("telegram_init_data_missing");

    // Сессия живёт только в памяти: auth_date фиксируется при запуске
    // Mini App, поэтому переживать перезагрузку ей незачем.
    await auth.setPersistence(firebase.auth.Auth.Persistence.NONE);

    const response = await fetch(AUTH_WORKER_URL + "/auth/telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData: initData })
    });
    if (!response.ok) throw new Error("telegram_auth_failed");

    const payload = await response.json();
    if (!payload || payload.ok !== true ||
        typeof payload.customToken !== "string" ||
        typeof payload.uid !== "string" || !/^tg_\d+$/.test(payload.uid)) {
        throw new Error("telegram_auth_bad_response");
    }

    const credential = await auth.signInWithCustomToken(payload.customToken);
    // Сверяем, что Firebase выдал ИМЕННО ту личность, которую назвал Worker.
    if (!credential || !credential.user || credential.user.uid !== payload.uid) {
        try { await auth.signOut(); } catch (e) {}
        throw new Error("telegram_auth_uid_mismatch");
    }

    return {
        id: credential.user.uid,
        name: (typeof payload.name === "string" && payload.name) ? payload.name : "Игрок"
    };
}

// ПЕРЕВООРУЖЕНИЕ onDisconnect ПРИ ОБНОВЛЕНИИ ТОКЕНА.
//
// Правила v12 требуют auth для записи присутствия, а onDisconnect
// исполняется сервером ПОЗЖЕ, когда клиента уже нет. Токен живёт час;
// после обновления прежняя серверная операция может оказаться привязана к
// истёкшим правам. Перевооружаем её тем же путём, что уже отлажен в v184
// для реконнекта — нового механизма не заводим.
function armPresenceReauthWatcher() {
    if (!auth || typeof auth.onIdTokenChanged !== "function") return;
    auth.onIdTokenChanged(function (user) {
        if (!user || !/^tg_\d+$/.test(user.uid) || (myTelegramId && user.uid !== myTelegramId)) {
            firebaseAuthReady = false; pendingFirebaseIdentity = null;
            stopPresenceHeartbeat(); stopOwnerPresenceHeartbeat(); stopOwnerBotMoveRetryTimer();
            return;
        }
        if (localOnlyBotGame) { firebaseAuthReady = false; return; }
        if (firebaseFlowsStarted && myTelegramId === user.uid) firebaseAuthReady = true;
        if (!canUseFirebase() || !isOnlineGame || !roomCode || isSpectator) return;
        if (typeof revivePresenceAfterReconnect === "function") revivePresenceAfterReconnect();
    });
}

// ЖИЗНЕННЫЙ ЦИКЛ ВХОДА.
//
// Промис создаётся СРАЗУ, ещё до задержки в 100 мс, и включает её в себя.
// Иначе игрок успевает нажать кнопку раньше, чем промис появится, и
// дожидаться будет нечего — именно этим прошлая правка и была бесполезна.
async function bootstrapApp() {
    startApp();

    authPhase = "pending";
    authPromise = (async function () {
        // Те же 100 мс, что были: Telegram успевает разложить initData.
        await new Promise(function (resolve) { setTimeout(resolve, 100); });
        const me = await authenticateTelegramUser();
        armPresenceReauthWatcher();
        queueOrStartFirebaseFlows(me);
        return me;
    })();

    try {
        await authPromise;
        authPhase = "ready";
    } catch (error) {
        console.error("Telegram auth failed:", error);
        try { await auth.signOut(); } catch (e) {}
        firebaseAuthReady = false;
        pendingFirebaseIdentity = null;
        authPhase = "failed";
        showInfoModal(t("err_auth_required"), false);
    }
}

// Запуск приложения
if (window.Telegram && window.Telegram.WebApp) {
    Telegram.WebApp.ready();
    Telegram.WebApp.expand();
    bootstrapApp(); // задержка перенесена ВНУТРЬ authPromise
} else {
    // Вне Telegram подписанного initData нет, значит нет и входа.
    // Интерфейс и партия с ботом работают, Firebase — нет.
    startApp();
    authPhase = "failed";
    showInfoModal(t("err_auth_required"), false);
}
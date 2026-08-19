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

const appCheck = firebase.appCheck();
appCheck.activate('6LdveXstAAAAAEH1UUtHVPTzlUOx-b82D5eWDXNw', true);

const database = firebase.database();

// ===== ГЛОБАЛЬНЫЙ СЛУШАТЕЛЬ ПЕРЕПОДКЛЮЧЕНИЯ FIREBASE =====
// Решает проблему ложных статусов "Офлайн" при кратковременных морганиях сети.
// Когда сеть возвращается, мы мгновенно бьём пульс присутствия (online: true),
// не дожидаясь ближайшего интервала (4 секунды). Это сбрасывает таймер 
// "checkOpponentAbsence" у соперника и не даёт комнате удалиться.
const connectedRef = database.ref(".info/connected");
connectedRef.on("value", function(snap) {
    if (snap.val() === true) {
        // Дополнительная защита: оживляем presence, только если человек
        // ДЕЙСТВИТЕЛЬНО сейчас участвует в какой-то партии как игрок —
        // а не когда myPresenceRef случайно остался от уже неактуальной комнаты.
        if (myPresenceRef && isOnlineGame && !isSpectator && roomCode) {
            myPresenceRef.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
        }
    }
});

// ===== ЭКОНОМИКА =====

function normalizeEconomy(current) {
    const result = {};

    if (current) {
        for (const key in current) {
            result[key] = current[key];
        }
    }

    result.name = myTelegramName || result.name || "Игрок";

    result.balance =
        typeof result.balance === "number"
            ? Math.max(0, Math.floor(result.balance))
            : 0;

    result.lifetimeEarned =
        typeof result.lifetimeEarned === "number"
            ? Math.max(0, Math.floor(result.lifetimeEarned))
            : 0;

    result.lifetimeSpent =
        typeof result.lifetimeSpent === "number"
            ? Math.max(0, Math.floor(result.lifetimeSpent))
            : 0;

    result.lastDailyClaim =
        typeof result.lastDailyClaim === "string"
            ? result.lastDailyClaim
            : "";

    result.welcomeClaimed =
        result.welcomeClaimed === true;

    if (
        !result.rewardedMatches ||
        typeof result.rewardedMatches !== "object"
    ) {
        result.rewardedMatches = {};
    }

    return result;
}


// Получаем время максимально близкое к серверному времени Firebase.
// .info/serverTimeOffset показывает разницу между временем Firebase
// и локальными часами устройства.
function getFirebaseServerNow() {
    return database.ref(".info/serverTimeOffset")
        .once("value")
        .then(function (snapshot) {
            const offset = Number(snapshot.val()) || 0;
            return Date.now() + offset;
        });
}


// Единый серверный день для ежедневного бонуса.
// Используем UTC, чтобы правило было одинаковым для всех игроков.
function getFirebaseServerDayKey() {
    return getFirebaseServerNow().then(function (serverNow) {
        return new Date(serverNow).toISOString().slice(0, 10);
    });
}


// Пока визуал монет ещё не добавлен.
// В Части 2 эта функция будет обновлять видимый счётчик.
let coinBalanceAnimFrame = null;
let coinBalanceDisplayedValue = 0; // То, что реально видно на экране прямо сейчас

function updateCoinBalanceUI(balance) {
    const newBalance = Math.max(0, Number(balance) || 0);
    const el = document.getElementById("coin-balance-value");

    currentCoinBalance = newBalance; // Канонический баланс — обновляем сразу

    // Мои собственные монеты в statsCache (показ рядом с именем) не должны
    // устаревать после rewardedMatches — обновляем в том же месте, без лишних чтений.
    if (myTelegramId && statsCache[myTelegramId]) {
        statsCache[myTelegramId].coins = newBalance;
    }

    if (!el) {
        coinBalanceDisplayedValue = newBalance;
        return;
    }

    // Отменяем предыдущую анимацию, если новое значение пришло раньше её окончания —
    // но стартуем от того, что реально видно на экране в этот момент, а не от старой цели.
    if (coinBalanceAnimFrame) {
        cancelAnimationFrame(coinBalanceAnimFrame);
        coinBalanceAnimFrame = null;
    }

    const startValue = coinBalanceDisplayedValue;
    const endValue = newBalance;

    const duration = 600;
    const startTime = performance.now();

    function step(now) {
        const progress = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        const displayValue = Math.round(startValue + (endValue - startValue) * eased);
        coinBalanceDisplayedValue = displayValue;
        el.textContent = displayValue.toLocaleString();

        if (progress < 1) {
            coinBalanceAnimFrame = requestAnimationFrame(step);
        } else {
            coinBalanceDisplayedValue = endValue;
            coinBalanceAnimFrame = null;
        }
    }

    coinBalanceAnimFrame = requestAnimationFrame(step);
}


// Простая очередь всплывающих окошек монет, чтобы, например,
// стартовый и ежедневный бонусы при первом входе не наложились друг на друга.
let coinPopupQueue = [];
let coinPopupShowing = false;

function showCoinPopup(amount) {
    if (!amount) return;
    coinPopupQueue.push(amount);
    processCoinPopupQueue();
}

function processCoinPopupQueue() {
    if (coinPopupShowing) return;
    if (coinPopupQueue.length === 0) return;

    const popup = document.getElementById("coin-popup");
    const text = document.getElementById("coin-popup-text");
    if (!popup || !text) {
        coinPopupQueue = [];
        return;
    }

    const amount = coinPopupQueue.shift();
    coinPopupShowing = true;

    const sign = amount > 0 ? "+" : "";
    text.textContent = sign + amount + " 🪙";
    popup.classList.remove("hidden");
    popup.classList.add("coin-popup-show");

    setTimeout(function () {
        popup.classList.remove("coin-popup-show"); // Запускаем fade-out

        setTimeout(function () {
            popup.classList.add("hidden"); // Ставим hidden только после окончания transition
            coinPopupShowing = false;
            processCoinPopupQueue();
        }, 250);
    }, 1600);
}


// Стартовый подарок.
// Firebase transaction гарантирует, что +500 выдаётся только один раз.
function claimWelcomeCoins() {
    if (!myTelegramId) return Promise.resolve(false);

    const economyRef =
        database.ref("economy/" + myTelegramId);

    return economyRef.transaction(function (current) {
        const economy = normalizeEconomy(current);

        if (economy.welcomeClaimed) {
            return;
        }

        economy.welcomeClaimed = true;
        economy.balance += COIN_REWARDS.welcome;
        economy.lifetimeEarned += COIN_REWARDS.welcome;
        economy.name = myTelegramName;

        return economy;
    }).then(function (result) {
        if (result.snapshot) {
            const data = result.snapshot.val();

            if (data) {
                updateCoinBalanceUI(data.balance);
            }
        }

        if (result.committed) {
            showCoinPopup(COIN_REWARDS.welcome);
        }

        return result.committed;
    }).catch(function (error) {
        console.error("Welcome coins failed:", error);
        return false;
    });
}


// Ежедневный бонус.
// Проверка даты и изменение баланса находятся
// в одной transaction().
function claimDailyCoins() {
    if (!myTelegramId) return Promise.resolve(false);

    return getFirebaseServerDayKey().then(function (todayKey) {
        const economyRef =
            database.ref("economy/" + myTelegramId);

        return economyRef.transaction(function (current) {
            const economy = normalizeEconomy(current);

            if (economy.lastDailyClaim === todayKey) {
                return;
            }

            economy.lastDailyClaim = todayKey;
            economy.balance += COIN_REWARDS.daily;
            economy.lifetimeEarned += COIN_REWARDS.daily;
            economy.name = myTelegramName;

            return economy;
        }).then(function (result) {
            if (result.snapshot) {
                const data = result.snapshot.val();

                if (data) {
                    updateCoinBalanceUI(data.balance);
                }
            }

            if (result.committed) {
                showCoinPopup(COIN_REWARDS.daily);
            }

            return result.committed;
        });
    }).catch(function (error) {
        console.error("Daily coins failed:", error);
        return false;
    });
}


// Загружаем экономику при запуске.
// Сначала стартовый подарок, затем ежедневный,
// чтобы две transaction не выполнялись одновременно.
function initializeEconomy() {
    if (!myTelegramId) return;

    claimWelcomeCoins()
        .then(function () {
            return claimDailyCoins();
        })
        .then(function () {
            return database.ref("economy/" + myTelegramId)
                .once("value");
        })
        .then(function (snapshot) {
            const economy = snapshot.val();

            if (economy) {
                updateCoinBalanceUI(economy.balance);
            }
        })
        .catch(function (error) {
            console.error("Economy initialization failed:", error);
        });
}


// Уникальный идентификатор именно ПАРТИИ, а не комнаты.
function getCurrentRewardMatchId() {
    if (isBotGame) {
        return currentBotMatchId;
    }

    if (
        isOnlineGame &&
        roomCode &&
        currentState
    ) {
        const matchNumber =
            typeof currentState.matchNumber === "number"
                ? currentState.matchNumber
                : 0;

        return "online_" + roomCode + "_" + matchNumber;
    }

    return null;
}


// Атомарная выплата результата одной партии.
// rewardedMatches и баланс меняются В ОДНОЙ transaction().
function awardCoinsForMatch(matchId, amount) {
    if (!myTelegramId || !matchId) {
        return Promise.resolve({
            rewarded: false,
            balance: currentCoinBalance
        });
    }

    const economyRef =
        database.ref("economy/" + myTelegramId);

    return economyRef.transaction(function (current) {
        const economy = normalizeEconomy(current);

        economy.rewardedMatches =
            economy.rewardedMatches || {};

        // Эта конкретная партия уже была оплачена.
        if (economy.rewardedMatches[matchId] === true) {
            return;
        }

        economy.rewardedMatches[matchId] = true;
        economy.name = myTelegramName;

        const oldBalance = economy.balance || 0;

        // Баланс никогда не опускается ниже нуля.
        economy.balance =
            Math.max(0, oldBalance + amount);

        // lifetimeEarned увеличивается только при получении монет.
        // Поражения его не уменьшают.
        if (amount > 0) {
            economy.lifetimeEarned =
                (economy.lifetimeEarned || 0) + amount;
        }

        return economy;
    }).then(function (result) {
        const economy =
            result.snapshot
                ? result.snapshot.val()
                : null;

        if (economy) {
            updateCoinBalanceUI(economy.balance);
        }

        return {
            rewarded: result.committed,
            balance: economy
                ? economy.balance
                : currentCoinBalance
        };
    });
}


// Определяем награду по результату текущей партии.
function getCurrentCoinReward() {
    if (!currentState || !currentState.winner) {
        return null;
    }

    if (isBotGame) {
        // Для ничьей с ботом отдельной награды пока нет.
        if (currentState.winner === "draw") {
            return null;
        }

        const didIWin = currentState.winner === myColor;

        // Лёгкий — тренировочный режим. Возвращаем null (не 0), чтобы
        // recordCoinResultOnce() вообще не пытался создать запись награды —
        // "reward === null" уже проверяется там как условие выхода.
        if (botDifficulty === "easy") {
            return null;
        }
        if (botDifficulty === "medium") {
            return didIWin ? COIN_REWARDS.botMediumWin : COIN_REWARDS.botMediumLoss;
        }
        // Любое другое/неизвестное значение (включая "hard") безопасно
        // трактуется как Сложный — тот же принцип, что и в getMaxDepthForDifficulty.
        return didIWin ? COIN_REWARDS.botHardWin : COIN_REWARDS.botHardLoss;
    }

    if (isOnlineGame) {
        if (currentState.winner === "draw") {
            return COIN_REWARDS.onlineDraw;
        }

        return currentState.winner === myColor
            ? COIN_REWARDS.onlineWin
            : COIN_REWARDS.onlineLoss;
    }

    return null;
}


// Вызывается после окончания партии.
// Локальный флаг убирает лишние запросы,
// Firebase rewardedMatches даёт настоящую защиту.
function recordCoinResultOnce() {
    if (isSpectator) return;
    if (!currentState || !currentState.winner) return;
    if (!myTelegramId) return;

    // В онлайн-игре не начисляем монеты по локальному
    // оптимистичному состоянию. Ждём подтверждение Firebase.
    if (isOnlineGame && isLocalStateOptimistic) return;

    const matchId = getCurrentRewardMatchId();
    const reward = getCurrentCoinReward();

    if (!matchId || reward === null) return;

    if (coinRewardAttemptForMatch === matchId) {
        return;
    }

    coinRewardAttemptForMatch = matchId;

    awardCoinsForMatch(matchId, reward)
        .then(function (result) {
            if (result.rewarded) {
                showCoinPopup(reward);

                console.log(
                    "Coins rewarded:",
                    reward,
                    "match:",
                    matchId,
                    "balance:",
                    result.balance
                );
            }
        })
        .catch(function (error) {
            // При настоящей сетевой ошибке разрешаем повторить
            // запрос в этой же открытой сессии.
            coinRewardAttemptForMatch = null;
            console.error("Coin reward failed:", error);
        });
}


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

function getMyTelegramUser() {
    if (window.Telegram && window.Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.user) {
        const u = Telegram.WebApp.initDataUnsafe.user;
        const name = u.username ? ("@" + u.username) : (u.first_name || "Игрок");
        return { id: "tg_" + u.id, name: name };
    }
    let id = localStorage.getItem("shashki_test_id");
    if (!id) {
        id = "test_" + Math.random().toString(36).slice(2, 10);
        localStorage.setItem("shashki_test_id", id);
    }
    return { id: id, name: "Игрок (браузер)" };
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
        draw_agreed: "🤝 Ничья!\nОба игрока согласились закончить партию.",
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
        stats_top_coins: "🪙 Топ по заработанным монетам",
        modal_offline_opp: "Соперник офлайн",
        modal_bot_difficulty: "Выберите сложность",
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
        draw_agreed: "🤝 Draw!\nBoth players agreed to end the game.",
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
        stats_top_coins: "🪙 Top by coins earned",
        modal_offline_opp: "Opponent offline",
        modal_bot_difficulty: "Choose difficulty",
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
        draw_agreed: "🤝 Pareggio!\nEntrambi i giocatori hanno concordato di terminare.",
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
        stats_top_coins: "🪙 Migliori per monete guadagnate",
        modal_offline_opp: "Avversario offline",
        modal_bot_difficulty: "Scegli la difficoltà",
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
const backConfirmModal = document.getElementById("back-confirm-modal");
const btnBackBotYes = document.getElementById("btn-back-bot-yes");
const btnBackBotNo = document.getElementById("btn-back-bot-no");
const endGameModal = document.getElementById("end-game-modal");
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

// ===== МОНЕТЫ / ЭКОНОМИКА =====

const COIN_REWARDS = {
    welcome: 500,
    daily: 25,
    onlineWin: 100,
    onlineDraw: 25,
    onlineLoss: -30,
    // Лёгкий — тренировочный режим, монеты не начисляются вообще.
    botEasyWin: 0,
    botEasyLoss: 0,
    botMediumWin: 10,
    botMediumLoss: -10,
    // Значения Сложного не изменились — это те же botWin/botLoss, что были
    // единственными до появления уровней сложности.
    botHardWin: 35,
    botHardLoss: -10
};

let currentCoinBalance = 0;

// Уникальный ID текущей партии с ботом.
// Для онлайн-игры ID будет строиться из roomCode + matchNumber.
let currentBotMatchId = null;

// Локальная защита от повторного запроса выплаты
// для одной и той же партии в текущей открытой сессии.
// Настоящая защита от двойной выплаты будет находиться
// в Firebase: economy/<id>/rewardedMatches.
let coinRewardAttemptForMatch = null;

let roomCode = null;
let myPendingFriendRoomCode = null; // Отдельная, "неприкосновенная" переменная именно для ссылки-приглашения — защита от того, что общая roomCode может смениться где-то в фоне между созданием комнаты и нажатием "Отправить другу"
let myColor = "light";
let isOnlineGame = false;
let pendingTimeControlSeconds = 0;
let roomListenerRef = null;
let myPresenceRef = null;
let presenceHeartbeatInterval = null;
let opponentAbsenceHandled = false;
const STALE_MS = 20000; 
const RECONNECT_GRACE_MS = 60000; // Перенесли наверх для порядка
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
let myCurrentSpectatorRef = null; // ссылка на мою собственную запись "я смотрю эту партию"
let botSpectateRoomCode = null; // код "зеркальной" комнаты для игры с ботом, чтобы её было видно в "Играть онлайн"
let botSpectateListenerRef = null; // Слушатель зрителей для игры с ботом
let botSpectatePresenceInterval = null;
let botMoveTimer = null; // Защита от накопления таймеров хода бота
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

// Проверяет пороги 7.2.5 (только дамки, 15 ходов) и 7.2.6 (30/60 ходов без
// изменения материального баланса, у обеих сторон есть дамка) и 7.2.3
// (троекратное повторение). Ничего не мутирует, только читает переданные значения.
function checkAutomaticDraw(pieces, kingOnlyStreak, noProgressStreak, positionHistory, newPositionKey) {
    // 7.2.5 — 15 полностью завершённых ходов только дамками, без взятий и без
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

    // Цепочка взятия ещё не закончена — многоходовое взятие целиком считается
    // ОДНИМ ходом, поэтому счётчики трогать рано, ждём финального прыжка.
    if (result.mustContinueFrom !== null) {
        return {
            kingOnlyStreak: prevKingOnlyStreak,
            noProgressStreak: prevNoProgressStreak,
            positionHistory: prevHistory,
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

    const newPositionKey = getDrawPositionKey(result.pieces, result.turn);
    const newHistory = prevHistory.concat([newPositionKey]);

    const drawReason = result.winner
        ? null // Партия уже закончилась обычной победой — автоматическую ничью не проверяем поверх неё
        : checkAutomaticDraw(result.pieces, newKingOnlyStreak, newNoProgressStreak, newHistory, newPositionKey);

    return {
        kingOnlyStreak: newKingOnlyStreak,
        noProgressStreak: newNoProgressStreak,
        positionHistory: newHistory,
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
let endGameShownForRoom = null;
let pieceElements = {};
let lastRenderedSignature = null;

function getLabels() {
    if (!flipped) {
        return { letters: ["a", "b", "c", "d", "e", "f", "g", "h"], numbers: [8, 7, 6, 5, 4, 3, 2, 1] };
    }
    return { letters: ["h", "g", "f", "e", "d", "c", "b", "a"], numbers: [1, 2, 3, 4, 5, 6, 7, 8] };
}

function renderCapturedIcons(container, count, iconClass) {
    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
        const icon = document.createElement("div");
        icon.classList.add("captured-icon", iconClass);
        container.appendChild(icon);
    }
}

let statsCache = {};

function fetchAndCacheStatsIfNeeded(id) {
    if (!id || statsCache[id] !== undefined) return;
    statsCache[id] = null;
    database.ref("stats/" + id).once("value").then(function (snapshot) {
        const val = snapshot.val();
        statsCache[id] = { wins: (val && val.wins) || 0, losses: (val && val.losses) || 0, coins: null };
        renderPlayerPanels();

        // Баланс монет запрашиваем отдельно, из другого узла — не блокирует
        // отображение wins/losses, если экономика ещё не подтянулась.
        database.ref("economy/" + id + "/balance").once("value").then(function (coinSnap) {
            if (statsCache[id]) {
                statsCache[id].coins = coinSnap.val();
                renderPlayerPanels();
            }
        }).catch(function () {});
    }).catch(function () {
        // При ошибке сети не обнуляем кэш, оставляем undefined для повторной попытки
        statsCache[id] = undefined;
        // Пробуем запросить ещё раз через 5 секунд
        setTimeout(function() {
            fetchAndCacheStatsIfNeeded(id);
        }, 5000);
    });
}

function statusForColor(color) {
    if (!currentState) return { text: "", cls: "" };
    if (!isOnlineGame) {
        return { text: "", cls: "" };
    }

    const playerId = currentState.players && currentState.players[color] && currentState.players[color].id;
    if (playerId) fetchAndCacheStatsIfNeeded(playerId);
    const stats = playerId ? statsCache[playerId] : null;
    const coinsPart = (stats && typeof stats.coins === "number") ? (" · 🪙" + stats.coins) : "";
    const ratingPrefix = stats ? ("🏆" + stats.wins + " ❌" + stats.losses + coinsPart + " · ") : "";

    const presence = (currentState.presence && currentState.presence[color]) || null;
    if (!presence) {
        return { text: ratingPrefix + t("status_connecting"), cls: "status-neutral" };
    }
    if (presence.online === false) {
        // Считаем оставшееся время до конца "минуты форы"
        const elapsed = Date.now() - (presence.lastSeen || Date.now());
        let remaining = Math.ceil((RECONNECT_GRACE_MS - elapsed) / 1000);
        if (remaining < 0) remaining = 0;
        return { text: ratingPrefix + t("status_offline") + " (" + t("status_left") + " " + remaining + t("sec") + ")", cls: "status-left" };
    }
    return { text: ratingPrefix + t("status_in_game"), cls: "status-online" };
}

function applyStatusToElement(el, panelEl, statusInfo) {
    el.className = "player-status";
    if (statusInfo.cls) el.classList.add(statusInfo.cls);
    el.textContent = statusInfo.text;
    if (statusInfo.cls === "status-left") {
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

    playerTopName.textContent = (topColor === "light" ? "⚪ " : "⚫ ") + (topColor === "light" ? lightName : darkName);
    playerBottomName.textContent = (bottomColor === "light" ? "⚪ " : "⚫ ") + (bottomColor === "light" ? lightName : darkName);

    if (topColor === "light") {
        renderCapturedIcons(playerTopCaptured, currentState.capturedDark, "dark-icon");
        renderCapturedIcons(playerBottomCaptured, currentState.capturedLight, "light-icon");
    } else {
        renderCapturedIcons(playerTopCaptured, currentState.capturedLight, "light-icon");
        renderCapturedIcons(playerBottomCaptured, currentState.capturedDark, "dark-icon");
    }

    applyStatusToElement(playerTopStatus, playerTopPanel, statusForColor(topColor));
    applyStatusToElement(playerBottomStatus, playerBottomPanel, statusForColor(bottomColor));

    // Скрываем кнопки управления для зрителей
    const gameButtons = document.querySelectorAll('#game-screen .menu-button');
    gameButtons.forEach(btn => {
        if (isSpectator) {
            btn.classList.add("hidden");
        } else {
            btn.classList.remove("hidden");
        }
    });

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
    const info = statusForColor(oppColor);

    if (info.cls === "status-left") {
        if (!opponentGraceTimer) {
            opponentGraceTimer = setTimeout(function () {
                opponentGraceTimer = null;
                if (!isOnlineGame || !currentState || opponentAbsenceHandled) return;
                // Если игра закончилась, продолжаем только если ждём ответа на реванш
                if (currentState.winner && !(currentState.rematchProposal && currentState.rematchProposal.by === myColor)) return;

                const stillInfo = statusForColor(oppColor);
                if (stillInfo.cls === "status-left") {
                    opponentAbsenceHandled = true;
                    if (currentState.winner && currentState.rematchProposal) {
                        // Если соперник пропал во время ожидания ответа на реванш
                        showInfoModal(t("rematch_no_response"), false);
                        showScreen(menuScreen);
                        loadActiveRooms();
                        cleanupAbandonedRoom();
                    } else {
                        // Обычный уход во время игры
                        const oppName = (currentState.players && currentState.players[oppColor] && currentState.players[oppColor].name) || t("opponent_default");
                        const reasonText = oppName + t("left_game");
                        opponentLeftText.textContent = reasonText + t("game_over");
                        opponentLeftModal.classList.remove("hidden");
                        cleanupAbandonedRoom();
                    }
                }
            }, RECONNECT_GRACE_MS);
        }
    } else {
        if (opponentGraceTimer) {
            clearTimeout(opponentGraceTimer);
            opponentGraceTimer = null;
        }
    }
}

function cleanupAbandonedRoom() {
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
}

// ===== СИСТЕМА ПРИСУТСТВИЯ (ONLINE / OFFLINE) =====

function handleVisibilityChange() {
    if (!myPresenceRef) return;

    if (document.hidden) {
        // Mini App ушёл в фон: соперник сразу видит Offline
        // и начинает отсчёт 60 секунд на возвращение.
        myPresenceRef.update({
            online: false,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        });
    } else {
        // Игрок вернулся в игру — сразу снова Online.
        myPresenceRef.update({
            online: true,
            lastSeen: firebase.database.ServerValue.TIMESTAMP
        });
    }
}

function setupPresence() {
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

    presenceRef.set({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    presenceRef.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });

    presenceHeartbeatInterval = setInterval(function () {
        if (document.hidden) return;
        presenceRef.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
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

// Общая функция: полностью "отвязываемся" от presence текущей комнаты.
// Вызывать её нужно везде, где человек по-настоящему перестаёт участвовать
// в партии (обычное завершение игры, явный выход, брошенная комната,
// переход в режим зрителя) — иначе глобальный слушатель .info/connected
// может позже "оживить" presence уже неактуальной, старой комнаты.
function detachMyPresence() {
    if (myPresenceRef) {
        myPresenceRef.onDisconnect().cancel();
    }
    stopPresenceHeartbeat();
    myPresenceRef = null;
}

function markMyselfLeftExplicitly() {
    if (myPresenceRef) {
        myPresenceRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
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

function renderBoard() {
    ensureBoardBuilt();
    updateBoardPieces();
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
    if (!currentState.timeControlSeconds || !currentState.turnStartedAt) {
        turnTimerDiv.textContent = "";
        return;
    }
    const elapsed = (Date.now() - currentState.turnStartedAt) / 1000;
    let remaining = currentState.timeControlSeconds - elapsed;
    if (remaining > currentState.timeControlSeconds) remaining = currentState.timeControlSeconds;
    const whoseTurn = currentState.turn === "light" ? t("whites") : t("blacks");
    turnTimerDiv.textContent = "⏱ " + t("timer_move") + ": " + whoseTurn + " — " + t("timer_time_left") + " " + formatTime(remaining);
}

function renderEndGameModal() {
    if (currentState && currentState.winner) {
        if (currentState.winner === "draw") {
            endGameText.textContent = t("draw_agreed");
        } else {
            const winnerColor = currentState.winner;
            const loserColor = winnerColor === "light" ? "dark" : "light";
            const winnerName = (currentState.players && currentState.players[winnerColor] && currentState.players[winnerColor].name) || (winnerColor === "light" ? t("whites") : t("blacks"));
            const loserName = (currentState.players && currentState.players[loserColor] && currentState.players[loserColor].name) || (loserColor === "light" ? t("whites") : t("blacks"));
            const winnerIcon = "✅";
            const loserIcon = "❌";

            let text = winnerIcon + " " + winnerName + "\n" + loserIcon + " " + loserName;

            endGameText.textContent = text;
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
        const marker = isBotGame
            ? (currentBotMatchId || "offline") + "_" + currentState.moveCount + (currentState.winner === "draw" ? "_draw" : "")
            : (roomCode || "offline") + "_" + currentState.moveCount + (currentState.winner === "draw" ? "_draw" : "");
        if (endGameShownForRoom !== marker) {
            playWinSound();
            endGameShownForRoom = marker;
        }
        if (statsRecordedForRoom !== marker) {
            statsRecordedForRoom = marker;
            recordGameResult();
        }

        recordCoinResultOnce();
    } else {
        endGameModal.classList.add("hidden");
    }
}

let statsRecordedForRoom = null;

function recordGameResult() {
    if (isSpectator) return; // Зритель никогда не участвует в статистике
    if (!isOnlineGame && !isBotGame) return; // Если это не онлайн и не бот — выходим
    if (!currentState || !currentState.winner) return;
    if (currentState.winner === "draw") return;
    if (!myTelegramId) return;
    // Лёгкий — тренировочный режим, полностью исключён из публичной статистики.
    if (isBotGame && botDifficulty === "easy") return;

    const didIWin = currentState.winner === myColor;
    
    // Если игра с ботом — пишем в отдельную ветку statsBot
    const statsPath = isBotGame ? "statsBot" : "stats";

    if (isBotGame) {
        // Medium/Hard считаются раздельно в byLevel, но верхнеуровневые
        // wins/losses продолжают обновляться параллельно — это сохраняет
        // существующий leaderboard (сортировка идёт именно по ним) без
        // единой правки в коде чтения. Старые накопленные результаты (до
        // появления уровней) остаются как есть — честно разделить их между
        // Medium/Hard задним числом невозможно, и мы не пытаемся это сделать.
        const level = (botDifficulty === "medium") ? "medium" : "hard";
        database.ref(statsPath + "/" + myTelegramId).transaction(function (current) {
            const result = current || { wins: 0, losses: 0, name: myTelegramName };
            result.name = myTelegramName;
            if (!result.byLevel) result.byLevel = {};
            if (!result.byLevel[level]) result.byLevel[level] = { wins: 0, losses: 0 };
            if (didIWin) {
                result.wins = (result.wins || 0) + 1;
                result.byLevel[level].wins = (result.byLevel[level].wins || 0) + 1;
            } else {
                result.losses = (result.losses || 0) + 1;
                result.byLevel[level].losses = (result.byLevel[level].losses || 0) + 1;
            }
            return result;
        }).catch(function(error) {
            console.error("Stats write failed:", error);
        });
        return;
    }

    database.ref(statsPath + "/" + myTelegramId).transaction(function (current) {
        const result = current || { wins: 0, losses: 0, name: myTelegramName };
        result.name = myTelegramName;
        if (didIWin) {
            result.wins = (result.wins || 0) + 1;
        } else {
            result.losses = (result.losses || 0) + 1;
        }
        return result;
    }).catch(function(error) {
        console.error("Stats write failed:", error);
    });
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
        performMove(selectedFrom.row, selectedFrom.col, row, col);
    }
}

let pendingSyncChain = Promise.resolve();

function forceResyncFromServer() {
    if (!roomCode) return;
    database.ref("rooms/" + roomCode).once("value").then(function(snapshot) {
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
            kingOnlyStreak: room.kingOnlyStreak || 0,
            noProgressStreak: room.noProgressStreak || 0,
            positionHistory: room.positionHistory || [],
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
        showInfoModal(t("err_resync_failed"), false);
    });
}

function performMove(fromRow, fromCol, toRow, toCol) {
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

        if (optimisticResult.mustContinueFrom === null && currentState.timeControlSeconds > 0) {
            currentState.turnStartedAt = Date.now();
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

        playSoundForMoveType(optimisticResult.moveType, movingPieceWasKing);
        renderBoard();

        pendingSyncChain = pendingSyncChain.then(function () {
            return database.ref("rooms/" + roomCode).transaction(function (room) {
                if (!room || !room.pieces || room.winner) return;

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
                    positionHistory: room.positionHistory || []
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
                if (!result.committed) {
                    console.log("Move rejected by server, resyncing...");
                    forceResyncFromServer();
                }
            });
        }).catch(function () {
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
            if (isBotGame) syncBotStateToFirebase();
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
    return state.moveCount + "_" + winnerPart + "_" + winReasonPart + "_" + playersPart + "_" + rematchPart + "_" + drawPart + "_" + turnStartedAtPart;
}

function startOnlineGame() {
    isBotGame = false; 
    isOnlineGame = true;
    flipped = (myColor === "dark");
    lastSeenMoveCount = -1;
    isLocalStateOptimistic = false; // Сбрасываем флаг при новой игре
    selectedFrom = null;
    endGameShownForRoom = null;
    statsRecordedForRoom = null;
    coinRewardAttemptForMatch = null;
    statsCache = {}; // Новая партия/реванш — статистика и монеты обоих игроков могли устареть
    opponentAbsenceHandled = false;
    lastRenderedSignature = null;
    boardBuilt = false;
    pendingSyncChain = Promise.resolve();
    if (opponentGraceTimer) {
        clearTimeout(opponentGraceTimer);
        opponentGraceTimer = null;
    }
    if (mustCaptureHintTimer) {
        clearTimeout(mustCaptureHintTimer);
        mustCaptureHintTimer = null;
    }

    setupPresence();
    
    // Показываем кнопки реакций только для онлайн-игр
    if (reactionsRow) reactionsRow.classList.remove("hidden");
    if (btnBackBot) btnBackBot.classList.add("hidden"); // Прячем кнопку "Назад" для бота

    if (roomListenerRef) roomListenerRef.off();
    roomListenerRef = database.ref("rooms/" + roomCode);
    roomListenerRef.on("value", function (snapshot) {
        const room = snapshot.val();
        if (!room || !room.pieces) {
            // Если комната была удалена (соперник закрыл игру или отменил реванш)
            if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
            stopPresenceHeartbeat();
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
            kingOnlyStreak: room.kingOnlyStreak || 0,
            noProgressStreak: room.noProgressStreak || 0,
            positionHistory: room.positionHistory || [],
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
            rematchProposal: room.rematchProposal || null,
            drawProposal: room.drawProposal || null
        };

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
                if (newState.players && newState.players.light && newState.players.light.id === myTelegramId) {
                    myColor = "light";
                } else if (newState.players && newState.players.dark && newState.players.dark.id === myTelegramId) {
                    myColor = "dark";
                }
                flipped = (myColor === "dark");
                boardBuilt = false;
                statsCache = {}; // Реванш без startOnlineGame() — кэш иначе останется старым
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
    });
}

// ===== ЗЕРКАЛО ИГРЫ С БОТОМ (чтобы её было видно в "Играть онлайн") =====

function startBotSpectateRoom() {
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
    if (botSpectatePresenceInterval) {
        clearInterval(botSpectatePresenceInterval);
        botSpectatePresenceInterval = null;
    }
    if (botSpectateListenerRef) {
        botSpectateListenerRef.off();
        botSpectateListenerRef = null;
    }
    if (botSpectateRoomCode) {
        database.ref("rooms/" + botSpectateRoomCode).onDisconnect().cancel();
        database.ref("rooms/" + botSpectateRoomCode).remove();
        botSpectateRoomCode = null;
    }
}

function syncBotStateToFirebase() {
    if (!botSpectateRoomCode || !currentState) return;
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
    botDifficultyModal.classList.remove("hidden");
}

btnDifficultyEasy.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    botDifficulty = "easy";
    startOfflineGame();
});
btnDifficultyMedium.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    botDifficulty = "medium";
    startOfflineGame();
});
btnDifficultyHard.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    botDifficulty = "hard";
    startOfflineGame();
});
btnDifficultyBack.addEventListener("click", function () {
    botDifficultyModal.classList.add("hidden");
    isBotGame = false;
    showScreen(menuScreen);
    loadActiveRooms();
});

function startOfflineGame() {
    isOnlineGame = false;
    isSpectator = false;

    // Каждая новая партия с ботом имеет собственный ID.
    // Зеркальная bot-комната может использовать тот же roomCode при реванше,
    // поэтому roomCode нельзя использовать как уникальный ID партии.
    currentBotMatchId =
        "bot_" +
        myTelegramId +
        "_" +
        Date.now() +
        "_" +
        Math.random().toString(36).slice(2, 8);

    // Новая партия должна иметь право сделать новую попытку выплаты.
    // Защита от реального двойного начисления всё равно находится в Firebase.
    coinRewardAttemptForMatch = null;
    
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
    endGameShownForRoom = null;
    opponentAbsenceHandled = false;
    lastRenderedSignature = null;
    boardBuilt = false; // Обязательно перестраиваем доску при перевороте
    pendingSyncChain = Promise.resolve();
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
    if (btnBackBot) btnBackBot.classList.remove("hidden"); // Показываем кнопку "Назад" для бота
    
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
        startBotSpectateRoom();
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
                const room = roomSnap.val();

                const lightP = room && room.players && room.players.light;
                const darkP = room && room.players && room.players.dark;
                const bothPlayersExist = !!(lightP && darkP && lightP.id && darkP.id);
                const differentPlayers = bothPlayersExist && lightP.id !== darkP.id;
                const STALE_ROOM_MS = 48 * 60 * 60 * 1000;
                const isStaleRoom = room && room.turnStartedAt && (Date.now() - room.turnStartedAt > STALE_ROOM_MS);
                
                const lightPresence = room.presence && room.presence.light;
                const darkPresence = room.presence && room.presence.dark;
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
        groupId: GROUP_ID
    };

    database.ref("rooms/" + roomCode).set(initialState).then(function () {
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

btnPlayOnline.addEventListener("click", function () {
    isBotGame = false;
    showGroupLobby();
});

btnCancelMatchmaking.addEventListener("click", function () {
    cancelOnlineSearch();
});

btnPlayFriend.addEventListener("click", function () {
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
        groupId: GROUP_ID
    };

    database.ref("rooms/" + roomCode).set(initialState).then(function () {
        database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
            opponentName: "Ожидание подключения...",
            myColor: "light"
        });
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
if (btnBackBotYes) {
    btnBackBotYes.addEventListener("click", function() {
        if (backConfirmModal) backConfirmModal.classList.add("hidden");
        stopBotSpectateRoom(); // Удаляем фантомную комнату
        isBotGame = false;
        showScreen(menuScreen);
        loadActiveRooms();
    });
}

btnResignYes.addEventListener("click", function () {
    resignConfirmModal.classList.add("hidden");
    if (!currentState) return;

    if (isOnlineGame) {
        database.ref("rooms/" + roomCode).transaction(function (room) {
            if (!room || room.winner) return;
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
    } else {
        currentState.winner = currentState.turn === "light" ? "dark" : "light";
        currentState.winReason = "resign";
        renderBoard();
        if (isBotGame) syncBotStateToFirebase();
    }
});

// ===== НИЧЬЯ =====

if (btnOfferDraw) {
    btnOfferDraw.addEventListener("click", function () {
        if (!isOnlineGame || !currentState || currentState.winner) return;
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
        database.ref("rooms/" + roomCode).transaction(function (room) {
            if (!room || room.winner) return;
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
        database.ref("rooms/" + roomCode + "/drawProposal").remove();
    });
}

if (btnDrawCancel) {
    btnDrawCancel.addEventListener("click", function () {
        drawOfferModal.classList.add("hidden");
        database.ref("rooms/" + roomCode + "/drawProposal").remove();
    });
}

// ===== НОВАЯ ИГРА / ЗАКРЫТЬ =====

btnCloseGame.addEventListener("click", function () {
    endGameModal.classList.add("hidden");
    
    // Если мы зритель — просто отписываемся от комнаты и выходим в меню
    if (isSpectator) {
        if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
        if (myCurrentSpectatorRef) { myCurrentSpectatorRef.remove(); myCurrentSpectatorRef = null; }
        showScreen(menuScreen);
        loadActiveRooms();
        return;
    }

    markMyselfLeftExplicitly();
    if (isOnlineGame) {
        cleanupFinishedRoom(); // Это удалит комнату, и соперник/зритель автоматически увидят закрытие
    }
    if (isBotGame) {
        stopBotSpectateRoom();
        // Игра с ботом — просто возвращаемся в меню, Mini App НЕ закрываем.
        // Явный сброс не обязателен для корректности (все точки входа сами
        // выставляют isBotGame перед использованием), но соответствует уже
        // существующему паттерну btnBackBotYes — оставляем для консистентности.
        isBotGame = false;
        showScreen(menuScreen);
        return;
    }
    if (window.Telegram && window.Telegram.WebApp) Telegram.WebApp.close();
});

function cleanupFinishedRoom() {
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
}

btnNewGame.addEventListener("click", function () {
    if (isOnlineGame) {
        database.ref("rooms/" + roomCode + "/rematchProposal").set({ by: myColor, name: myTelegramName });
    } else if (isBotGame) {
        endGameModal.classList.add("hidden");
        startOfflineGame();
    } else {
        endGameModal.classList.add("hidden");
        startOfflineGame();
    }
});

function performRematchReset() {
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

    updates["moveType"] = null;
    updates["lastMove"] = null;
    updates["lastMovePath"] = null;
    updates["lastCapturedSquares"] = null;
    updates["pendingRemovals"] = null;
    updates["winner"] = null;
    updates["winReason"] = null;
    updates["status"] = "active";
    updates["turnStartedAt"] = firebase.database.ServerValue.TIMESTAMP;
    updates["rematchProposal"] = null;
    updates["drawProposal"] = null;
    updates["reaction"] = null;
    
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

btnRematchAccept.addEventListener("click", function () {
    rematchRequestModal.classList.add("hidden");
    performRematchReset().then(function () {
        database.ref("rooms/" + roomCode + "/players").once("value").then(function (snap) {
            const players = snap.val() || {};
            myColor = (players.light && players.light.id === myTelegramId) ? "light" : "dark";
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
    database.ref("rooms/" + roomCode + "/rematchProposal").remove();
});

// ===== ТАЙМЕР ХОДА =====

setInterval(function () {
    if (!gameScreen.classList.contains("hidden")) {
        updateTimerDisplay();
        checkTimeout();
        updatePresenceOnly();
    }
}, 1000);

function updatePresenceOnly() {
    if (!isOnlineGame || !currentState) return;
    const topColor = flipped ? "light" : "dark";
    const bottomColor = flipped ? "dark" : "light";
    applyStatusToElement(playerTopStatus, playerTopPanel, statusForColor(topColor));
    applyStatusToElement(playerBottomStatus, playerBottomPanel, statusForColor(bottomColor));
    checkOpponentAbsence();
}

function checkTimeout() {
    if (isSpectator) return;
    if (!isOnlineGame || !currentState || currentState.winner) return;
    if (!currentState.timeControlSeconds || !currentState.turnStartedAt) return;

    const elapsed = (Date.now() - currentState.turnStartedAt) / 1000;
    if (elapsed <= currentState.timeControlSeconds) return;

    const loser = currentState.turn;
    database.ref("rooms/" + roomCode).transaction(function (room) {
        if (!room || room.winner) return;
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

    const timeoutId = setTimeout(function () {
        if (settled) return;

        settled = true;
        roomCode = null;
        showScreen(menuScreen);
        loadActiveRooms();
        showInfoModal(t("err_load_game"), false);
    }, 10000);

    database.ref("rooms/" + roomCode).once("value").then(function (snapshot) {
        if (settled) return;

        const room = snapshot.val();

        if (!room || !room.pieces || room.status === "finished" || room.winner) {
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

        // Возвращаем проверенную рабочую схему из старой версии:
        // без Firebase transaction().
        database.ref("rooms/" + roomCode).update({
            status: "active",
            "players/dark": {
                id: myTelegramId,
                name: myTelegramName
            },
            turnStartedAt: firebase.database.ServerValue.TIMESTAMP
        }).then(function () {
            if (settled) return;

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
        }).catch(function (error) {
            console.error("Invite update failed:", error);

            if (settled) return;

            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            myColor = "light";
            isOnlineGame = false;
            isSpectator = false;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal(t("err_join_failed"), false);
        });

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
        link.className = "stats-user-link";
        rankSpan.appendChild(link);
    } else {
        rankSpan.appendChild(document.createTextNode(displayName));
    }
    return rankSpan;
}

// Компактная строка для рейтинга Online: место, имя, победы, поражения, игры.
// Игры = wins + losses — ничьи в "stats" никогда не учитываются (см.
// recordGameResult: winner === "draw" выходит раньше записи), поэтому это
// действительно все ЗАСЧИТАННЫЕ партии, а не предположение.
function renderOnlineStatsRow(rank, name, wins, losses) {
    const row = document.createElement("div");
    row.className = "stats-row";
    row.appendChild(renderRankAndName(rank, name));

    const infoSpan = document.createElement("span");
    infoSpan.className = "stats-info-block";
    const total = wins + losses;
    infoSpan.textContent = "🏆" + wins + " ❌" + losses + " 🎮" + total;
    row.appendChild(infoSpan);
    return row;
}

// Карточка для рейтинга "С ботом": заголовок с местом/именем, основная
// строка показателей, и отдельный блок разбивки по Medium/Hard (только если
// byLevel реально присутствует — у партий до появления уровней сложности
// его нет, и это нормально; Easy никогда не пишет byLevel и не показывается).
function renderBotStatsCard(rank, name, wins, losses, coins, byLevel) {
    const card = document.createElement("div");
    card.className = "stats-bot-card";

    const header = document.createElement("div");
    header.className = "stats-bot-card-header";
    header.appendChild(renderRankAndName(rank, name));
    card.appendChild(header);

    const main = document.createElement("div");
    main.className = "stats-bot-card-main";
    const total = wins + losses;
    const coinsValue = (typeof coins === "number") ? coins : 0;
    const stats = [
        { value: wins, label: "🏆 " + t("stats_label_wins") },
        { value: losses, label: "❌ " + t("stats_label_losses") },
        { value: coinsValue, label: "🪙" },
        { value: total, label: "🎮 " + t("stats_label_games") }
    ];
    stats.forEach(function (s) {
        const item = document.createElement("div");
        item.className = "stats-stat-item";
        const val = document.createElement("span");
        val.className = "stats-stat-value";
        val.textContent = s.value;
        const lbl = document.createElement("span");
        lbl.className = "stats-stat-label";
        lbl.textContent = s.label;
        item.appendChild(val);
        item.appendChild(lbl);
        main.appendChild(item);
    });
    card.appendChild(main);

    if (byLevel && (byLevel.medium || byLevel.hard)) {
        const levelBlock = document.createElement("div");
        levelBlock.className = "stats-bylevel-block";

        const title = document.createElement("div");
        title.className = "stats-bylevel-title";
        title.textContent = t("stats_label_bylevel");
        levelBlock.appendChild(title);

        const m = byLevel.medium || { wins: 0, losses: 0 };
        const h = byLevel.hard || { wins: 0, losses: 0 };
        [
            { icon: t("btn_difficulty_medium"), w: m.wins || 0, l: m.losses || 0 },
            { icon: t("btn_difficulty_hard"), w: h.wins || 0, l: h.losses || 0 }
        ].forEach(function (lvl) {
            const lvlRow = document.createElement("div");
            lvlRow.className = "stats-bylevel-row";
            const nameSpan = document.createElement("span");
            nameSpan.className = "stats-bylevel-name";
            nameSpan.textContent = lvl.icon;
            const winsSpan = document.createElement("span");
            winsSpan.textContent = "🏆 " + lvl.w;
            const lossesSpan = document.createElement("span");
            lossesSpan.textContent = "❌ " + lvl.l;
            lvlRow.appendChild(nameSpan);
            lvlRow.appendChild(winsSpan);
            lvlRow.appendChild(lossesSpan);
            levelBlock.appendChild(lvlRow);
        });
        card.appendChild(levelBlock);
    }

    return card;
}

// Отдельная строка для рейтинга "Заработано" — переиспользует те же
// CSS-классы обрезки имени, но показывает только rank/имя/монеты.
function renderCoinRankRow(rank, name, coins) {
    const row = document.createElement("div");
    row.className = "stats-row";

    const rankSpan = document.createElement("span");
    rankSpan.className = "stats-name-block";
    const rankNumber = document.createElement("span");
    rankNumber.className = "stats-rank";
    rankNumber.textContent = rank + ".";
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
        link.className = "stats-user-link";
        rankSpan.appendChild(link);
    } else {
        rankSpan.appendChild(document.createTextNode(displayName));
    }

    const infoSpan = document.createElement("span");
    infoSpan.className = "stats-info-block";
    infoSpan.textContent = "🪙" + (coins || 0);

    row.appendChild(rankSpan);
    row.appendChild(infoSpan);
    return row;
}

// Общая сортировка для обоих рейтингов (Online и Bot):
// 1) больше побед выше; 2) при равенстве — меньше поражений выше;
// 3) win rate НЕ используется отдельным шагом: если wins И losses уже
//    совпали на шагах 1-2, то и win rate (wins/(wins+losses)) у них
//    математически идентичен — как отдельный шаг он ничего не решает;
// 4) финальный детерминированный tie-break — по id, чтобы позиции
//    никогда не "прыгали" случайно между обновлениями страницы.
function compareLeaderboardEntries(a, b) {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (a.losses !== b.losses) return a.losses - b.losses;
    return String(a.id).localeCompare(String(b.id));
}

function openStatsModal() {
    statsLeaderboard.innerHTML = "";

    const statsLeaderboardBot = document.getElementById("stats-leaderboard-bot");
    if (statsLeaderboardBot) statsLeaderboardBot.innerHTML = "";

    statsModal.classList.remove("hidden");

    // --- ОНЛАЙН РЕЙТИНГ ---
    // limitToLast(10) по одному "wins" был бы недостаточен: Firebase при
    // равных wins упорядочивает внутри группы по КЛЮЧУ, не по losses — то
    // есть при большом числе игроков с одинаковым wins можно ДО всякого
    // JS-tie-break потерять того, кто по-настоящему входит в top-10 по
    // losses. Берём кандидатов с запасом (50 — впятеро больше цели в 10,
    // разумный компромисс для проекта такого масштаба: покрывает типичные
    // случаи массовых ничьих по wins, не читая всю базу целиком), сортируем
    // честным compareLeaderboardEntries и уже потом обрезаем до 10.
    database.ref("stats").orderByChild("wins").limitToLast(50).once("value").then(function (snapshot) {
        const data = snapshot.val();
        statsLeaderboard.innerHTML = "";
        if (!data) {
            statsLeaderboard.textContent = t("stats_no_online_games");
            return;
        }
        const entries = Object.keys(data).map(function (key) {
            return { id: key, name: data[key].name || "Игрок", wins: data[key].wins || 0, losses: data[key].losses || 0 };
        });
        entries.sort(compareLeaderboardEntries);
        const top = entries.slice(0, 10);

        top.forEach(function (entry, index) {
            statsLeaderboard.appendChild(renderOnlineStatsRow(index + 1, entry.name, entry.wins, entry.losses));
        });
    }).catch(function () {
        statsLeaderboard.textContent = t("stats_load_error");
    });

    // --- РЕЙТИНГ ПРОТИВ БОТА ---
    if (statsLeaderboardBot) {
        database.ref("statsBot").orderByChild("wins").limitToLast(50).once("value").then(function (snapshot) {
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
            const top = entries.slice(0, 10);

            Promise.all(top.map(function (entry) {
                return database.ref("economy/" + entry.id + "/balance").once("value").then(function (coinSnap) {
                    entry.coins = coinSnap.val();
                }).catch(function () {
                    entry.coins = null;
                });
            })).then(function () {
                top.forEach(function (entry, index) {
                    statsLeaderboardBot.appendChild(renderBotStatsCard(index + 1, entry.name, entry.wins, entry.losses, entry.coins, entry.byLevel));
                });
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

if (statsTabOnline && statsTabBot && statsViewOnline && statsViewBot) {
    statsTabOnline.addEventListener("click", function () {
        statsTabOnline.classList.add("stats-tab-active");
        statsTabBot.classList.remove("stats-tab-active");
        statsViewOnline.classList.remove("hidden");
        statsViewBot.classList.add("hidden");
    });

    statsTabBot.addEventListener("click", function () {
        statsTabBot.classList.add("stats-tab-active");
        statsTabOnline.classList.remove("stats-tab-active");
        statsViewBot.classList.remove("hidden");
        statsViewOnline.classList.add("hidden");
    });
}

if (btnStatsClose) {
    btnStatsClose.addEventListener("click", function () {
        statsModal.classList.add("hidden");
    });
}

// ===== ИГРАТЬ ОНЛАЙН (МАТЧМЕЙКИНГ) =====

function startOnlineSearch() {
    showScreen(matchmakingScreen);
    isMatchmakingResolved = false;

    // 1. Сначала создаём свою комнату и встаём в очередь.
    // ЖДЁМ полного завершения записи в базу (Promise), чтобы избежать гонки условий.
    addToMatchmakingQueue().then(function() {
        
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
            groupId: GROUP_ID
        };

        // Создаём комнату в базе
        database.ref("rooms/" + roomCode).set(initialState).then(function() {
            // После создания комнаты — записываем ссылку в профиль пользователя
            return database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
                opponentName: "Поиск соперника...",
                myColor: "light"
            });
        }).then(function() {
            // После создания комнаты — включаем presence (сердцебиение)
            setupPresence();

            // И ТОЛЬКО ПОСЛЕ ЭТОГО — добавляем себя в очередь поиска
            const myQueueRef = database.ref("matchmakingQueue/" + myTelegramId);
            return myQueueRef.set({ name: myTelegramName, timestamp: Date.now(), roomCode: roomCode });
        }).then(function() {
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

function startApp() {
    const me = getMyTelegramUser();
    myTelegramId = me.id;
    myTelegramName = me.name;

    initializeEconomy();

    const greetingNameSpan = document.getElementById("user-greeting-name");
    if (greetingNameSpan) {
        let displayName = myTelegramName.length > 15 ? myTelegramName.substring(0, 15) + "..." : myTelegramName;
        greetingNameSpan.textContent = displayName;
    }

    // Применяем переводы к интерфейсу при старте
    applyTranslationsToDOM();

    const joinedViaLink = checkForInviteLink();
    if (!joinedViaLink) {
        loadActiveRooms();
    }
}

// Общая функция: возврат в свою собственную активную партию — как игрок,
// а не зритель. Используется и из списка "Кто играет?", и при повторном
// открытии своей же ссылки-приглашения.
function resumeOwnActiveRoom(code) {
    return database.ref("rooms/" + code).once("value").then(function (snapshot) {
        const room = snapshot.val();

        if (!room ||
            !room.pieces ||
            room.status !== "active" ||
            room.winner ||
            !room.players) {
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

        if (groupLobbyListener) {
            groupLobbyListener.off();
            groupLobbyListener = null;
        }

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
            if (groupLobbyListener) { 
                groupLobbyListener.off(); 
                groupLobbyListener = null; 
            }
            // Если я сам ждал соперника через "Играть онлайн" — убираем свою
            // запись СРАЗУ ЖЕ при явном выходе, чтобы у остальных она не
            // висела лишнее время. Аварийный выход (закрытие приложения,
            // потеря сети) по-прежнему обрабатывается через onDisconnect/presence.
            if (myPendingOnlineRoom) {
                const roomToRemove = myPendingOnlineRoom;
                database.ref("rooms/" + roomToRemove).remove();
                database.ref("users/" + myTelegramId + "/rooms/" + roomToRemove).remove();
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

function showGroupLobby() {
    const groupLobbyScreen = document.getElementById("group-lobby-screen");
    const groupRoomsList = document.getElementById("group-rooms-list");
    
    if (!groupLobbyScreen || !groupRoomsList) return;
    
    showScreen(groupLobbyScreen);
    groupRoomsList.innerHTML = '<p class="section-title">' + t("loading") + '</p>';

    // Важно: отключаем предыдущую "слежку" за списком, если она ещё была
    // активна (например, при повторном входе) — иначе они накапливаются
    // одна поверх другой и начинают работать непредсказуемо.
    if (groupLobbyListener) {
        groupLobbyListener.off();
        groupLobbyListener = null;
    }

    // Показываем ВСЕХ, кто играет, без привязки к коду группы —
    // раньше здесь была фильтрация по GROUP_ID (Telegram chat_instance),
    // но она оказалась ненадёжной и разные люди получали разные коды,
    // из-за чего никто никого не видел.
    groupLobbyListener = database.ref("rooms");
    groupLobbyListener.on("value", function(snapshot) {
        const rooms = snapshot.val() || {};
        groupRoomsList.innerHTML = "";

        let waitingHtml = "";
        let activeHtml = "";

        for (const code in rooms) {
            const room = rooms[code];

            const isPlayerStale = function(color) {
                const p = room.presence && room.presence[color];
                if (!p) return true;
                return (Date.now() - (p.lastSeen || 0)) > RECONNECT_GRACE_MS;
            };

            // АВТО-ЧИСТКА: зависшее предложение реванша
            if (room.rematchProposal) {
                const proposerColor = room.rematchProposal.by;
                const answererColor = proposerColor === "light" ? "dark" : "light";
                if (isPlayerStale(answererColor)) {
                    database.ref("rooms/" + code + "/rematchProposal").remove();
                    room.rematchProposal = null;
                }
            }

            // Не показываем завершенные игры
            if (room.status === "finished" || room.winner) continue;

            const lightIsStale = isPlayerStale("light");
            const darkIsStale = isPlayerStale("dark");

            // Лобби больше никогда само не удаляет комнаты.
            // Если игрок временно пропал — комнату просто не показываем.
            if (room.status === "waiting" && lightIsStale) {
                continue;
            }

            // ЛЕНИВАЯ ОЧИСТКА: если партия активна, но оба игрока по-настоящему
            // давно оффлайн (дольше RECONNECT_GRACE_MS через isPlayerStale) —
            // партия гарантированно заброшена. Удаляет тот, кто первым откроет
            // "Кто играет?" после истечения этого времени.
            if (room.status === "active" && lightIsStale && darkIsStale) {
                if (room.players && room.players.light && room.players.light.id) {
                    database.ref("users/" + room.players.light.id + "/rooms/" + code).remove();
                }
                if (room.players && room.players.dark && room.players.dark.id) {
                    database.ref("users/" + room.players.dark.id + "/rooms/" + code).remove();
                }
                database.ref("rooms/" + code).remove();
                continue;
            }

            let lightName = (room.players && room.players.light && room.players.light.name) || "Ожидание...";
            let darkName = (room.players && room.players.dark && room.players.dark.name) || "Ожидание...";
            lightName = escapeHtml(lightName);
            darkName = escapeHtml(darkName);

            if (room.status === "waiting") {
                // Не показываем в списке доступных соперников самого себя
                const isMine = room.players && room.players.light && room.players.light.id === myTelegramId;
                if (!isMine) {
                    waitingHtml += `
                        <div class="group-room-card">
                            <div class="group-room-info waiting">🟡 ${lightName}</div>
                            <button class="group-join-btn" data-code="${code}">Играть</button>
                        </div>
                    `;
                }
            } else if (room.status === "active") {
                const isMyActiveGame =
                    (room.players && room.players.light && room.players.light.id === myTelegramId) ||
                    (room.players && room.players.dark && room.players.dark.id === myTelegramId);

                if (isMyActiveGame) {
                    activeHtml += `
                        <div class="group-room-card">
                            <div class="group-room-info active">⚫ ${lightName} vs ⚪ ${darkName}</div>
                            <button class="group-resume-btn" data-code="${code}">${t("btn_continue")}</button>
                        </div>
                    `;
                } else {
                    activeHtml += `
                        <div class="group-room-card">
                            <div class="group-room-info active">⚫ ${lightName} vs ⚪ ${darkName}</div>
                            <button class="group-watch-btn" data-code="${code}">Смотреть</button>
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
    });
}

// Функция присоединения к открытой комнате
function joinGroupRoom(code) {
    roomCode = code;
    myColor = "dark";
    isOnlineGame = true;
    isSpectator = false;

    database.ref("rooms/" + roomCode).once("value").then(function(snapshot) {
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

            if (groupLobbyListener) { groupLobbyListener.off(); groupLobbyListener = null; }
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
function watchGroupRoom(code) {
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

    roomCode = code;
    myColor = null; // У наблюдателя нет цвета
    isOnlineGame = true;
    isSpectator = true; // ВАЖНО: Режим наблюдателя

    if (groupLobbyListener) { groupLobbyListener.off(); groupLobbyListener = null; }

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
    roomListenerRef = database.ref("rooms/" + roomCode);
    roomListenerRef.on("value", function (snapshot) {
        const room = snapshot.val();
        if (!room || !room.pieces) {
            if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
            if (myCurrentSpectatorRef) { myCurrentSpectatorRef.remove(); myCurrentSpectatorRef = null; }
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

// Запуск приложения
if (window.Telegram && window.Telegram.WebApp) {
    Telegram.WebApp.ready();
    Telegram.WebApp.expand();
    setTimeout(startApp, 100); // Даём 100мс на инициализацию данных
} else {
    startApp();
}
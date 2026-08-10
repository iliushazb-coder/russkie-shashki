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
        if (myPresenceRef) {
            myPresenceRef.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
        }
    }
});

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

let roomCode = null;
let myColor = "light";
let isOnlineGame = false;
let pendingTimeControlSeconds = 0;
let roomListenerRef = null;
let myPresenceRef = null;
let presenceHeartbeatInterval = null;
let opponentAbsenceHandled = false;
const STALE_MS = 20000; 
const BOT_USERNAME = "russkie_shashki_bot";

let matchmakingQueueRef = null;
let myPendingOnlineRoom = null; // код комнаты, которую я создал через "Играть онлайн" и ещё жду соперника
let activeMatchRef = null;
let matchmakingDecisionMade = false; // защита от гонки условий: решение "создать/присоединиться" принимается один раз
let isBotGame = false;
let botColor = "dark"; // Больше не константа, меняется от игры к игре

// Флаг для защиты от гонки условий в матчмейкинге
let isMatchmakingResolved = false;

// ПЕРЕМЕННЫЕ ДЛЯ ЛОББИ ГРУППЫ:
let groupLobbyListener = null;
let myCurrentSpectatorRef = null; // ссылка на мою собственную запись "я смотрю эту партию"
let botSpectateRoomCode = null; // код "зеркальной" комнаты для игры с ботом, чтобы её было видно в "Играть онлайн"
let botSpectateListenerRef = null; // Слушатель зрителей для игры с ботом
let botSpectatePresenceInterval = null;
let isSpectator = false;
// Используем chat_instance для определения группы при открытии по прямой ссылке
const GROUP_ID = (window.Telegram && window.Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.chat_instance != null) ? Telegram.WebApp.initDataUnsafe.chat_instance.toString() : "private_chat";

function generateRoomCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
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
                    jumps.push({ toRow: r, toCol: c, capturedRow: foundRow, capturedCol: foundCol });
                    if (!king) break;
                } else {
                    break;
                }
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

function maxCaptureChainLength(pieces, row, col, color, king) {
    const jumps = getCaptureJumps(pieces, row, col, color, king);
    if (jumps.length === 0) return 0;

    let best = 0;
    for (let i = 0; i < jumps.length; i++) {
        const j = jumps[i];
        const newPieces = {};
        for (const k in pieces) newPieces[k] = pieces[k];
        newPieces[j.capturedRow + "_" + j.capturedCol] = { color: "blocked", king: false };
        delete newPieces[row + "_" + col];

        let newKing = king;
        if (!king) {
            if ((color === "light" && j.toRow === 0) || (color === "dark" && j.toRow === 7)) newKing = true;
        }
        newPieces[j.toRow + "_" + j.toCol] = { color: color, king: newKing };

        const sub = 1 + maxCaptureChainLength(newPieces, j.toRow, j.toCol, color, newKing);
        if (sub > best) best = sub;
    }
    return best;
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
        statsCache[id] = { wins: (val && val.wins) || 0, losses: (val && val.losses) || 0 };
        renderPlayerPanels();
    }).catch(function () {
        statsCache[id] = { wins: 0, losses: 0 };
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
    const ratingPrefix = stats ? ("🏆" + stats.wins + " ❌" + stats.losses + " · ") : "";

    const presence = (currentState.presence && currentState.presence[color]) || null;
    if (!presence) {
        return { text: ratingPrefix + "подключение...", cls: "status-neutral" };
    }
    const isStale = (Date.now() - (presence.lastSeen || 0)) > STALE_MS;
    if (presence.online === false || isStale) {
        // Считаем оставшееся время до конца "минуты форы"
        const elapsed = Date.now() - (presence.lastSeen || Date.now());
        let remaining = Math.ceil((RECONNECT_GRACE_MS - elapsed) / 1000);
        if (remaining < 0) remaining = 0;
        return { text: ratingPrefix + "Оффлайн (осталось " + remaining + "с)", cls: "status-left" };
    }
    return { text: ratingPrefix + "В игре", cls: "status-online" };
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
    el.textContent = "👁 Смотрят: " + names.join(", ");
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
const RECONNECT_GRACE_MS = 60000;

function checkOpponentAbsence() {
    // ВАЖНАЯ ЗАЩИТА: Если игрок — зритель, функция немедленно останавливается. 
    // Зритель не может удалить игру, которую смотрит.
    if (isSpectator) return; 
    
    if (!isOnlineGame || !currentState || currentState.winner) return;
    if (opponentAbsenceHandled) return;

    const oppColor = myColor === "light" ? "dark" : "light";
    const info = statusForColor(oppColor);

    if (info.cls === "status-left") {
        if (!opponentGraceTimer) {
            opponentGraceTimer = setTimeout(function () {
                opponentGraceTimer = null;
                if (!isOnlineGame || !currentState || currentState.winner || opponentAbsenceHandled) return;

                const stillInfo = statusForColor(oppColor);
                if (stillInfo.cls === "status-left") {
                    opponentAbsenceHandled = true;
                    const oppName = (currentState.players && currentState.players[oppColor] && currentState.players[oppColor].name) || "Соперник";
                    const reasonText = stillInfo.text.indexOf("потерял соединение") !== -1
                        ? (oppName + " потерял соединение 📡")
                        : (oppName + " покинул игру 👋");
                    opponentLeftText.textContent = reasonText + "\nПартия завершена.";
                    opponentLeftModal.classList.remove("hidden");
                    cleanupAbandonedRoom();
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
}

// ===== СИСТЕМА ПРИСУТСТВИЯ (ONLINE / OFFLINE) =====

function handleVisibilityChange() {
    if (!myPresenceRef) return;
    // Если приложение реально свёрнуто (document.hidden) — пишем offline сразу.
    // Поле hasFocus() больше не используем, чтобы клавиатура и уведомления не ломали игру.
    if (document.hidden) {
        myPresenceRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    } else {
        // Если приложение снова на экране — сразу бьём пульс, статус становится "В игре"
        myPresenceRef.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    }
}

function setupPresence() {
    if (!myTelegramId || !roomCode) return;
    stopPresenceHeartbeat();

    const presenceRef = database.ref("rooms/" + roomCode + "/presence/" + myColor);
    myPresenceRef = presenceRef;

    presenceRef.set({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    presenceRef.onDisconnect().update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });

    presenceHeartbeatInterval = setInterval(function () {
        presenceRef.update({ online: true, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    }, 4000);

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleVisibilityChange);
    window.addEventListener("focus", handleVisibilityChange);
}

function stopPresenceHeartbeat() {
    if (presenceHeartbeatInterval) {
        clearInterval(presenceHeartbeatInterval);
        presenceHeartbeatInterval = null;
    }
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("blur", handleVisibilityChange);
    window.removeEventListener("focus", handleVisibilityChange);
}

function markMyselfLeftExplicitly() {
    if (myPresenceRef) {
        myPresenceRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    }
    stopPresenceHeartbeat();
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
        setTimeout(triggerBotMove, 500);
    }
}

function renderLastMoveArrow() {
    const svg = document.getElementById("last-move-arrow-svg");
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);

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
    svg.appendChild(defs);

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
    const whoseTurn = currentState.turn === "light" ? "Белые" : "Чёрные";
    turnTimerDiv.textContent = "⏱ Ход: " + whoseTurn + " — осталось " + formatTime(remaining);
}

function renderEndGameModal() {
    if (currentState && currentState.winner) {
        if (currentState.winner === "draw") {
            endGameText.textContent = "🤝 Ничья!\nОба игрока согласились закончить партию.";
        } else {
            const winnerColor = currentState.winner;
            const loserColor = winnerColor === "light" ? "dark" : "light";
            const winnerName = (currentState.players && currentState.players[winnerColor] && currentState.players[winnerColor].name) || (winnerColor === "light" ? "Белые" : "Чёрные");
            const loserName = (currentState.players && currentState.players[loserColor] && currentState.players[loserColor].name) || (loserColor === "light" ? "Белые" : "Чёрные");
            const winnerIcon = "✅";
            const loserIcon = "❌";

            let text = winnerIcon + " " + winnerName + "\n" + loserIcon + " " + loserName;

            endGameText.textContent = text;
        }
        
        endGameModal.classList.remove("hidden");
        
        // Скрываем кнопки для зрителей
        const buttonsRow = endGameModal.querySelector(".modal-buttons");
        if (buttonsRow) {
            if (isSpectator) {
                buttonsRow.classList.add("hidden");
            } else {
                buttonsRow.classList.remove("hidden");
            }
        }

        const marker = (roomCode || "offline") + "_" + currentState.moveCount + (currentState.winner === "draw" ? "_draw" : "");
        if (endGameShownForRoom !== marker) {
            playWinSound();
            endGameShownForRoom = marker;
        }
        if (statsRecordedForRoom !== marker) {
            statsRecordedForRoom = marker;
            recordGameResult();
        }
    } else {
        endGameModal.classList.add("hidden");
    }
}

let statsRecordedForRoom = null;

function recordGameResult() {
    if (!isOnlineGame || !currentState || !currentState.winner) return;
    if (currentState.winner === "draw") return;
    if (!myTelegramId) return;

    const didIWin = currentState.winner === myColor;

    database.ref("stats/" + myTelegramId).transaction(function (current) {
        const result = current || { wins: 0, losses: 0, name: myTelegramName };
        result.name = myTelegramName;
        if (didIWin) {
            result.wins = (result.wins || 0) + 1;
        } else {
            result.losses = (result.losses || 0) + 1;
        }
        return result;
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
        if (currentState.turn === myColor && currentState.mustContinueFrom) {
            selectedFrom = { row: currentState.mustContinueFrom.row, col: currentState.mustContinueFrom.col };
        } else {
            selectedFrom = null;
        }
        lastRenderedSignature = computeGameSignature(currentState);
        renderBoard();
    }).catch(function(err) {
        console.error("Resync error", err);
    });
}

function performMove(fromRow, fromCol, toRow, toCol) {
    if (isOnlineGame) {
        const optimisticResult = attemptMove(currentState, fromRow, fromCol, toRow, toCol, myColor);
        if (!optimisticResult) return;

        const movingPieceWasKing = !!(currentState.pieces[fromRow + "_" + fromCol] && currentState.pieces[fromRow + "_" + fromCol].king);

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

        if (optimisticResult.mustContinueFrom === null && currentState.timeControlSeconds > 0) {
            currentState.turnStartedAt = Date.now();
        }

        if (optimisticResult.winner) {
            currentState.winner = optimisticResult.winner;
            currentState.winReason = optimisticResult.winReason;
        }
        selectedFrom = optimisticResult.mustContinueFrom
            ? { row: optimisticResult.mustContinueFrom.row, col: optimisticResult.mustContinueFrom.col }
            : null;

        lastSeenMoveCount = currentState.moveCount;
        lastRenderedSignature = computeGameSignature(currentState);

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
                    pendingRemovals: room.pendingRemovals || null
                };

                const result = attemptMove(state, fromRow, fromCol, toRow, toCol, myColor);
                if (!result) return;

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
                
                if (result.mustContinueFrom === null) newRoom.turnStartedAt = firebase.database.ServerValue.TIMESTAMP;
                
                if (result.winner) {
                    newRoom.winner = result.winner;
                    newRoom.winReason = result.winReason;
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
            if (result.winner) {
                currentState.winner = result.winner;
                currentState.winReason = result.winReason;
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
    selectedFrom = null;
    endGameShownForRoom = null;
    statsRecordedForRoom = null;
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

    if (roomListenerRef) roomListenerRef.off();
    roomListenerRef = database.ref("rooms/" + roomCode);
    roomListenerRef.on("value", function (snapshot) {
        const room = snapshot.val();
        if (!room || !room.pieces) return;

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

function startOfflineGame() {
    isOnlineGame = false;
    
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
    stopPresenceHeartbeat();
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    
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
            setTimeout(triggerBotMove, 500);
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
                        btn.textContent = "Игра против " + item.opponent;
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
                        removeBtn.title = "Убрать из списка";
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
    createOnlineRoom();
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

function createRoomAndShowWaiting() {
    if (roomListenerRef) { roomListenerRef.off(); roomListenerRef = null; }
    stopPresenceHeartbeat();
    roomCode = generateRoomCode();
    myColor = "light";
    isOnlineGame = true;

    const initialState = {
        status: "waiting",
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
        players: { light: { id: myTelegramId, name: myTelegramName }, dark: null },
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

        const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
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
    const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
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
    startOfflineGame();
});

// ===== СДАТЬСЯ =====

btnResign.addEventListener("click", function () {
    resignConfirmModal.classList.remove("hidden");
});

btnResignNo.addEventListener("click", function () {
    resignConfirmModal.classList.add("hidden");
});

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
        drawOfferText.textContent = "⏳ Ждём ответа соперника на ничью...";
        if (btnDrawAccept) btnDrawAccept.classList.add("hidden");
        if (btnDrawDecline) btnDrawDecline.classList.add("hidden");
        if (btnDrawCancel) btnDrawCancel.classList.remove("hidden");
    } else {
        drawOfferText.textContent = (proposal.name || "Соперник") + " предлагает ничью";
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
    markMyselfLeftExplicitly();
    if (isOnlineGame) {
        cleanupFinishedRoom();
    }
    if (isBotGame) {
        stopBotSpectateRoom();
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
    return database.ref("rooms/" + roomCode).transaction(function (room) {
        if (!room) return;
        const newRoom = {};
        for (const key in room) newRoom[key] = room[key];
        newRoom.pieces = createInitialPieces();
        newRoom.turn = "light";
        newRoom.mustContinueFrom = null;
        newRoom.capturedDark = 0;
        newRoom.capturedLight = 0;
        newRoom.moveCount = 0;
        newRoom.moveType = null;
        newRoom.lastMove = null;
        newRoom.lastMovePath = null;
        newRoom.lastCapturedSquares = null;
        newRoom.winner = null;
        newRoom.winReason = null;
        newRoom.status = "active";
        newRoom.turnStartedAt = firebase.database.ServerValue.TIMESTAMP;
        newRoom.rematchProposal = null;
        const oldLight = room.players ? room.players.light : null;
        const oldDark = room.players ? room.players.dark : null;
        newRoom.players = { light: oldDark, dark: oldLight };
        return newRoom;
    });
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
            endGameText.textContent = endGameText.textContent.split("\n\n⏳")[0] + "\n\n⏳ Ждём ответа соперника на реванш...";
            if (buttonsRow) buttonsRow.classList.add("hidden");
        }
    } else {
        rematchRequestText.textContent = (proposal.name || "Соперник") + " предлагает сыграть ещё раз";
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
    });
}

// ===== ПРИСОЕДИНЕНИЕ ПО ССЫЛКЕ =====

function showInfoModal(text, offerNewGame) {
    infoModalText.textContent = text;
    if (offerNewGame) {
        btnInfoNewGame.classList.remove("hidden");
        btnInfoClose.textContent = "Закрыть";
    } else {
        btnInfoNewGame.classList.add("hidden");
        btnInfoClose.textContent = "ОК";
    }
    infoModal.classList.remove("hidden");
}

function checkForInviteLink() {
    let startParam = null;
    if (window.Telegram && window.Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.start_param) {
        startParam = Telegram.WebApp.initDataUnsafe.start_param;
    }

    if (!startParam) return false;

    roomCode = startParam;

    showScreen(waitingScreen);
    waitingText.textContent = "Проверяем игру...";
    inviteLinkBox.classList.add("hidden");
    btnShareLink.classList.add("hidden");

    let settled = false;
    const timeoutId = setTimeout(function () {
        if (!settled) {
            settled = true;
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal("Не удалось загрузить игру. Проверьте интернет-соединение.", false);
        }
    }, 10000);

    database.ref("rooms/" + roomCode).once("value").then(function (snapshot) {
        if (settled) return;
        const room = snapshot.val();

        if (!room || room.status === "finished" || room.winner) {
            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal("Нет активной игры", false);
            return;
        }

        const creatorId = (room.players && room.players.light) ? room.players.light.id : null;
        const creatorName = (room.players && room.players.light) ? room.players.light.name : "Соперник";

        if (creatorId && creatorId === myTelegramId) {
            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal("Нельзя играть против самого себя", false);
            return;
        }

        const creatorPresence = room.presence && room.presence.light;
        const creatorLastSeen = creatorPresence ? (creatorPresence.lastSeen || 0) : 0;
        const isCreatorStale = (Date.now() - creatorLastSeen) > STALE_MS; 
        const creatorIsOffline = !creatorPresence || creatorPresence.online === false || isCreatorStale;
        
        if (creatorIsOffline) {
            settled = true;
            clearTimeout(timeoutId);
            database.ref("rooms/" + roomCode).remove();
            if (myTelegramId) {
                database.ref("users/" + myTelegramId + "/rooms/" + roomCode).remove();
            }
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal("Соперник оффлайн\n\n" + creatorName + " больше не находится в игре.", false);
            return;
        }

        if (room.players && room.players.dark && room.players.dark.id && room.players.dark.id !== myTelegramId) {
            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal("Нет активной игры", false);
            return;
        }

        myColor = "dark";
        isOnlineGame = true;
        waitingText.textContent = "Подключаемся к другу...";

        database.ref("rooms/" + roomCode).update({
            status: "active",
            "players/dark": { id: myTelegramId, name: myTelegramName },
            turnStartedAt: firebase.database.ServerValue.TIMESTAMP
        }).then(function () {
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
        }).catch(function () {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            roomCode = null;
            showScreen(menuScreen);
            loadActiveRooms();
            showInfoModal("Не удалось подключиться к игре. Попробуйте ещё раз.", false);
        });
    }).catch(function () {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        roomCode = null;
        showScreen(menuScreen);
        loadActiveRooms();
        showInfoModal("Не удалось подключиться к игре. Попробуйте ещё раз.", false);
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
    showScreen(menuScreen);
    loadActiveRooms();
});

// ===== МОДАЛКА "СОПЕРНИК ОФЛАЙН" =====

btnOfflinePlayBot.addEventListener("click", function () {
    offlineOpponentModal.classList.add("hidden");
    roomCode = null;
    showScreen(gameScreen);
    isBotGame = true;
    startOfflineGame();
});

btnOfflineInviteFriend.addEventListener("click", function () {
    offlineOpponentModal.classList.add("hidden");
    pendingTimeControlSeconds = 0;
    createRoomAndShowWaiting();
    setTimeout(function() {
        const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
        const shareUrl = "https://t.me/share/url?url=" + encodeURIComponent(link);
        if (window.Telegram && window.Telegram.WebApp) {
            Telegram.WebApp.openTelegramLink(shareUrl);
        } else {
            window.open(shareUrl, "_blank");
        }
    }, 500);
});

// ===== СТАТИСТИКА И РЕЙТИНГ =====

function renderStatsRow(rank, name, wins, losses) {
    const row = document.createElement("div");
    row.className = "stats-row";
    const total = wins + losses;
    const rankSpan = document.createElement("span");
    const rankNumber = document.createElement("span");
    rankNumber.className = "stats-rank";
    rankNumber.textContent = rank + ".";
    rankSpan.appendChild(rankNumber);
    rankSpan.appendChild(document.createTextNode(name));
    const infoSpan = document.createElement("span");
    infoSpan.textContent = "🏆 " + wins + " · ❌ " + losses + " · " + total + " партий";
    row.appendChild(rankSpan);
    row.appendChild(infoSpan);
    return row;
}

function openStatsModal() {
    statsMySummary.textContent = "Загрузка...";
    statsLeaderboard.innerHTML = "";
    if (statsLeaderboardLosses) statsLeaderboardLosses.innerHTML = "";
    statsModal.classList.remove("hidden");

    database.ref("stats/" + myTelegramId).once("value").then(function (snapshot) {
        const mine = snapshot.val();
        const wins = (mine && mine.wins) || 0;
        const losses = (mine && mine.losses) || 0;
        const total = wins + losses;
        if (total === 0) {
            statsMySummary.textContent = "Ты ещё не сыграл ни одной онлайн-партии";
        } else {
            statsMySummary.textContent = "🏆 Побед: " + wins + "   ❌ Поражений: " + losses + "   Всего: " + total;
        }
    }).catch(function () {
        statsMySummary.textContent = "Не удалось загрузить статистику";
    });

    database.ref("stats").orderByChild("wins").limitToLast(10).once("value").then(function (snapshot) {
        const data = snapshot.val();
        statsLeaderboard.innerHTML = "";
        if (!data) {
            statsLeaderboard.textContent = "Пока никто не сыграл ни одной партии";
            return;
        }
        const entries = Object.keys(data).map(function (key) {
            return { name: data[key].name || "Игрок", wins: data[key].wins || 0, losses: data[key].losses || 0 };
        });
        entries.sort(function (a, b) { return b.wins - a.wins; });
        entries.forEach(function (entry, index) {
            statsLeaderboard.appendChild(renderStatsRow(index + 1, entry.name, entry.wins, entry.losses));
        });
    }).catch(function () {
        statsLeaderboard.textContent = "Не удалось загрузить рейтинг";
    });

    if (statsLeaderboardLosses) {
        database.ref("stats").orderByChild("losses").limitToLast(10).once("value").then(function (snapshot) {
            const data = snapshot.val();
            statsLeaderboardLosses.innerHTML = "";
            if (!data) {
                statsLeaderboardLosses.textContent = "Пока никто не сыграл ни одной партии";
                return;
            }
            const entries = Object.keys(data).map(function (key) {
                return { name: data[key].name || "Игрок", wins: data[key].wins || 0, losses: data[key].losses || 0 };
            });
            entries.sort(function (a, b) { return b.losses - a.losses; });
            entries.forEach(function (entry, index) {
                statsLeaderboardLosses.appendChild(renderStatsRow(index + 1, entry.name, entry.wins, entry.losses));
            });
        }).catch(function () {
            statsLeaderboardLosses.textContent = "Не удалось загрузить рейтинг";
        });
    }
}

if (btnShowStats) {
    btnShowStats.addEventListener("click", openStatsModal);
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
            matchmakingCount.textContent = "Сейчас в поиске: " + queueSize + " игрок" + (queueSize === 1 ? "" : (queueSize > 1 && queueSize < 5 ? "а" : "ов"));
            
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
        showInfoModal("Не удалось начать поиск. Проверьте интернет-соединение.", false);
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

function triggerBotMove() {
    if (!isBotGame || !currentState || currentState.turn !== botColor || currentState.winner) return;

    const pieceCount = Object.keys(currentState.pieces).length;
    let depth = 7; 
    
    if (pieceCount <= 12) depth = 8; 
    if (pieceCount <= 6) depth = 10;  
    
    const bestMove = findBestMove(currentState, botColor, depth);
    if (bestMove) {
        performMove(bestMove.from.row, bestMove.from.col, bestMove.to.row, bestMove.to.col);
    }
}

function findBestMove(state, color, depth) {
    const moves = getAllLegalMovesForBot(state, color);
    if (moves.length === 0) return null;

    let bestScore = -Infinity;
    let bestMoves = [];

    for (const move of moves) {
        const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, color);
        if (!newState) continue;

        // ВАЖНО: Если после хода ход не передан сопернику (newState.turn === color),
        // значит это промежуточный прыжок в цепочке взятия (mustContinueFrom).
        // В этом случае мы НЕ уменьшаем глубину поиска (depth), чтобы минимакс
        // мог бесплатно "досчитать" всю цепочку взятия до конца и правильно
        // сравнить разные клетки приземления (например, c7 и d8).
        const nextDepth = (newState.turn === color) ? depth : depth - 1;
        const score = minimax(newState, nextDepth, -Infinity, Infinity, color);
        
        if (score > bestScore) {
            bestScore = score;
            bestMoves = [move];
        } else if (score === bestScore) {
            bestMoves.push(move);
        }
    }
    
    return bestMoves[Math.floor(Math.random() * bestMoves.length)];
}

function minimax(state, depth, alpha, beta, botColor) {
    if (depth === 0 || state.winner) {
        return evaluateBoard(state, botColor);
    }

    const currentColor = state.turn;
    const isMaximizing = (currentColor === botColor);
    const moves = getAllLegalMovesForBot(state, currentColor);

    if (moves.length === 0) return isMaximizing ? -1000000 : 1000000;

    if (isMaximizing) {
        let maxEval = -Infinity;
        for (const move of moves) {
            const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, currentColor);
            if (!newState) continue;
            // Не уменьшаем глубину, если ход не передан сопернику (идёт цепочка взятия)
            const nextDepth = (newState.turn === currentColor) ? depth : depth - 1;
            const evalScore = minimax(newState, nextDepth, alpha, beta, botColor);
            maxEval = Math.max(maxEval, evalScore);
            alpha = Math.max(alpha, evalScore);
            if (beta <= alpha) break; 
        }
        return maxEval;
    } else {
        let minEval = Infinity;
        for (const move of moves) {
            const newState = attemptMove(state, move.from.row, move.from.col, move.to.row, move.to.col, currentColor);
            if (!newState) continue;
            // Не уменьшаем глубину, если ход не передан сопернику (идёт цепочка взятия)
            const nextDepth = (newState.turn === currentColor) ? depth : depth - 1;
            const evalScore = minimax(newState, nextDepth, alpha, beta, botColor);
            minEval = Math.min(minEval, evalScore);
            beta = Math.min(beta, evalScore);
            if (beta <= alpha) break;
        }
        return minEval;
    }
}

function evaluateBoard(state, botColor) {
    if (state.winner === botColor) return 1000000;
    if (state.winner && state.winner !== botColor) return -1000000;

    let score = 0;
    const opponentColor = botColor === "light" ? "dark" : "light";

    for (const key in state.pieces) {
        const p = state.pieces[key];
        const parts = key.split('_');
        const r = parseInt(parts[0]);
        const c = parseInt(parts[1]);

        let pieceVal = p.king ? 450 : 100;

        if (p.color === botColor) {
            score += pieceVal;
            if (!p.king) {
                let adv = (botColor === "dark" ? r : 7 - r);
                score += adv * 4; 
                
                if ((botColor === "dark" && r === 6) || (botColor === "light" && r === 1)) {
                    score += 60;
                }
                if ((botColor === "light" && r === 7) || (botColor === "dark" && r === 0)) {
                    score += 10;
                }
            }
            if (r >= 2 && r <= 5 && c >= 2 && c <= 5) {
                score += 4;
                if (r >= 3 && r <= 4 && c >= 3 && c <= 4) score += 2;
            }
        } else {
            score -= pieceVal;
            if (!p.king) {
                let adv = (opponentColor === "dark" ? r : 7 - r);
                score -= adv * 4;
                if ((opponentColor === "dark" && r === 6) || (opponentColor === "light" && r === 1)) {
                    score -= 60;
                }
                if ((opponentColor === "light" && r === 7) || (opponentColor === "dark" && r === 0)) {
                    score -= 10;
                }
            }
            if (r >= 2 && r <= 5 && c >= 2 && c <= 5) {
                score -= 4;
                if (r >= 3 && r <= 4 && c >= 3 && c <= 4) score -= 2;
            }
        }
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

    const greetingNameSpan = document.getElementById("user-greeting-name");
    if (greetingNameSpan) {
        let displayName = myTelegramName.length > 15 ? myTelegramName.substring(0, 15) + "..." : myTelegramName;
        greetingNameSpan.textContent = displayName;
    }

    const joinedViaLink = checkForInviteLink();
    if (!joinedViaLink) {
        loadActiveRooms();
    }
}

// ===== ЛОББИ ГРУППЫ (Список комнат) =====

document.addEventListener('DOMContentLoaded', function() {
    const btnPlayGroup = document.getElementById("btn-play-group");
    const btnBackToMenu = document.getElementById("btn-back-to-menu");

    if (btnPlayGroup) {
        btnPlayGroup.addEventListener("click", function() {
            isBotGame = false;
            showGroupLobby();
        });
    }

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
    groupRoomsList.innerHTML = '<p class="section-title">Загрузка...</p>';

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
                return !p || p.online === false || (Date.now() - (p.lastSeen || 0)) > RECONNECT_GRACE_MS;
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
            let roomDeleted = false;

            // АВТО-ЧИСТКА: комната ждёт соперника (waiting), но создатель пропал -> удаляем
            if (room.status === "waiting" && lightIsStale) {
                if (room.players && room.players.light && room.players.light.id) {
                    database.ref("users/" + room.players.light.id + "/rooms/" + code).remove();
                }
                database.ref("rooms/" + code).remove();
                roomDeleted = true;
            }

            // АВТО-ЧИСТКА: брошенная активная игра (включая после принятого реванша) -> удаляем
            if (!roomDeleted && room.status === "active" && lightIsStale && darkIsStale) {
                if (room.players && room.players.light && room.players.light.id) {
                    database.ref("users/" + room.players.light.id + "/rooms/" + code).remove();
                }
                if (room.players && room.players.dark && room.players.dark.id) {
                    database.ref("users/" + room.players.dark.id + "/rooms/" + code).remove();
                }
                database.ref("rooms/" + code).remove();
                roomDeleted = true;
            }

            if (roomDeleted) continue;

            const lightName = (room.players && room.players.light && room.players.light.name) || "Ожидание...";
            const darkName = (room.players && room.players.dark && room.players.dark.name) || "Ожидание...";

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
                activeHtml += `
                    <div class="group-room-card">
                        <div class="group-room-info active">⚫ ${lightName} vs ⚪ ${darkName}</div>
                        <button class="group-watch-btn" data-code="${code}">Смотреть</button>
                    </div>
                `;
            }
        }

        let finalHtml = "";
        if (waitingHtml) {
            finalHtml += '<p class="section-title">Ждут игру</p>' + waitingHtml;
        }
        if (activeHtml) {
            finalHtml += '<p class="section-title" style="margin-top: 15px;">Идут игры</p>' + activeHtml;
        }
        if (!finalHtml) {
            finalHtml = '<p class="section-title">Пока никто не играет</p>';
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
            showInfoModal("Комната уже занята или не существует.", false);
            return;
        }

        const creatorId = room.players.light.id;
        const creatorName = room.players.light.name;

        // ПРОВЕРКА: Защита от игры против самого себя
        if (creatorId && creatorId === myTelegramId) {
            showInfoModal("Нельзя играть против самого себя", false);
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
        stopPresenceHeartbeat();
        myPresenceRef = null;
    }

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
            showInfoModal("Игра была завершена или закрыта.", false);
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
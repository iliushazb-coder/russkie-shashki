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
const database = firebase.database();

// ===== ЗВУКИ =====

const audioContext = new (window.AudioContext || window.webkitAudioContext)();

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

function playMoveSound() { playTone(440, 0.15, 0.3); }
function playCaptureSound() {
    playTone(200, 0.12, 0.4);
    setTimeout(function () { playTone(150, 0.15, 0.4); }, 100);
}
function playKingSound() {
    playTone(523, 0.12, 0.3);
    setTimeout(function () { playTone(659, 0.12, 0.3); }, 120);
    setTimeout(function () { playTone(784, 0.25, 0.3); }, 240);
}
function playWinSound() {
    playTone(392, 0.15, 0.3);
    setTimeout(function () { playTone(523, 0.15, 0.3); }, 150);
    setTimeout(function () { playTone(659, 0.3, 0.3); }, 300);
}

function playSoundForMoveType(type) {
    if (type === "king") playKingSound();
    else if (type === "capture") playCaptureSound();
    else if (type === "move") playMoveSound();
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

let roomCode = null;
let myColor = "light";
let isOnlineGame = false;
let isBotGame = false;
let pendingTimeControlSeconds = 0;
let roomListenerRef = null;
let myPresenceRef = null;
let presenceHeartbeatInterval = null;
let opponentAbsenceHandled = false;
const STALE_MS = 10000;
const BOT_USERNAME = "russkie_shashki_bot/play";

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

    let opponentsOnPath = 0;
    let capturedKey = null;
    for (let dist = 1; dist < rowDiff; dist++) {
        const key = (fromRow + dRow * dist) + "_" + (fromCol + dCol * dist);
        if (pieces[key]) {
            opponentsOnPath++;
            capturedKey = key;
            if (pieces[key].color === actingColor) return null;
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
    } else {
        if (!king && rowDiff !== 2) return null;

        const capturedPiece = pieces[capturedKey];
        delete pieces[capturedKey];
        delete pieces[fromKey];

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

        const canContinue = canCaptureAt(pieces, toRow, toCol, actingColor, !!moving.king);

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
let squareElements = {};
let boardBuilt = false;
let builtFlipped = null;
let hintedSquares = [];

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

function statusForColor(color) {
    if (!currentState) return { text: "", cls: "" };
    const name = (currentState.players && currentState.players[color] && currentState.players[color].name) || (color === "light" ? "Белые" : "Чёрные");
    if (!isOnlineGame) {
        return { text: "", cls: "" };
    }
    const presence = (currentState.presence && currentState.presence[color]) || null;
    if (!presence) {
        return { text: name + " • подключение...", cls: "status-neutral" };
    }
    if (presence.online === false) {
        return { text: name + " покинул игру 👋", cls: "status-left" };
    }
    const age = Date.now() - (presence.lastSeen || 0);
    if (age > STALE_MS) {
        return { text: name + " потерял соединение", cls: "status-left" };
    }
    return { text: name + " • В игре", cls: "status-online" };
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

    checkOpponentAbsence();
}

function checkOpponentAbsence() {
    if (!isOnlineGame || !currentState || currentState.winner) return;
    if (opponentAbsenceHandled) return;

    const oppColor = myColor === "light" ? "dark" : "light";
    const info = statusForColor(oppColor);
    if (info.cls === "status-left") {
        opponentAbsenceHandled = true;
        const oppName = (currentState.players && currentState.players[oppColor] && currentState.players[oppColor].name) || "Соперник";
        const reasonText = info.text.indexOf("потерял соединение") !== -1
            ? (oppName + " потерял соединение 📡")
            : (oppName + " покинул игру 👋");
        opponentLeftText.textContent = reasonText + "\nПартия завершена.";
        opponentLeftModal.classList.remove("hidden");
        cleanupAbandonedRoom();
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
}

function stopPresenceHeartbeat() {
    if (presenceHeartbeatInterval) {
        clearInterval(presenceHeartbeatInterval);
        presenceHeartbeatInterval = null;
    }
}

function markMyselfLeftExplicitly() {
    if (myPresenceRef) {
        myPresenceRef.update({ online: false, lastSeen: firebase.database.ServerValue.TIMESTAMP });
    }
    stopPresenceHeartbeat();
}

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
            if (desiredIsKing) piece.classList.add("king");
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
    renderEndGameModal();
    showMoveHints(selectedFrom);
}

function clearMoveHints() {
    hintedSquares.forEach(function (sq) { sq.classList.remove("move-hint"); });
    hintedSquares = [];
}

function getLegalDestinations(pieces, row, col, color, king) {
    const opponent = color === "light" ? "dark" : "light";
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const destinations = [];

    const maxCaptureDist = king ? 7 : 2;
    for (let d = 0; d < directions.length; d++) {
        const dRow = directions[d][0];
        const dCol = directions[d][1];
        let foundOpponent = false;
        for (let dist = 1; dist <= maxCaptureDist; dist++) {
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
                    destinations.push({ row: r, col: c });
                    if (!king) break;
                } else {
                    break;
                }
            }
        }
    }

    if (destinations.length > 0) return destinations;

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
            const p = pieceAt(pieces, r, c);
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
    const destinations = getLegalDestinations(currentState.pieces, sel.row, sel.col, pieceData.color, !!pieceData.king);
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
    const remaining = currentState.timeControlSeconds - elapsed;
    const whoseTurn = currentState.turn === "light" ? "Белые" : "Чёрные";
    turnTimerDiv.textContent = "⏱ Ход: " + whoseTurn + " — осталось " + formatTime(remaining);
}

function renderEndGameModal() {
    if (currentState && currentState.winner) {
        const winnerColor = currentState.winner;
        const loserColor = winnerColor === "light" ? "dark" : "light";
        const winnerName = (currentState.players && currentState.players[winnerColor] && currentState.players[winnerColor].name) || (winnerColor === "light" ? "Белые" : "Чёрные");
        const loserName = (currentState.players && currentState.players[loserColor] && currentState.players[loserColor].name) || (loserColor === "light" ? "Белые" : "Чёрные");
        const winnerIcon = winnerColor === "light" ? "⚪" : "⚫";
        const loserIcon = loserColor === "light" ? "⚪" : "⚫";

        let reasonText = "";
        if (currentState.winReason === "no_pieces") reasonText = "у соперника закончились шашки";
        else if (currentState.winReason === "no_moves") reasonText = "у соперника нет допустимых ходов";
        else if (currentState.winReason === "resign") reasonText = "соперник сдался";
        else if (currentState.winReason === "timeout") reasonText = "закончилось время на ход";

        let text = "🏆 Победитель: " + winnerName + " " + winnerIcon + "\nПроиграл: " + loserName + " " + loserIcon;
        if (reasonText) text += "\n(" + reasonText + ")";

        endGameText.textContent = text;
        endGameModal.classList.remove("hidden");
        const marker = (roomCode || "offline") + "_" + currentState.moveCount;
        if (endGameShownForRoom !== marker) {
            playWinSound();
            endGameShownForRoom = marker;
        }
    } else {
        endGameModal.classList.add("hidden");
    }
}

function updateSelectionDom(oldSel, newSel) {
    if (oldSel) {
        const oldEl = pieceElements[oldSel.row + "_" + oldSel.col];
        if (oldEl) oldEl.classList.remove("selected");
    }
    if (newSel) {
        const newEl = pieceElements[newSel.row + "_" + newSel.col];
        if (newEl) newEl.classList.add("selected");
    }
    showMoveHints(newSel);
}

function handleClick(row, col) {
    if (!currentState || currentState.winner) return;
    const state = currentState;

    if (isOnlineGame && state.turn !== myColor) return;

    const selectableColor = isOnlineGame ? myColor : state.turn;
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

function performMove(fromRow, fromCol, toRow, toCol) {
    if (!currentState || currentState.winner) return;

    const actingColor = isOnlineGame ? myColor : currentState.turn;
    const result = attemptMove(currentState, fromRow, fromCol, toRow, toCol, actingColor);
    if (!result) return;

    currentState.pieces = result.pieces;
    currentState.turn = result.turn;
    currentState.mustContinueFrom = result.mustContinueFrom;
    currentState.capturedDark = result.capturedDark;
    currentState.capturedLight = result.capturedLight;
    currentState.moveCount = result.moveCount;
    currentState.lastMove = result.lastMove;
    currentState.winner = result.winner;
    currentState.winReason = result.winReason;
    if (currentState.timeControlSeconds) {
        currentState.turnStartedAt = Date.now();
    }

    if (result.mustContinueFrom) {
        selectedFrom = { row: result.mustContinueFrom.row, col: result.mustContinueFrom.col };
    } else {
        selectedFrom = null;
    }

    playSoundForMoveType(result.moveType);
    renderBoard();

    if (isOnlineGame && roomCode) {
        database.ref("rooms/" + roomCode).update({
            pieces: currentState.pieces,
            turn: currentState.turn,
            mustContinueFrom: currentState.mustContinueFrom || null,
            capturedDark: currentState.capturedDark,
            capturedLight: currentState.capturedLight,
            moveCount: currentState.moveCount,
            lastMove: currentState.lastMove,
            winner: currentState.winner || null,
            winReason: currentState.winReason || null,
            turnStartedAt: currentState.turnStartedAt || null
        });
    } else if (isBotGame && !currentState.winner && currentState.turn === "dark") {
        setTimeout(makeBotMove, 500);
    }
}

// ===== ИГРА С БОТОМ И СЛУШАТЕЛИ =====

function makeBotMove() {
    if (!currentState || currentState.winner || currentState.turn !== "dark" || !isBotGame) return;

    const legalMoves = [];
    for (const key in currentState.pieces) {
        const p = currentState.pieces[key];
        if (p.color === "dark") {
            const parts = key.split("_");
            const r = parseInt(parts[0]);
            const c = parseInt(parts[1]);

            if (currentState.mustContinueFrom && (currentState.mustContinueFrom.row !== r || currentState.mustContinueFrom.col !== c)) {
                continue;
            }

            const dests = getLegalDestinations(currentState.pieces, r, c, "dark", !!p.king);
            dests.forEach(function (d) {
                const testResult = attemptMove(currentState, r, c, d.row, d.col, "dark");
                if (testResult) {
                    legalMoves.push({ from: { row: r, col: c }, to: { row: d.row, col: d.col } });
                }
            });
        }
    }

    if (legalMoves.length === 0) return;
    const chosen = legalMoves[Math.floor(Math.random() * legalMoves.length)];
    performMove(chosen.from.row, chosen.from.col, chosen.to.row, chosen.to.col);
}

function listenToRoom(code) {
    if (roomListenerRef) roomListenerRef.off();

    roomListenerRef = database.ref("rooms/" + code);
    roomListenerRef.on("value", function (snapshot) {
        const data = snapshot.val();
        if (!data) return;

        currentState = data;

        if (data.moveCount !== lastSeenMoveCount) {
            if (lastSeenMoveCount !== -1 && data.lastMove) {
                playSoundForMoveType(data.moveType || "move");
            }
            lastSeenMoveCount = data.moveCount;
        }

        renderBoard();
    });
}

function startNewLocalGame(vsBot) {
    isOnlineGame = false;
    isBotGame = vsBot;
    roomCode = null;
    myColor = "light";
    flipped = false;
    selectedFrom = null;
    lastSeenMoveCount = -1;
    endGameShownForRoom = null;

    const user = getMyTelegramUser();
    myTelegramId = user.id;
    myTelegramName = user.name;

    currentState = {
        pieces: createInitialPieces(),
        turn: "light",
        mustContinueFrom: null,
        capturedDark: 0,
        capturedLight: 0,
        moveCount: 0,
        players: {
            light: { id: myTelegramId, name: myTelegramName },
            dark: { id: vsBot ? "bot" : "player2", name: vsBot ? "Бот" : "Игрок 2" }
        },
        winner: null,
        winReason: null
    };

    showScreen(gameScreen);
    renderBoard();
}

function checkStartParamAndJoin() {
    const tg = window.Telegram?.WebApp;
    let startParam = null;

    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) {
        startParam = tg.initDataUnsafe.start_param;
    } else {
        const urlParams = new URLSearchParams(window.location.search);
        startParam = urlParams.get("start_param") || urlParams.get("tgWebAppStartParam");
    }

    if (startParam) {
        joinOnlineRoom(startParam);
        return true;
    }
    return false;
}

function joinOnlineRoom(code) {
    isOnlineGame = true;
    isBotGame = false;
    roomCode = code;
    selectedFrom = null;
    lastSeenMoveCount = -1;
    endGameShownForRoom = null;
    opponentAbsenceHandled = false;

    const user = getMyTelegramUser();
    myTelegramId = user.id;
    myTelegramName = user.name;

    database.ref("rooms/" + code).once("value").then(function (snapshot) {
        const data = snapshot.val();
        if (!data) {
            alert("Комната не найдена.");
            showScreen(menuScreen);
            return;
        }

        if (data.players && data.players.light && data.players.light.id === myTelegramId) {
            myColor = "light";
            flipped = false;
        } else {
            myColor = "dark";
            flipped = true;
            database.ref("rooms/" + code + "/players/dark").set({
                id: myTelegramId,
                name: myTelegramName
            });
        }

        setupPresence();
        showScreen(gameScreen);
        listenToRoom(code);
    });
}

function initUserAndEvents() {
    const user = getMyTelegramUser();
    myTelegramId = user.id;
    myTelegramName = user.name;

    btnPlayBot.addEventListener("click", function () {
        startNewLocalGame(true);
    });

    btnPlayFriend.addEventListener("click", function () {
        showScreen(timeControlScreen);
    });

    btnResign.addEventListener("click", function () {
        resignConfirmModal.classList.remove("hidden");
    });

    btnResignNo.addEventListener("click", function () {
        resignConfirmModal.classList.add("hidden");
    });

    btnResignYes.addEventListener("click", function () {
        resignConfirmModal.classList.add("hidden");
        if (!currentState || currentState.winner) return;

        const winnerColor = myColor === "light" ? "dark" : "light";
        currentState.winner = winnerColor;
        currentState.winReason = "resign";
        renderBoard();

        if (isOnlineGame && roomCode) {
            database.ref("rooms/" + roomCode).update({
                winner: winnerColor,
                winReason: "resign"
            });
        }
    });

    btnNewGame.addEventListener("click", function () {
        endGameModal.classList.add("hidden");
        showScreen(menuScreen);
    });

    btnCloseGame.addEventListener("click", function () {
        markMyselfLeftExplicitly();
        endGameModal.classList.add("hidden");
        showScreen(menuScreen);
    });

    if (btnNewGameAfterLeave) {
        btnNewGameAfterLeave.addEventListener("click", function () {
            opponentLeftModal.classList.add("hidden");
            showScreen(menuScreen);
        });
    }

    if (btnCloseAfterLeave) {
        btnCloseAfterLeave.addEventListener("click", function () {
            opponentLeftModal.classList.add("hidden");
            showScreen(menuScreen);
        });
    }

    const joined = checkStartParamAndJoin();
    if (!joined) {
        showScreen(menuScreen);
    }

    setInterval(updateTimerDisplay, 500);
}

document.addEventListener("DOMContentLoaded", function () {
    initUserAndEvents();
});
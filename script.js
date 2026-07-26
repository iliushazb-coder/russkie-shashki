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

function playMoveSound() {
    playTone(440, 0.15, 0.3);
}

function playCaptureSound() {
    playTone(200, 0.12, 0.4);
    setTimeout(() => playTone(150, 0.15, 0.4), 100);
}

function playKingSound() {
    playTone(523, 0.12, 0.3);
    setTimeout(() => playTone(659, 0.12, 0.3), 120);
    setTimeout(() => playTone(784, 0.25, 0.3), 240);
}

function playSoundForMoveType(type) {
    if (type === "king") {
        playKingSound();
    } else if (type === "capture") {
        playCaptureSound();
    } else {
        playMoveSound();
    }
}

// ===== ЭКРАНЫ И МЕНЮ =====

const menuScreen = document.getElementById("menu-screen");
const waitingScreen = document.getElementById("waiting-screen");
const gameScreen = document.getElementById("game-screen");
const btnPlayFriend = document.getElementById("btn-play-friend");
const btnPlayBot = document.getElementById("btn-play-bot");
const inviteLinkBox = document.getElementById("invite-link-box");
const btnShareLink = document.getElementById("btn-share-link");
const waitingText = document.getElementById("waiting-text");

let roomCode = null;
let myColor = "light";
let isOnlineGame = false;
const BOT_USERNAME = "russkie_shashki_bot/play";

function generateRoomCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function showScreen(screen) {
    menuScreen.classList.add("hidden");
    waitingScreen.classList.add("hidden");
    gameScreen.classList.add("hidden");
    screen.classList.remove("hidden");
}

// ===== ИГРОВОЙ ДВИЖОК (чистые функции, без обращения к DOM) =====

// Создаёт начальную расстановку шашек.
// Ключ объекта — "строка_столбец", значение — {color, king}
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

// Может ли шашка, стоящая в (row, col), кого-то побить прямо сейчас (в любую из 4 сторон)
function canCaptureAt(pieces, row, col, color, king) {
    const opponent = color === "light" ? "dark" : "light";
    const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    const maxDistance = king ? 7 : 2;

    for (const [dRow, dCol] of directions) {
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

// Есть ли у игрока данного цвета хотя бы одна шашка, способная побить (обязательное взятие)
function hasMandatoryCapture(pieces, color) {
    for (const key in pieces) {
        const p = pieces[key];
        if (p.color === color) {
            const parts = key.split("_");
            const r = parseInt(parts[0]);
            const c = parseInt(parts[1]);
            if (canCaptureAt(pieces, r, c, color, !!p.king)) {
                return true;
            }
        }
    }
    return false;
}

// Главная функция движка: пробует применить ход к состоянию state.
// Возвращает НОВОЕ состояние, если ход разрешён правилами, или null, если ход невозможен.
// ВАЖНО: эта функция ничего не знает про DOM, Firebase или экраны — только про правила игры.
// Именно поэтому она одинаково используется и для онлайн-игры (внутри транзакции Firebase),
// и для локальной игры "с ботом" (хотсит на одном экране).
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
    if (!moving) return null;
    if (moving.color !== actingColor) return null;

    // Если идёт обязательная серия взятий — ходить можно только той же самой шашкой
    if (mustContinueFrom && (mustContinueFrom.row !== fromRow || mustContinueFrom.col !== fromCol)) {
        return null;
    }

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
        const r = fromRow + dRow * dist;
        const c = fromCol + dCol * dist;
        const key = r + "_" + c;
        if (pieces[key]) {
            opponentsOnPath++;
            capturedKey = key;
            if (pieces[key].color === actingColor) return null;
        }
    }
    if (opponentsOnPath > 1) return null;

    const forwardDirection = actingColor === "light" ? -1 : 1;
    const actualDirection = toRow - fromRow > 0 ? 1 : -1;

    if (opponentsOnPath === 0) {
        // Обычный ход без боя
        if (mustContinueFrom) return null;
        if (hasMandatoryCapture(pieces, actingColor)) return null;
        if (!king && rowDiff !== 1) return null;
        if (!king && actualDirection !== forwardDirection) return null;

        delete pieces[fromKey];
        let becameKing = false;
        if (!king) {
            if (actingColor === "light" && toRow === 0) {
                moving.king = true;
                becameKing = true;
            }
            if (actingColor === "dark" && toRow === 7) {
                moving.king = true;
                becameKing = true;
            }
        }
        pieces[toKey] = moving;

        turn = actingColor === "light" ? "dark" : "light";
        mustContinueFrom = null;
        moveCount++;

        return {
            pieces: pieces,
            turn: turn,
            mustContinueFrom: mustContinueFrom,
            capturedDark: capturedDark,
            capturedLight: capturedLight,
            moveCount: moveCount,
            moveType: becameKing ? "king" : "move",
            lastMove: { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } }
        };
    } else {
        // Ход со взятием
        if (!king && rowDiff !== 2) return null;

        const capturedPiece = pieces[capturedKey];
        delete pieces[capturedKey];
        delete pieces[fromKey];

        if (capturedPiece.color === "dark") {
            capturedDark++;
        } else {
            capturedLight++;
        }

        let becameKing = false;
        if (!king) {
            if (actingColor === "light" && toRow === 0) {
                moving.king = true;
                becameKing = true;
            }
            if (actingColor === "dark" && toRow === 7) {
                moving.king = true;
                becameKing = true;
            }
        }
        pieces[toKey] = moving;

        // Проверяем возможность продолжить серию взятий той же шашкой.
        // Правило: если шашка стала дамкой именно этим ходом — серия на этом заканчивается.
        let canContinue = false;
        if (!becameKing) {
            canContinue = canCaptureAt(pieces, toRow, toCol, actingColor, !!moving.king);
        }

        if (canContinue) {
            mustContinueFrom = { row: toRow, col: toCol };
            // ход НЕ передаётся сопернику — turn остаётся прежним
        } else {
            mustContinueFrom = null;
            turn = actingColor === "light" ? "dark" : "light";
        }

        moveCount++;

        return {
            pieces: pieces,
            turn: turn,
            mustContinueFrom: mustContinueFrom,
            capturedDark: capturedDark,
            capturedLight: capturedLight,
            moveCount: moveCount,
            moveType: becameKing ? "king" : "capture",
            lastMove: { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } }
        };
    }
}

// ===== СОСТОЯНИЕ ИГРЫ НА ЭКРАНЕ =====

let currentState = null;
let selectedFrom = null;
let flipped = false;
let lastSeenMoveCount = -1;

function getLabels() {
    if (!flipped) {
        return { letters: ["a", "b", "c", "d", "e", "f", "g", "h"], numbers: [8, 7, 6, 5, 4, 3, 2, 1] };
    } else {
        return { letters: ["h", "g", "f", "e", "d", "c", "b", "a"], numbers: [1, 2, 3, 4, 5, 6, 7, 8] };
    }
}

function updateCapturedDisplay() {
    const capturedDarkDisplay = document.getElementById("captured-dark");
    const capturedLightDisplay = document.getElementById("captured-light");
    if (!currentState) return;
    capturedDarkDisplay.textContent = "Белые: Съедено: " + currentState.capturedDark;
    capturedLightDisplay.textContent = "Чёрные: Съедено: " + currentState.capturedLight;
}

function renderBoard() {
    const wrapper = document.getElementById("board-wrapper");
    wrapper.innerHTML = "";

    const labels = getLabels();
    const letters = labels.letters;
    const numbers = labels.numbers;

    const boardDiv = document.createElement("div");
    boardDiv.id = "board";

    const topLabels = document.createElement("div");
    topLabels.classList.add("labels", "labels-top");
    letters.forEach(letter => {
        const label = document.createElement("div");
        label.classList.add("label");
        label.textContent = letter;
        topLabels.appendChild(label);
    });

    const leftLabels = document.createElement("div");
    leftLabels.classList.add("labels", "labels-left");
    numbers.forEach(number => {
        const label = document.createElement("div");
        label.classList.add("label");
        label.textContent = number;
        leftLabels.appendChild(label);
    });

    wrapper.appendChild(topLabels);
    wrapper.appendChild(leftLabels);
    wrapper.appendChild(boardDiv);

    if (!currentState) {
        return;
    }

    const lastMove = currentState.lastMove;

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

            if (lastMove) {
                const isFrom = lastMove.from.row === row && lastMove.from.col === col;
                const isTo = lastMove.to.row === row && lastMove.to.col === col;
                if (isFrom || isTo) {
                    square.classList.add("last-move");
                }
            }

            const pieceData = pieceAt(currentState.pieces, row, col);
            if (pieceData) {
                const piece = document.createElement("div");
                piece.classList.add("piece", pieceData.color === "light" ? "piece-light" : "piece-dark");
                if (pieceData.king) {
                    piece.classList.add("king");
                }
                if (selectedFrom && selectedFrom.row === row && selectedFrom.col === col) {
                    piece.classList.add("selected");
                }
                square.appendChild(piece);
            }

            square.addEventListener("click", () => handleClick(row, col));
            boardDiv.appendChild(square);
        }
    }
}

// Обрабатывает клик по клетке с канонической координатой (row, col) —
// то есть координатой в системе правил игры, а не в системе того, что видно на экране.
function handleClick(row, col) {
    if (!currentState) return;
    const state = currentState;

    // В онлайн-игре можно ходить только в свой ход и только своим цветом
    if (isOnlineGame && state.turn !== myColor) {
        return;
    }

    const selectableColor = isOnlineGame ? myColor : state.turn;
    const pieceHere = pieceAt(state.pieces, row, col);

    if (pieceHere && pieceHere.color === state.turn && pieceHere.color === selectableColor) {
        // Если идёт обязательная серия взятий — выбор шашки заблокирован на ней же
        if (state.mustContinueFrom) {
            return;
        }
        // Если есть обязательное взятие — выбирать можно только бьющую шашку
        if (hasMandatoryCapture(state.pieces, state.turn) && !canCaptureAt(state.pieces, row, col, state.turn, !!pieceHere.king)) {
            return;
        }

        if (selectedFrom && selectedFrom.row === row && selectedFrom.col === col) {
            selectedFrom = null;
        } else {
            selectedFrom = { row: row, col: col };
        }
        renderBoard();
        return;
    }

    if (selectedFrom) {
        performMove(selectedFrom.row, selectedFrom.col, row, col);
    }
}

function performMove(fromRow, fromCol, toRow, toCol) {
    if (isOnlineGame) {
        const roomRef = database.ref("rooms/" + roomCode);
        roomRef.transaction(function (room) {
            if (!room || !room.pieces) {
                return; // abort — комнаты ещё нет или она пуста
            }

            const state = {
                pieces: room.pieces,
                turn: room.turn,
                mustContinueFrom: room.mustContinueFrom || null,
                capturedDark: room.capturedDark || 0,
                capturedLight: room.capturedLight || 0,
                moveCount: room.moveCount || 0
            };

            const result = attemptMove(state, fromRow, fromCol, toRow, toCol, myColor);
            if (!result) {
                return; // abort — ход недопустим
            }

            const newRoom = {};
            for (const key in room) {
                newRoom[key] = room[key];
            }
            newRoom.pieces = result.pieces;
            newRoom.turn = result.turn;
            newRoom.mustContinueFrom = result.mustContinueFrom;
            newRoom.capturedDark = result.capturedDark;
            newRoom.capturedLight = result.capturedLight;
            newRoom.moveCount = result.moveCount;
            newRoom.moveType = result.moveType;
            newRoom.lastMove = result.lastMove;

            return newRoom;
        });
    } else {
        const result = attemptMove(currentState, fromRow, fromCol, toRow, toCol, currentState.turn);
        if (result) {
            currentState = result;
            selectedFrom = result.mustContinueFrom ? { row: result.mustContinueFrom.row, col: result.mustContinueFrom.col } : null;
            playSoundForMoveType(result.moveType);
            updateCapturedDisplay();
            renderBoard();
        }
    }
}

// ===== ЗАПУСК ИГРЫ =====

function startOnlineGame() {
    isOnlineGame = true;
    flipped = (myColor === "dark");
    lastSeenMoveCount = -1;
    selectedFrom = null;

    database.ref("rooms/" + roomCode).on("value", (snapshot) => {
        const room = snapshot.val();
        if (!room || !room.pieces) return;

        currentState = {
            pieces: room.pieces,
            turn: room.turn,
            mustContinueFrom: room.mustContinueFrom || null,
            capturedDark: room.capturedDark || 0,
            capturedLight: room.capturedLight || 0,
            moveCount: room.moveCount || 0,
            lastMove: room.lastMove || null,
            moveType: room.moveType || null
        };

        if (currentState.turn === myColor && currentState.mustContinueFrom) {
            selectedFrom = { row: currentState.mustContinueFrom.row, col: currentState.mustContinueFrom.col };
        } else {
            selectedFrom = null;
        }

        if (lastSeenMoveCount >= 0 && currentState.moveCount > lastSeenMoveCount) {
            playSoundForMoveType(currentState.moveType);
        }
        lastSeenMoveCount = currentState.moveCount;

        updateCapturedDisplay();
        renderBoard();
    });
}

function startOfflineGame() {
    isOnlineGame = false;
    myColor = "light";
    flipped = false;
    selectedFrom = null;
    currentState = {
        pieces: createInitialPieces(),
        turn: "light",
        mustContinueFrom: null,
        capturedDark: 0,
        capturedLight: 0,
        moveCount: 0,
        lastMove: null,
        moveType: null
    };
    updateCapturedDisplay();
    renderBoard();
}

// --- Кнопка "Играть с другом" ---
btnPlayFriend.addEventListener("click", () => {
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
        moveType: null,
        pieces: createInitialPieces()
    };

    database.ref("rooms/" + roomCode).set(initialState);

    const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
    inviteLinkBox.textContent = link;

    showScreen(waitingScreen);

    database.ref("rooms/" + roomCode + "/status").on("value", (snapshot) => {
        if (snapshot.val() === "active") {
            database.ref("rooms/" + roomCode + "/status").off();
            waitingText.textContent = "Друг подключился! Начинаем игру.";
            setTimeout(() => {
                showScreen(gameScreen);
                startOnlineGame();
            }, 1000);
        }
    });
});

// --- Кнопка "Отправить другу" ---
btnShareLink.addEventListener("click", () => {
    const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
    const shareUrl = "https://t.me/share/url?url=" + encodeURIComponent(link);

    if (window.Telegram && window.Telegram.WebApp) {
        Telegram.WebApp.openTelegramLink(shareUrl);
    } else {
        window.open(shareUrl, "_blank");
    }
});

// --- Кнопка "Играть с ботом" (локальная игра вдвоём на одном экране) ---
btnPlayBot.addEventListener("click", () => {
    showScreen(gameScreen);
    startOfflineGame();
});

// --- Проверяем, открыта ли игра по ссылке-приглашению ---
function checkForInviteLink() {
    let startParam = null;

    if (window.Telegram && window.Telegram.WebApp && Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.start_param) {
        startParam = Telegram.WebApp.initDataUnsafe.start_param;
    }

    if (startParam) {
        roomCode = startParam;
        myColor = "dark";
        isOnlineGame = true;

        showScreen(waitingScreen);
        waitingText.textContent = "Подключаемся к другу...";
        inviteLinkBox.classList.add("hidden");
        btnShareLink.classList.add("hidden");

        database.ref("rooms/" + roomCode + "/status").set("active").then(() => {
            setTimeout(() => {
                showScreen(gameScreen);
                startOnlineGame();
            }, 1000);
        });
    }
}

checkForInviteLink();
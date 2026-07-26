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
    setTimeout(() => playTone(150, 0.15, 0.4), 100);
}
function playKingSound() {
    playTone(523, 0.12, 0.3);
    setTimeout(() => playTone(659, 0.12, 0.3), 120);
    setTimeout(() => playTone(784, 0.25, 0.3), 240);
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

btnPlayFriend.addEventListener("click", () => {
    roomCode = generateRoomCode();
    myColor = "light";
    isOnlineGame = true;

    database.ref("rooms/" + roomCode).set({
        status: "waiting",
        board: null,
        turn: "light"
    });

    const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
    inviteLinkBox.textContent = link;

    showScreen(waitingScreen);

    database.ref("rooms/" + roomCode + "/status").on("value", (snapshot) => {
        if (snapshot.val() === "active") {
            database.ref("rooms/" + roomCode + "/status").off();
            waitingText.textContent = "Друг подключился! Начинаем игру.";
            setTimeout(() => {
                showScreen(gameScreen);
                initBoard();
            }, 1000);
        }
    });
});

btnShareLink.addEventListener("click", () => {
    const link = "https://t.me/" + BOT_USERNAME + "?startapp=" + roomCode;
    const shareUrl = "https://t.me/share/url?url=" + encodeURIComponent(link) + "&text=" + encodeURIComponent("Давай сыграем в русские шашки! 🎮");

    if (window.Telegram && window.Telegram.WebApp) {
        Telegram.WebApp.openTelegramLink(shareUrl);
    } else {
        window.open(shareUrl, "_blank");
    }
});

btnPlayBot.addEventListener("click", () => {
    isOnlineGame = false;
    myColor = "light";
    showScreen(gameScreen);
    initBoard();
});

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
                initBoard();
            }, 1000);
        });
    }
}

checkForInviteLink();

// ===== ЛОГИКА ИГРЫ =====

function initBoard() {
    const board = document.getElementById("board");
    board.innerHTML = "";
    const letters = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const numbers = [8, 7, 6, 5, 4, 3, 2, 1];

    const wrapper = document.getElementById("board-wrapper");

    let capturedDarkCount = 0;
    let capturedLightCount = 0;
    const capturedDarkDisplay = document.getElementById("captured-dark");
    const capturedLightDisplay = document.getElementById("captured-light");

    function updateCapturedDisplay() {
        capturedDarkDisplay.textContent = "Съедено чёрных: " + capturedDarkCount;
        capturedLightDisplay.textContent = "Съедено белых: " + capturedLightCount;
    }

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

    const squares = [];
    let currentTurn = "light";
    let mustContinueWith = null;

    for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
            const square = document.createElement("div");
            square.classList.add("square");
            square.dataset.row = row;
            square.dataset.col = col;

            const isDark = (row + col) % 2 !== 0;
            if (isDark) {
                square.classList.add("dark");
            } else {
                square.classList.add("light");
            }

            if (isDark) {
                if (row < 3) {
                    const piece = document.createElement("div");
                    piece.classList.add("piece", "piece-dark");
                    piece.addEventListener("click", () => selectPiece(piece));
                    square.appendChild(piece);
                } else if (row > 4) {
                    const piece = document.createElement("div");
                    piece.classList.add("piece", "piece-light");
                    piece.addEventListener("click", () => selectPiece(piece));
                    square.appendChild(piece);
                }
            }

            board.appendChild(square);
            squares.push(square);
        }
    }

    let selectedPiece = null;
    let lastMoveSquares = [];

    function findSquare(row, col) {
        for (let i = 0; i < squares.length; i++) {
            const sq = squares[i];
            if (parseInt(sq.dataset.row) === row && parseInt(sq.dataset.col) === col) {
                return sq;
            }
        }
        return null;
    }

    function isKing(piece) {
        return piece.classList.contains("king");
    }

    function canPieceCapture(piece) {
        const square = piece.parentElement;
        const row = parseInt(square.dataset.row);
        const col = parseInt(square.dataset.col);
        const pieceColor = piece.classList.contains("piece-light") ? "light" : "dark";
        const opponentClass = pieceColor === "light" ? "piece-dark" : "piece-light";
        const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
        const king = isKing(piece);
        const maxDistance = king ? 7 : 2;

        for (const [dRow, dCol] of directions) {
            let foundOpponent = false;
            for (let dist = 1; dist <= maxDistance; dist++) {
                const checkRow = row + dRow * dist;
                const checkCol = col + dCol * dist;
                const checkSquare = findSquare(checkRow, checkCol);
                if (!checkSquare) break;

                const checkPiece = checkSquare.querySelector(".piece");

                if (!foundOpponent) {
                    if (checkPiece && checkPiece.classList.contains(opponentClass)) {
                        foundOpponent = true;
                    } else if (checkPiece) {
                        break;
                    }
                } else {
                    if (!checkPiece) {
                        return true;
                    } else {
                        break;
                    }
                }
            }
        }
        return false;
    }

    function playerHasCapture(color) {
        const cssClass = color === "light" ? "piece-light" : "piece-dark";
        const pieces = document.querySelectorAll("." + cssClass);
        for (const piece of pieces) {
            if (canPieceCapture(piece)) {
                return true;
            }
        }
        return false;
    }

    function selectPiece(piece) {
        const pieceColor = piece.classList.contains("piece-light") ? "light" : "dark";

        if (pieceColor !== currentTurn) {
            return;
        }

        if (isOnlineGame && pieceColor !== myColor) {
            return;
        }

        if (mustContinueWith && piece !== mustContinueWith) {
            return;
        }

        if (!mustContinueWith && playerHasCapture(currentTurn) && !canPieceCapture(piece)) {
            return;
        }

        if (selectedPiece && selectedPiece !== mustContinueWith) {
            selectedPiece.classList.remove("selected");
        }

        if (selectedPiece === piece && !mustContinueWith) {
            selectedPiece = null;
            return;
        }

        selectedPiece = piece;
        piece.classList.add("selected");
    }

    function checkPromotion(piece, toSquare) {
        if (isKing(piece)) {
            return false;
        }

        const pieceColor = piece.classList.contains("piece-light") ? "light" : "dark";
        const row = parseInt(toSquare.dataset.row);

        if (pieceColor === "light" && row === 0) {
            piece.classList.add("king");
            return true;
        } else if (pieceColor === "dark" && row === 7) {
            piece.classList.add("king");
            return true;
        }
        return false;
    }

    function completeMove(fromSquare, toSquare, wasCapture) {
        lastMoveSquares.forEach(sq => sq.classList.remove("last-move"));
        lastMoveSquares = [];

        fromSquare.classList.add("last-move");
        lastMoveSquares.push(fromSquare);

        const movedPiece = selectedPiece;
        toSquare.appendChild(movedPiece);
        const becameKing = checkPromotion(movedPiece, toSquare);
        movedPiece.classList.remove("selected");

        toSquare.classList.add("last-move");
        lastMoveSquares.push(toSquare);

        if (becameKing) {
            playKingSound();
        } else if (wasCapture) {
            playCaptureSound();
        } else {
            playMoveSound();
        }

        if (wasCapture && canPieceCapture(movedPiece)) {
            selectedPiece = movedPiece;
            mustContinueWith = movedPiece;
            movedPiece.classList.add("selected");
        } else {
            selectedPiece = null;
            mustContinueWith = null;
            currentTurn = currentTurn === "light" ? "dark" : "light";
        }
    }

    squares.forEach(square => {
        square.addEventListener("click", () => {
            if (!selectedPiece) return;
            if (square.querySelector(".piece")) return;

            const fromSquare = selectedPiece.parentElement;
            const fromRow = parseInt(fromSquare.dataset.row);
            const fromCol = parseInt(fromSquare.dataset.col);
            const toRow = parseInt(square.dataset.row);
            const toCol = parseInt(square.dataset.col);

            const rowDiff = Math.abs(toRow - fromRow);
            const colDiff = Math.abs(toCol - fromCol);
            const king = isKing(selectedPiece);

            if (rowDiff !== colDiff || rowDiff === 0) {
                return;
            }

            const dRow = (toRow - fromRow) / rowDiff;
            const dCol = (toCol - fromCol) / colDiff;

            let opponentsOnPath = 0;
            let lastOpponentSquare = null;
            const opponentClass = currentTurn === "light" ? "piece-dark" : "piece-light";

            for (let dist = 1; dist < rowDiff; dist++) {
                const checkSquare = findSquare(fromRow + dRow * dist, fromCol + dCol * dist);
                const checkPiece = checkSquare.querySelector(".piece");
                if (checkPiece) {
                    opponentsOnPath++;
                    lastOpponentSquare = checkSquare;
                    if (!checkPiece.classList.contains(opponentClass)) {
                        return;
                    }
                }
            }

            const forwardDirection = currentTurn === "light" ? -1 : 1;
            const actualDirection = toRow - fromRow > 0 ? 1 : -1;

            if (opponentsOnPath === 0) {
                if (mustContinueWith) return;
                if (playerHasCapture(currentTurn)) return;
                if (!king && rowDiff !== 1) return;
                if (!king && actualDirection !== forwardDirection) return;

                completeMove(fromSquare, square, false);
            } else if (opponentsOnPath === 1) {
                if (!king && rowDiff !== 2) return;

                const middlePiece = lastOpponentSquare.querySelector(".piece");
                const capturedColor = middlePiece.classList.contains("piece-light") ? "light" : "dark";
                middlePiece.remove();

                if (capturedColor === "dark") {
                    capturedDarkCount++;
                } else {
                    capturedLightCount++;
                }
                updateCapturedDisplay();

                completeMove(fromSquare, square, true);
            }
        });
    });
}
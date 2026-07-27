function performMove(fromRow, fromCol, toRow, toCol) {
    const actingColor = isOnlineGame ? myColor : currentState.turn;
    const result = attemptMove(currentState, fromRow, fromCol, toRow, toCol, actingColor);
    if (!result) return;

    // Воспроизведение звука хода
    playSoundForMoveType(result.moveType);

    // Оптимистичное / локальное обновление состояния
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

    // Если шашка обязана продолжить взятие — сохраняем её выделение
    selectedFrom = result.mustContinueFrom ? { row: result.mustContinueFrom.row, col: result.mustContinueFrom.col } : null;

    renderBoard();

    // Синхронизация с Firebase (при онлайн-игре)
    if (isOnlineGame && roomCode) {
        const updates = {
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
        };
        database.ref("rooms/" + roomCode).update(updates);
    } 
    // Логика хода бота (при игре с ботом)
    else if (!isOnlineGame && isBotGame && currentState.turn === "dark" && !currentState.winner) {
        setTimeout(makeBotMove, 400);
    }
}

// ===== ИИ (БОТ) =====

let isBotGame = false;

function getAllLegalMovesForColor(pieces, color, mustContinueFrom) {
    const moves = [];
    const hasCapture = hasMandatoryCapture(pieces, color);

    for (const key in pieces) {
        const p = pieces[key];
        if (p.color !== color) continue;

        const parts = key.split("_");
        const r = parseInt(parts[0]);
        const c = parseInt(parts[1]);

        if (mustContinueFrom && (mustContinueFrom.row !== r || mustContinueFrom.col !== c)) continue;

        const dests = getLegalDestinations(pieces, r, c, color, !!p.king);
        dests.forEach(function (d) {
            moves.push({ from: { row: r, col: c }, to: d });
        });
    }
    return moves;
}

function makeBotMove() {
    if (!currentState || currentState.winner || currentState.turn !== "dark") return;

    const legalMoves = getAllLegalMovesForColor(currentState.pieces, "dark", currentState.mustContinueFrom);
    if (legalMoves.length === 0) return;

    // Выбираем случайный допустимый ход из всех возможных
    const randomMove = legalMoves[Math.floor(Math.random() * legalMoves.length)];
    performMove(randomMove.from.row, randomMove.from.col, randomMove.to.row, randomMove.to.col);
}

// ===== ТАЙМЕР ХОДА =====

setInterval(function () {
    updateTimerDisplay();

    // Проверка таймаута на ходе
    if (currentState && currentState.timeControlSeconds && currentState.turnStartedAt && !currentState.winner) {
        const elapsed = (Date.now() - currentState.turnStartedAt) / 1000;
        if (elapsed >= currentState.timeControlSeconds) {
            const winner = currentState.turn === "light" ? "dark" : "light";
            currentState.winner = winner;
            currentState.winReason = "timeout";
            renderBoard();

            if (isOnlineGame && roomCode) {
                database.ref("rooms/" + roomCode).update({
                    winner: winner,
                    winReason: "timeout"
                });
            }
        }
    }
}, 500);

// ===== СИНХРОНИЗАЦИЯ FIREBASE (ОНЛАЙН) =====

function listenToRoom(code) {
    if (roomListenerRef) roomListenerRef.off();

    roomListenerRef = database.ref("rooms/" + code);
    roomListenerRef.on("value", function (snapshot) {
        const data = snapshot.val();
        if (!data) return;

        currentState = data;

        // Звуковое сопровождение ходов соперника
        if (data.moveCount > lastSeenMoveCount) {
            if (lastSeenMoveCount !== -1 && data.lastMove) {
                // Воспроизведение звука при обновлении с сервера
                const moveType = data.mustContinueFrom ? "capture" : "move";
                playSoundForMoveType(moveType);
            }
            lastSeenMoveCount = data.moveCount;
        }

        renderBoard();
    });
}

// ===== СТАРТ ИНИЦИАЛИЗАЦИИ И ИНТЕРФЕЙСА =====

function startNewLocalGame(vsBot) {
    isOnlineGame = false;
    isBotGame = vsBot;
    roomCode = null;
    myColor = "light";
    flipped = false;
    selectedFrom = null;

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
        lastMove: null,
        winner: null,
        winReason: null,
        players: {
            light: { id: myTelegramId, name: myTelegramName },
            dark: { id: vsBot ? "bot" : "player2", name: vsBot ? "Бот" : "Игрок 2" }
        }
    };

    boardBuilt = false;
    showScreen(gameScreen);
    renderBoard();
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
}

// Запуск инициализации
initUserAndEvents();
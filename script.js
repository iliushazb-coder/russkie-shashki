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

        database.ref("rooms/" + roomCode).set(initialState).then(function() {
            return database.ref("users/" + myTelegramId + "/rooms/" + roomCode).set({
                opponentName: "Поиск соперника...",
                myColor: "light"
            });
        }).then(function() {
            setupPresence();

            const myQueueRef = database.ref("matchmakingQueue/" + myTelegramId);
            return myQueueRef.set({ name: myTelegramName, timestamp: Date.now(), roomCode: roomCode });
        }).then(function() {
            database.ref("matchmakingQueue/" + myTelegramId).onDisconnect().remove();
            resolve();
        }).catch(function(error) {
            console.error("Ошибка создания комнаты для матчмейкинга:", error);
            reject(error);
        });
    });
}
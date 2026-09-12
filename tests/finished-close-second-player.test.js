const fs = require("fs");
const vm = require("vm");

const src = fs.readFileSync("script.js", "utf8");
let passed = 0;
let failed = 0;

function ok(cond, name) {
    if (cond) {
        passed++;
        console.log("✅ " + name);
    } else {
        failed++;
        console.log("❌ " + name);
    }
}

// Production race:
// первый игрок удалил finished-room, второй ещё видит endGameModal.
const nullStart = src.indexOf("if (!room || !room.pieces) {");
const nullEnd = src.indexOf("\n        const newState = {", nullStart);
const nullBlock = nullStart >= 0 && nullEnd > nullStart
    ? src.slice(nullStart, nullEnd)
    : "";

ok(nullStart >= 0 && nullEnd > nullStart,
   "1. найден null-room branch основного room-listener");

ok(nullBlock.includes("isOnlineGame = false;") &&
   nullBlock.includes("roomCode = null;"),
   "2. удаление комнаты сбрасывает online-маркеры второго клиента");

ok(!nullBlock.includes("closeModal(endGameModal)"),
   "3. null-room branch не закрывает уже открытую end-game modal");

ok(!nullBlock.includes("currentState = null;"),
   "4. после удаления комнаты finished currentState остаётся доступен");

// Выполняем РЕАЛЬНЫЙ btnCloseGame callback в состоянии второго игрока:
// room уже удалена -> isOnlineGame=false, roomCode=null,
// но currentState.winner и end-game modal ещё существуют.
const handlerMatch = src.match(
    /btnCloseGame\.addEventListener\("click", function \(\) \{([\s\S]*?)\n\}\);\n\nfunction cleanupFinishedRoom\(\)/
);

if (!handlerMatch) {
    ok(false, "5. найден btnCloseGame callback");
    ok(false, "6. второй finished-online игрок не закрывает Telegram Mini App");
    ok(false, "7. оба finished-online пути возвращают в главное меню");
} else {
    const events = [];
    const context = {
        isSpectator: false,
        isOnlineGame: false,
        currentState: { winner: "light" },
        roomCode: null,
        isBotGame: false,
        ownerSessionAttached: false,
        endGameModal: {},
        menuScreen: {},
        closeModal: function () { events.push("closeModal"); },
        markMyselfLeftExplicitly: function () { events.push("markLeft"); },
        cleanupFinishedRoom: function () { events.push("cleanup"); },
        detachFromOwnerBotSessionLocally: function () {},
        stopBotSpectateRoom: function () {},
        finishLocalOnlyBotSeries: function () {},
        showScreen: function (screen) {
            events.push(screen === context.menuScreen ? "menuScreen" : "otherScreen");
        },
        loadActiveRooms: function () { events.push("loadActiveRooms"); },
        window: {
            Telegram: {
                WebApp: {
                    close: function () { events.push("telegramClose"); }
                }
            }
        },
        Telegram: {
            WebApp: {
                close: function () { events.push("telegramClose"); }
            }
        }
    };

    const handler = vm.runInNewContext(
        "(function () {" + handlerMatch[1] + "\n})",
        context
    );

    handler();

    ok(!events.includes("telegramClose"),
       "5. второй finished-online игрок НЕ закрывает Telegram Mini App");

    ok(events.includes("menuScreen") && events.includes("loadActiveRooms"),
       "6. второй finished-online игрок возвращается в главное меню");

    const helperMatch = src.match(
        /function leaveFinishedOnlineAndReturnToLobby\(\) \{([\s\S]*?)\n\}/
    );
    const helperBody = helperMatch ? helperMatch[1] : "";

    ok(helperMatch &&
       helperBody.includes("showScreen(menuScreen);") &&
       helperBody.includes("loadActiveRooms();") &&
       !helperBody.includes("showGroupLobby();"),
       "7. первый finished-online игрок тоже возвращается в главное меню, не в «Кто играет?»");
}

console.log("\nИТОГ: " + passed + "/7, провалено: " + failed);
process.exit(failed ? 1 : 0);

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

const start = src.indexOf("function cancelWaitingFriendRoomAndReturnToTimeControl()");
const end = src.indexOf("\n\nif (btnBackFromWaiting)", start);
const fnText = start >= 0 && end > start ? src.slice(start, end) : "";

ok(!!fnText, "1. найден реальный cancel-helper");

function makeThenable(result) {
    return {
        then(fn) {
            fn(result);
            return { catch() {} };
        }
    };
}

function runScenario(mode) {
    const events = [];
    let txReturn;

    const waitingRoom = {
        status: "waiting",
        players: {
            light: { id: "tg_1", name: "Creator" },
            dark: null
        }
    };

    const activeRoom = {
        status: "active",
        players: {
            light: { id: "tg_1", name: "Creator" },
            dark: { id: "tg_2", name: "Friend" }
        }
    };

    const roomRef = {
        transaction(callback) {
            const current = mode === "waiting-wins" ? waitingRoom : activeRoom;
            txReturn = callback(current);

            if (mode === "waiting-wins") {
                return makeThenable({
                    committed: txReturn === null,
                    snapshot: { exists: () => false }
                });
            }

            return makeThenable({
                committed: false,
                snapshot: { exists: () => true }
            });
        }
    };

    const context = {
        console,
        canUseFirebase: () => true,
        roomCode: "ABC123",
        myTelegramId: "tg_1",
        myTelegramName: "Creator",
        myPendingFriendRoomCode: "ABC123",
        myColor: "light",
        currentState: { some: "state" },
        isOnlineGame: true,
        btnBackFromWaiting: { disabled: false },
        timeControlScreen: { id: "time" },

        database: {
            ref(path) {
                if (path === "rooms/ABC123") return roomRef;

                if (path === "users/tg_1/rooms/ABC123") {
                    return {
                        remove() {
                            events.push("metadata-remove");
                            return { catch() {} };
                        }
                    };
                }

                throw new Error("Unexpected ref: " + path);
            }
        },

        detachFriendWaitingStatusListener() {
            events.push("detach-status-listener");
        },

        detachMyPresence() {
            events.push("detach-presence");
        },

        showScreen(screen) {
            events.push(screen === context.timeControlScreen ? "time-control" : "other-screen");
        }
    };

    const fn = vm.runInNewContext("(" + fnText + ")", context);
    fn();

    return { context, events, txReturn };
}

const a = runScenario("waiting-wins");

ok(a.txReturn === null,
   "2. waiting-комната без dark атомарно удаляется transaction");

ok(a.events.includes("detach-status-listener"),
   "3. после успешной отмены снимается waiting status-listener");

ok(a.events.includes("detach-presence"),
   "4. после успешной отмены снимается presence");

ok(a.events.includes("metadata-remove"),
   "5. после успешной отмены удаляется users-room metadata");

ok(a.events.includes("time-control"),
   "6. после успешной отмены пользователь возвращается к выбору времени");

ok(
    a.context.roomCode === null &&
    a.context.isOnlineGame === false &&
    a.context.myPendingFriendRoomCode === null &&
    a.context.myColor === null &&
    a.context.currentState === null,
    "7. после успешной отмены локальное waiting-состояние полностью сброшено"
);

const b = runScenario("join-wins");

ok(b.txReturn === undefined,
   "8. если друг уже подключился, transaction отменяет удаление комнаты");

ok(!b.events.includes("metadata-remove") &&
   !b.events.includes("detach-presence") &&
   !b.events.includes("detach-status-listener"),
   "9. проигравшая отмена НЕ чистит active-комнату/listener/presence");

ok(!b.events.includes("time-control"),
   "10. при победе join пользователь НЕ уходит обратно к выбору времени");

ok(
    b.context.roomCode === "ABC123" &&
    b.context.isOnlineGame === true &&
    b.context.myPendingFriendRoomCode === "ABC123" &&
    b.context.myColor === "light",
    "11. при победе join локальное состояние active-перехода сохранено"
);

ok(b.context.btnBackFromWaiting.disabled === false,
   "12. после разрешения гонки кнопка снова разблокируется");

console.log("\nИТОГ: " + passed + "/12, провалено: " + failed);
process.exitCode = failed ? 1 : 0;

const fs = require("fs");

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

const marker = "// ===== НОВАЯ ИГРА / ЗАКРЫТЬ =====";
const markerPos = src.indexOf(marker);
const cleanupPos = src.indexOf("function cleanupFinishedRoom()", markerPos);
const section = markerPos >= 0 && cleanupPos > markerPos ? src.slice(markerPos, cleanupPos) : "";

ok(markerPos >= 0 && cleanupPos > markerPos, "1. найден блок «НОВАЯ ИГРА / ЗАКРЫТЬ»");

const helperName = "leaveFinishedOnlineAndReturnToLobby";
const helperStart = section.indexOf("function " + helperName + "()");
const handlerStart = section.indexOf('btnCloseGame.addEventListener("click"');
const helperBody = helperStart >= 0 && handlerStart > helperStart ? section.slice(helperStart, handlerStart) : "";

ok(helperStart >= 0, "2. есть отдельный helper выхода завершившего игрока в лобби");
ok(helperBody.includes("detachRoomListener();"), "3. helper отписывает старый room-listener");
ok(helperBody.includes("detachMyPresence();"), "4. helper снимает локальный presence");
ok(helperBody.includes("isOnlineGame = false;"), "5. helper сбрасывает online-флаг");
ok(helperBody.includes("roomCode = null;"), "6. helper инвалидирует roomCode");
ok(helperBody.includes("currentState = null;"), "7. helper очищает старое состояние партии");
ok(helperBody.includes("showGroupLobby();"), "8. helper возвращает именно в online-лобби");

const onlineAnchor = "if (isOnlineGame && currentState && currentState.winner && roomCode) {";
const onlineStart = section.indexOf(onlineAnchor, handlerStart);
const fallbackAnchor = "\n    closeModal(endGameModal);\n    markMyselfLeftExplicitly();";
const onlineEnd = section.indexOf(fallbackAnchor, onlineStart);
const onlineBlock = onlineStart >= 0 && onlineEnd > onlineStart ? section.slice(onlineStart, onlineEnd) : "";

ok(onlineStart >= 0 && onlineEnd > onlineStart, "9. найден finished-online путь кнопки «Закрыть»");
ok(onlineBlock.includes("waitForSettlementBeforeRoomMutation()"), "10. settlement-барьер перед cleanup сохранён");
ok(onlineBlock.includes("cleanupFinishedRoom();"), "11. безопасный cleanup завершённой комнаты сохранён");
ok(!onlineBlock.includes("Telegram.WebApp.close()"), "12. finished-online «Закрыть» больше НЕ закрывает Telegram Mini App");

const helperCalls = (onlineBlock.match(/leaveFinishedOnlineAndReturnToLobby\(\);/g) || []).length;
ok(helperCalls >= 2, "13. возврат в лобби выполняется и после normal outcome, и при settlement error");

console.log("\nИТОГ: " + passed + "/13, провалено: " + failed);
process.exit(failed ? 1 : 0);

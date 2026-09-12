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
const cleanupFnPos = src.indexOf("function cleanupFinishedRoom()", markerPos);
const section = markerPos >= 0 && cleanupFnPos > markerPos ? src.slice(markerPos, cleanupFnPos) : "";

const handlerStart = section.indexOf('btnCloseGame.addEventListener("click"');
const onlineAnchor = "if (isOnlineGame && currentState && currentState.winner && roomCode) {";
const onlineStart = section.indexOf(onlineAnchor, handlerStart);
const fallbackAnchor = "\n    closeModal(endGameModal);\n    markMyselfLeftExplicitly();";
const onlineEnd = section.indexOf(fallbackAnchor, onlineStart);
const onlineBlock = onlineStart >= 0 && onlineEnd > onlineStart ? section.slice(onlineStart, onlineEnd) : "";

const waitIdx = onlineBlock.indexOf("waitForSettlementBeforeRoomMutation()");
const detachIdx = onlineBlock.indexOf("detachRoomListener();");
const cleanupIdx = onlineBlock.indexOf("cleanupFinishedRoom();");

ok(onlineStart >= 0 && onlineEnd > onlineStart, "1. найден finished-online путь «Закрыть»");
ok(waitIdx >= 0 && cleanupIdx > waitIdx, "2. settlement-barrier остаётся перед cleanup");
ok(detachIdx >= 0, "3. finished-online путь явно снимает старый room-listener");
ok(detachIdx > waitIdx && detachIdx < cleanupIdx, "4. room-listener снимается ДО cleanupFinishedRoom()");
ok(!onlineBlock.includes("Telegram.WebApp.close()"), "5. finished-online путь не закрывает Telegram Mini App");

console.log("\nИТОГ: " + passed + "/5, провалено: " + failed);
process.exit(failed ? 1 : 0);

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
const section = markerPos >= 0 && cleanupPos > markerPos
    ? src.slice(markerPos, cleanupPos)
    : "";

const onlineAnchor = "if (isOnlineGame && currentState && currentState.winner && roomCode) {";
const onlineStart = section.indexOf(onlineAnchor);
const fallbackAnchor = "\n    closeModal(endGameModal);\n    markMyselfLeftExplicitly();";
const onlineEnd = section.indexOf(fallbackAnchor, onlineStart);
const onlineBlock = onlineStart >= 0 && onlineEnd > onlineStart
    ? section.slice(onlineStart, onlineEnd)
    : "";

const catchAnchor = "}).catch(function (error) {";
const catchStart = onlineBlock.indexOf(catchAnchor);
const catchEndAnchor = "\n        });";
const catchEnd = catchStart >= 0
    ? onlineBlock.indexOf(catchEndAnchor, catchStart)
    : -1;
const catchBlock = catchStart >= 0 && catchEnd > catchStart
    ? onlineBlock.slice(catchStart, catchEnd)
    : "";

ok(catchStart >= 0 && catchEnd > catchStart,
   "1. найден отдельный settlement-error catch");

ok(catchBlock.includes("closeModal(endGameModal);"),
   "2. при settlement error end-game modal закрывается");

ok(catchBlock.includes("leaveFinishedOnlineAndReturnToLobby();"),
   "3. при settlement error игрок локально возвращается в online-лобби");

ok(!catchBlock.includes("cleanupFinishedRoom();"),
   "4. при settlement error finished outcome НЕ удаляется");

ok(!catchBlock.includes("Telegram.WebApp.close()"),
   "5. при settlement error Telegram Mini App НЕ закрывается");

console.log("\nИТОГ: " + passed + "/5, провалено: " + failed);
process.exit(failed ? 1 : 0);

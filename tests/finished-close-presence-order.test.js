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

const thenBlock = catchStart >= 0
    ? onlineBlock.slice(0, catchStart)
    : "";

const catchBlock = catchStart >= 0
    ? onlineBlock.slice(catchStart)
    : "";

const thenDetach = thenBlock.indexOf("detachRoomListener();");
const thenMark = thenBlock.indexOf("markMyselfLeftExplicitly();");

const catchDetach = catchBlock.indexOf("detachRoomListener();");
const catchMark = catchBlock.indexOf("markMyselfLeftExplicitly();");

ok(thenDetach >= 0 && thenMark >= 0,
   "1. success/blocked путь содержит detach listener и explicit presence leave");

ok(thenDetach < thenMark,
   "2. success/blocked: room-listener снимается ДО markMyselfLeftExplicitly()");

ok(catchDetach >= 0 && catchMark >= 0,
   "3. settlement-error catch содержит detach listener и explicit presence leave");

ok(catchDetach < catchMark,
   "4. settlement-error: room-listener снимается ДО markMyselfLeftExplicitly()");

console.log("\nИТОГ: " + passed + "/4, провалено: " + failed);
process.exit(failed ? 1 : 0);

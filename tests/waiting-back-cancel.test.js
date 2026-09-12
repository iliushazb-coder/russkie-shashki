const fs = require("fs");

const js = fs.readFileSync("script.js", "utf8");
const html = fs.readFileSync("index.html", "utf8");

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

const waitingMatch = html.match(
    /<div id="waiting-screen"[\s\S]*?<\/div>\s*<div id="game-screen"/
);
const waitingHtml = waitingMatch ? waitingMatch[0] : "";

ok(
    /id="btn-back-from-waiting"/.test(waitingHtml),
    '1. waiting-screen содержит отдельную кнопку «Назад»'
);

ok(
    /const\s+btnBackFromWaiting\s*=\s*document\.getElementById\("btn-back-from-waiting"\)/.test(js),
    '2. script.js получает ссылку на кнопку «Назад» waiting-screen'
);

ok(
    /let\s+friendWaitingStatusRef\s*=\s*null\s*;/.test(js),
    '3. status-listener waiting-room хранится в отдельной ссылке'
);

ok(
    /function\s+detachFriendWaitingStatusListener\s*\(\)/.test(js),
    '4. есть единый helper снятия waiting status-listener'
);

ok(
    /function\s+cancelWaitingFriendRoomAndReturnToTimeControl\s*\(\)/.test(js),
    '5. есть отдельный безопасный cancel-helper waiting-room'
);

const cancelMatch = js.match(
    /function\s+cancelWaitingFriendRoomAndReturnToTimeControl\s*\(\)\s*\{([\s\S]*?)\n\}/
);
const cancelBody = cancelMatch ? cancelMatch[1] : "";

ok(
    cancelBody.includes(".transaction(") ||
    /transaction\s*\(/.test(cancelBody),
    '6. отмена waiting-room использует атомарную transaction'
);

ok(
    /status\s*!==\s*"waiting"/.test(cancelBody) &&
    /players/.test(cancelBody) &&
    /dark/.test(cancelBody),
    '7. transaction не удаляет комнату, если друг уже подключился'
);

ok(
    /timeControlScreen/.test(cancelBody) &&
    /showScreen/.test(cancelBody),
    '8. успешная отмена возвращает именно к выбору времени'
);

console.log("\nИТОГ: " + passed + "/8, провалено: " + failed);
process.exit(failed ? 1 : 0);

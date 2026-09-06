// Реальный .mjs-файл (та же семантика, что и worker/index.mjs: ESM-контекст
// без package.json "type":"module" рядом). Выполняется КАК ОТДЕЛЬНЫЙ процесс
// (не eval, не require) через `node this-file.mjs`, печатает KEY=value строки,
// которые проверяет tests/worker-shared-engine-smoke.test.js.
try {
    await import("../../shared/game-engine.js");
    console.log("IMPORT_OK=true");
} catch (e) {
    console.log("IMPORT_OK=false");
    console.log("IMPORT_ERROR=" + e.message);
    process.exit(0);
}

console.log("ENGINE_TYPEOF=" + typeof globalThis.RussianCheckersEngine);
console.log("ATTEMPTMOVE_TYPEOF=" + typeof (globalThis.RussianCheckersEngine && globalThis.RussianCheckersEngine.attemptMove));

if (globalThis.RussianCheckersEngine && typeof globalThis.RussianCheckersEngine.createInitialPieces === "function") {
    const pieces = globalThis.RussianCheckersEngine.createInitialPieces();
    const keys = Object.keys(pieces);
    const light = keys.filter(function (k) { return pieces[k].color === "light"; }).length;
    const dark = keys.filter(function (k) { return pieces[k].color === "dark"; }).length;
    console.log("TOTAL_PIECES=" + keys.length);
    console.log("LIGHT_PIECES=" + light);
    console.log("DARK_PIECES=" + dark);
} else {
    console.log("TOTAL_PIECES=none");
}

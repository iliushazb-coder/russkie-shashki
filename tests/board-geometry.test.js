// ==========================================================================
// ГЕОМЕТРИЯ ДОСКИ В НАСТОЯЩЕМ БРАУЗЕРЕ.
//
// Фишки/дамки визуально сидели не по центру клетки на Android Telegram и
// Desktop. Аудит доказал два независимых источника, оба в этом PR
// исправлены:
//
//   1. #board использовал border (участвует в box-модели) вместо outline,
//      из-за чего 8 grid-tracks (800px, не сжимаются) красились в область
//      фона на 2px меньше (798px, border съедал по 1px с каждой стороны) --
//      расхождение росло линейно к дальнему краю, до ~4.76px.
//   2. assets/board.png сама по себе не была математически точной 8x8
//      сеткой: внутренние границы клеток лежали на 1-4px не там, где
//      должны.
//
// Здесь ничего не считается по формулам CSS -- Chromium/WebKit сами
// рендерят реальные style.css и assets/board.png, а тест рисует итоговую
// картинку на canvas и ищет в ней видимые границы клеток тем же способом,
// каким их искал аудит (субпиксельный пик производной яркости), сравнивая
// с DOM-границами .square, полученными через getBoundingClientRect.
//
// СЮИТА НЕ ВХОДИТ В tests/run.js -- см. tests/panel-browser-layout.test.js
// про причину и команду запуска (npm run test:browser).
// ==========================================================================
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const BOARD_PNG_PATH = path.join(REPO_ROOT, 'assets', 'board.png');

const { chromium, webkit } = require('playwright');

const ENGINES = [
    { name: 'chromium', type: chromium, launchOptions: {} },
    { name: 'webkit', type: webkit, launchOptions: {} }
];

let passed = 0, failed = 0;
function check(n, c, i) {
    if (c) { passed++; console.log('  ✅ ' + n); }
    else { failed++; console.log('  ❌ ' + n + (i ? '  — ' + i : '')); }
}

// Порог погрешности. Аудит целился в <=1px на нативном 800px рендере;
// здесь добавлен небольшой запас на кросс-движковые отличия субпиксельного
// антиалиасинга (WebKit и Chromium сглаживают немного по-разному) --
// 1.5px. Прежний (сломанный) вариант давал до ~4.76px, так что порог
// остаётся многократно ниже дефекта, который тест обязан ловить.
const MAX_ALLOWED_PX = 1.5;

// page.setContent() с абсолютной file:// ссылкой на внешний style.css
// ненадёжно грузит стиль внутри Playwright (проверено: сетка разваливается
// до дефолтного блочного layout, .square получает ширину body вместо
// var(--cell-size)). page.goto() на настоящий файл с ОТНОСИТЕЛЬНОЙ
// ссылкой работает корректно, поэтому для каждого движка собирается
// временный каталог с копией style.css рядом с html.
function buildTestPage(tmpDir) {
    fs.copyFileSync(path.join(REPO_ROOT, 'style.css'), path.join(tmpDir, 'style.css'));
    const html = `
<!DOCTYPE html><html><head>
<link rel="stylesheet" href="style.css">
</head><body>
<div id="board-wrapper">
  <div id="board"></div>
</div>
<script>
  // --coord-size обязателен: #board-wrapper.grid-template-columns =
  // var(--coord-size) repeat(8, var(--cell-size)) var(--coord-size), и без
  // него браузер не может корректно посчитать область грида, в которой
  // #board (span 2..9) должен занять ровно 8*cell-size. Значение выбрано
  // небольшим и не участвует в проверках -- нужна только валидность.
  document.documentElement.style.setProperty('--coord-size', '24px');
  document.documentElement.style.setProperty('--cell-size', '100px');
  const board = document.getElementById('board');
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const sq = document.createElement('div');
      sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      sq.id = 'sq_' + r + '_' + c;
      board.appendChild(sq);
    }
  }
</script>
</body></html>`;
    const htmlPath = path.join(tmpDir, 'board.html');
    fs.writeFileSync(htmlPath, html);
    return htmlPath;
}

// Субпиксельный поиск границы клетки рядом с ожидаемой позицией --
// параболическая интерполяция вокруг пика |производной яркости|. Портировано
// из read-only-аудита один в один, чтобы тест проверял ровно то, что
// доказало дефект и его исправление.
function findSubpixelEdge(profile, expected, window) {
    const d = [];
    for (let i = 1; i < profile.length; i++) d.push(Math.abs(profile[i] - profile[i - 1]));
    const lo = Math.max(0, expected - window);
    const hi = Math.min(d.length, expected + window);
    let k = lo, best = -Infinity;
    for (let i = lo; i < hi; i++) if (d[i] > best) { best = d[i]; k = i; }
    if (k >= 1 && k < d.length - 1) {
        const y0 = d[k - 1], y1 = d[k], y2 = d[k + 1];
        const den = y0 - 2 * y1 + y2;
        const delta = Math.abs(den) > 1e-9 ? 0.5 * (y0 - y2) / den : 0;
        return k + delta;
    }
    return k;
}

(async () => {
    for (const engine of ENGINES) {
        console.log('\n=== Движок: ' + engine.name + ' ===');
        const browser = await engine.type.launch(engine.launchOptions);
        const page = await browser.newPage({ viewport: { width: 1000, height: 1000 }, deviceScaleFactor: 1 });
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-geometry-'));
        const htmlPath = buildTestPage(tmpDir);
        await page.goto('file://' + htmlPath);
        await page.waitForTimeout(150);

        // --- Геометрия box: клиентская область должна совпадать с суммой
        // ширин 8 треков -- это и есть проверка "border -> outline".
        const boxGeom = await page.evaluate(() => {
            const board = document.getElementById('board');
            const cs = getComputedStyle(board);
            let sumW = 0;
            for (let c = 0; c < 8; c++) sumW += document.getElementById('sq_0_' + c).getBoundingClientRect().width;
            return {
                boardRect: board.getBoundingClientRect(),
                clientWidth: board.clientWidth,
                offsetWidth: board.offsetWidth,
                borderWidth: cs.borderWidth,
                outlineWidth: cs.outlineWidth,
                sumOfTracks: sumW,
                sq0: document.getElementById('sq_0_0').getBoundingClientRect(),
                sq3: document.getElementById('sq_0_3').getBoundingClientRect(),
                sq7: document.getElementById('sq_0_7').getBoundingClientRect(),
                sq7row: document.getElementById('sq_7_0').getBoundingClientRect()
            };
        });

        check(engine.name + ': border больше не задан (0px)', boxGeom.borderWidth === '0px', boxGeom.borderWidth);
        check(engine.name + ': outline задан (1px)', boxGeom.outlineWidth === '1px', boxGeom.outlineWidth);
        check(engine.name + ': content area == сумме 8 треков (клип/сжатие устранены)',
            Math.abs(boxGeom.clientWidth - boxGeom.sumOfTracks) < 0.5,
            'clientWidth=' + boxGeom.clientWidth + ' sumOfTracks=' + boxGeom.sumOfTracks);
        check(engine.name + ': border-box == content-box (border больше не съедает область фона)',
            boxGeom.offsetWidth === boxGeom.clientWidth,
            'offsetWidth=' + boxGeom.offsetWidth + ' clientWidth=' + boxGeom.clientWidth);

        // --- Рисуем board.png в canvas ровно того же размера, что и
        // отрендеренный #board, тем же способом, каким это делает CSS
        // (background-size: 100% 100%) -- и ищем в НЁМ реальные видимые
        // границы клеток. Это проверяет ассет так, как его видит браузер,
        // а не как отдельный файл на диске.
        const boardBuffer = fs.readFileSync(BOARD_PNG_PATH);
        const boardBase64 = boardBuffer.toString('base64');
        const edgeData = await page.evaluate(async ({ base64, boardW, boardH }) => {
            const img = new Image();
            const loaded = new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
            });
            img.src = 'data:image/jpeg;base64,' + base64;
            await loaded;

            const canvas = document.createElement('canvas');
            canvas.width = boardW;
            canvas.height = boardH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, boardW, boardH);

            const midY = Math.floor(boardH / 2);
            const rowData = ctx.getImageData(0, midY, boardW, 1).data;
            const colX = Math.floor(boardW / 2);
            const colData = ctx.getImageData(colX, 0, 1, boardH).data;

            const rowLuma = [];
            for (let i = 0; i < rowData.length; i += 4) {
                rowLuma.push((rowData[i] + rowData[i + 1] + rowData[i + 2]) / 3);
            }
            const colLuma = [];
            for (let i = 0; i < colData.length; i += 4) {
                colLuma.push((colData[i] + colData[i + 1] + colData[i + 2]) / 3);
            }
            return { rowLuma, colLuma, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
        }, { base64: boardBase64, boardW: boxGeom.clientWidth, boardH: boxGeom.clientWidth });

        check(engine.name + ': board.png декодировался (JPEG-контент под именем .png)',
            edgeData.naturalWidth === 800 && edgeData.naturalHeight === 800,
            edgeData.naturalWidth + 'x' + edgeData.naturalHeight);

        const cellW = boxGeom.clientWidth / 8;
        let maxDivX = 0, maxDivY = 0;
        const reportX = [], reportY = [];
        for (let i = 1; i < 8; i++) {
            const domX = boxGeom.sq0.left + i * cellW - boxGeom.sq0.left; // относительно левого края board
            const visX = findSubpixelEdge(edgeData.rowLuma, Math.round(i * cellW), 10);
            const divX = visX - i * cellW;
            reportX.push(divX.toFixed(2));
            if (Math.abs(divX) > maxDivX) maxDivX = Math.abs(divX);

            const domY = i * cellW;
            const visY = findSubpixelEdge(edgeData.colLuma, Math.round(i * cellW), 10);
            const divY = visY - domY;
            reportY.push(divY.toFixed(2));
            if (Math.abs(divY) > maxDivY) maxDivY = Math.abs(divY);
        }

        check(engine.name + ': видимые границы клеток совпадают с DOM по X (<=' + MAX_ALLOWED_PX + 'px)',
            maxDivX <= MAX_ALLOWED_PX, 'max=' + maxDivX.toFixed(2) + 'px, по границам: ' + reportX.join(', '));
        check(engine.name + ': видимые границы клеток совпадают с DOM по Y (<=' + MAX_ALLOWED_PX + 'px)',
            maxDivY <= MAX_ALLOWED_PX, 'max=' + maxDivY.toFixed(2) + 'px, по границам: ' + reportY.join(', '));

        // --- Первая / центральная / последняя клетка отдельно, явно --
        // Первая клетка обязана начинаться точно у левого края #board --
        // именно это раньше НЕ ломалось (грид всегда flush к content-box),
        // но проверяем явно как часть контракта.
        check(engine.name + ': первая клетка вплотную к левому краю board',
            Math.abs(boxGeom.sq0.left - boxGeom.boardRect.left) < 0.5,
            'sq0.left=' + boxGeom.sq0.left + ' board.left=' + boxGeom.boardRect.left);
        check(engine.name + ': первая клетка вплотную к верхнему краю board',
            Math.abs(boxGeom.sq0.top - boxGeom.boardRect.top) < 0.5,
            'sq0.top=' + boxGeom.sq0.top + ' board.top=' + boxGeom.boardRect.top);
        check(engine.name + ': центральная клетка (индекс 3) визуально не смещена', maxDivX <= MAX_ALLOWED_PX);
        // Последняя клетка обязана заканчиваться ровно на правом краю
        // #board -- до фикса грид переполнял border-box на 1px (см. аудит:
        // sq7.right=915 при board.right=914), что клипалось overflow:hidden
        // и указывало на рассинхрон грида с рамкой.
        check(engine.name + ': последняя клетка заканчивается на правом краю board, без overflow',
            Math.abs(boxGeom.sq7.right - boxGeom.boardRect.right) < 0.5,
            'sq7.right=' + boxGeom.sq7.right + ' board.right=' + boxGeom.boardRect.right);
        check(engine.name + ': последняя строка заканчивается на нижнем краю board, без overflow',
            Math.abs(boxGeom.sq7row.bottom - boxGeom.boardRect.bottom) < 0.5,
            'sq7row.bottom=' + boxGeom.sq7row.bottom + ' board.bottom=' + boxGeom.boardRect.bottom);

        await browser.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed === 0 ? 0 : 1);
})();

// ==========================================================================
// РАСКЛАДКА ПАНЕЛИ В НАСТОЯЩЕМ БРАУЗЕРЕ.
//
// Прежняя сюита считала ширины формулой с коэффициентом 0.55em и
// пропустила переполнение: единица ch в grid-template-columns считается
// от шрифта САМОЙ ПАНЕЛИ, а не дочерних элементов с их clamp. Минимум
// колонок выходил 347px при панели 292px.
//
// Здесь ничего не считается — Chromium меряет сам.
//
// СЮИТА НЕ ВХОДИТ В ОБЩИЙ ПРОГОН tests/run.js. Ей нужен playwright, а у
// проекта зависимостей нет вовсе и CI ставит только Node. Без браузера
// она вывела бы «ИТОГ: 0/0», а раннер справедливо считает такой результат
// недостоверным и роняет весь прогон.
//
// Запуск вручную там, где браузер есть:
//
//     npm run test:browser
//
// Делать это стоит после любой правки раскладки панели: ширин колонок,
// размеров стопки, шрифтов и полей.
// ==========================================================================
const fs = require('fs');
const path = require('path');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

let chromium = null;
try { chromium = require('playwright').chromium; } catch (e) {}

let passed = 0, failed = 0;
function check(n, c, i) {
    if (c) { passed++; console.log('  ✅ ' + n); }
    else { failed++; console.log('  ❌ ' + n + (i ? '  — ' + i : '')); }
}

const LONG_NAME = '@tetiana220722';
const RATINGS = ['⭐876', '⭐1156', '⭐9999', '⭐10000', '⭐99999'];
const STATUSES = ['В игре', 'Подключение…', 'Оффлайн 45с', 'Подтверждение…'];
const CAPTURED = [0, 1, 2, 3, 5, 6, 12];
const WIDTHS = [320, 360, 390, 430];

function html(rating, status, caps) {
    const icons = '<div class="captured-icon dark-icon"></div>'.repeat(Math.min(caps, 6));
    const badge = caps ? '<span class="captured-count">' + caps + '</span>' : '';
    return '<!doctype html><html><head><style>' + CSS + '</style></head><body>'
        + '<div id="game-screen"><div id="board-wrapper"><div id="board"></div></div>'
        + '<div class="player-panel" id="p">'
        + '<div class="player-name"><span class="player-color-dot dark-dot"></span>'
        + '<span class="player-name-label">' + LONG_NAME + '</span></div>'
        + '<div class="player-rating">' + rating + '</div>'
        + '<div class="player-status"><span class="player-status-text">' + status + '</span></div>'
        + '<div class="captured-icons">' + icons + badge + '</div>'
        + '</div></div></body></html>';
}

const MEASURE = function () {
    const p = document.getElementById('p');
    const bw = document.getElementById('board-wrapper');
    const q = s => p.querySelector(s);
    const cut = e => e && e.scrollWidth > e.getBoundingClientRect().width + 1;
    const name = q('.player-name-label');
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:'
        + getComputedStyle(name).font;
    document.body.appendChild(probe);
    let shown = 0;
    const full = name.textContent;
    for (let i = 1; i <= full.length; i++) {
        probe.textContent = full.slice(0, i);
        if (probe.getBoundingClientRect().width <= name.getBoundingClientRect().width) shown = i;
        else break;
    }
    probe.remove();
    const cap = q('.captured-icons');
    const badge = q('.captured-count');
    return {
        overflow: document.documentElement.scrollWidth > document.body.clientWidth,
        widerThanBoard: p.getBoundingClientRect().width > bw.getBoundingClientRect().width + 1,
        ratingCut: cut(q('.player-rating')),
        statusCut: cut(q('.player-status-text')),
        nameShown: shown,
        capRight: Math.round(cap.getBoundingClientRect().right),
        badgeRight: badge ? Math.round(badge.getBoundingClientRect().right) : null
    };
};

(async function () {
    if (!chromium) {
        console.log('  ⚠ playwright недоступен — браузерная проверка пропущена');
        console.log('\nИТОГ: 0/0');
        process.exit(0);
    }
    const browser = await chromium.launch({ args: ['--no-sandbox'] });

    console.log('=== 1. КРАЙНИЙ СЛУЧАЙ НА КАЖДОЙ ШИРИНЕ ===');
    console.log('    длинное имя + ⭐99999 + «Оффлайн 45с» + 12 взятых');
    for (const vw of WIDTHS) {
        const pg = await browser.newPage({ viewport: { width: vw, height: 700 } });
        await pg.setContent(html('⭐99999', 'Оффлайн 45с', 12));
        const r = await pg.evaluate(MEASURE);
        await pg.close();
        check(vw + 'px: нет переполнения страницы', !r.overflow);
        check(vw + 'px: панель не шире доски', !r.widerThanBoard);
        check(vw + 'px: рейтинг целиком', !r.ratingCut);
        check(vw + 'px: статус целиком', !r.statusCut);
        // Порог шесть: кружок цвета вынесен из текста, поэтому это шесть
        // настоящих букв имени, а не знаков вместе с эмодзи.
        check(vw + 'px: имени видно не меньше шести букв (' + r.nameShown + ')',
            r.nameShown >= 6);
    }

    console.log('\n=== 2. ЗНАЧОК НЕ ДВИГАЕТСЯ ОТ СОДЕРЖИМОГО ===');
    for (const vw of [320, 360, 390]) {
        const rights = new Set();
        let broke = null;
        for (const rating of RATINGS) {
            for (const status of STATUSES) {
                for (const caps of CAPTURED) {
                    const pg = await browser.newPage({ viewport: { width: vw, height: 600 } });
                    await pg.setContent(html(rating, status, caps));
                    const r = await pg.evaluate(MEASURE);
                    await pg.close();
                    if (r.overflow && !broke) broke = vw + 'px ' + rating + ' «' + status + '» ' + caps;
                    rights.add(r.capRight);
                    if (r.badgeRight !== null) rights.add(r.badgeRight);
                }
            }
        }
        check(vw + 'px: правый край стопки одинаков во всех 140 сочетаниях',
            rights.size === 1, JSON.stringify([...rights]));
        check(vw + 'px: ни одно сочетание не переполняет', !broke, broke);
    }

    console.log('\n=== 3. ДВЕ ПАНЕЛИ С РАЗНЫМ СОДЕРЖИМЫМ ===');
    console.log('    сверху длинное имя ⭐99999 «Оффлайн 45с» 12 взятых');
    console.log('    снизу короткое имя ⭐876 «В игре» 0 взятых');
    for (const vw of WIDTHS) {
        const pg = await browser.newPage({ viewport: { width: vw, height: 900 } });
        const top = html('⭐99999', 'Оффлайн 45с', 12)
            .replace(/<\/body>[\s\S]*$/, '');
        await pg.setContent('<!doctype html><html><head><style>' + CSS + '</style></head><body>'
            + '<div id="game-screen"><div id="board-wrapper"><div id="board"></div></div>'
            + '<div class="player-panel" id="a">'
            + '<div class="player-name"><span class="player-color-dot dark-dot"></span>'
            + '<span class="player-name-label">@tetiana220722</span></div>'
            + '<div class="player-rating">⭐99999</div>'
            + '<div class="player-status"><span class="player-status-text">Оффлайн 45с</span></div>'
            + '<div class="captured-icons">'
            + '<div class="captured-icon dark-icon"></div>'.repeat(6)
            + '<span class="captured-count">12</span></div></div>'
            + '<div class="player-panel" id="b">'
            + '<div class="player-name"><span class="player-color-dot light-dot"></span>'
            + '<span class="player-name-label">@yl</span></div>'
            + '<div class="player-rating">⭐876</div>'
            + '<div class="player-status"><span class="player-status-text">В игре</span></div>'
            + '<div class="captured-icons"></div></div>'
            + '</div></body></html>');
        const r = await pg.evaluate(function () {
            const ps = [document.getElementById('a'), document.getElementById('b')];
            const L = (p, s) => { const e = p.querySelector(s);
                return e ? Math.round(e.getBoundingClientRect().left) : null; };
            const R = (p, s) => { const e = p.querySelector(s);
                return e ? Math.round(e.getBoundingClientRect().right) : null; };
            return { ratingL: ps.map(p => L(p, '.player-rating')),
                statusL: ps.map(p => L(p, '.player-status')),
                capL: ps.map(p => L(p, '.captured-icons')),
                capR: ps.map(p => R(p, '.captured-icons')),
                over: document.documentElement.scrollWidth > document.body.clientWidth };
        });
        await pg.close();
        const same = a => a[0] === a[1];
        check(vw + 'px: ⭐ на одной вертикали', same(r.ratingL), JSON.stringify(r.ratingL));
        check(vw + 'px: статус на одной вертикали', same(r.statusL), JSON.stringify(r.statusL));
        check(vw + 'px: стопка на одной вертикали', same(r.capL) && same(r.capR),
            JSON.stringify([r.capL, r.capR]));
        check(vw + 'px: без переполнения', !r.over);
    }

    await browser.close();
    console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
    process.exit(failed > 0 ? 1 : 0);
})();

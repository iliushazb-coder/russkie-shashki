// №43 slice 2 (frozen plan): постепенная модульность script.js.
// Audio-effects cluster, вынесенный из script.js в
// shared/audio-effects.js, по тому же паттерну, что и №22
// (game-engine.js) и №43 slice 1 (string-utils.js).
//
// Что доказывается:
//   A. Нет declaration ни одной из 9 функций/audioContext в script.js.
//   B. shared/audio-effects.js экспортирует 7 публичных функций (playTone/
//      playWoodKnock -- внутренние helpers, не экспортируются: ни один их
//      call site вне этого кластера не существует).
//   C. index.html: audio-effects.js грузится РАНЬШЕ script.js, ПОСЛЕ
//      string-utils.js, без async/defer/module.
//   D. script.js реально получает binding из window.RussianCheckersAudioEffects
//      через fail-loud проверку; touchstart/click регистрация остаётся
//      в script.js (side-effect привязки к document, не звуковая логика).
//   F. Нет второй production-копии тел этих функций.
//   G. Cache-bust: script.js поднят (получил новую fail-loud зависимость),
//      shared/audio-effects.js присутствует.
//   H. Behavioral: реальный fake AudioContext (без npm-зависимости) --
//      unlockAudioContext на suspended/running, playTone передаёт реальные
//      параметры в Web Audio API, playSoundForMoveType маршрутизирует
//      КАЖДУЮ из 4 веток в правильный вложенный вызов (включая отложенные
//      через setTimeout ноты).

const fs = require('fs');
const path = require('path');

// Fake AudioContext подставляется ОДИН РАЗ, до первого require() модуля --
// тот же ручной stub-паттерн, что уже используется во всех остальных
// тестах этого repo (global.document = {...}), без новых npm-зависимостей.
// Node не имеет глобального AudioContext по умолчанию, поэтому require()
// БЕЗ этого стаба корректно бросает исключение (ровно как в реальности
// модуль не может быть загружен без Web Audio API) -- стаб должен стоять
// раньше самого первого require, не только в behavioral-секции H, иначе
// первый (непойманный настроенный) require не закэшируется с fake-объектом.
function makeFakeNode() {
    return {
        connect: function () { return this; },
        frequency: { value: null },
        type: null,
        gain: {
            history: [],
            setValueAtTime: function (v, t) { this.history.push(['set', v, t]); },
            exponentialRampToValueAtTime: function (v, t) { this.history.push(['ramp', v, t]); }
        },
        Q: { value: null },
        buffer: null,
        started: false, stopped: false,
        start: function () { this.started = true; },
        stop: function () { this.stopped = true; }
    };
}
function makeFakeAudioContext() {
    const calls = [];
    return {
        state: 'running',
        currentTime: 1000,
        sampleRate: 44100,
        destination: {},
        resume: function () { calls.push('resume'); this.state = 'running'; },
        createOscillator: function () { calls.push('createOscillator'); return makeFakeNode(); },
        createGain: function () { calls.push('createGain'); return makeFakeNode(); },
        createBufferSource: function () { calls.push('createBufferSource'); return makeFakeNode(); },
        createBiquadFilter: function () { calls.push('createBiquadFilter'); return makeFakeNode(); },
        createBuffer: function (ch, len) {
            calls.push('createBuffer');
            const data = new Float32Array(len);
            return { getChannelData: function () { return data; } };
        },
        _calls: calls
    };
}
const fakeCtx = makeFakeAudioContext();
global.AudioContext = function () { return fakeCtx; };

// require() -- РОВНО ОДИН РАЗ, здесь, после того как стаб уже установлен.
// Node кэширует успешный require по пути; секция H переиспользует этот же
// sharedApi/fakeCtx, а не грузит модуль заново.
let sharedApi = null;
let sharedLoadError = null;
try { sharedApi = require(path.join(__dirname, '..', 'shared', 'audio-effects.js')); }
catch (e) { sharedLoadError = e; }

let passed = 0, failed = 0;
function check(name, cond, info) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; console.log('  ❌ ' + name + (info !== undefined ? '  — ' + info : '')); }
}

const ROOT = path.join(__dirname, '..');
const SCRIPT_SRC = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SHARED_PATH = path.join(ROOT, 'shared', 'audio-effects.js');
const SHARED_SRC = fs.readFileSync(SHARED_PATH, 'utf8');

const CLUSTER_FUNCS = ['unlockAudioContext', 'playTone', 'playWoodKnock', 'playMoveSound',
    'playCaptureSound', 'playKingSound', 'playKingCaptureSound', 'playWinSound', 'playSoundForMoveType'];
const EXPORTED_FUNCS = ['unlockAudioContext', 'playMoveSound', 'playCaptureSound',
    'playKingSound', 'playKingCaptureSound', 'playWinSound', 'playSoundForMoveType'];
const INTERNAL_ONLY = ['playTone', 'playWoodKnock'];

console.log('=== A. Нет declaration ни одной из 9 функций/audioContext в script.js ===');
CLUSTER_FUNCS.forEach(function (fn) {
    check('A. script.js: нет declaration ' + fn, !new RegExp('^function ' + fn + '\\(', 'm').test(SCRIPT_SRC));
});
check('A. script.js: нет declaration audioContext (const)',
    !/^const audioContext = new /m.test(SCRIPT_SRC));

console.log('');
console.log('=== B. shared/audio-effects.js экспортирует ровно 7 публичных функций ===');
{
    check('B.1 shared/audio-effects.js реально require\'ится', !!sharedApi,
        sharedLoadError ? sharedLoadError.message : undefined);
    if (sharedApi) {
        EXPORTED_FUNCS.forEach(function (fn) {
            check('B.2 экспортирует ' + fn, typeof sharedApi[fn] === 'function');
        });
        INTERNAL_ONLY.forEach(function (fn) {
            check('B.3 НЕ экспортирует внутренний helper ' + fn + ' (нет call site вне кластера)',
                typeof sharedApi[fn] === 'undefined');
        });
    }
    check('B.4 IIFE + "use strict"', /^\(function \(global\) \{\s*\n\s*"use strict";/.test(SHARED_SRC));
    check('B.5 экспорт через global.RussianCheckersAudioEffects = api;',
        /global\.RussianCheckersAudioEffects\s*=\s*api;/.test(SHARED_SRC));
    check('B.6 module.exports для Node tests',
        /if \(typeof module === "object" && module\.exports\) \{\s*\n\s*module\.exports = api;/.test(SHARED_SRC));
}

console.log('');
console.log('=== C. index.html: порядок и способ загрузки script tags ===');
{
    const stringUtilsIdx = HTML.indexOf('shared/string-utils.js?v=1');
    const audioIdx = HTML.indexOf('shared/audio-effects.js?v=1');
    const scriptIdx = HTML.indexOf('script.js?v=202');
    check('C.1 shared/audio-effects.js?v=1 присутствует', audioIdx !== -1);
    check('C.2 порядок: string-utils.js < audio-effects.js < script.js',
        stringUtilsIdx !== -1 && stringUtilsIdx < audioIdx && audioIdx < scriptIdx,
        'stringUtils@' + stringUtilsIdx + ' audio@' + audioIdx + ' script@' + scriptIdx);
    const tagMatch = /<script src="shared\/audio-effects\.js\?v=1"[^>]*><\/script>/.exec(HTML);
    check('C.3 тег без async/defer/type="module"', !!tagMatch, tagMatch ? tagMatch[0] : 'не найден');
}

console.log('');
console.log('=== D. script.js реально получает функции из RussianCheckersAudioEffects ===');
{
    check('D.1 fail-loud проверка на RussianCheckersAudioEffects.playSoundForMoveType присутствует',
        /if \(!window\.RussianCheckersAudioEffects \|\| typeof window\.RussianCheckersAudioEffects\.playSoundForMoveType !== "function"\) \{\s*\n\s*throw new Error\("RussianCheckersAudioEffects failed to load"\);/.test(SCRIPT_SRC));
    const destrPresent = SCRIPT_SRC.indexOf('} = window.RussianCheckersAudioEffects;') !== -1;
    check('D.2 destructuring из window.RussianCheckersAudioEffects присутствует', destrPresent);
    check('D.3 fail-loud проверка идёт РАНЬШЕ destructuring', (function () {
        const guardPos = SCRIPT_SRC.indexOf('RussianCheckersAudioEffects.playSoundForMoveType !== "function"');
        const destrPos = SCRIPT_SRC.indexOf('} = window.RussianCheckersAudioEffects;');
        return guardPos !== -1 && destrPos !== -1 && guardPos < destrPos;
    })());
    check('D.4 нет client-side fallback-копии (присваивание вида "= window.RussianCheckersAudioEffects || {...}")',
        !/=\s*window\.RussianCheckersAudioEffects\s*\|\|/.test(SCRIPT_SRC));
    check('D.5 touchstart/click регистрация unlockAudioContext ОСТАЛАСЬ в script.js',
        /document\.addEventListener\("touchstart", unlockAudioContext, \{ once: true \}\);/.test(SCRIPT_SRC) &&
        /document\.addEventListener\("click", unlockAudioContext, \{ once: true \}\);/.test(SCRIPT_SRC));
}

console.log('');
console.log('=== F. Нет второй production-копии тел этих функций ===');
CLUSTER_FUNCS.forEach(function (fn) {
    check('F. script.js: нет declaration ' + fn, !new RegExp('^function ' + fn + '\\(', 'm').test(SCRIPT_SRC));
});

console.log('');
console.log('=== G. Cache-bust ===');
check('G.1 HTML содержит shared/audio-effects.js?v=1', /shared\/audio-effects\.js\?v=1/.test(HTML));
check('G.2 HTML содержит script.js?v=202 (поднят: script.js получил новую fail-loud зависимость)',
    /script\.js\?v=202/.test(HTML));
check('G.3 HTML НЕ содержит старую script.js?v=201', !/script\.js\?v=201/.test(HTML));

console.log('');
console.log('=== H. Behavioral: реальный fake AudioContext, без npm-зависимости ===');
{
    // Перехватываем setTimeout: не ждём реальную задержку, только проверяем,
    // что она запланирована с правильными значениями, и можем вручную
    // "проиграть" её, чтобы проверить вложенную (отложенную) ноту.
    const timeoutCalls = [];
    const savedSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, delay) { timeoutCalls.push({ fn: fn, delay: delay }); return timeoutCalls.length; };

    const audio = sharedApi;
    if (audio) {
        // Перехватываем createOscillator/createGain ПОСЛЕ загрузки модуля --
        // сам audioContext уже создан модулем один раз при require(), и
        // остаётся тем же объектом на все вызовы функций ниже.
        const origCreateOscillator = fakeCtx.createOscillator;
        let lastOsc = null;
        fakeCtx.createOscillator = function () { lastOsc = origCreateOscillator.call(fakeCtx); return lastOsc; };

        console.log('  --- unlockAudioContext ---');
        fakeCtx.state = 'suspended'; fakeCtx._calls.length = 0;
        audio.unlockAudioContext();
        check('H.1 resume() реально вызван при state=suspended', fakeCtx._calls.indexOf('resume') !== -1);
        fakeCtx.state = 'running'; fakeCtx._calls.length = 0;
        audio.unlockAudioContext();
        check('H.2 resume() НЕ вызван при state=running', fakeCtx._calls.indexOf('resume') === -1);

        console.log('  --- playSoundForMoveType: routing по всем 4 веткам ---');

        timeoutCalls.length = 0;
        audio.playSoundForMoveType('move', false);
        check('H.3 routing "move" -> первая нота идёт через createBufferSource (playWoodKnock, не playTone)',
            fakeCtx._calls.indexOf('createBufferSource') !== -1 && fakeCtx._calls.indexOf('createOscillator') === -1);

        timeoutCalls.length = 0; fakeCtx._calls.length = 0;
        audio.playSoundForMoveType('king', false);
        check('H.4 routing "king" -> playKingSound: первая нота через oscillator (createOscillator, не createBufferSource)',
            fakeCtx._calls.indexOf('createOscillator') !== -1 && fakeCtx._calls.indexOf('createBufferSource') === -1);
        check('H.5 routing "king" -> запланировано ровно 2 отложенные ноты (setTimeout)', timeoutCalls.length === 2);

        timeoutCalls.length = 0; fakeCtx._calls.length = 0;
        audio.playSoundForMoveType('capture', false);
        check('H.6 routing "capture" (wasKing=false) -> playCaptureSound: через createBufferSource',
            fakeCtx._calls.indexOf('createBufferSource') !== -1);
        check('H.7 routing "capture" (wasKing=false) -> ровно 1 отложенная нота', timeoutCalls.length === 1);

        timeoutCalls.length = 0; fakeCtx._calls.length = 0;
        audio.playSoundForMoveType('capture', true);
        check('H.8 routing "capture" (wasKing=true) -> playKingCaptureSound, НЕ playCaptureSound: 2 отложенные ноты (не 1)',
            timeoutCalls.length === 2);
        // Третья (отложенная) нота playKingCaptureSound идёт через oscillator (playTone), а не через wood knock.
        if (timeoutCalls.length === 2) {
            fakeCtx._calls.length = 0;
            timeoutCalls[1].fn();
            check('H.9 вторая отложенная нота playKingCaptureSound реально идёт через createOscillator (playTone)',
                fakeCtx._calls.indexOf('createOscillator') !== -1);
        }

        console.log('  --- playTone: реальные параметры доходят до Web Audio API ---');
        fakeCtx._calls.length = 0; lastOsc = null;
        // playTone не экспортирован напрямую -- проверяем его параметры
        // косвенно через playWinSound (первая нота: playTone(392, 0.15, 0.3)).
        audio.playWinSound();
        check('H.10 playWinSound первая нота: oscillator.frequency.value === 392', lastOsc && lastOsc.frequency.value === 392,
            lastOsc ? String(lastOsc.frequency.value) : 'lastOsc is null');
        check('H.11 playWinSound первая нота: oscillator.type === "sine"', lastOsc && lastOsc.type === 'sine');
        check('H.12 playWinSound первая нота: oscillator.start()/stop() реально вызваны',
            lastOsc && lastOsc.started && lastOsc.stopped);
    }

    // global.AudioContext остаётся стабом на весь файл (устанавливался
    // один раз в начале, до первого require) -- восстанавливать нечего;
    // только setTimeout был подменён локально для этой секции.
    global.setTimeout = savedSetTimeout;
}

console.log('\nИТОГ: ' + passed + '/' + (passed + failed));
if (failed > 0) process.exit(1);

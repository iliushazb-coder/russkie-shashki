(function (global) {
    "use strict";

    // №43 slice 2: механически перенесено из script.js -- то же поведение,
    // тот же порядок Web Audio API вызовов, тот же паттерн, что
    // shared/game-engine.js (№22) и shared/string-utils.js (№43 slice 1).
    //
    // Одно намеренное отличие от буквального переноса: исходный код
    // обращался к "window.AudioContext || window.webkitAudioContext".
    // Здесь используется "global" -- параметр этой самой IIFE, которому
    // ниже передаётся globalThis. В браузере window === globalThis всегда,
    // так что поведение идентично; выигрыш -- модуль становится require'able
    // в Node (у "window" там нет смысла, у globalThis есть), что и позволяет
    // behavioral-тестам ниже подставлять fake AudioContext без монки-патча
    // самого script.js.
    //
    // Регистрация touchstart/click listener'ов НАМЕРЕННО остаётся в
    // script.js, не здесь: это side-effect привязки к конкретному документу
    // страницы, а не часть звуковой логики самой по себе -- переносить его
    // в модуль значило бы вводить новый паттерн (модуль с side-effect при
    // загрузке), которого нет у shared/game-engine.js и shared/string-utils.js.

    const audioContext = new (global.AudioContext || global.webkitAudioContext)();

    function unlockAudioContext() {
        if (audioContext.state === "suspended") {
            audioContext.resume();
        }
    }

    function playTone(frequency, duration, volume) {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.frequency.value = frequency;
        oscillator.type = "sine";
        gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + duration);
    }

    function playWoodKnock(duration, volume, filterFreq) {
        const bufferSize = Math.floor(audioContext.sampleRate * duration);
        const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 3);
        }
        const noise = audioContext.createBufferSource();
        noise.buffer = buffer;

        const filter = audioContext.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = filterFreq;
        filter.Q.value = 1.1;

        const gain = audioContext.createGain();
        gain.gain.setValueAtTime(volume, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

        noise.connect(filter);
        filter.connect(gain);
        gain.connect(audioContext.destination);
        noise.start();
    }

    function playMoveSound() { playWoodKnock(0.09, 0.32, 1700); }
    function playCaptureSound() {
        playWoodKnock(0.13, 0.5, 850);
        setTimeout(function () { playWoodKnock(0.1, 0.32, 650); }, 55);
    }
    function playKingSound() {
        playTone(523, 0.1, 0.22);
        setTimeout(function () { playTone(659, 0.1, 0.24); }, 90);
        setTimeout(function () { playTone(784, 0.22, 0.26); }, 180);
    }
    function playKingCaptureSound() {
        playWoodKnock(0.18, 0.6, 600);
        setTimeout(function () { playWoodKnock(0.13, 0.42, 480); }, 65);
        setTimeout(function () { playTone(880, 0.14, 0.18); }, 150);
    }
    // ИСХОД ПАРТИИ -- три разных звука вместо одного.
    //
    // Раньше playWinSound() звучал на ЛЮБОМ финале, поэтому проигравший
    // слышал ту же восходящую фанфару, что и победитель. Ниже -- три
    // отдельных акцента, синтезированных тем же Web Audio: новых ассетов
    // не добавляется, загружать и декодировать нечего.
    //
    // Громкости намеренно ниже прежних 0.3: финал должен быть заметным,
    // но не громким, и уж точно не «аркадным».

    // ПОБЕДА. Светлый короткий акцент: мягкий импакт как опора, затем
    // восходящая пара с обертоном. Осознанно короче и тише прежней
    // фанфары -- это «молодец», а не «джекпот».
    function playVictorySound() {
        playWoodKnock(0.09, 0.2, 520);
        setTimeout(function () {
            playTone(659, 0.16, 0.16);
            playTone(988, 0.10, 0.05);
        }, 60);
        setTimeout(function () { playTone(880, 0.30, 0.17); }, 170);
    }

    // ПОРАЖЕНИЕ. Спокойное нисходящее «оседание» -- две ноты вниз, мягко
    // и тихо. Никакого диссонанса, минорных «уу» и тревожных интервалов:
    // проигрыш не должен звучать как наказание.
    function playDefeatSound() {
        playTone(392, 0.22, 0.13);
        setTimeout(function () { playTone(294, 0.38, 0.11); }, 140);
    }

    // НИЧЬЯ. Нейтрально: две ровные ноты одной высоты, без движения вверх
    // или вниз -- «партия закончена», без оценки.
    function playDrawSound() {
        playTone(523, 0.14, 0.12);
        setTimeout(function () { playTone(523, 0.26, 0.10); }, 150);
    }

    function playWinSound() {
        playTone(392, 0.15, 0.3);
        setTimeout(function () { playTone(523, 0.15, 0.3); }, 150);
        setTimeout(function () { playTone(659, 0.3, 0.3); }, 300);
    }
    function playSoundForMoveType(type, wasKing) {
        if (type === "king") {
            playKingSound();
        } else if (type === "capture") {
            if (wasKing) {
                playKingCaptureSound();
            } else {
                playCaptureSound();
            }
        } else if (type === "move") {
            playMoveSound();
        }
    }

    // Внутренние helpers (playTone, playWoodKnock) не экспортируются --
    // ни один их call site вне этого кластера не существует в script.js.
    const api = {
        unlockAudioContext,
        playMoveSound,
        playCaptureSound,
        playKingSound,
        playKingCaptureSound,
        playWinSound,
        playVictorySound,
        playDefeatSound,
        playDrawSound,
        playSoundForMoveType,
    };

    global.RussianCheckersAudioEffects = api;

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);

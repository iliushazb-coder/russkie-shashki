// Stage 6E: the board effects of the Russian game screen as a NEUTRAL module (no ruleset, no network, no game state, no rules).
// It only PAINTS what shared/board-transition.js says happened, with the CLASSES, the animations and the timings that style.css and script.js
// already define for the Russian board (.last-move, .move-ghost-piece, .move-ghost-captured, .king-promotion-*, .must-capture-hint, .last-move-capture-mark).
// The constants below are the Russian ones; tests/board-effects.test.js compares every one of them with script.js, so they cannot drift.
// A failure of any effect never touches the position: the real board is drawn by the caller before and stays correct without these overlays.
(function (global) {
    "use strict";

    // ---- the Russian constants (script.js) -----------------------------------------------------------------------------------------------
    const MOVE_GHOST_DURATION_MS = 150;
    const CAPTURE_EFFECT_DURATION_MS = 260;
    const KING_PROMOTION_DURATION_MS = 1000;
    const KING_PROMOTION_REVEAL_FRACTION = 0.725;
    const KING_SOUND_RESOLVE_OFFSET_MS = 420;
    const MUST_CAPTURE_HINT_DELAY_MS = 5000;
    const KING_PROMOTION_SOUND_DELAY_MS = Math.max(0, Math.round(
        MOVE_GHOST_DURATION_MS + KING_PROMOTION_DURATION_MS * KING_PROMOTION_REVEAL_FRACTION - KING_SOUND_RESOLVE_OFFSET_MS));

    const SVG_NS = "http://www.w3.org/2000/svg";

    // opts: doc, cell(row,col) -> square element | null, pieceIn(square) -> the real piece element | null, board() -> the board element | null,
    //       reduced() -> boolean (prefers-reduced-motion), setTimer / clearTimer / raf (optional)
    function create(opts) {
        const doc = opts.doc;
        const cell = opts.cell, pieceIn = opts.pieceIn, boardEl = opts.board;
        const reduced = typeof opts.reduced === "function" ? opts.reduced : function () { return false; };
        const setTimer = opts.setTimer || function (fn, ms) { return global.setTimeout(fn, ms); };
        const clearTimer = opts.clearTimer || function (id) { global.clearTimeout(id); };
        const raf = opts.raf || function (fn) { return (global.requestAnimationFrame || function (f) { return global.setTimeout(f, 16); })(fn); };

        let cancels = [];                    // every running overlay registers its own cleanup (like activeGhostCancelFns in script.js)
        function cancel() {
            const fns = cancels.slice();
            cancels = [];
            fns.forEach(function (fn) { try { fn(); } catch (_) { /* an effect must never break the board */ } });
        }
        function register(fn) { cancels.push(fn); }
        function unregister(fn) { cancels = cancels.filter(function (x) { return x !== fn; }); }

        // ---- the piece flies from its square to the new one; the taken piece fades; the new king turns ------------------------------------------
        function kingPromotion(toSquare, toKey, realPiece, colorClass) {
            const flip = doc.createElement("div");
            flip.className = "piece " + colorClass + " king-promotion-flip";
            const flipBack = doc.createElement("div");
            flipBack.className = "piece " + colorClass + " king-promotion-flip-back";
            const flipKing = doc.createElement("div");
            flipKing.className = "piece " + colorClass + " king-promotion-flip-king";
            const glow = doc.createElement("div");
            glow.className = "king-promotion-glow";
            [flip, flipBack, flipKing, glow].forEach(function (el) {
                el.style.setProperty("--king-promotion-delay", MOVE_GHOST_DURATION_MS + "ms");
                el.style.setProperty("--king-promotion-duration", KING_PROMOTION_DURATION_MS + "ms");
            });
            if (realPiece) realPiece.classList.add("piece-hidden-for-promotion");
            toSquare.appendChild(glow);
            toSquare.appendChild(flip);
            toSquare.appendChild(flipBack);
            toSquare.appendChild(flipKing);
            let done = false;
            function cleanup() {
                if (done) return;
                done = true;
                if (realPiece) realPiece.classList.remove("piece-hidden-for-promotion");
                [flip, flipBack, flipKing, glow].forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });
                unregister(cleanup);
            }
            flip.addEventListener("animationend", cleanup);
            setTimer(cleanup, MOVE_GHOST_DURATION_MS + KING_PROMOTION_DURATION_MS + 120);
            register(cleanup);
        }

        function play(t) {
            cancel();                         // a new move removes the overlays of the previous one (like script.js)
            if (!t || !t.ok || !t.move) return false;
            const m = t.move;
            const fromSq = cell(m.from.row, m.from.col), toSq = cell(m.to.row, m.to.col);
            const real = toSq ? pieceIn(toSq) : null;
            if (!fromSq || !toSq || !real) return false;   // the board is already right without the animation

            if (m.becameKing) kingPromotion(toSq, m.to.row + "_" + m.to.col, real, m.mover === "light" ? "piece-light" : "piece-dark");

            const wasKingBeforeThisHop = !!m.wasKing;
            const colorClass = m.mover === "light" ? "piece-light" : "piece-dark";
            const fromRect = fromSq.getBoundingClientRect(), toRect = toSq.getBoundingClientRect();
            real.classList.add("piece-hidden-for-ghost");
            const ghost = doc.createElement("div");
            ghost.className = "piece " + colorClass + " move-ghost-piece" + (wasKingBeforeThisHop ? " king" : "");
            ghost.style.transform = "translate(" + (fromRect.left - toRect.left) + "px, " + (fromRect.top - toRect.top) + "px)";
            toSq.appendChild(ghost);
            let cancelled = false;
            function cleanupGhost() {
                if (cancelled) return;
                cancelled = true;
                real.classList.remove("piece-hidden-for-ghost");
                if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
                unregister(cleanupGhost);
            }
            register(cleanupGhost);
            raf(function () {
                if (cancelled) return;
                ghost.style.transition = "transform " + MOVE_GHOST_DURATION_MS + "ms ease-out";
                ghost.style.transform = "translate(0px, 0px)";
            });
            ghost.addEventListener("transitionend", cleanupGhost);
            setTimer(cleanupGhost, MOVE_GHOST_DURATION_MS + 60);

            if (!reduced()) {
                m.captured.forEach(function (snap) {
                    const sq = cell(snap.row, snap.col);
                    if (!sq) return;
                    const wrap = doc.createElement("div");
                    wrap.className = "move-ghost-captured";
                    wrap.setAttribute("aria-hidden", "true");
                    wrap.style.setProperty("--capture-effect-duration", CAPTURE_EFFECT_DURATION_MS + "ms");
                    const piece = doc.createElement("div");
                    piece.className = "piece " + (snap.color === "light" ? "piece-light" : "piece-dark") + " move-ghost-captured-piece" + (snap.king ? " king" : "");
                    wrap.appendChild(piece);
                    sq.appendChild(wrap);
                    let capCancelled = false;
                    function cleanupCaptured() {
                        if (capCancelled) return;
                        capCancelled = true;
                        wrap.removeEventListener("animationend", onEnd);
                        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
                        unregister(cleanupCaptured);
                    }
                    function onEnd(event) {
                        if (event.target !== wrap || event.animationName !== "capturedGhostImpact") return;
                        cleanupCaptured();
                    }
                    register(cleanupCaptured);
                    wrap.addEventListener("animationend", onEnd);
                    setTimer(cleanupCaptured, CAPTURE_EFFECT_DURATION_MS + 60);
                });
            }
            return true;
        }

        // ---- the last move: the arrow along the path and the marks on the taken pieces (the Russian renderLastMoveArrow) --------------------------
        function drawLastMove(path, capturedSquares, ids) {
            const host = boardEl();
            if (!host) return false;
            const old = host.querySelector("svg[data-board-last-move]");
            if (old && old.parentNode) old.parentNode.removeChild(old);
            if (!Array.isArray(path) || path.length < 2) return false;
            const points = [];
            for (let i = 0; i < path.length; i++) {
                const sq = cell(path[i].row, path[i].col);
                if (!sq) return false;
                points.push({ x: sq.offsetLeft + sq.offsetWidth / 2, y: sq.offsetTop + sq.offsetHeight / 2 });
            }
            const svg = doc.createElementNS(SVG_NS, "svg");
            svg.setAttribute("id", ids.svg);
            svg.setAttribute("data-board-last-move", "1");
            svg.setAttribute("aria-hidden", "true");
            const defs = doc.createElementNS(SVG_NS, "defs");
            const filter = doc.createElementNS(SVG_NS, "filter");
            filter.setAttribute("id", ids.glow);
            filter.setAttribute("x", "-60%"); filter.setAttribute("y", "-60%");
            filter.setAttribute("width", "220%"); filter.setAttribute("height", "220%");
            const blur = doc.createElementNS(SVG_NS, "feGaussianBlur");
            blur.setAttribute("stdDeviation", "2.4"); blur.setAttribute("result", "blurred");
            const merge = doc.createElementNS(SVG_NS, "feMerge");
            const n1 = doc.createElementNS(SVG_NS, "feMergeNode"); n1.setAttribute("in", "blurred");
            const n2 = doc.createElementNS(SVG_NS, "feMergeNode"); n2.setAttribute("in", "SourceGraphic");
            merge.appendChild(n1); merge.appendChild(n2);
            filter.appendChild(blur); filter.appendChild(merge); defs.appendChild(filter); svg.appendChild(defs);
            for (let i = 0; i < points.length - 1; i++) {
                const line = doc.createElementNS(SVG_NS, "line");
                line.setAttribute("x1", points[i].x); line.setAttribute("y1", points[i].y);
                line.setAttribute("x2", points[i + 1].x); line.setAttribute("y2", points[i + 1].y);
                line.setAttribute("stroke", "rgba(178, 214, 128, 0.22)");
                line.setAttribute("stroke-width", "2.5");
                line.setAttribute("stroke-linecap", "round");
                line.setAttribute("filter", "url(#" + ids.glow + ")");
                svg.appendChild(line);
            }
            (capturedSquares || []).forEach(function (cap) {
                const sq = cell(cap.row, cap.col);
                if (!sq) return;
                const circle = doc.createElementNS(SVG_NS, "circle");
                circle.setAttribute("cx", sq.offsetLeft + sq.offsetWidth / 2);
                circle.setAttribute("cy", sq.offsetTop + sq.offsetHeight / 2);
                circle.setAttribute("r", Math.max(4, sq.offsetWidth * 0.08));
                circle.setAttribute("class", "last-move-capture-mark");
                circle.setAttribute("filter", "url(#" + ids.glow + ")");
                svg.appendChild(circle);
            });
            host.appendChild(svg);
            return true;
        }

        // ---- "you must capture": after MUST_CAPTURE_HINT_DELAY_MS of inactivity the pieces that can capture glow (class .must-capture-hint) ------------
        // sync() is called after EVERY redraw with a signature of the position + selection. A new signature restarts the 5 s; the same signature keeps
        // the running timer and, once shown, paints the glow again on the freshly drawn pieces (a redraw replaces the elements, not the situation).
        const hint = { sig: null, squares: [], shown: false, timer: null };
        function paintHint() {
            hint.squares.forEach(function (s) {
                const sq = cell(s.row, s.col), p = sq ? pieceIn(sq) : null;
                if (p) p.classList.add("must-capture-hint");
            });
        }
        function hintOff() {
            if (hint.timer !== null) { clearTimer(hint.timer); hint.timer = null; }
            hint.sig = null; hint.squares = []; hint.shown = false;
        }
        function hintSync(sig, squares) {
            if (!sig || !squares || !squares.length) { hintOff(); return; }
            if (hint.sig === sig) { if (hint.shown) paintHint(); return; }
            hintOff();
            hint.sig = sig; hint.squares = squares.slice();
            hint.timer = setTimer(function () {
                hint.timer = null;
                hint.shown = true;
                paintHint();
            }, MUST_CAPTURE_HINT_DELAY_MS);
        }

        function kingSoundDelayMs() { return reduced() ? 0 : KING_PROMOTION_SOUND_DELAY_MS; }

        return Object.freeze({ play, cancel, drawLastMove, hintSync, hintOff, kingSoundDelayMs, isHintShown: function () { return hint.shown; } });
    }

    const api = Object.freeze({
        create,
        MOVE_GHOST_DURATION_MS, CAPTURE_EFFECT_DURATION_MS, KING_PROMOTION_DURATION_MS, KING_PROMOTION_REVEAL_FRACTION,
        KING_SOUND_RESOLVE_OFFSET_MS, MUST_CAPTURE_HINT_DELAY_MS, KING_PROMOTION_SOUND_DELAY_MS
    });
    global.BoardEffects = api;
    if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);

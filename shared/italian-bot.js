/* Итальянский компьютерный соперник: оценка позиции, уровни и выбор хода
 * поверх общего поиска (shared/draughts-search.js). Русский бот не затрагивается.
 *
 * Уровни:
 *   easy   — случайный допустимый ход (результаты в статистику не идут — решение владельца);
 *   medium — поиск до 450 мс / глубины 6, из почти равных ходов (в пределах 12 сотых шашки)
 *            выбирается случайный: бот играет осмысленно, но не идеально;
 *   hard   — поиск до 2200 мс / глубины 16, лучший ход (при равенстве — случайный из равных).
 * Глубина не фиксирована: итеративное углубление идёт, пока хватает времени, поэтому на слабом
 * телефоне бот сам играет мельче, а на быстром — глубже.
 */
(function (global) {
  'use strict';

  var LEVELS = Object.freeze({
    easy: Object.freeze({ random: true }),
    medium: Object.freeze({ timeMs: 450, maxDepth: 6, qsDepth: 6, margin: 12 }),
    hard: Object.freeze({ timeMs: 2200, maxDepth: 16, qsDepth: 12, margin: 0 })
  });

  var MAN = 100;
  var KING = 300;

  // r+c нечётно — тёмные поля. Главная диагональ (r+c=7) — длинная диагональ дамы.
  function evaluate(state, perspective) {
    var pieces = state.pieces;
    var grid = new Array(64);
    var i, p;
    for (i = 0; i < 64; i++) grid[i] = 0;
    var lightMen = 0, darkMen = 0, lightKings = 0, darkKings = 0;
    for (i = 0; i < pieces.length; i++) {
      p = pieces[i];
      grid[p.row * 8 + p.col] = p.color === 'light' ? (p.king ? 3 : 1) : (p.king ? 4 : 2);
      if (p.color === 'light') { if (p.king) lightKings++; else lightMen++; }
      else { if (p.king) darkKings++; else darkMen++; }
    }
    var total = pieces.length;
    var score = 0;

    for (i = 0; i < pieces.length; i++) {
      p = pieces[i];
      var mine = p.color === perspective;
      var sign = mine ? 1 : -1;
      var v;
      var centerDist = Math.abs(p.row - 3.5) + Math.abs(p.col - 3.5); // 1..7
      if (p.king) {
        v = KING + (7 - centerDist) * 3;
        if (p.row + p.col === 7) v += 8; // длинная диагональ
      } else {
        var adv = p.color === 'light' ? (7 - p.row) : p.row; // 0..7
        v = MAN + adv * 4;
        if (adv === 6) v += 12; // один шаг до дамки
        if (adv === 0 && total > 14) v += 6; // защитник последней линии в дебюте/миттельшпиле
        if (centerDist <= 3) v += 4;
        // защищённость тылом: обе клетки позади заняты своими или краем
        var back = p.color === 'light' ? 1 : -1;
        var rr = p.row + back;
        if (rr >= 0 && rr < 8) {
          var own = p.color === 'light' ? 1 : 2;
          var a = p.col - 1 < 0 || grid[rr * 8 + p.col - 1] === own || grid[rr * 8 + p.col - 1] === own + 2;
          var b = p.col + 1 > 7 || grid[rr * 8 + p.col + 1] === own || grid[rr * 8 + p.col + 1] === own + 2;
          if (a && b) v += 3;
        }
      }
      score += sign * v;
    }

    // Эндшпиль: сторона с преимуществом сближает дамы с чужими шашками (иначе бот «гуляет»)
    if (total <= 10) {
      var myPow = perspective === 'light' ? lightMen + 3 * lightKings : darkMen + 3 * darkKings;
      var opPow = perspective === 'light' ? darkMen + 3 * darkKings : lightMen + 3 * lightKings;
      if (myPow !== opPow) {
        var leader = myPow > opPow ? perspective : (perspective === 'light' ? 'dark' : 'light');
        var closeness = 0;
        for (i = 0; i < pieces.length; i++) {
          var k = pieces[i];
          if (!k.king || k.color !== leader) continue;
          for (var j = 0; j < pieces.length; j++) {
            var o = pieces[j];
            if (o.color === leader) continue;
            closeness += 14 - (Math.abs(k.row - o.row) + Math.abs(k.col - o.col));
          }
        }
        score += (leader === perspective ? 1 : -1) * closeness;
      }
    }
    return score;
  }

  function positionKey(state) {
    var codes = [];
    var pieces = state.pieces;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      codes.push((p.row * 8 + p.col) * 4 + (p.color === 'light' ? 0 : 2) + (p.king ? 1 : 0));
    }
    codes.sort(function (a, b) { return a - b; });
    var key = codes.join(',') + (state.turn === 'light' ? 'L' : 'D');
    if (state.mustContinueFrom) key += 'c' + state.mustContinueFrom.row + state.mustContinueFrom.col;
    var pend = state.pendingRemovals;
    if (pend && pend.length) {
      key += 'x' + pend.map(function (q) { return q.row * 8 + q.col; }).sort().join('.');
    }
    return key;
  }

  /* options: { adapter, engine, now, rng } — adapter/engine нужны только для тестов с подменой */
  function createBot(options) {
    options = options || {};
    var adapter = options.adapter;
    if (!adapter) throw new Error('italian_bot_adapter_required');
    var engine = options.engine || adapter.engine;
    var step = engine && typeof engine.attemptMove === 'function'
      ? function (state, m) {
          var r = engine.attemptMove(state, m.fromRow, m.fromCol, m.toRow, m.toCol, state.turn);
          return r && r.ok ? r.state : null;
        }
      : undefined;
    var searcher = global.DraughtsSearch.create({
      adapter: adapter, step: step, evaluate: evaluate, positionKey: positionKey, now: options.now
    });
    var defaultRng = options.rng || Math.random;

    function chooseMove(state, color, level, opts) {
      opts = opts || {};
      var rng = opts.rng || defaultRng;
      var cfg = LEVELS[level];
      if (!cfg) throw new Error('unknown_ai_level:' + String(level));
      var moves = adapter.getLegalMoves(state, color);
      if (!moves.length) return null;
      if (cfg.random || moves.length === 1) {
        return moves[Math.floor(rng() * moves.length)];
      }
      var r = searcher.search(state, color, {
        timeMs: opts.timeMs || cfg.timeMs,
        maxDepth: opts.maxDepth || cfg.maxDepth,
        qsDepth: cfg.qsDepth,
        margin: cfg.margin,
        rng: rng
      });
      if (opts.report) opts.report(r);
      return r ? r.move : moves[0];
    }

    return {
      levels: ['easy', 'medium', 'hard'],
      chooseMove: chooseMove,
      lastSearchReset: function () { searcher.clear(); },
      evaluate: evaluate
    };
  }

  var api = Object.freeze({ LEVELS: LEVELS, evaluate: evaluate, positionKey: positionKey, createBot: createBot });
  global.ItalianBot = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

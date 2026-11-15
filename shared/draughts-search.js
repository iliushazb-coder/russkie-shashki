/* Общий поисковый механизм компьютерного соперника для шашечных модулей.
 *
 * НЕ используется русским ботом (он остаётся в script.js без изменений).
 * Подключается через shared/ruleset-modules.js; первый потребитель — итальянский бот.
 *
 * Возможности: итеративное углубление под бюджет времени, альфа-бета, продолжение взятий
 * (серия взятий одним ходом не расходует глубину) и поиск спокойной позиции (quiescence),
 * упорядочивание ходов (ход из таблицы, взятия, killer, history), таблица позиций,
 * случайный выбор среди почти равных ходов (для слабых уровней).
 *
 * Поиск не знает правил: всё правило-зависимое приходит из описания модуля
 *   adapter.getLegalMoves(state, color) -> [{fromRow,fromCol,toRow,toCol,capture}]
 *   step(state, move) -> новое состояние или null   (по умолчанию через adapter.attemptMove)
 *   evaluate(state, perspective, ply) -> число (чем больше, тем лучше для perspective)
 *   positionKey(state) -> строка (ключ таблицы позиций)
 * Состояние: state.turn, state.winner. Ход «завершён», если после него сменился state.turn;
 * шаг серии взятий turn не меняет.
 */
(function (global) {
  'use strict';

  var WIN = 100000;
  var INF = 1e9;
  var TT_LIMIT = 250000;
  var FLAG_EXACT = 0, FLAG_LOWER = 1, FLAG_UPPER = 2;

  function defaultNow() {
    return (global.performance && typeof global.performance.now === 'function')
      ? global.performance.now() : Date.now();
  }

  function moveIndex(m) {
    return (m.fromRow << 9) | (m.fromCol << 6) | (m.toRow << 3) | m.toCol;
  }

  function create(config) {
    if (!config || !config.adapter || typeof config.adapter.getLegalMoves !== 'function') {
      throw new Error('draughts_search_adapter_required');
    }
    if (typeof config.evaluate !== 'function') throw new Error('draughts_search_evaluate_required');
    if (typeof config.positionKey !== 'function') throw new Error('draughts_search_position_key_required');

    var adapter = config.adapter;
    var evaluate = config.evaluate;
    var positionKey = config.positionKey;
    var now = config.now || defaultNow;
    var step = config.step || function (state, m) {
      var r = adapter.attemptMove(state, m.fromRow, m.fromCol, m.toRow, m.toCol, state.turn);
      return r && r.ok ? r.state : null;
    };

    var tt = new Map();
    var history = new Int32Array(4096);

    function search(rootState, color, opts) {
      opts = opts || {};
      var timeMs = opts.timeMs > 0 ? opts.timeMs : 500;
      var maxDepth = opts.maxDepth > 0 ? opts.maxDepth : 6;
      var qsLimit = opts.qsDepth >= 0 ? opts.qsDepth : 6;
      var margin = opts.margin > 0 ? opts.margin : 0;
      var rng = opts.rng || Math.random;
      var started = now();
      var deadline = started + timeMs;
      var persp = color;
      var nodes = 0;
      var aborted = false;
      var checkTime = false;
      var killers = [];
      if (tt.size > TT_LIMIT) tt.clear();
      history.fill(0);

      var rootMoves = adapter.getLegalMoves(rootState, color);
      if (!rootMoves.length) return null;
      if (rootMoves.length === 1) {
        return { move: rootMoves[0], score: 0, depth: 0, nodes: 0, ms: 0, forced: true };
      }

      function orderMoves(moves, ttMove, ply) {
        var k = killers[ply] || null;
        var scored = new Array(moves.length);
        for (var i = 0; i < moves.length; i++) {
          var m = moves[i];
          var s = history[moveIndex(m)];
          if (m.capture) s += 10000;
          if (ttMove && m.fromRow === ttMove.fromRow && m.fromCol === ttMove.fromCol &&
              m.toRow === ttMove.toRow && m.toCol === ttMove.toCol) s += 1000000;
          if (k && ((k[0] && sameMove(k[0], m)) || (k[1] && sameMove(k[1], m)))) s += 5000;
          scored[i] = { m: m, s: s };
        }
        scored.sort(function (a, b) { return b.s - a.s; });
        for (var j = 0; j < scored.length; j++) moves[j] = scored[j].m;
        return moves;
      }

      function sameMove(a, b) {
        return a.fromRow === b.fromRow && a.fromCol === b.fromCol && a.toRow === b.toRow && a.toCol === b.toCol;
      }

      function terminal(state, ply) {
        if (state.winner === 'draw') return 0; // автоматическая ничья (например, итальянская): ровно 0
        // победитель известен: ближайшая победа лучше дальней
        return state.winner === persp ? (WIN - ply) : -(WIN - ply);
      }

      function ab(state, depth, alpha, beta, ply, qs) {
        nodes++;
        if (checkTime && (nodes & 127) === 0 && now() >= deadline) aborted = true;
        if (aborted) return 0;
        if (state.winner) return terminal(state, ply);

        var moves = adapter.getLegalMoves(state, state.turn);
        if (!moves.length) {
          // нет ходов у стороны, которая должна ходить — для неё это поражение
          return state.turn === persp ? -(WIN - ply) : (WIN - ply);
        }

        var inQs = depth <= 0;
        if (inQs) {
          var forced = false;
          for (var q = 0; q < moves.length; q++) if (moves[q].capture) { forced = true; break; }
          if (!forced || qs <= 0) return evaluate(state, persp, ply);
        }

        var maximizing = state.turn === persp;
        var alpha0 = alpha, beta0 = beta;
        var key = null, ttMove = null;
        if (!inQs) {
          key = positionKey(state) + '|' + persp;
          var e = tt.get(key);
          if (e) {
            ttMove = e.move;
            if (e.depth >= depth) {
              if (e.flag === FLAG_EXACT) return e.value;
              if (e.flag === FLAG_LOWER && e.value >= beta) return e.value;
              if (e.flag === FLAG_UPPER && e.value <= alpha) return e.value;
            }
          }
        }

        orderMoves(moves, ttMove, ply);
        var best = maximizing ? -INF : INF;
        var bestMove = null;

        for (var i = 0; i < moves.length; i++) {
          var m = moves[i];
          var child = step(state, m);
          if (!child) continue;
          var completed = child.turn !== state.turn;
          var value = ab(child, completed ? depth - 1 : depth, alpha, beta, ply + 1,
            inQs && completed ? qs - 1 : qs);
          if (aborted) return 0;
          if (maximizing) {
            if (value > best) { best = value; bestMove = m; }
            if (value > alpha) alpha = value;
          } else {
            if (value < best) { best = value; bestMove = m; }
            if (value < beta) beta = value;
          }
          if (beta <= alpha) {
            if (!m.capture) {
              var kk = killers[ply] || (killers[ply] = [null, null]);
              if (!kk[0] || !sameMove(kk[0], m)) { kk[1] = kk[0]; kk[0] = m; }
              history[moveIndex(m)] += depth * depth;
            }
            break;
          }
        }

        if (best === INF || best === -INF) return evaluate(state, persp, ply);

        if (key && Math.abs(best) < WIN - 1000) {
          var flag = FLAG_EXACT;
          if (best <= alpha0) flag = FLAG_UPPER;
          else if (best >= beta0) flag = FLAG_LOWER;
          var old = tt.get(key);
          if (!old || old.depth <= depth) tt.set(key, { depth: depth, value: best, flag: flag, move: bestMove });
        }
        return best;
      }

      // --- корень: итеративное углубление ---
      var scores = new Array(rootMoves.length);
      var order = rootMoves.slice();
      var result = null;
      var lastIterMs = 0;

      for (var depth = 1; depth <= maxDepth; depth++) {
        var iterStart = now();
        if (depth > 1) {
          var elapsed = iterStart - started;
          // следующая итерация обычно в 2–4 раза дороже предыдущей: не начинаем, если не успеть
          if (elapsed + lastIterMs * 1.5 > timeMs) break;
          checkTime = true;
        }
        var bestScore = -INF;
        var iterScores = [];
        var failed = false;
        for (var i = 0; i < order.length; i++) {
          var m = order[i];
          var child = step(rootState, m);
          if (!child) continue;
          var completed = child.turn !== rootState.turn;
          var alpha = bestScore === -INF ? -INF : bestScore - margin - 1;
          var v = ab(child, completed ? depth - 1 : depth, alpha, INF, 1, qsLimit);
          if (aborted) { failed = true; break; }
          iterScores.push({ m: m, v: v, exact: bestScore === -INF || v > alpha });
          if (v > bestScore) bestScore = v;
        }
        if (failed) break;
        iterScores.sort(function (a, b) { return b.v - a.v; });
        result = { depth: depth, bestScore: bestScore, list: iterScores };
        order = iterScores.map(function (x) { return x.m; });
        lastIterMs = now() - iterStart;
        if (Math.abs(bestScore) > WIN - 200) break; // найдена форсированная победа/поражение
      }

      if (!result) {
        // даже глубина 1 не завершилась (нереально, но на всякий случай) — первый ход
        return { move: rootMoves[0], score: 0, depth: 0, nodes: nodes, ms: now() - started };
      }

      var pool = result.list.filter(function (x) {
        return x.exact && x.v >= result.bestScore - margin;
      });
      if (!pool.length) pool = [result.list[0]];
      var pick = pool[Math.floor(rng() * pool.length)] || pool[0];
      return {
        move: pick.m, score: pick.v, depth: result.depth,
        nodes: nodes, ms: Math.round(now() - started), forced: false
      };
    }

    return {
      search: search,
      clear: function () { tt.clear(); },
      ttSize: function () { return tt.size; }
    };
  }

  var api = Object.freeze({ create: create, WIN: WIN });
  global.DraughtsSearch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

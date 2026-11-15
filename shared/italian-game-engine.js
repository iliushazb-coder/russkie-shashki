(function (global) {
  'use strict';

  const DIRS = [[-1,-1],[-1,1],[1,-1],[1,1]];
  const forward = color => color === 'light' ? -1 : 1;
  const other = color => color === 'light' ? 'dark' : 'light';
  const inside = (r,c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const key = (r,c) => r + ',' + c;
  const clone = value => JSON.parse(JSON.stringify(value));

  function createInitialPieces() {
    const pieces = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 8; col++) if ((row + col) % 2 === 1) {
        pieces.push({ row, col, color: 'dark', king: false });
      }
    }
    for (let row = 5; row < 8; row++) {
      for (let col = 0; col < 8; col++) if ((row + col) % 2 === 1) {
        pieces.push({ row, col, color: 'light', king: false });
      }
    }
    return pieces;
  }

  function pieceAt(pieces, row, col) {
    return pieces.find(p => p.row === row && p.col === col) || null;
  }

  function occupied(pieces, pending, row, col) {
    return !!pieceAt(pieces, row, col) || pending.some(p => p.row === row && p.col === col);
  }

  function immediateCaptures(pieces, pending, piece) {
    const dirs = piece.king ? DIRS : [[forward(piece.color),-1],[forward(piece.color),1]];
    const out = [];
    for (const [dr,dc] of dirs) {
      const mr = piece.row + dr, mc = piece.col + dc;
      const lr = piece.row + 2*dr, lc = piece.col + 2*dc;
      if (!inside(lr,lc)) continue;
      const victim = pieceAt(pieces, mr, mc);
      if (!victim || victim.color === piece.color) continue;
      if (!piece.king && victim.king) continue;
      if (occupied(pieces, pending, lr, lc)) continue;
      out.push({ toRow:lr, toCol:lc, victim });
    }
    return out;
  }

  function captureLines(pieces, pending, piece) {
    const jumps = immediateCaptures(pieces, pending, piece);
    if (!jumps.length) return [{ jumps:[], capturedKings:0, kingPattern:[] }];
    const lines = [];
    for (const jump of jumps) {
      const nextPieces = pieces
        .filter(p => !(p.row === piece.row && p.col === piece.col))
        .filter(p => !(p.row === jump.victim.row && p.col === jump.victim.col));
      const moved = { ...piece, row:jump.toRow, col:jump.toCol };
      nextPieces.push(moved);
      const nextPending = pending.concat([{ ...jump.victim }]);
      const tails = captureLines(nextPieces, nextPending, moved);
      for (const tail of tails) {
        lines.push({
          jumps:[jump].concat(tail.jumps),
          capturedKings:(jump.victim.king ? 1 : 0) + tail.capturedKings,
          kingPattern:[jump.victim.king ? 1 : 0].concat(tail.kingPattern)
        });
      }
    }
    return lines;
  }

  function compareKingPattern(a,b) {
    const n = Math.max(a.length,b.length);
    for (let i=0;i<n;i++) {
      const av=a[i]||0, bv=b[i]||0;
      if (av !== bv) return av-bv;
    }
    return 0;
  }

  function bestCaptureChoices(state, color, onlyFrom) {
    const pending = state.pendingRemovals || [];
    let candidates = state.pieces.filter(p => p.color === color);
    if (onlyFrom) candidates = candidates.filter(p => p.row === onlyFrom.row && p.col === onlyFrom.col);
    const choices = [];
    for (const p of candidates) {
      for (const line of captureLines(state.pieces, pending, p)) {
        if (!line.jumps.length) continue;
        choices.push({ piece:p, line, count:line.jumps.length });
      }
    }
    if (!choices.length) return [];
    let bestCount = Math.max(...choices.map(c => c.count));
    let best = choices.filter(c => c.count === bestCount);
    if (best.some(c => c.piece.king)) best = best.filter(c => c.piece.king);
    if (best.every(c => c.piece.king)) {
      const maxKings = Math.max(...best.map(c => c.line.capturedKings));
      best = best.filter(c => c.line.capturedKings === maxKings);
      if (best.length > 1) {
        let winnerPattern = best[0].line.kingPattern;
        for (const c of best.slice(1)) if (compareKingPattern(c.line.kingPattern,winnerPattern) > 0) winnerPattern = c.line.kingPattern;
        best = best.filter(c => compareKingPattern(c.line.kingPattern,winnerPattern) === 0);
      }
    }
    return best;
  }

  function hasMandatoryCapture(state, color) {
    return bestCaptureChoices(state, color, state.mustContinueFrom || null).length > 0;
  }

  function hasAnyLegalMove(state, color) {
    if (hasMandatoryCapture(state,color)) return true;
    return state.pieces.some(p => {
      if (p.color !== color) return false;
      const dirs = p.king ? DIRS : [[forward(color),-1],[forward(color),1]];
      return dirs.some(([dr,dc]) => inside(p.row+dr,p.col+dc) && !occupied(state.pieces,state.pendingRemovals||[],p.row+dr,p.col+dc));
    });
  }

  function getLegalMoves(state, color) {
    if (!state || state.winner || state.turn !== color) return [];

    const pending = state.pendingRemovals || [];
    const best = bestCaptureChoices(state, color, state.mustContinueFrom || null);

    if (best.length) {
      const seen = new Set();
      const moves = [];
      for (const choice of best) {
        const jump = choice.line.jumps[0];
        const moveKey = choice.piece.row + ',' + choice.piece.col + '>' + jump.toRow + ',' + jump.toCol;
        if (seen.has(moveKey)) continue;
        seen.add(moveKey);
        moves.push({
          fromRow: choice.piece.row,
          fromCol: choice.piece.col,
          toRow: jump.toRow,
          toCol: jump.toCol,
          capture: true
        });
      }
      return moves;
    }

    const moves = [];
    for (const p of state.pieces) {
      if (p.color !== color) continue;
      if (state.mustContinueFrom &&
          (p.row !== state.mustContinueFrom.row || p.col !== state.mustContinueFrom.col)) continue;

      const dirs = p.king ? DIRS : [[forward(color),-1],[forward(color),1]];
      for (const [dr,dc] of dirs) {
        const toRow = p.row + dr;
        const toCol = p.col + dc;
        if (!inside(toRow,toCol) || occupied(state.pieces,pending,toRow,toCol)) continue;
        moves.push({
          fromRow: p.row,
          fromCol: p.col,
          toRow,
          toCol,
          capture: false
        });
      }
    }
    return moves;
  }

  // РЕШЕНИЕ ВЛАДЕЛЬЦА 14.11.2026 (B2R31): оба правила ниже -- осознанные ПРАВИЛА ПРИЛОЖЕНИЯ для онлайна; 40 ходов -- адаптация процедуры FID (у FID это ничья по требованию), не официальное требование FID. Кнопок требования нет.
  // ---- АВТОМАТИЧЕСКИЕ НИЧЬИ dama italiana (правила: docs/PROJECT_PASSPORT_CHECKERS.md, раздел 13.10) ----
  // 1) 'repetition': одна и та же позиция (расстановка + чей ход) в третий раз за партию (не обязательно подряд).
  // 2) 'forty_moves': 40 ходов каждой стороны (80 полуходов) подряд ТОЛЬКО ходами дамок, без взятия и без хода простой шашки.
  // Ход простой шашки или взятие необратимы: счётчик и история позиций обнуляются (раньше этого момента позиция повториться не может).
  // Победа по «нет ходов» сильнее ничьей. Состояние: state.drawPlies (число) и state.positionHistory (ключи позиций с обнуления).
  const DRAW_REPETITIONS = 3;
  const DRAW_PLIES_LIMIT = 80;
  function positionKey(pieces, turn) {
    const cell = Array(32).fill('e');
    for (const p of pieces) {
      if ((p.row + p.col) % 2 !== 1) continue; // тёмные поля: row+col нечётно (как у всех шашек этой реализации)
      cell[p.row * 4 + (p.col >> 1)] = p.color === 'light' ? (p.king ? 'L' : 'l') : (p.king ? 'D' : 'd');
    }
    return cell.join('') + (turn === 'light' ? 'l' : 'd');
  }
  function applyAutomaticDraw(state, keyBefore, irreversible) {
    const key = positionKey(state.pieces, state.turn);
    if (irreversible) {
      state.drawPlies = 0;
      state.positionHistory = [key];
      return;
    }
    const prev = Array.isArray(state.positionHistory) && state.positionHistory.length ? state.positionHistory : [keyBefore];
    const history = prev.concat([key]);
    state.positionHistory = history;
    state.drawPlies = (Number.isInteger(state.drawPlies) ? state.drawPlies : 0) + 1;
    if (history.filter(k => k === key).length >= DRAW_REPETITIONS) { state.winner = 'draw'; state.winReason = 'repetition'; }
    else if (state.drawPlies >= DRAW_PLIES_LIMIT) { state.winner = 'draw'; state.winReason = 'forty_moves'; }
  }
  function attemptMove(input, fromRow, fromCol, toRow, toCol, color) {
    const state = clone(input);
    if (state.winner) return { ok:false, error:'game_over', state };
    const keyBefore = positionKey(state.pieces, state.turn);
    if (state.turn !== color) return { ok:false, error:'not_your_turn', state };
    const p = pieceAt(state.pieces,fromRow,fromCol);
    if (!p || p.color !== color) return { ok:false, error:'invalid_piece', state };
    if (state.mustContinueFrom && (fromRow !== state.mustContinueFrom.row || fromCol !== state.mustContinueFrom.col)) {
      return { ok:false, error:'must_continue', state };
    }

    const pending = state.pendingRemovals || [];
    const best = bestCaptureChoices(state,color,state.mustContinueFrom || null);
    if (best.length) {
      const allowed = best.filter(c => c.piece.row === fromRow && c.piece.col === fromCol && c.line.jumps[0].toRow === toRow && c.line.jumps[0].toCol === toCol);
      if (!allowed.length) return { ok:false, error:'capture_priority', state };
      const jump = allowed[0].line.jumps[0];
      const victimIndex = state.pieces.findIndex(x => x.row === jump.victim.row && x.col === jump.victim.col);
      const movingIndex = state.pieces.findIndex(x => x.row === fromRow && x.col === fromCol);
      const victim = state.pieces[victimIndex];
      state.pieces.splice(victimIndex,1);
      const adjustedMovingIndex = state.pieces.findIndex(x => x.row === fromRow && x.col === fromCol && x.color === color);
      const moving = state.pieces[adjustedMovingIndex];
      moving.row=toRow; moving.col=toCol;
      state.pendingRemovals = pending.concat([{ ...victim }]);
      if (victim.color === 'dark') state.capturedDark = (state.capturedDark||0)+1;
      else state.capturedLight = (state.capturedLight||0)+1;

      const continuation = bestCaptureChoices(state,color,{row:toRow,col:toCol});
      if (continuation.length) {
        state.mustContinueFrom={row:toRow,col:toCol};
        return { ok:true, capture:true, state };
      }

      if (!moving.king && ((moving.color === 'light' && moving.row === 0) || (moving.color === 'dark' && moving.row === 7))) moving.king=true;
      state.pendingRemovals=[];
      state.mustContinueFrom=null;
      state.turn=other(color);
      state.moveCount=(state.moveCount||0)+1;
      if (!state.pieces.some(x => x.color === state.turn) || !hasAnyLegalMove(state,state.turn)) {
        state.winner=color; state.winReason='no_legal_moves';
      } else applyAutomaticDraw(state, keyBefore, true);
      return { ok:true, capture:true, state };
    }

    if (Math.abs(toRow-fromRow)!==1 || Math.abs(toCol-fromCol)!==1 || !inside(toRow,toCol) || occupied(state.pieces,pending,toRow,toCol)) {
      return { ok:false, error:'illegal_move', state };
    }
    if (!p.king && toRow-fromRow !== forward(color)) return { ok:false, error:'illegal_move', state };
    const moving = state.pieces.find(x => x.row===fromRow && x.col===fromCol);
    moving.row=toRow; moving.col=toCol;
    if (!moving.king && ((color==='light' && toRow===0)||(color==='dark' && toRow===7))) moving.king=true;
    state.turn=other(color);
    state.moveCount=(state.moveCount||0)+1;
    if (!state.pieces.some(x => x.color===state.turn) || !hasAnyLegalMove(state,state.turn)) {
      state.winner=color; state.winReason='no_legal_moves';
    } else applyAutomaticDraw(state, keyBefore, !p.king);
    return { ok:true, capture:false, state };
  }

  const api = Object.freeze({
    createInitialPieces,
    pieceAt,
    hasMandatoryCapture,
    hasAnyLegalMove,
    getLegalMoves,
    attemptMove,
    positionKey
  });

  global.ItalianCheckersEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);

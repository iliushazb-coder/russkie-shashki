(function (global) {
    "use strict";

    if (!global.RussianCheckersEngine) {
        throw new Error("RussianCheckersEngine must load before LocalRulesetAdapter");
    }
    if (!global.ItalianCheckersEngine) {
        throw new Error("ItalianCheckersEngine must load before LocalRulesetAdapter");
    }

    function baseState(pieces) {
        return {
            pieces: pieces,
            turn: "light",
            mustContinueFrom: null,
            pendingRemovals: [],
            capturedDark: 0,
            capturedLight: 0,
            moveCount: 0,
            winner: null,
            winReason: null
        };
    }

    function failedMoveResult() {
        return { ok: false, state: null, transition: null };
    }

    function capturedSquaresBetween(beforePieces, afterPieces, movingColor) {
        const afterKeys = Object.create(null);
        afterPieces.forEach(function (piece) {
            afterKeys[piece.row + "_" + piece.col + "_" + piece.color] = true;
        });

        return beforePieces.filter(function (piece) {
            return piece.color !== movingColor &&
                !afterKeys[piece.row + "_" + piece.col + "_" + piece.color];
        }).map(function (piece) {
            return { row: piece.row, col: piece.col };
        }).sort(function (a, b) {
            return (a.row - b.row) || (a.col - b.col);
        });
    }

    function buildTransition(beforePieces, afterPieces, fromRow, fromCol, toRow, toCol, color, chainContinues) {
        const beforeMoving = beforePieces.find(function (piece) {
            return piece.row === fromRow && piece.col === fromCol && piece.color === color;
        }) || null;
        const afterMoving = afterPieces.find(function (piece) {
            return piece.row === toRow && piece.col === toCol && piece.color === color;
        }) || null;
        const capturedSquares = capturedSquaresBetween(beforePieces, afterPieces, color);

        return {
            from: { row: fromRow, col: fromCol },
            to: { row: toRow, col: toCol },
            capture: capturedSquares.length > 0,
            capturedSquares: capturedSquares,
            promoted: !!(beforeMoving && !beforeMoving.king && afterMoving && afterMoving.king),
            chainContinues: !!chainContinues
        };
    }
    const adapters = Object.freeze({
        russian: Object.freeze({
            id: "russian",
            engine: global.RussianCheckersEngine,
            createInitialState: function () {
                return baseState(global.RussianCheckersEngine.createInitialPieces());
            },
            pieceAt: function (state, row, col) {
                if (!state || !state.pieces) return null;
                const piece = state.pieces[row + "_" + col];
                if (!piece) return null;
                return { row: row, col: col, color: piece.color, king: !!piece.king };
            },
            listPieces: function (state) {
                if (!state || !state.pieces) return [];
                return Object.keys(state.pieces).map(function (key) {
                    const parts = key.split("_");
                    const row = parseInt(parts[0], 10);
                    const col = parseInt(parts[1], 10);
                    const piece = state.pieces[key];
                    return { row: row, col: col, color: piece.color, king: !!piece.king };
                }).sort(function (a, b) {
                    return (a.row - b.row) || (a.col - b.col);
                });
            },
            attemptMove: function (state, fromRow, fromCol, toRow, toCol, color) {
                const beforePieces = this.listPieces(state);
                const next = global.RussianCheckersEngine.attemptMove(
                    state, fromRow, fromCol, toRow, toCol, color
                );
                if (!next) return failedMoveResult();

                const afterPieces = this.listPieces(next);
                return {
                    ok: true,
                    state: next,
                    transition: buildTransition(
                        beforePieces, afterPieces,
                        fromRow, fromCol, toRow, toCol, color,
                        next.mustContinueFrom !== null
                    )
                };
            },
            getLegalMoves: function (state, color) {
                if (!state || state.winner || state.turn !== color) return [];

                const moves = [];
                const only = state.mustContinueFrom || null;

                for (const key in state.pieces) {
                    const piece = state.pieces[key];
                    if (!piece || piece.color !== color) continue;

                    const parts = key.split("_");
                    const fromRow = parseInt(parts[0], 10);
                    const fromCol = parseInt(parts[1], 10);

                    if (only && (only.row !== fromRow || only.col !== fromCol)) continue;

                    for (let toRow = 0; toRow < 8; toRow++) {
                        for (let toCol = 0; toCol < 8; toCol++) {
                            const next = global.RussianCheckersEngine.attemptMove(
                                state, fromRow, fromCol, toRow, toCol, color
                            );
                            if (!next) continue;

                            moves.push({
                                fromRow: fromRow,
                                fromCol: fromCol,
                                toRow: toRow,
                                toCol: toCol,
                                capture: Array.isArray(next.lastCapturedSquares) &&
                                    next.lastCapturedSquares.length > 0
                            });
                        }
                    }
                }

                return moves;
            }
        }),

        italian: Object.freeze({
            id: "italian",
            engine: global.ItalianCheckersEngine,
            createInitialState: function () {
                return baseState(global.ItalianCheckersEngine.createInitialPieces());
            },
            pieceAt: function (state, row, col) {
                if (!state || !state.pieces) return null;
                const piece = global.ItalianCheckersEngine.pieceAt(state.pieces, row, col);
                if (!piece) return null;
                return { row: row, col: col, color: piece.color, king: !!piece.king };
            },
            listPieces: function (state) {
                if (!state || !Array.isArray(state.pieces)) return [];
                return state.pieces.map(function (piece) {
                    return {
                        row: piece.row,
                        col: piece.col,
                        color: piece.color,
                        king: !!piece.king
                    };
                }).sort(function (a, b) {
                    return (a.row - b.row) || (a.col - b.col);
                });
            },
            attemptMove: function (state, fromRow, fromCol, toRow, toCol, color) {
                const beforePieces = this.listPieces(state);
                const result = global.ItalianCheckersEngine.attemptMove(
                    state, fromRow, fromCol, toRow, toCol, color
                );
                if (!result || !result.ok) return failedMoveResult();

                const afterPieces = this.listPieces(result.state);
                return {
                    ok: true,
                    state: result.state,
                    transition: buildTransition(
                        beforePieces, afterPieces,
                        fromRow, fromCol, toRow, toCol, color,
                        result.state.mustContinueFrom !== null
                    )
                };
            },
            getLegalMoves: function (state, color) {
                return global.ItalianCheckersEngine.getLegalMoves(state, color);
            }
        })
    });

    function has(id) {
        return typeof id === "string" && !!adapters[id];
    }

    function get(id) {
        if (!has(id)) {
            throw new Error("unknown_local_ruleset:" + String(id));
        }
        return adapters[id];
    }

    global.LocalRulesetAdapter = Object.freeze({
        has: has,
        get: get
    });
})(typeof window !== "undefined" ? window : globalThis);

(function (global) {
    "use strict";

    // Механически перенесено из script.js (№22, base 15264d1c...) без
    // логических изменений: те же условия, тот же порядок, та же
    // cloning/return-семантика. Единый implementation source для client
    // и Worker.

    function createInitialPieces() {
        const pieces = {};
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if ((row + col) % 2 !== 0) {
                    if (row < 3) {
                        pieces[row + "_" + col] = { color: "dark", king: false };
                    } else if (row > 4) {
                        pieces[row + "_" + col] = { color: "light", king: false };
                    }
                }
            }
        }
        return pieces;
    }

    function pieceAt(pieces, row, col) {
        return pieces[row + "_" + col] || null;
    }

    function countPiecesOfColor(pieces, color) {
        let count = 0;
        for (const key in pieces) {
            if (pieces[key].color === color) count++;
        }
        return count;
    }

    function canCaptureAt(pieces, row, col, color, king) {
        const opponent = color === "light" ? "dark" : "light";
        const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
        const maxDistance = king ? 7 : 2;

        for (let d = 0; d < directions.length; d++) {
            const dRow = directions[d][0];
            const dCol = directions[d][1];
            let foundOpponent = false;
            for (let dist = 1; dist <= maxDistance; dist++) {
                const r = row + dRow * dist;
                const c = col + dCol * dist;
                if (r < 0 || r > 7 || c < 0 || c > 7) break;
                const p = pieceAt(pieces, r, c);
                if (!foundOpponent) {
                    if (p && p.color === opponent) {
                        foundOpponent = true;
                    } else if (p) {
                        break;
                    }
                } else {
                    if (!p) {
                        return true;
                    } else {
                        break;
                    }
                }
            }
        }
        return false;
    }

    function getCaptureJumps(pieces, row, col, color, king) {
        const opponent = color === "light" ? "dark" : "light";
        const directions = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
        const maxDistance = king ? 7 : 2;
        const jumps = [];

        for (let d = 0; d < directions.length; d++) {
            const dRow = directions[d][0];
            const dCol = directions[d][1];
            let foundRow = -1;
            let foundCol = -1;
            let foundOpponent = false;
            let potentialLandings = []; // Клетки приземления дамки за одной побитой шашкой
            for (let dist = 1; dist <= maxDistance; dist++) {
                const r = row + dRow * dist;
                const c = col + dCol * dist;
                if (r < 0 || r > 7 || c < 0 || c > 7) break;
                const p = pieceAt(pieces, r, c);
                if (!foundOpponent) {
                    if (p && p.color === opponent) {
                        foundOpponent = true;
                        foundRow = r;
                        foundCol = c;
                    } else if (p) {
                        break;
                    }
                } else {
                    if (!p) {
                        if (!king) {
                            jumps.push({ toRow: r, toCol: c, capturedRow: foundRow, capturedCol: foundCol });
                            break;
                        } else {
                            potentialLandings.push({ toRow: r, toCol: c, capturedRow: foundRow, capturedCol: foundCol });
                        }
                    } else {
                        break;
                    }
                }
            }

            // ПРАВИЛО РУССКИХ ШАШЕК: если дамка бьёт шашку, и за ней несколько свободных полей,
            // с одного из которых можно продолжить бой, а с других нет — дамка обязана
            // стать на то поле, с которого бой продолжается.
            if (king && potentialLandings.length > 0) {
                const validLandings = [];
                for (const landing of potentialLandings) {
                    const tempPieces = {};
                    for (const k in pieces) tempPieces[k] = pieces[k];
                    const capKey = landing.capturedRow + "_" + landing.capturedCol;
                    const fromKey = row + "_" + col;
                    const toKey = landing.toRow + "_" + landing.toCol;
                    tempPieces[capKey] = { color: "blocked", king: false };
                    delete tempPieces[fromKey];
                    tempPieces[toKey] = { color: color, king: true };
                    if (canCaptureAt(tempPieces, landing.toRow, landing.toCol, color, true)) {
                        validLandings.push(landing);
                    }
                }
                if (validLandings.length > 0) {
                    jumps.push(...validLandings);
                } else {
                    jumps.push(...potentialLandings);
                }
            }
        }
        return jumps;
    }

    function withPendingBlockers(pieces, pendingRemovals) {
        if (!pendingRemovals || pendingRemovals.length === 0) return pieces;
        const blocked = {};
        for (const k in pieces) blocked[k] = pieces[k];
        pendingRemovals.forEach(function (key) {
            if (!blocked[key]) blocked[key] = { color: "blocked", king: false };
        });
        return blocked;
    }

    function filterJumpsByMajorityRule(pieces, row, col, color, king, jumps) {
        // В русских шашках (в отличие от международных) нет правила
        // "обязан бить максимум" — выбор направления взятия свободный,
        // независимо от того, сколько шашек собьёт каждый вариант.
        // Поэтому здесь просто возвращаем все варианты без фильтрации.
        return jumps;
    }

    function canMoveNormally(pieces, row, col, color, king) {
        const forwardDirection = color === "light" ? -1 : 1;
        const directions = king
            ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
            : [[forwardDirection, -1], [forwardDirection, 1]];
        const maxDistance = king ? 7 : 1;

        for (let d = 0; d < directions.length; d++) {
            const dRow = directions[d][0];
            const dCol = directions[d][1];
            for (let dist = 1; dist <= maxDistance; dist++) {
                const r = row + dRow * dist;
                const c = col + dCol * dist;
                if (r < 0 || r > 7 || c < 0 || c > 7) break;
                const p = pieceAt(pieces, r, c);
                if (!p) {
                    return true;
                } else {
                    break;
                }
            }
        }
        return false;
    }

    function hasMandatoryCapture(pieces, color) {
        for (const key in pieces) {
            const p = pieces[key];
            if (p.color === color) {
                const parts = key.split("_");
                const r = parseInt(parts[0]);
                const c = parseInt(parts[1]);
                if (canCaptureAt(pieces, r, c, color, !!p.king)) return true;
            }
        }
        return false;
    }

    function hasAnyLegalMove(pieces, color) {
        if (hasMandatoryCapture(pieces, color)) return true;
        for (const key in pieces) {
            const p = pieces[key];
            if (p.color === color) {
                const parts = key.split("_");
                const r = parseInt(parts[0]);
                const c = parseInt(parts[1]);
                if (canMoveNormally(pieces, r, c, color, !!p.king)) return true;
            }
        }
        return false;
    }

    function checkWinCondition(pieces, opponentColor) {
        if (countPiecesOfColor(pieces, opponentColor) === 0) {
            return { winner: opponentColor === "light" ? "dark" : "light", reason: "no_pieces" };
        }
        if (!hasAnyLegalMove(pieces, opponentColor)) {
            return { winner: opponentColor === "light" ? "dark" : "light", reason: "no_moves" };
        }
        return null;
    }

    function getDrawPositionKey(pieces, turn) {
        let s = "";
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if ((row + col) % 2 === 0) continue;
                const p = pieces[row + "_" + col];
                if (!p) { s += "."; continue; }
                if (p.color === "light") s += p.king ? "L" : "l";
                else s += p.king ? "D" : "d";
            }
        }
        return s + "_" + turn;
    }

    function isOnLongRoad(row, col) {
        return (row + col) === 7;
    }

    function analyzeLongRoadEnding(pieces) {
        let lightCount = 0, darkCount = 0;
        let lastLightKey = null, lastDarkKey = null;
        for (const key in pieces) {
            if (pieces[key].color === "light") { lightCount++; lastLightKey = key; }
            else { darkCount++; lastDarkKey = key; }
        }
        function loneKingOnRoad(key) {
            const p = pieces[key];
            if (!p || !p.king) return false;
            const parts = key.split("_");
            return isOnLongRoad(parseInt(parts[0], 10), parseInt(parts[1], 10));
        }
        if (lightCount === 3 && darkCount === 1 && loneKingOnRoad(lastDarkKey)) {
            return { attacker: "light" };
        }
        if (darkCount === 3 && lightCount === 1 && loneKingOnRoad(lastLightKey)) {
            return { attacker: "dark" };
        }
        return null;
    }

    function checkAutomaticDraw(pieces, kingOnlyStreak, noProgressStreak, positionHistory, newPositionKey, longRoadStreak) {
        // Специальное окончание "3 фигуры против одинокой дамки на большой
        // дороге" проверяется ПЕРВЫМ как наиболее частное (lex specialis).
        // ВАЖНО, честная оговорка: официального порядка применения ничейных
        // правил в текстах ФШР/Минспорта НЕТ (проверено). Порядок здесь влияет
        // ТОЛЬКО на код причины, но не на исход — во всех пересекающихся
        // случаях обе нормы дают одну и ту же ничью. Практически пересечение
        // возможно лишь когда одинокая дамка ВСТУПАЕТ на большую дорогу
        // (без взятия и превращения), поэтому kingOnlyStreak к этому моменту
        // мог быть уже накоплен; при обычном же установлении соотношения
        // через взятие kingOnlyStreak обнуляется и конфликта не возникает.
        if (longRoadStreak >= 5 && analyzeLongRoadEnding(pieces)) {
            return "long_road_5";
        }

        // 15 полностью завершённых ходов только дамками, без взятий и без
        // движения простых шашек.
        if (kingOnlyStreak >= 15) {
            return "kings_only_15";
        }

        // 7.2.6 — материальный баланс не менялся заданное число ходов, при условии,
        // что у ОБЕИХ сторон сейчас есть хотя бы одна дамка.
        let totalPieces = 0;
        let lightHasKing = false;
        let darkHasKing = false;
        for (const key in pieces) {
            totalPieces++;
            const p = pieces[key];
            if (p.king) {
                if (p.color === "light") lightHasKing = true;
                else darkHasKing = true;
            }
        }
        if (lightHasKing && darkHasKing) {
            // Диапазон 2-3 фигуры — естественное продолжение того же
            // noProgress-механизма, что уже применяется для 4-5 и 6-7.
            // Единица счёта та же самая (отдельный ход одной стороны), как и
            // требовалось: не создаём параллельную систему подсчёта.
            if (totalPieces >= 2 && totalPieces <= 3 && noProgressStreak >= 5) {
                return "no_progress_5";
            }
            if (totalPieces >= 4 && totalPieces <= 5 && noProgressStreak >= 30) {
                return "no_progress_30";
            }
            if (totalPieces >= 6 && totalPieces <= 7 && noProgressStreak >= 60) {
                return "no_progress_60";
            }
        }

        // 7.2.3 — троекратное повторение одной и той же позиции при ходе одной
        // и той же стороны. Ключ уже включает turn, поэтому условие "тот же
        // игрок должен ходить" выполняется автоматически.
        let repeatCount = 0;
        for (let i = 0; i < positionHistory.length; i++) {
            if (positionHistory[i] === newPositionKey) repeatCount++;
        }
        if (repeatCount >= 3) {
            return "threefold_repetition";
        }

        return null;
    }

    function attemptMove(state, fromRow, fromCol, toRow, toCol, actingColor) {
        const pieces = {};
        for (const k in state.pieces) {
            pieces[k] = { color: state.pieces[k].color, king: !!state.pieces[k].king };
        }

        let turn = state.turn;
        let mustContinueFrom = state.mustContinueFrom || null;
        let capturedDark = state.capturedDark || 0;
        let capturedLight = state.capturedLight || 0;
        let moveCount = state.moveCount || 0;

        let lastMovePath = (!mustContinueFrom) ? [{ row: fromRow, col: fromCol }] : (state.lastMovePath || [{ row: fromRow, col: fromCol }]).slice();
        let lastCapturedSquares = (!mustContinueFrom) ? [] : (state.lastCapturedSquares || []).slice();

        let pendingRemovals = (!mustContinueFrom) ? [] : (state.pendingRemovals || []).slice();

        if (turn !== actingColor) return null;

        const fromKey = fromRow + "_" + fromCol;
        const toKey = toRow + "_" + toCol;
        const moving = pieces[fromKey];
        if (!moving || moving.color !== actingColor) return null;

        if (mustContinueFrom && (mustContinueFrom.row !== fromRow || mustContinueFrom.col !== fromCol)) return null;
        if (toRow < 0 || toRow > 7 || toCol < 0 || toCol > 7) return null;
        if (pieces[toKey]) return null;

        const rowDiff = Math.abs(toRow - fromRow);
        const colDiff = Math.abs(toCol - fromCol);
        if (rowDiff !== colDiff || rowDiff === 0) return null;

        const dRow = (toRow - fromRow) / rowDiff;
        const dCol = (toCol - fromCol) / colDiff;
        const king = !!moving.king;
        if (!king && rowDiff > 2) return null;

        const scanPieces = withPendingBlockers(pieces, pendingRemovals);

        let opponentsOnPath = 0;
        let capturedKey = null;
        for (let dist = 1; dist < rowDiff; dist++) {
            const key = (fromRow + dRow * dist) + "_" + (fromCol + dCol * dist);
            const scanPiece = scanPieces[key];
            if (scanPiece) {
                if (scanPiece.color === "blocked") return null;
                opponentsOnPath++;
                capturedKey = key;
                if (scanPiece.color === actingColor) return null;
            }
        }
        if (opponentsOnPath > 1) return null;

        const forwardDirection = actingColor === "light" ? -1 : 1;
        const actualDirection = toRow - fromRow > 0 ? 1 : -1;

        let becameKing = false;
        let moveType;

        if (opponentsOnPath === 0) {
            if (mustContinueFrom) return null;
            if (hasMandatoryCapture(pieces, actingColor)) return null;
            if (!king && rowDiff !== 1) return null;
            if (!king && actualDirection !== forwardDirection) return null;

            delete pieces[fromKey];
            if (!king) {
                if (actingColor === "light" && toRow === 0) { moving.king = true; becameKing = true; }
                if (actingColor === "dark" && toRow === 7) { moving.king = true; becameKing = true; }
            }
            pieces[toKey] = moving;

            turn = actingColor === "light" ? "dark" : "light";
            mustContinueFrom = null;
            moveCount++;
            moveType = becameKing ? "king" : "move";
            lastMovePath.push({ row: toRow, col: toCol });
        } else {
            if (!king && rowDiff !== 2) return null;

            {
                const allJumps = getCaptureJumps(scanPieces, fromRow, fromCol, actingColor, king);
                const bestJumps = filterJumpsByMajorityRule(scanPieces, fromRow, fromCol, actingColor, king, allJumps);
                let isOptimalJump = false;
                for (let i = 0; i < bestJumps.length; i++) {
                    if (bestJumps[i].toRow === toRow && bestJumps[i].toCol === toCol) { isOptimalJump = true; break; }
                }
                if (!isOptimalJump) return null;
            }

            const capturedPiece = pieces[capturedKey];
            delete pieces[capturedKey];
            delete pieces[fromKey];
            pendingRemovals.push(capturedKey);

            const capturedParts = capturedKey.split("_");
            lastCapturedSquares.push({ row: parseInt(capturedParts[0]), col: parseInt(capturedParts[1]) });

            if (capturedPiece.color === "dark") {
                capturedDark++;
            } else {
                capturedLight++;
            }

            if (!king) {
                if (actingColor === "light" && toRow === 0) { moving.king = true; becameKing = true; }
                if (actingColor === "dark" && toRow === 7) { moving.king = true; becameKing = true; }
            }
            pieces[toKey] = moving;
            lastMovePath.push({ row: toRow, col: toCol });

            const continuationScanPieces = withPendingBlockers(pieces, pendingRemovals);
            const canContinue = canCaptureAt(continuationScanPieces, toRow, toCol, actingColor, !!moving.king);

            if (canContinue) {
                mustContinueFrom = { row: toRow, col: toCol };
            } else {
                mustContinueFrom = null;
                turn = actingColor === "light" ? "dark" : "light";
            }
            moveCount++;
            moveType = becameKing ? "king" : "capture";
        }

        let winner = null;
        let winReason = null;
        if (mustContinueFrom === null) {
            const opponentColor = actingColor === "light" ? "dark" : "light";
            const winResult = checkWinCondition(pieces, opponentColor);
            if (winResult) {
                winner = winResult.winner;
                winReason = winResult.reason;
            }
        }

        return {
            pieces: pieces,
            turn: turn,
            mustContinueFrom: mustContinueFrom,
            capturedDark: capturedDark,
            capturedLight: capturedLight,
            moveCount: moveCount,
            moveType: moveType,
            lastMove: { from: { row: fromRow, col: fromCol }, to: { row: toRow, col: toCol } },
            lastMovePath: lastMovePath,
            lastCapturedSquares: lastCapturedSquares,
            pendingRemovals: (mustContinueFrom === null) ? [] : pendingRemovals,
            winner: winner,
            winReason: winReason
        };
    }

    function computeNextDrawState(prevState, result, movingPieceWasKing) {
        const prevKingOnlyStreak = prevState.kingOnlyStreak || 0;
        const prevNoProgressStreak = prevState.noProgressStreak || 0;
        const prevHistory = prevState.positionHistory || [];
        const prevLongRoadAttacker = prevState.longRoadAttacker || null;
        const prevLongRoadStreak = prevState.longRoadStreak || 0;

        // Цепочка взятия ещё не закончена — многоходовое взятие целиком считается
        // ОДНИМ ходом, поэтому счётчики трогать рано, ждём финального прыжка.
        if (result.mustContinueFrom !== null) {
            return {
                kingOnlyStreak: prevKingOnlyStreak,
                noProgressStreak: prevNoProgressStreak,
                positionHistory: prevHistory,
                longRoadAttacker: prevLongRoadAttacker,
                longRoadStreak: prevLongRoadStreak,
                drawReason: null
            };
        }

        const prevCapturedTotal = (prevState.capturedDark || 0) + (prevState.capturedLight || 0);
        const newCapturedTotal = (result.capturedDark || 0) + (result.capturedLight || 0);
        const wasCapture = newCapturedTotal > prevCapturedTotal;

        const destKey = result.lastMove.to.row + "_" + result.lastMove.to.col;
        const movedPieceNowKing = !!(result.pieces[destKey] && result.pieces[destKey].king);
        const becamePromoted = !movingPieceWasKing && movedPieceNowKing;

        let newKingOnlyStreak;
        if (wasCapture || !movingPieceWasKing) {
            // Взятие, либо ходила простая шашка (независимо от превращения) —
            // серия "только дамки без взятий" прерывается.
            newKingOnlyStreak = 0;
        } else {
            // Ходила именно дамка, и взятия не было.
            newKingOnlyStreak = prevKingOnlyStreak + 1;
        }

        let newNoProgressStreak;
        if (wasCapture || becamePromoted) {
            newNoProgressStreak = 0;
        } else {
            newNoProgressStreak = prevNoProgressStreak + 1;
        }

        // Специальное окончание "3 фигуры против одинокой дамки на большой
        // дороге": считаем ТОЛЬКО собственные ходы сильной стороны.
        // prevState.turn — цвет, который только что СДЕЛАЛ этот ход (result.turn
        // уже переключён на соперника). Устанавливающий соотношение ход в счёт
        // пяти НЕ входит — отсчёт стартует со следующего хода сильной стороны
        // (по аналогии с формулировкой "считая с момента установления
        // соотношения сил"; сам текст этого частного пункта момент старта
        // явно не оговаривает).
        //
        // Пока позиция соответствует условию правила (3 фигуры сильной стороны
        // против одинокой дамки соперника НА большой дороге) — специальный
        // счётчик идёт; как только позиция перестаёт ему соответствовать,
        // режим прекращается и счётчик обнуляется.
        //
        // ЭТО ИНТЕРПРЕТАЦИЯ ДЛЯ АВТОМАТИЗАЦИИ, а НЕ предписание ФШР. Текст
        // правил описывает дамку как "находящуюся на большой дороге", но
        // НИЧЕГО не говорит о том, что делать со счётчиком, если она оттуда
        // ушла; момент старта отсчёта в этом пункте тоже не оговорён.
        // Положение на большаке трактуется как часть условия правила наравне
        // с материальным соотношением: специальный счётчик действует ровно
        // столько, сколько существует описанная в правиле позиция.
        const moverColor = prevState.turn;
        const longRoadNow = analyzeLongRoadEnding(result.pieces);
        let newLongRoadAttacker;
        let newLongRoadStreak;
        if (!longRoadNow) {
            newLongRoadAttacker = null;
            newLongRoadStreak = 0;
        } else if (prevLongRoadAttacker !== longRoadNow.attacker) {
            newLongRoadAttacker = longRoadNow.attacker;
            newLongRoadStreak = 0;
        } else if (moverColor === longRoadNow.attacker) {
            newLongRoadAttacker = longRoadNow.attacker;
            newLongRoadStreak = prevLongRoadStreak + 1;
        } else {
            newLongRoadAttacker = longRoadNow.attacker;
            newLongRoadStreak = prevLongRoadStreak;
        }

        const newPositionKey = getDrawPositionKey(result.pieces, result.turn);
        const newHistory = prevHistory.concat([newPositionKey]);

        const drawReason = result.winner
            ? null // Партия уже закончилась обычной победой — автоматическую ничью не проверяем поверх неё
            : checkAutomaticDraw(result.pieces, newKingOnlyStreak, newNoProgressStreak, newHistory, newPositionKey, newLongRoadStreak);

        return {
            kingOnlyStreak: newKingOnlyStreak,
            noProgressStreak: newNoProgressStreak,
            positionHistory: newHistory,
            longRoadAttacker: newLongRoadAttacker,
            longRoadStreak: newLongRoadStreak,
            drawReason: drawReason
        };
    }

    const api = {
        createInitialPieces,
        pieceAt,
        countPiecesOfColor,
        canCaptureAt,
        getCaptureJumps,
        withPendingBlockers,
        filterJumpsByMajorityRule,
        canMoveNormally,
        hasMandatoryCapture,
        hasAnyLegalMove,
        checkWinCondition,
        getDrawPositionKey,
        isOnLongRoad,
        analyzeLongRoadEnding,
        checkAutomaticDraw,
        attemptMove,
        computeNextDrawState,
    };

    global.RussianCheckersEngine = api;

    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);

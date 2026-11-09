import { SQUARES, type Chess, type Color } from "chess.js";

export const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/** Handcrafted centipawns, from the side-to-move perspective. No teacher input. */
export function evaluate(board: Chess): number {
  let whiteScore = 0;
  const pawns = { w: Array<number>(8).fill(0), b: Array<number>(8).fill(0) };
  const pieces = board.board().flat().filter((p) => p !== null);
  const endgame = pieces.filter((p) => p.type === "q" || p.type === "r").length <= 2;
  for (const piece of pieces) if (piece.type === "p") pawns[piece.color][piece.square.charCodeAt(0) - 97]++;
  for (const piece of pieces) {
    const file = piece.square.charCodeAt(0) - 97;
    const rank = Number(piece.square[1]) - 1;
    const advance = piece.color === "w" ? rank : 7 - rank;
    const center = 7 - Math.abs(file - 3.5) - Math.abs(rank - 3.5);
    let score = VALUE[piece.type];
    if (piece.type === "p") {
      score += advance * 7 + center * 2;
      if (pawns[piece.color][file] > 1) score -= 14;
      if (!(pawns[piece.color][file - 1] || pawns[piece.color][file + 1])) score -= 12;
      const passed = !pieces.some((enemy) => enemy.type === "p" && enemy.color !== piece.color &&
        Math.abs(enemy.square.charCodeAt(0) - piece.square.charCodeAt(0)) <= 1 &&
        (piece.color === "w" ? Number(enemy.square[1]) > rank + 1 : Number(enemy.square[1]) < rank + 1));
      if (passed) score += advance * 8;
    }
    if (piece.type === "n") score += center * 10 - (advance === 0 ? 12 : 0);
    if (piece.type === "b") score += center * 5 + (advance > 0 ? 8 : 0);
    if (piece.type === "r") score += (advance === 6 ? 18 : 0) + (pawns[piece.color][file] === 0 ? 10 : 0);
    if (piece.type === "q") score += center * 2;
    if (piece.type === "k") {
      score += endgame ? center * 8 : -center * 8;
      if (!endgame) {
        if (advance === 0 && (file === 2 || file === 6)) score += 30;
        for (const pawn of pieces) if (pawn.color === piece.color && pawn.type === "p" &&
          Math.abs(pawn.square.charCodeAt(0) - piece.square.charCodeAt(0)) <= 1 &&
          Number(pawn.square[1]) === rank + 1 + (piece.color === "w" ? 1 : -1)) score += 12;
      }
    }
    whiteScore += (piece.color === "w" ? 1 : -1) * score;
  }
  // Controlled squares are a cheap, symmetric mobility proxy; chess.js owns attacks.
  for (const square of SQUARES) {
    for (const color of ["w", "b"] as Color[]) {
      const occupant = board.get(square);
      if (occupant?.color !== color && board.isAttacked(square, color)) whiteScore += color === "w" ? 2 : -2;
    }
  }
  return (board.turn() === "w" ? 1 : -1) * whiteScore;
}

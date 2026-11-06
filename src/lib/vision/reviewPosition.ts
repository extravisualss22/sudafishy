import { Chess, type Square } from "chess.js";
import { buildFen, type BoardMap } from "@/lib/chess/position";
import { placementOf, type BoardReading } from "./boardVision";

/** Pixels cannot establish castling history or an en-passant target. */
export function conservativeFen(board: BoardMap, turn: "w" | "b"): string {
  for (const [square, piece] of Object.entries(board)) {
    if (!/^[a-h][1-8]$/.test(square) || !/^[wb][KQRBNP]$/.test(piece)) {
      throw new Error("Review contains an invalid square or piece.");
    }
  }
  const fen = buildFen({
    board,
    turn,
    castling: { K: false, Q: false, k: false, q: false },
    ep: "-",
    half: 0,
    full: 1,
  });
  const chess = new Chess(fen); // Includes king counts and pawns on back ranks.
  const other = turn === "w" ? "b" : "w";
  const otherKing = Object.keys(board).find((square) => board[square] === `${other}K`)!;
  if (chess.isAttacked(otherKing as Square, turn)) {
    throw new Error(
      "The side that just moved cannot leave its king in check. Correct the pieces or side to move.",
    );
  }
  return fen;
}

/** Only a unique legal successor can establish whose turn is next from pixels. */
export function inferWatchedFen(
  previousFen: string,
  reading: Pick<BoardReading, "board" | "placement">,
): string | null {
  try {
    if (placementOf(reading.board) !== reading.placement) return null;
    const game = new Chess(previousFen);
    const matches: string[] = [];
    for (const move of game.moves({ verbose: true })) {
      game.move(move);
      if (game.fen().split(" ")[0] === reading.placement) matches.push(game.fen());
      game.undo();
    }
    return matches.length === 1 ? matches[0] : null;
  } catch {
    return null;
  }
}

// Board/FEN helpers that work for arbitrary (even illegal) setup positions.
export type PieceCode = "wK" | "wQ" | "wR" | "wB" | "wN" | "wP" | "bK" | "bQ" | "bR" | "bB" | "bN" | "bP";
export type BoardMap = Record<string, PieceCode>;
export type Castling = { K: boolean; Q: boolean; k: boolean; q: boolean };

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
export const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";
export const FILES = "abcdefgh";

export interface ParsedFen {
  board: BoardMap;
  turn: "w" | "b";
  castling: Castling;
  ep: string;
  half: number;
  full: number;
}

export function parseFen(fen: string): ParsedFen {
  const [placement = "8/8/8/8/8/8/8/8", turn = "w", cast = "-", ep = "-", half = "0", full = "1"] = fen
    .trim()
    .split(/\s+/);
  const board: BoardMap = {};
  const rows = placement.split("/");
  rows.slice(0, 8).forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else if (f < 8) {
        const color = ch === ch.toUpperCase() ? "w" : "b";
        board[`${FILES[f]}${8 - i}`] = (color + ch.toUpperCase()) as PieceCode;
        f++;
      }
    }
  });
  return {
    board,
    turn: turn === "b" ? "b" : "w",
    castling: { K: cast.includes("K"), Q: cast.includes("Q"), k: cast.includes("k"), q: cast.includes("q") },
    ep,
    half: Number(half) || 0,
    full: Number(full) || 1,
  };
}

export function buildFen(p: ParsedFen): string {
  const rows: string[] = [];
  for (let r = 8; r >= 1; r--) {
    let row = "";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const pc = p.board[`${FILES[f]}${r}`];
      if (!pc) empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += pc[0] === "w" ? pc[1] : pc[1].toLowerCase();
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const c = p.castling;
  const cast = (c.K ? "K" : "") + (c.Q ? "Q" : "") + (c.k ? "k" : "") + (c.q ? "q" : "") || "-";
  return `${rows.join("/")} ${p.turn} ${cast} ${p.ep} ${p.half} ${p.full}`;
}

/** Drop castling rights that the piece placement can't support. */
export function sanitizeCastling(p: ParsedFen): Castling {
  const b = p.board;
  return {
    K: p.castling.K && b.e1 === "wK" && b.h1 === "wR",
    Q: p.castling.Q && b.e1 === "wK" && b.a1 === "wR",
    k: p.castling.k && b.e8 === "bK" && b.h8 === "bR",
    q: p.castling.q && b.e8 === "bK" && b.a8 === "bR",
  };
}

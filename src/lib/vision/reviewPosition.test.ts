import { describe, expect, it } from "vitest";
import { Chess } from "chess.js";
import { parseFen, START_FEN } from "@/lib/chess/position";
import { conservativeFen, inferWatchedFen } from "./reviewPosition";
import { placementOf } from "./boardVision";

describe("reviewed screen positions", () => {
  it("resets historical rights and validates both kings and side to move", () => {
    expect(conservativeFen(parseFen(START_FEN).board, "b")).toBe(
      START_FEN.replace("w KQkq", "b -"),
    );
    expect(() => conservativeFen({ e1: "wK" }, "w")).toThrow();
    expect(() => conservativeFen({ e1: "wK", e2: "bK" }, "w")).toThrow();
    expect(() => conservativeFen({ e1: "wK", e8: "bK", e7: "wR" }, "w")).toThrow(/king in check/);
    expect(() => conservativeFen({ e1: "wK", e8: "bK", a8: "wP" }, "w")).toThrow();
  });

  it("only infers side to move for a unique legal successor", () => {
    const game = new Chess();
    game.move("e4");
    const board = parseFen(game.fen()).board;
    expect(inferWatchedFen(START_FEN, { board, placement: placementOf(board) })).toBe(game.fen());
    game.move("e5");
    const jumped = parseFen(game.fen()).board;
    expect(
      inferWatchedFen(START_FEN, { board: jumped, placement: placementOf(jumped) }),
    ).toBeNull();
    expect(inferWatchedFen(START_FEN, { board, placement: "8/8/8/8/8/8/8/8" })).toBeNull();
  });

  it("keeps legal transition metadata for castling, en passant and promotion", () => {
    for (const [fen, move] of [
      ["r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1", "O-O"],
      ["4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 8", "exd6"],
      ["7k/P7/8/8/8/8/8/7K w - - 0 1", "a8=N"],
    ]) {
      const game = new Chess(fen);
      game.move(move);
      const board = parseFen(game.fen()).board;
      expect(inferWatchedFen(fen, { board, placement: placementOf(board) })).toBe(game.fen());
    }
  });
});

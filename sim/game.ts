import { Chess } from "chess.js";
import { randomUUID } from "node:crypto";
import type { GameRecord, ObservedGame } from "../src/lib/sudalol/types.ts";
import type { RunOptions } from "./config.ts";
import { createOpponent } from "./opponents.ts";

export interface Progress { moves: number; nodes: number; observed?: ObservedGame }
export function termination(board: Chess): { result: GameRecord["result"]; termination: string } | null {
  if (board.isCheckmate()) return { result: board.turn() === "w" ? "0-1" : "1-0", termination: "checkmate" };
  for (const [ended, reason] of [[board.isStalemate(), "stalemate"], [board.isInsufficientMaterial(), "insufficient-material"],
    [board.isThreefoldRepetition(), "threefold-repetition"], [board.isDrawByFiftyMoves(), "fifty-move-rule"]] as const) {
    if (ended) return { result: "1/2-1/2", termination: reason };
  }
  return null;
}
export async function playGame(options: RunOptions, index = 0, onProgress?: (progress: Progress) => void) {
  const start = performance.now();
  const seed = (options.seed + Math.imul(index, 2654435761)) >>> 0;
  const white = await createOpponent(options.white, seed, options.stockfish);
  let black: Awaited<ReturnType<typeof createOpponent>> | undefined;
  try {
  black = await createOpponent(options.black, seed ^ 0xabcdef, options.stockfish);
  const blackPlayer = black;
  const board = new Chess(options.initialFen);
  const initialFen = board.fen();
  const gameId = randomUUID();
  const moves: string[] = [], san: string[] = [];
  let nodes = 0;
  const observed = (): ObservedGame => ({ gameId, white: white.identity, black: blackPlayer.identity, initialFen,
    moves: [...moves], san: [...san], finished: false });
  const report = () => onProgress?.({ moves: moves.length, nodes, ...(options.observe ? { observed: observed() } : {}) });
  report();
  while (!termination(board) && moves.length < options.maxMoves * 2) {
    const player = board.turn() === "w" ? white.opponent : black.opponent;
    const decision = await player.chooseMove(board, options.search);
    if (!decision.move) throw new Error(`${player.name} returned no move in a nonterminal position`);
    const move = board.move({ from: decision.move.slice(0, 2), to: decision.move.slice(2, 4), promotion: decision.move[4] });
    moves.push(decision.move); san.push(move.san); nodes += decision.nodes;
    if (moves.length % 8 === 0) report();
  }
  // A resource cap is an adjudicated draw, explicitly distinguished from a chess-rule draw.
  const outcome = termination(board) ?? { result: "1/2-1/2" as const, termination: "max-moves-adjudication" };
  const record: GameRecord = { schemaVersion: 1, gameId, index, white: white.identity, black: black.identity,
    generation: { white: white.identity.generation, black: black.identity.generation }, ...outcome,
    moveCount: moves.length, moves, san, initialFen, finalFen: board.fen(), elapsedSeconds: (performance.now() - start) / 1000,
    nodes, seed, search: { ...options.search } };
  board.header("Event", "sudalol Phase 1 simulation", "Site", "local", "Date", new Date().toISOString().slice(0, 10).replaceAll("-", "."),
    "Round", String(index + 1), "White", white.identity.name, "Black", black.identity.name, "Result", outcome.result,
    "GameId", gameId, "Termination", outcome.termination, "WhiteGeneration", white.identity.generation ?? "none",
    "BlackGeneration", black.identity.generation ?? "none");
  onProgress?.({ moves: moves.length, nodes, ...(options.observe ? { observed: { ...observed(), finished: true, ...outcome } } : {}) });
  return { record, pgn: board.pgn() + "\n\n" };
  } finally { white.opponent.dispose?.(); black?.opponent.dispose?.(); }
}

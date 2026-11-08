import { Chess } from "chess.js";
import { z } from "zod";
import type { ObservedGame, RunSnapshot } from "./types.ts";

const number = z.number().finite().nonnegative();
const identity = z.object({ id: z.string(), name: z.string(), generation: z.string().nullable(), fingerprint: z.string() });
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string(), status: z.enum(["running", "completed", "failed", "stopped"]), error: z.string().optional(),
  workers: number, requestedGames: number, completedGames: number, elapsedSeconds: number,
  gamesPerSecond: number, gamesPerMinute: number, moves: number, nodes: number,
  movesPerSecond: number, nodesPerSecond: number, averageGameLength: number,
  observed: z.array(z.object({ gameId: z.string(), white: identity, black: identity, initialFen: z.string(),
    moves: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/)).max(2000), san: z.array(z.string()).max(2000),
    finished: z.boolean(), result: z.string().optional(), termination: z.string().optional() })).max(12),
});
export function parseSnapshot(value: unknown): RunSnapshot {
  const snapshot = snapshotSchema.parse(value);
  for (const game of snapshot.observed) {
    if (game.moves.length !== game.san.length) throw new Error("Move data is incomplete");
    replayFrames(game); // Reject corrupt or illegal imported move sequences.
  }
  return snapshot;
}
export function replayFrames(game: ObservedGame) {
  const board = new Chess(game.initialFen);
  const frames = [board.fen()];
  for (const move of game.moves) {
    board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    frames.push(board.fen());
  }
  return frames;
}

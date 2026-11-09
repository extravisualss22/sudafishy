import { z } from "zod";
import { replayFrames } from "./spectator.ts";
import type { ObservedGame } from "./types";
const count = z.number().int().nonnegative();
const finite = z.number().finite();
const generation = z.string().regex(/^gen\d+$/);
const evaluation = z
  .object({ cp: finite.nullable(), mate: z.number().int().nullable() })
  .refine((v) => (v.cp === null) !== (v.mate === null), "Evaluation must contain cp or mate");
const identity = z.object({
  id: z.string(),
  name: z.string(),
  generation: generation.nullable(),
  fingerprint: z.string(),
});
const game = z.object({
  gameId: z.string(),
  white: identity,
  black: identity,
  initialFen: z.string(),
  moves: z.array(z.string()).max(2000),
  san: z.array(z.string()).max(2000),
  finished: z.literal(true),
  result: z.enum(["1-0", "0-1", "1/2-1/2"]),
  termination: z.string(),
});
const metrics = z.object({
  loss: finite.nonnegative(),
  policyLoss: finite.nonnegative(),
  valueError: finite.nonnegative(),
  policyAccuracy: finite.min(0).max(1),
});
const schema = z.object({
  schemaVersion: z.literal(2),
  savedAt: z.string(),
  champion: generation,
  estimatedChessElo: z.object({ status: z.literal("unrated"), value: z.null() }),
  totalGames: count,
  totalPositions: count,
  reviewedPositions: count,
  trainingExamples: count,
  ratings: z
    .array(
      z
        .object({
          generation,
          rating: finite,
          games: count,
          wins: count,
          draws: count,
          losses: count,
          peak: finite,
          change: finite,
          updated: z.string(),
        })
        .refine((r) => r.games === r.wins + r.draws + r.losses),
    )
    .max(10000),
  training: z
    .array(
      z.object({
        status: z.enum(["paused", "completed"]),
        epochsCompleted: count,
        steps: count,
        elapsedSeconds: finite.nonnegative(),
        device: z.string(),
        hardware: z.string(),
        history: z
          .array(z.object({ epoch: count, train: metrics, validation: metrics }))
          .max(10000),
      }),
    )
    .max(10),
  pipeline: z
    .object({
      phase: z.string().optional(),
      iteration: count.optional(),
      candidate: generation.optional(),
      champion: generation.optional(),
    })
    .passthrough(),
  coaching: z
    .array(
      z.object({
        id: z.string(),
        gameId: z.string(),
        ply: count,
        fen: z.string(),
        generation,
        played: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
        recommended: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
        before: evaluation,
        after: evaluation,
        centipawnLoss: finite.nonnegative().nullable(),
        classification: z.enum(["normal", "mistake", "blunder"]),
        selectionReasons: z.array(z.string()),
        inDataset: z.boolean(),
      }),
    )
    .max(100),
  reviewedGames: z.array(game).max(100),
  matches: z
    .array(
      z.object({
        generation,
        games: count,
        wins: count,
        draws: count,
        losses: count,
        score: finite.min(0).max(1).nullable(),
        run: z.string(),
      }),
    )
    .max(10000),
});
export type TrainingSnapshot = z.infer<typeof schema>;
export function parseTraining(value: unknown): TrainingSnapshot {
  const result = schema.parse(value);
  const frames = new Map(
    result.reviewedGames.map((game) => [game.gameId, replayFrames(game as ObservedGame)]),
  );
  for (const example of result.coaching) {
    const game = result.reviewedGames.find((game) => game.gameId === example.gameId);
    if (
      !game ||
      game.moves[example.ply] !== example.played ||
      frames.get(example.gameId)?.[example.ply] !== example.fen
    )
      throw new Error("Coaching does not match its completed replay");
  }
  return result;
}

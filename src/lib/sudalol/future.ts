/** Phase 2 data contracts only. There is no analyzer, trainer, or promotion loop here. */
export interface TeacherPosition {
  schemaVersion: 1;
  gameId: string;
  ply: number;
  fenBefore: string;
  playedMove: string;
  recommendedMove: string;
  teacher: { name: "Stockfish"; version: string; depth: number; nodes: number };
  // Always normalize to the player who made playedMove; mate scores stay separate.
  playedScore: { cp: number } | { mate: number };
  bestScore: { cp: number } | { mate: number };
  evaluationLossCp: number | null;
  sourceGeneration: string;
}
export interface FutureTrainingCheckpoint {
  generation: string;
  parentGeneration: string;
  encoderVersion: string;
  architectureVersion: string;
  weightsPath: string;
  weightsSha256: string;
  datasetIds: string[];
  metrics: { trainingLoss: number; validationLoss: number; moveAccuracy: number };
}

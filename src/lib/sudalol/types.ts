import type { Chess } from "chess.js";

export interface SearchOptions {
  depth: number;
  maxNodes: number;
  quiescenceDepth: number;
  tableEntries: number;
}
export interface Decision {
  move: string | null; // UCI, including a promotion suffix when needed
  score: number;
  nodes: number;
  completedDepth: number;
  tableHits: number;
}
export interface Opponent {
  id: string;
  name: string;
  generation: string | null;
  chooseMove(board: Chess, options: SearchOptions): Decision;
}
export interface PlayerIdentity {
  id: string;
  name: string;
  generation: string | null;
  fingerprint: string;
}
export interface GameRecord {
  schemaVersion: 1;
  gameId: string;
  index: number;
  white: PlayerIdentity;
  black: PlayerIdentity;
  generation: { white: string | null; black: string | null };
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  termination: string;
  moveCount: number; // plies: one player's move
  moves: string[]; // UCI
  san: string[];
  initialFen: string;
  finalFen: string;
  elapsedSeconds: number;
  nodes: number;
  seed: number;
  search: SearchOptions;
}
export interface ObservedGame {
  gameId: string;
  white: PlayerIdentity;
  black: PlayerIdentity;
  initialFen: string;
  moves: string[];
  san: string[];
  finished: boolean;
  result?: string;
  termination?: string;
}
export interface RunSnapshot {
  schemaVersion: 1;
  runId: string;
  status: "running" | "completed" | "failed" | "stopped";
  error?: string;
  workers: number;
  requestedGames: number;
  completedGames: number;
  elapsedSeconds: number;
  gamesPerSecond: number;
  gamesPerMinute: number;
  moves: number;
  nodes: number;
  movesPerSecond: number;
  nodesPerSecond: number;
  averageGameLength: number;
  observed: ObservedGame[];
}

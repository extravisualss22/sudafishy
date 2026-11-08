import { availableParallelism } from "node:os";
import { DEFAULT_SEARCH, validateSearch } from "../src/lib/sudalol/generations/gen0/engine.ts";
import type { SearchOptions } from "../src/lib/sudalol/types.ts";

export interface RunOptions {
  games: number;
  workers: number;
  maxMoves: number; // full moves (two plies)
  search: SearchOptions;
  white: string;
  black: string;
  mode: "normal" | "overnight";
  seed: number;
  output: string;
  observe: boolean;
  initialFen?: string;
}
export function preset(mode: string, cpus = availableParallelism()) {
  if (mode !== "normal" && mode !== "overnight") throw new Error("mode must be normal or overnight");
  return mode === "normal" ? Math.max(1, Math.min(4, Math.floor(cpus / 2))) : Math.max(1, Math.min(16, cpus - 1));
}
export function validateRun(options: RunOptions, cpus = availableParallelism()) {
  for (const [name, value, min, max] of [
    ["games", options.games, 1, 1000000], ["workers", options.workers, 1, cpus],
    ["max-moves", options.maxMoves, 1, 1000], ["seed", options.seed, 0, 0xffffffff],
  ] as const) if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  preset(options.mode, cpus);
  validateSearch(options.search);
}
export function defaultOptions(): RunOptions {
  return { games: 1, workers: preset("normal"), maxMoves: 150, search: { ...DEFAULT_SEARCH },
    white: "gen0", black: "weak", mode: "normal", seed: 1, output: "runs", observe: false };
}

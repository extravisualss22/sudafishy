import type { Chess } from "chess.js";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Decision, Opponent, PlayerIdentity, SearchOptions } from "../src/lib/sudalol/types.ts";
import { generationRoot, verifyGeneration } from "./generations.ts";

export function randomSource(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
export function weakBot(seed: number): Opponent {
  const random = randomSource(seed);
  const values: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
  return {
    id: "weak", name: "weak greedy bot", generation: null,
    chooseMove(board: Chess): Decision {
      if (board.isGameOver()) return { move: null, score: 0, nodes: 0, completedDepth: 0, tableHits: 0 };
      let best = -Infinity, chosen: string | null = null, nodes = 0;
      for (const move of board.moves({ verbose: true })) {
        let score = (values[move.captured ?? ""] ?? 0) + (values[move.promotion ?? ""] ?? 0) + random() * 8;
        board.move(move);
        try {
          if (board.isCheckmate()) score += 100000;
          if (board.isAttacked(move.to, board.turn())) score -= values[move.promotion ?? move.piece] * 0.5;
        } finally { board.undo(); }
        nodes++;
        if (score > best) { best = score; chosen = move.from + move.to + (move.promotion ?? ""); }
      }
      return { move: chosen, score: best, nodes, completedDepth: 1, tableHits: 0 };
    },
  };
}
export async function createOpponent(id: string, seed: number): Promise<{ opponent: Opponent; identity: PlayerIdentity }> {
  if (id === "weak") {
    const opponent = weakBot(seed);
    const source = (await readFile(new URL("./opponents.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    return { opponent, identity: { id, name: opponent.name, generation: null, fingerprint: createHash("sha256").update(source).digest("hex") } };
  }
  const { manifest, fingerprint } = await verifyGeneration(id);
  const engine = await import(pathToFileURL(join(generationRoot, id, "engine.ts")).href) as { chooseMove: (board: Chess, options: SearchOptions) => Decision };
  return { opponent: { id, name: manifest.name, generation: id, chooseMove: engine.chooseMove },
    identity: { id, name: manifest.name, generation: id, fingerprint } };
}

/** Configurable weighted scheduling seam for Phase 2. No opponent mix is imposed. */
export function selectOpponent(distribution: { id: string; weight: number }[], random: () => number) {
  if (!distribution.length || distribution.some((x) => !Number.isFinite(x.weight) || x.weight < 0)) throw new Error("Invalid opponent distribution");
  const total = distribution.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) throw new Error("Opponent weights must have a positive total");
  let value = random() * total;
  for (const item of distribution) { value -= item.weight; if (value < 0) return item.id; }
  return distribution.at(-1)!.id;
}

import { readFile, mkdir, writeFile, readdir, rename } from "node:fs/promises";
import {
  createReadStream,
  writeFileSync,
  renameSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Chess } from "chess.js";
import { defaultOptions, type RunOptions } from "../sim/config.ts";
import { createOpponent } from "../sim/opponents.ts";
import { runSimulation } from "../sim/runner.ts";
import type { GameRecord } from "../src/lib/sudalol/types.ts";

export const OPENINGS = [
  [],
  ["e4", "e5"],
  ["d4", "d5"],
  ["Nf3", "d5"],
  ["c4", "e5"],
  ["e4", "c5"],
  ["d4", "Nf6"],
  ["e4", "e6"],
];
export function openingFen(pair: number) {
  const board = new Chess();
  for (const move of OPENINGS[pair % OPENINGS.length]) board.move(move);
  return board.fen();
}
function atomic(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2));
  renameSync(path + ".tmp", path);
}
type CompactGame = Pick<GameRecord, "index" | "gameId" | "moveCount" | "nodes"> & {
  fingerprint: string;
};
export async function collectGames(directory: string): Promise<CompactGame[]> {
  const records = new Map<number, CompactGame>();
  for (const run of (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    for (const file of (await readdir(join(directory, run.name)))
      .filter((name) => /^games-\d+\.jsonl$/.test(name))
      .sort()) {
      const path = join(directory, run.name, file);
      const length = statSync(path).size,
        tail = Buffer.alloc(1),
        fd = openSync(path, "r");
      try {
        if (length) readSync(fd, tail, 0, 1, length - 1);
      } finally {
        closeSync(fd);
      }
      const stream = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
      // readline also emits a partial last line. Only a malformed last line may be ignored after a crash.
      let malformed = false;
      for await (const line of stream) {
        if (malformed) throw new Error(`Corrupt interior JSONL line in ${file}`);
        if (!line.trim()) continue;
        let record: GameRecord;
        try {
          record = JSON.parse(line);
        } catch {
          if (tail[0] === 10) throw new Error(`Corrupt JSONL line in ${file}`);
          malformed = true;
          continue;
        }
        if (
          record.schemaVersion !== 1 ||
          record.result === "*" ||
          record.moves.length !== record.moveCount
        )
          throw new Error("Invalid completed game");
        const prior = records.get(record.index);
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify([record.moves, record.white, record.black, record.result, record.seed]),
          )
          .digest("hex");
        if (prior && prior.fingerprint !== fingerprint)
          throw new Error("Conflicting game index during recovery");
        records.set(record.index, {
          index: record.index,
          gameId: record.gameId,
          moveCount: record.moveCount,
          nodes: record.nodes,
          fingerprint,
        });
      }
    }
  }
  return [...records.values()].sort((a, b) => a.index - b.index);
}
export async function runPlan(planFile: string, directory: string) {
  const plan = JSON.parse(await readFile(planFile, "utf8")) as {
    options: Partial<RunOptions>;
    jobs: NonNullable<RunOptions["jobs"]>;
  };
  const options = {
    ...defaultOptions(),
    ...plan.options,
    games: plan.jobs.length,
    jobs: plan.jobs,
    observe: true,
  };
  const ids = [...new Set(plan.jobs.flatMap((job) => [job.white, job.black]))];
  const identities = [];
  for (const id of ids) {
    const item = await createOpponent(id, options.seed, options.stockfish);
    identities.push(item.identity);
    item.opponent.dispose?.();
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ plan, identities }))
    .digest("hex");
  await mkdir(directory, { recursive: true });
  const metadata = join(directory, "job.json");
  try {
    await writeFile(metadata, JSON.stringify({ fingerprint, plan, identities }, null, 2), {
      flag: "wx",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (JSON.parse(await readFile(metadata, "utf8")).fingerprint !== fingerprint)
      throw new Error("Resume configuration or opponent changed");
  }
  const existing = await collectGames(directory);
  const completed = new Set(existing.map((game) => game.index));
  const remaining = plan.jobs.filter((job) => !completed.has(job.index));
  const dataRoot = resolve(process.env["SUDALOL_DATA"] ?? "training-data");
  await mkdir(dataRoot, { recursive: true });
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const stopTimer = setInterval(() => {
    if (existsSync(join(dataRoot, "STOP"))) controller.abort();
  }, 500);
  try {
    if (remaining.length)
      await runSimulation(
        { ...options, jobs: remaining, games: remaining.length, output: directory },
        {
          signal: controller.signal,
          onSnapshot: (snapshot) => {
            // Existing atomic snapshot writer already publishes every 500 ms.
            atomic(join(dataRoot, "simulation.json"), snapshot);
          },
        },
      );
  } finally {
    clearInterval(stopTimer);
  }
  const games = await collectGames(directory);
  const summary = {
    schemaVersion: 2,
    fingerprint,
    status: games.length === plan.jobs.length ? "completed" : "stopped",
    games: games.length,
    requestedGames: plan.jobs.length,
    moves: games.reduce((sum, game) => sum + game.moveCount, 0),
    nodes: games.reduce((sum, game) => sum + game.nodes, 0),
    savedAt: new Date().toISOString(),
  };
  await atomic(join(directory, "job-summary.json"), summary);
  // A canonical bounded shard per 1000 games is reconstructed from completed records after recovery.
  await atomic(
    join(directory, "games-index.json"),
    games.map((game) => ({ index: game.index, gameId: game.gameId })),
  );
  console.log(JSON.stringify(summary));
  if (summary.status !== "completed") process.exitCode = 2;
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("learning/jobs.ts")) {
  const [plan, directory] = process.argv.slice(2);
  if (!plan || !directory)
    throw new Error("Usage: node learning/jobs.ts PLAN.json OUTPUT_DIRECTORY");
  runPlan(plan, directory).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

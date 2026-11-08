import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { mkdirSync, openSync, closeSync, writeSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import type { GameRecord, ObservedGame, RunSnapshot } from "../src/lib/sudalol/types.ts";
import { validateRun, type RunOptions } from "./config.ts";
import { createOpponent } from "./opponents.ts";
import type { Progress } from "./game.ts";

export interface RunHooks { signal?: AbortSignal; onSnapshot?: (snapshot: RunSnapshot) => void }
export async function runSimulation(options: RunOptions, hooks: RunHooks = {}) {
  validateRun(options);
  await createOpponent(options.white, options.seed);
  await createOpponent(options.black, options.seed);
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const directory = resolve(options.output, runId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), JSON.stringify({ schemaVersion: 1, runId, ...options }, null, 2), { flag: "wx" });
  const start = performance.now();
  const workerCount = Math.min(options.workers, options.games);
  let completed = 0, completedMoves = 0, moves = 0, nodes = 0, next = 0;
  let status: RunSnapshot["status"] = "running", failure: string | undefined;
  const observed: ObservedGame[] = [];
  const pool: Worker[] = [];
  // Single writer, rotating paired shards: no per-game files, no in-memory archive.
  let jsonFd = -1, pgnFd = -1, shard = 0;
  function rotate() {
    if (jsonFd >= 0) closeSync(jsonFd);
    if (pgnFd >= 0) closeSync(pgnFd);
    const stem = `games-${String(shard++).padStart(5, "0")}`;
    jsonFd = openSync(join(directory, stem + ".jsonl"), "wx");
    pgnFd = openSync(join(directory, stem + ".pgn"), "wx");
  }
  function snapshot(): RunSnapshot {
    const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001);
    return { schemaVersion: 1, runId, status, error: failure, workers: workerCount, requestedGames: options.games,
      completedGames: completed, elapsedSeconds, gamesPerSecond: completed / elapsedSeconds,
      gamesPerMinute: completed * 60 / elapsedSeconds, moves, nodes, movesPerSecond: moves / elapsedSeconds,
      nodesPerSecond: nodes / elapsedSeconds, averageGameLength: completed ? completedMoves / completed : 0,
      observed: structuredClone(observed) };
  }
  function publish() {
    const value = snapshot();
    // Atomic replacement keeps readers from seeing half-written JSON.
    writeFileSync(join(directory, "snapshot.tmp"), JSON.stringify(value));
    renameSync(join(directory, "snapshot.tmp"), join(directory, "snapshot.json"));
    hooks.onSnapshot?.(value);
    return value;
  }
  let finish!: () => void, reject!: (error: Error) => void;
  const done = new Promise<void>((res, rej) => { finish = res; reject = rej; });
  const fail = (error: unknown) => { if (status === "running") { status = "failed"; failure = String(error); reject(new Error(failure)); } };
  const abort = () => { if (status === "running") { status = "stopped"; finish(); } };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    rotate(); publish();
    hooks.signal?.addEventListener("abort", abort, { once: true });
    if (hooks.signal?.aborted) abort();
    timer = setInterval(() => { try { publish(); } catch (error) { fail(error); } }, 500);
    for (let slot = 0; slot < workerCount && status === "running"; slot++) {
      const worker = new Worker(new URL("./worker.ts", import.meta.url));
      pool.push(worker);
      let lastMoves = 0, lastNodes = 0;
      const assign = () => {
        if (next >= options.games || status !== "running") return;
        lastMoves = lastNodes = 0;
        worker.postMessage({ index: next++, options: { ...options, observe: options.observe && slot === 0 } });
      };
      worker.on("message", (message: { type: string; progress?: Progress; record?: GameRecord; pgn?: string; error?: string }) => {
        if (status !== "running") return;
        try {
          if (message.type === "failure") { fail(message.error); return; }
          if (message.type === "progress") {
            const progress = message.progress!;
            moves += progress.moves - lastMoves; nodes += progress.nodes - lastNodes;
            lastMoves = progress.moves; lastNodes = progress.nodes;
            if (progress.observed) {
              const index = observed.findIndex((g) => g.gameId === progress.observed!.gameId);
              if (index >= 0) observed[index] = progress.observed;
              else { observed.push(progress.observed); if (observed.length > 12) observed.shift(); }
            }
          } else if (message.type === "game") {
            if (completed > 0 && completed % 1000 === 0) rotate();
            writeSync(jsonFd, JSON.stringify(message.record) + "\n");
            writeSync(pgnFd, message.pgn!);
            completed++; completedMoves += message.record!.moveCount;
            if (completed === options.games) { status = "completed"; finish(); }
            else assign();
          }
        } catch (error) { fail(error); }
      });
      worker.on("error", fail);
      worker.on("exit", (code) => { if (status === "running") fail(`Worker exited unexpectedly (${code})`); });
      assign();
    }
    await done;
  } catch (error) {
    status = "failed";
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    clearInterval(timer);
    hooks.signal?.removeEventListener("abort", abort);
    await Promise.all(pool.map((worker) => worker.terminate()));
    if (jsonFd >= 0) closeSync(jsonFd);
    if (pgnFd >= 0) closeSync(pgnFd);
    const final = publish();
    writeFileSync(join(directory, "summary.json"), JSON.stringify(final, null, 2));
  }
  return { directory, summary: JSON.parse(await (await import("node:fs/promises")).readFile(join(directory, "summary.json"), "utf8")) as RunSnapshot };
}

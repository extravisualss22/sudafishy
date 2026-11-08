import { availableParallelism } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { defaultOptions, preset, validateRun, type RunOptions } from "./config.ts";
import { runSimulation } from "./runner.ts";
import { startObservationServer } from "./server.ts";
import type { RunSnapshot } from "../src/lib/sudalol/types.ts";

function parse(args: string[]) {
  const command = args.shift() ?? "simulate";
  if (!["simulate", "benchmark", "spectate"].includes(command)) throw new Error("Use simulate, benchmark, or spectate");
  const values = new Map<string, string>();
  const allowed = ["games", "workers", "search-depth", "max-moves", "max-nodes", "mode", "white", "black", "seed", "output", "worker-counts", "fen"];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--") continue;
    const key = args[i].replace(/^--/, "");
    if (!args[i].startsWith("--") || !allowed.includes(key) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Unknown or missing option: ${args[i]}`);
    if (values.has(key)) throw new Error(`Duplicate option: --${key}`);
    values.set(key, args[++i]);
  }
  const options = defaultOptions();
  options.mode = (values.get("mode") ?? "normal") as RunOptions["mode"];
  options.workers = preset(options.mode);
  for (const [flag, key] of [["games", "games"], ["workers", "workers"], ["max-moves", "maxMoves"], ["seed", "seed"]] as const) {
    if (values.has(flag)) options[key] = Number(values.get(flag));
  }
  for (const key of ["white", "black", "output"] as const) if (values.has(key)) options[key] = values.get(key)!;
  if (values.has("search-depth")) options.search.depth = Number(values.get("search-depth"));
  if (values.has("max-nodes")) options.search.maxNodes = Number(values.get("max-nodes"));
  if (values.has("fen")) options.initialFen = values.get("fen");
  options.observe = command === "spectate";
  validateRun(options);
  return { command, options, values };
}
async function main() {
  if (process.argv.includes("--help")) {
    console.log("sudalol Phase 1\nnode sim/cli.ts <simulate|benchmark|spectate> [--games N] [--workers N] [--search-depth 1..8] [--max-moves N] [--max-nodes N] [--mode normal|overnight] [--white gen0|weak] [--black gen0|weak] [--seed N] [--output runs] [--fen FEN]\nbenchmark: --worker-counts 1,2,4 (explicitly add 8,16 if available)\nmax-moves counts full moves; recorded moveCount counts plies.");
    return;
  }
  const { command, options, values } = parse(process.argv.slice(2));
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  if (command === "benchmark") {
    const counts = values.has("worker-counts") ? values.get("worker-counts")!.split(",").map(Number) : [1, 2, 4].filter((n) => n <= availableParallelism());
    if (!counts.length || new Set(counts).size !== counts.length) throw new Error("worker-counts must be a nonempty list of distinct integers");
    for (const workers of counts) validateRun({ ...options, workers });
    const games = values.has("games") ? options.games : Math.max(4, ...counts);
    if (games < Math.max(...counts)) throw new Error("benchmark games must be at least the largest worker count");
    const reports = [];
    for (const workers of counts) {
      if (controller.signal.aborted) break;
      const result = await runSimulation({ ...options, games, workers, observe: false }, { signal: controller.signal });
      const { observed: _, ...summary } = result.summary;
      reports.push({ ...summary, directory: result.directory });
      console.log(JSON.stringify(reports.at(-1), null, 2));
    }
    await mkdir(resolve(options.output), { recursive: true });
    const filename = join(resolve(options.output), `benchmark-${Date.now()}.json`);
    await writeFile(filename, JSON.stringify({ cpusAvailable: availableParallelism(), reports }, null, 2), { flag: "wx" });
    console.log(`Benchmark report: ${filename}`);
    return;
  }
  let latest: RunSnapshot | null = null;
  const server = command === "spectate" ? await startObservationServer(() => latest) : null;
  const vite = command === "spectate" ? spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--host", "127.0.0.1", "--port", "5173", "--strictPort"], { stdio: "inherit", windowsHide: true }) : null;
  let viteFailed = false;
  vite?.on("exit", (code) => { if (!controller.signal.aborted) { viteFailed = true; console.error(`Dashboard server exited (${code})`); controller.abort(); } });
  const stop = () => { server?.close(); vite?.kill(); };
  controller.signal.addEventListener("abort", stop, { once: true });
  if (server) console.log("Spectator: http://127.0.0.1:5173/spectator — Ctrl+C stops the session. Playback speed never controls workers.");
  try {
    const result = await runSimulation(options, { signal: controller.signal, onSnapshot: (value) => { latest = value; } });
    const { observed: _, ...summary } = result.summary;
    console.log(JSON.stringify({ ...summary, directory: result.directory }, null, 2));
    if (viteFailed) throw new Error("Dashboard server failed");
    if (server && !controller.signal.aborted) console.log("Simulation finished; dashboard remains open for replay. Ctrl+C to exit.");
  } catch (error) { controller.abort(); stop(); throw error; }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

import { parentPort } from "node:worker_threads";
import { playGame } from "./game.ts";
import type { RunOptions } from "./config.ts";
if (!parentPort) throw new Error("Simulation worker requires a parent");
parentPort.on("message", async ({ options, index }: { options: RunOptions; index: number }) => {
  try {
    const game = await playGame(options, index, (progress) => parentPort!.postMessage({ type: "progress", progress }));
    parentPort!.postMessage({ type: "game", ...game });
  } catch (error) { parentPort!.postMessage({ type: "failure", error: error instanceof Error ? error.message : String(error) }); }
});

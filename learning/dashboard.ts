import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { startObservationServer } from "../sim/server.ts";
import { parseSnapshot } from "../src/lib/sudalol/spectator.ts";
const root = resolve(process.env["SUDALOL_DATA"] ?? "training-data");
function read(name: string) {
  try {
    return JSON.parse(readFileSync(join(root, name), "utf8"));
  } catch {
    return null;
  }
}
const server = await startObservationServer(
  () => {
    const value = read("simulation.json");
    return value ? parseSnapshot(value) : null;
  },
  8787,
  () => {
    const status = read("status.json");
    if (!status) return null;
    try {
      status.training = readdirSync(join(root, "training"), { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => read(join("training", item.name, "metrics.json")))
        .filter(Boolean)
        .slice(-10);
    } catch {
      /* No training has started. */
    }
    return status;
  },
);
const child = spawn(
  process.execPath,
  [
    resolve("node_modules/vite/bin/vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    "5173",
    "--strictPort",
  ],
  { stdio: "inherit", windowsHide: true },
);
console.log("sudalol training dashboard: http://127.0.0.1:5173/spectator");
function close() {
  child.kill();
  server.close();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
child.once("exit", () => server.close());

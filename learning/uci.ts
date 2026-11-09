import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";

export interface StockfishOptions {
  executable?: string;
  threads: number;
  hash: number;
  depth: number;
  nodes: number;
}
export const STOCKFISH_DEFAULTS: StockfishOptions = { threads: 1, hash: 32, depth: 8, nodes: 5000 };
export class UciOpponent {
  private child: ChildProcessWithoutNullStreams;
  private pending?: {
    accept: (line: string) => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  name = "Stockfish";
  private lines: string[] = [];
  private failure?: Error;
  private options: StockfishOptions;
  constructor(options: StockfishOptions) {
    this.options = options;
    for (const [key, max] of [
      ["threads", availableParallelism()],
      ["hash", 1024],
      ["depth", 30],
      ["nodes", 10000000],
    ] as const)
      if (!Number.isInteger(options[key]) || options[key] < 1 || options[key] > max)
        throw new Error(`Invalid Stockfish ${key}`);
    if (!options.executable && options.threads !== 1)
      throw new Error(
        "Bundled Stockfish is single-threaded; configure a native executable for more threads",
      );
    this.child = spawn(
      options.executable ?? process.execPath,
      options.executable ? [] : [fileURLToPath(new URL("./stockfish.cjs", import.meta.url))],
      { windowsHide: true, stdio: "pipe" },
    );
    this.child.stderr.on("data", () => {});
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.lines.push(line);
      if (this.lines.length > 1000) this.lines.shift();
      if (line.startsWith("id name ")) this.name = line.slice(8);
      if (this.pending?.accept(line)) {
        clearTimeout(this.pending.timer);
        this.pending.resolve();
        this.pending = undefined;
      }
    });
    const fail = (error: Error) => {
      this.failure = error;
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(error);
        this.pending = undefined;
      }
    };
    this.child.on("error", fail);
    this.child.on("exit", (code) => fail(new Error(`Stockfish subprocess exited (${code})`)));
  }
  private command(command: string, accept: (line: string) => boolean) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error("Overlapping UCI request"));
    this.lines = [];
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.child.kill();
        reject(new Error("Stockfish request timed out"));
      }, 120000);
      this.pending = { accept, resolve, reject, timer };
      this.child.stdin.write(command + "\n");
    });
  }
  async initialize() {
    await this.command("uci", (line) => line === "uciok");
    this.child.stdin.write(
      `setoption name Threads value ${this.options.threads}\nsetoption name Hash value ${this.options.hash}\n`,
    );
    await this.command("isready", (line) => line === "readyok");
  }
  async move(fen: string) {
    this.child.stdin.write("ucinewgame\nposition fen " + fen + "\n");
    await this.command(`go depth ${this.options.depth} nodes ${this.options.nodes}`, (line) =>
      line.startsWith("bestmove "),
    );
    const best = [...this.lines]
      .reverse()
      .find((line) => line.startsWith("bestmove "))
      ?.split(" ")[1];
    const info = [...this.lines].reverse().find((line) => line.startsWith("info depth ")) ?? "";
    return {
      move: best && best !== "(none)" ? best : null,
      nodes: Number(info.match(/\bnodes (\d+)/)?.[1] ?? 0),
      completedDepth: Number(info.match(/\bdepth (\d+)/)?.[1] ?? 0),
      score: 0,
      tableHits: 0,
    };
  }
  dispose() {
    this.child.stdin.end("quit\n");
    this.child.kill();
  }
}

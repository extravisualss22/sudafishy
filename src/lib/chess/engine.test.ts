import { afterEach, describe, expect, it, vi } from "vitest";
import { createEngine, type ChessEngine } from "./engine";
import { START_FEN } from "./position";

class TestWorker {
  static instances: TestWorker[] = [];
  static failStartup = false;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  commands: string[] = [];
  terminated = false;
  constructor(public url: string) {
    TestWorker.instances.push(this);
  }
  postMessage(command: string) {
    this.commands.push(command);
    if (command === "uci")
      queueMicrotask(() => {
        if (TestWorker.failStartup) this.onerror?.({ message: "Cannot load worker" });
        else this.emit("uciok");
      });
    if (command === "isready") queueMicrotask(() => this.emit("readyok"));
  }
  emit(data: string) {
    this.onmessage?.({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

const engines: ChessEngine[] = [];
const opts = { depth: 4, movetimeMs: 1000, multiPv: 3 };
const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
async function workerEngine() {
  vi.stubGlobal("Worker", TestWorker);
  const engine = await createEngine();
  engines.push(engine);
  return { engine, worker: TestWorker.instances.at(-1)! };
}
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  engines.splice(0).forEach((engine) => engine.dispose());
  TestWorker.instances = [];
  TestWorker.failStartup = false;
  vi.unstubAllGlobals();
});

describe("Stockfish analysis lifecycle", () => {
  it("drains canceled output before starting only the latest queued position", async () => {
    const { engine, worker } = await workerEngine();
    const oldInfo = vi.fn(),
      middleInfo = vi.fn(),
      newInfo = vi.fn();
    const first = engine.analyze(START_FEN, opts, oldInfo);
    await flush();
    worker.emit("info depth 4 score cp 20 nodes 100 pv e2e4 e7e5");
    expect(oldInfo).toHaveBeenCalledTimes(1);
    const middle = engine.analyze(afterE4, opts, middleInfo);
    const latest = engine.analyze(START_FEN, opts, newInfo);
    await expect(first).resolves.toMatchObject({ done: true });
    await expect(middle).resolves.toMatchObject({ done: true });
    expect(worker.commands.filter((c) => c.startsWith("go "))).toHaveLength(1);
    worker.emit("info depth 6 score cp 10 pv d2d4");
    worker.emit("bestmove e2e4");
    await flush();
    expect(worker.commands.filter((c) => c.startsWith("go "))).toHaveLength(2);
    expect(worker.commands.filter((c) => c.startsWith("position fen "))).toEqual([
      `position fen ${START_FEN}`,
      `position fen ${START_FEN}`,
    ]);
    expect(oldInfo).toHaveBeenCalledTimes(1);
    expect(middleInfo).not.toHaveBeenCalled();
    expect(newInfo).not.toHaveBeenCalled();
    worker.emit("info depth 5 score cp 35 pv g1f3 d7d5");
    worker.emit("bestmove g1f3");
    await expect(latest).resolves.toMatchObject({ bestMove: "g1f3", done: true });
    expect(newInfo).toHaveBeenCalledTimes(2);
  });

  it("stop settles active and pending work and suppresses any subsequent stale callbacks", async () => {
    const { engine, worker } = await workerEngine();
    const info = vi.fn();
    const first = engine.analyze(START_FEN, opts, info);
    await flush();
    const second = engine.analyze(afterE4, opts, info);
    engine.stop();
    await expect(first).resolves.toMatchObject({ done: true });
    await expect(second).resolves.toMatchObject({ done: true });
    worker.emit("bestmove e2e4");
    await flush();
    expect(info).not.toHaveBeenCalled();
    expect(worker.commands.filter((c) => c.startsWith("go "))).toHaveLength(1);
  });

  it("reports White-perspective scores and handles a terminal bestmove", async () => {
    const { engine, worker } = await workerEngine();
    const info = vi.fn();
    const result = engine.analyze(afterE4, opts, info);
    await flush();
    worker.emit("info depth 5 score cp -48 pv e7e5");
    expect(info.mock.calls[0][0].lines[0].cp).toBe(48);
    worker.emit("bestmove 0000");
    await expect(result).resolves.toMatchObject({ bestMove: undefined, done: true });
  });

  it("disposing settles active work and terminates the worker", async () => {
    const { engine, worker } = await workerEngine();
    const info = vi.fn();
    const result = engine.analyze(START_FEN, opts, info);
    await flush();
    engine.dispose();
    await expect(result).resolves.toMatchObject({ done: true });
    expect(worker.terminated).toBe(true);
    worker.emit("bestmove e2e4");
    expect(info).not.toHaveBeenCalled();
    await expect(engine.analyze(START_FEN, opts, info)).rejects.toThrow("Engine closed");
  });

  it("terminates failed initialization attempts before falling back", async () => {
    TestWorker.failStartup = true;
    const { engine } = await workerEngine();
    expect(engine.name).toBe("Basic analysis fallback");
    expect(TestWorker.instances).toHaveLength(2);
    expect(TestWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it("fallback analysis suppresses canceled searches when a new position arrives", async () => {
    vi.stubGlobal("Worker", undefined);
    const engine = await createEngine();
    engines.push(engine);
    const oldInfo = vi.fn(),
      newInfo = vi.fn();
    const first = engine.analyze(START_FEN, { ...opts, depth: 1 }, oldInfo);
    const second = engine.analyze(afterE4, { ...opts, depth: 1 }, newInfo);
    await Promise.all([first, second]);
    expect(oldInfo).not.toHaveBeenCalled();
    expect(newInfo).toHaveBeenCalledTimes(1);
  });
});

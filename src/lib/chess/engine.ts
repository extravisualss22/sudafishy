/**
 * Engine adapter. INTEGRATION POINT: `createEngine()` returns a Stockfish
 * (WebAssembly/asm.js in a Web Worker, served from /public/engine) and falls
 * back to a small built-in search if the worker can't start.
 */
import { Chess } from "chess.js";

export interface EngineLine {
  multipv: number;
  /** Centipawns from White's perspective (undefined when mate). */
  cp?: number;
  /** Moves to mate from White's perspective (+ white mates). */
  mate?: number;
  pv: string[]; // UCI moves
  depth: number;
}

export interface EngineInfo {
  lines: EngineLine[];
  depth: number;
  nodes?: number;
  nps?: number;
  bestMove?: string;
  done: boolean;
  engineName: string;
}

export interface AnalyzeOptions {
  depth: number;
  movetimeMs: number;
  multiPv: number;
}

export interface ChessEngine {
  name: string;
  analyze(fen: string, opts: AnalyzeOptions, onInfo: (i: EngineInfo) => void): Promise<EngineInfo>;
  stop(): void;
  dispose(): void;
}

interface SearchRequest {
  fen: string;
  opts: AnalyzeOptions;
  onInfo: (info: EngineInfo) => void;
  resolve: (info: EngineInfo) => void;
  reject: (error: Error) => void;
  info: EngineInfo;
  lines: Map<number, EngineLine>;
  canceled: boolean;
}

class StockfishEngine implements ChessEngine {
  name: string;
  private worker: Worker;
  private ready: Promise<void>;
  private initialized = false;
  private disposed = false;
  private failure: Error | null = null;
  private active: SearchRequest | null = null;
  private pending: SearchRequest | null = null;
  private barrier = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  constructor(url: string, name: string) {
    this.name = name;
    this.worker = new Worker(url);
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.onmessage = (event) => {
      for (const line of String(event.data).split(/\r?\n/)) this.receive(line.trim());
    };
    this.worker.onerror = (event) =>
      this.fail(new Error(event.message || "Stockfish worker failed"));
    this.deadline(15000, "Stockfish initialization timed out");
    this.send("uci");
  }

  init() {
    return this.ready;
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private deadline(ms: number, message: string) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error(message)), ms);
  }

  private fail(error: Error) {
    if (this.disposed || this.failure) return;
    this.failure = error;
    clearTimeout(this.timer);
    this.worker.terminate();
    this.rejectReady(error);
    this.active?.reject(error);
    this.pending?.reject(error);
    this.active = this.pending = null;
    this.barrier = false;
  }

  private cancel(request: SearchRequest | null) {
    if (!request || request.canceled) return;
    request.canceled = true;
    // Settling canceled work prevents old analyzer calls from hanging. No old
    // callback is delivered after cancellation, even while UCI drains its output.
    request.resolve({ ...request.info, done: true });
  }

  analyze(fen: string, opts: AnalyzeOptions, onInfo: (i: EngineInfo) => void): Promise<EngineInfo> {
    if (this.disposed || this.failure)
      return Promise.reject(this.failure || new Error("Engine closed"));
    this.cancel(this.pending);
    const promise = new Promise<EngineInfo>((resolve, reject) => {
      this.pending = {
        fen,
        opts,
        onInfo,
        resolve,
        reject,
        canceled: false,
        lines: new Map(),
        info: { lines: [], depth: 0, done: false, engineName: this.name },
      };
    });
    if (this.active && !this.active.canceled) {
      this.cancel(this.active);
      this.deadline(10000, "Stockfish did not stop its previous search");
      this.send("stop");
    }
    this.pump();
    return promise;
  }

  private pump() {
    if (
      !this.initialized ||
      this.disposed ||
      this.failure ||
      this.active ||
      this.barrier ||
      !this.pending
    )
      return;
    this.barrier = true;
    this.deadline(10000, "Stockfish is not responding");
    this.send("isready");
  }

  private receive(line: string) {
    if (this.disposed || this.failure) return;
    if (!this.initialized) {
      if (line === "uciok") this.send("isready");
      if (line === "readyok") {
        clearTimeout(this.timer);
        this.initialized = true;
        this.resolveReady();
        this.pump();
      }
      return;
    }
    if (line === "readyok" && this.barrier) {
      this.barrier = false;
      clearTimeout(this.timer);
      const request = this.pending;
      this.pending = null;
      if (!request) return;
      this.active = request;
      this.send(`setoption name MultiPV value ${request.opts.multiPv}`);
      this.send("ucinewgame");
      this.send(`position fen ${request.fen}`);
      this.deadline(
        Math.max(10000, request.opts.movetimeMs + 15000),
        "Stockfish analysis timed out",
      );
      this.send(`go depth ${request.opts.depth} movetime ${request.opts.movetimeMs}`);
      return;
    }
    const request = this.active;
    if (!request) return;
    if (line.startsWith("bestmove ")) {
      clearTimeout(this.timer);
      this.active = null;
      if (!request.canceled) {
        const bm = line.split(" ")[1];
        const info = {
          ...request.info,
          bestMove: bm && bm !== "(none)" && bm !== "0000" ? bm : undefined,
          done: true,
        };
        request.onInfo(info);
        request.resolve(info);
      }
      this.pump();
      return;
    }
    if (request.canceled || !line.startsWith("info ") || !line.includes(" pv ")) return;
    const tok = line.split(/\s+/);
    const get = (key: string) => {
      const i = tok.indexOf(key);
      return i >= 0 ? tok[i + 1] : undefined;
    };
    const depth = Number(get("depth"));
    const mpv = Number(get("multipv") ?? 1);
    const si = tok.indexOf("score");
    const value = Number(tok[si + 2]);
    if (!Number.isFinite(depth) || si < 0 || !Number.isFinite(value)) return;
    const sign = request.fen.split(" ")[1] === "b" ? -1 : 1;
    request.lines.set(mpv, {
      multipv: mpv,
      depth,
      pv: tok.slice(tok.indexOf("pv") + 1),
      cp: get("score") === "cp" ? value * sign : undefined,
      mate: get("score") === "mate" ? value * sign : undefined,
    });
    request.info = {
      ...request.info,
      depth: Math.max(request.info.depth, depth),
      nodes: Number(get("nodes")) || request.info.nodes,
      nps: Number(get("nps")) || request.info.nps,
      lines: [...request.lines.values()]
        .sort((a, b) => a.multipv - b.multipv)
        .slice(0, request.opts.multiPv),
    };
    request.onInfo(request.info);
  }

  stop() {
    this.cancel(this.pending);
    this.pending = null;
    if (this.active && !this.active.canceled) {
      this.cancel(this.active);
      this.deadline(10000, "Stockfish did not stop its previous search");
      this.send("stop");
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.cancel(this.active);
    this.cancel(this.pending);
    this.active = this.pending = null;
    this.rejectReady(new Error("Engine closed"));
    this.worker.terminate();
  }
}

/** Minimal material-based negamax used when Stockfish is unavailable. */
class FallbackEngine implements ChessEngine {
  name = "Basic analysis fallback";
  private generation = 0;
  private disposed = false;
  private static V: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  private evaluate(c: Chess): number {
    let s = 0;
    for (const row of c.board())
      for (const sq of row) if (sq) s += (sq.color === "w" ? 1 : -1) * FallbackEngine.V[sq.type];
    return s;
  }
  private nodes = 0;
  private negamax(c: Chess, d: number, a: number, b: number): number {
    this.nodes++;
    if (c.isCheckmate()) return -100000 - d;
    if (c.isDraw() || c.isStalemate()) return 0;
    if (d === 0) return (c.turn() === "w" ? 1 : -1) * this.evaluate(c);
    let best = -Infinity;
    for (const m of c.moves({ verbose: true })) {
      c.move(m);
      const v = -this.negamax(c, d - 1, -b, -a);
      c.undo();
      if (v > best) best = v;
      if (v > a) a = v;
      if (a >= b) break;
    }
    return best;
  }

  async analyze(fen: string, opts: AnalyzeOptions, onInfo: (i: EngineInfo) => void) {
    if (this.disposed) throw new Error("Engine closed");
    const generation = ++this.generation;
    this.nodes = 0;
    const t0 = performance.now();
    const c = new Chess(fen);
    const sign = c.turn() === "w" ? 1 : -1;
    const depth = Math.min(opts.depth, 3);
    const scored: { uci: string; v: number }[] = [];
    for (const m of c.moves({ verbose: true })) {
      if (generation !== this.generation) break;
      c.move(m);
      const v = -this.negamax(c, depth - 1, -Infinity, Infinity);
      c.undo();
      scored.push({ uci: m.from + m.to + (m.promotion ?? ""), v });
      await new Promise((r) => setTimeout(r, 0));
    }
    scored.sort((a, b) => b.v - a.v);
    const lines: EngineLine[] = scored.slice(0, opts.multiPv).map((s, i) => {
      const mate = Math.abs(s.v) > 50000;
      return {
        multipv: i + 1,
        depth,
        pv: [s.uci],
        cp: mate ? undefined : s.v * sign,
        mate: mate ? Math.sign(s.v) * sign : undefined,
      };
    });
    const secs = (performance.now() - t0) / 1000;
    const info: EngineInfo = {
      lines,
      depth,
      nodes: this.nodes,
      nps: Math.round(this.nodes / Math.max(secs, 0.001)),
      bestMove: lines[0]?.pv[0],
      done: true,
      engineName: this.name,
    };
    if (generation === this.generation) onInfo(info);
    return info;
  }
  stop() {
    this.generation++;
  }
  dispose() {
    this.disposed = true;
    this.stop();
  }
}

export async function createEngine(): Promise<ChessEngine> {
  if (typeof Worker === "undefined") return new FallbackEngine();
  const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
  const wasm = `${base}engine/stockfish-19-lite-single.js`;
  const asm = `${base}engine/stockfish-19-asm.js`;
  const wasmBuild = { url: wasm, name: "Stockfish" };
  const jsBuild = { url: asm, name: "Stockfish" };
  const builds = typeof WebAssembly === "object" ? [wasmBuild, jsBuild] : [jsBuild];
  for (const { url, name } of builds) {
    try {
      const e = new StockfishEngine(url, name);
      await e.init();
      return e;
    } catch {
      /* try next */
    }
  }
  return new FallbackEngine();
}

/** Convert a UCI PV into SAN given a starting FEN. */
export function pvToSan(fen: string, pv: string[], max = 12): string[] {
  try {
    const c = new Chess(fen);
    const out: string[] = [];
    for (const u of pv.slice(0, max)) {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    }
    return out;
  } catch {
    return pv.slice(0, max);
  }
}

export function formatScore(l?: Pick<EngineLine, "cp" | "mate">): string {
  if (!l) return "0.00";
  if (l.mate !== undefined) return `${l.mate > 0 ? "+" : "-"}M${Math.abs(l.mate)}`;
  const v = (l.cp ?? 0) / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

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

class StockfishEngine implements ChessEngine {
  name: string;
  private worker: Worker;
  private ready: Promise<void>;
  private listener: ((line: string) => void) | null = null;

  constructor(url: string, name: string) {
    this.name = name;
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => this.listener?.(String(e.data));
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Engine timeout")), 15000);
      this.listener = (line) => {
        if (line === "uciok") this.send("isready");
        if (line === "readyok") {
          clearTimeout(t);
          resolve();
        }
      };
      this.worker.onerror = (err) => {
        clearTimeout(t);
        reject(err);
      };
      this.send("uci");
    });
  }

  init() {
    return this.ready;
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  async analyze(fen: string, opts: AnalyzeOptions, onInfo: (i: EngineInfo) => void) {
    await this.ready;
    const whiteToMove = fen.split(" ")[1] !== "b";
    const sign = whiteToMove ? 1 : -1;
    const lines = new Map<number, EngineLine>();
    let info: EngineInfo = { lines: [], depth: 0, done: false, engineName: this.name };
    return new Promise<EngineInfo>((resolve) => {
      this.listener = (line) => {
        if (line.startsWith("info") && line.includes(" pv ")) {
          const tok = line.split(" ");
          const get = (k: string) => {
            const i = tok.indexOf(k);
            return i >= 0 ? tok[i + 1] : undefined;
          };
          const depth = Number(get("depth"));
          const mpv = Number(get("multipv") ?? 1);
          const scoreType = get("score");
          const si = tok.indexOf("score");
          const val = Number(tok[si + 2]);
          const pv = tok.slice(tok.indexOf("pv") + 1);
          lines.set(mpv, {
            multipv: mpv,
            depth,
            pv,
            cp: scoreType === "cp" ? val * sign : undefined,
            mate: scoreType === "mate" ? val * sign : undefined,
          });
          info = {
            ...info,
            depth: Math.max(info.depth, depth),
            nodes: Number(get("nodes")) || info.nodes,
            nps: Number(get("nps")) || info.nps,
            lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv).slice(0, opts.multiPv),
          };
          onInfo(info);
        } else if (line.startsWith("bestmove")) {
          const bm = line.split(" ")[1];
          info = { ...info, bestMove: bm && bm !== "(none)" ? bm : undefined, done: true };
          onInfo(info);
          resolve(info);
        }
      };
      this.send("stop");
      this.send(`setoption name MultiPV value ${opts.multiPv}`);
      this.send("ucinewgame");
      this.send(`position fen ${fen}`);
      this.send(`go depth ${opts.depth} movetime ${opts.movetimeMs}`);
    });
  }

  stop() {
    this.send("stop");
  }
  dispose() {
    this.worker.terminate();
  }
}

/** Minimal material-based negamax used when Stockfish is unavailable. */
class FallbackEngine implements ChessEngine {
  name = "Sudafish Basic";
  private stopped = false;
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
    this.stopped = false;
    this.nodes = 0;
    const t0 = performance.now();
    const c = new Chess(fen);
    const sign = c.turn() === "w" ? 1 : -1;
    const depth = Math.min(opts.depth, 3);
    const scored: { uci: string; v: number }[] = [];
    for (const m of c.moves({ verbose: true })) {
      if (this.stopped) break;
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
    onInfo(info);
    return info;
  }
  stop() {
    this.stopped = true;
  }
  dispose() {}
}

export async function createEngine(): Promise<ChessEngine> {
  if (typeof Worker === "undefined") return new FallbackEngine();
  const base = (import.meta.env.BASE_URL || "/").replace(/\/?$/, "/");
  const wasm = `${base}engine/stockfish-19-lite-single.js`;
  const asm = `${base}engine/stockfish-19-asm.js`;
  const wasmBuild = { url: wasm, name: "Sudafish" };
  const jsBuild = { url: asm, name: "Sudafish" };
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

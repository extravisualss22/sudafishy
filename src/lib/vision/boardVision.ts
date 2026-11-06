// BoardVision: reads a chess position from a captured image frame.
// All processing is local (canvas pixels in the browser) — nothing is uploaded.
// Swap `createBoardVision()` to plug in a stronger CV model later.
import { buildFen, FILES, parseFen, type BoardMap, type PieceCode } from "@/lib/chess/position";

export interface VisionFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
/** Board area in frame pixels. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type Orientation = "auto" | "white" | "black";
export interface SquareReading {
  square: string;
  piece: PieceCode | null;
  confidence: number;
}
export interface BoardReading {
  board: BoardMap;
  squares: SquareReading[];
  /** 0..1 average certainty across the 64 squares */
  confidence: number;
  orientation: "white" | "black";
  /** FEN piece-placement field only */
  placement: string;
}
export interface BoardVision {
  readonly name: string;
  ready(): Promise<void>;
  read(frame: VisionFrame, crop: CropRect, orientation: Orientation): Promise<BoardReading>;
}

const N = 40; // samples per square side
const T = 20; // normalized shape size
const TYPES = ["K", "Q", "R", "B", "N", "P"] as const;
type Mask = Uint8Array;

/** Mark everything not reachable from the border through empty pixels as filled. */
function fillHoles(mask: Mask, w: number, h: number): Mask {
  const out = new Uint8Array(w * h).fill(1);
  const stack: number[] = [];
  const push = (i: number) => {
    if (out[i] && !mask[i]) {
      out[i] = 0;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x));
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1));
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return out;
}

/** Crop a mask to its bounding box and resample to T×T (scale-invariant shape). */
function normalize(mask: Mask, w: number, h: number): Mask | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const out = new Uint8Array(T * T);
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++)
      out[y * T + x] = mask[(y0 + Math.floor(((y + 0.5) * bh) / T)) * w + x0 + Math.floor(((x + 0.5) * bw) / T)];
  return out;
}

function iou(a: Mask, b: Mask) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) {
    if (a[k] && b[k]) i++;
    if (a[k] || b[k]) u++;
  }
  return u ? i / u : 0;
}

const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Map image cell (row from top, col from left) to a square name. */
export function cellToSquare(row: number, col: number, o: "white" | "black") {
  return o === "white" ? `${FILES[col]}${8 - row}` : `${FILES[7 - col]}${row + 1}`;
}

export function placementOf(board: BoardMap) {
  return buildFen({ ...parseFen("8/8/8/8/8/8/8/8 w - - 0 1"), board }).split(" ")[0];
}

/** Baseline detector: background subtraction per square + silhouette template matching. */
export class HeuristicBoardVision implements BoardVision {
  readonly name = "Heuristic templates v1";
  private templates: { type: (typeof TYPES)[number]; mask: Mask }[] = [];
  private loading: Promise<void> | null = null;

  constructor(private pieceUrl: (p: PieceCode) => string) {}

  ready() {
    this.loading ??= Promise.all(
      TYPES.map(async (type) => {
        const img = new Image();
        img.src = this.pieceUrl(`w${type}` as PieceCode);
        await img.decode();
        const S = 64;
        const c = document.createElement("canvas");
        c.width = c.height = S;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, S, S);
        const d = ctx.getImageData(0, 0, S, S).data;
        const m = new Uint8Array(S * S);
        for (let i = 0; i < S * S; i++) m[i] = d[i * 4 + 3] > 128 ? 1 : 0;
        this.templates.push({ type, mask: normalize(fillHoles(m, S, S), S, S)! });
      }),
    ).then(() => undefined);
    return this.loading;
  }

  async read(frame: VisionFrame, crop: CropRect, orientation: Orientation): Promise<BoardReading> {
    await this.ready();
    const cells: { piece: PieceCode | null; confidence: number }[][] = [];
    const cw = crop.w / 8, ch = crop.h / 8;
    for (let r = 0; r < 8; r++) {
      cells.push([]);
      for (let c = 0; c < 8; c++) {
        cells[r].push(this.readCell(frame, crop.x + c * cw, crop.y + r * ch, cw, ch));
      }
    }
    let o: "white" | "black" = orientation === "black" ? "black" : "white";
    if (orientation === "auto") {
      let topW = 0, botW = 0;
      cells.forEach((row, r) => row.forEach((x) => x.piece?.[0] === "w" && (r < 4 ? topW++ : botW++)));
      o = topW > botW ? "black" : "white";
    }
    const board: BoardMap = {};
    const squares: SquareReading[] = [];
    cells.forEach((row, r) =>
      row.forEach((x, c) => {
        const sq = cellToSquare(r, c, o);
        if (x.piece) board[sq] = x.piece;
        squares.push({ square: sq, ...x });
      }),
    );
    const confidence = squares.reduce((s, x) => s + x.confidence, 0) / 64;
    return { board, squares, confidence, orientation: o, placement: placementOf(board) };
  }

  private readCell(f: VisionFrame, x: number, y: number, w: number, h: number) {
    const inset = 0.04;
    const px = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const sx = Math.min(f.width - 1, Math.max(0, Math.floor(x + w * (inset + ((1 - 2 * inset) * (i + 0.5)) / N))));
        const sy = Math.min(f.height - 1, Math.max(0, Math.floor(y + h * (inset + ((1 - 2 * inset) * (j + 0.5)) / N))));
        const k = (sy * f.width + sx) * 4, o = (j * N + i) * 3;
        px[o] = f.data[k];
        px[o + 1] = f.data[k + 1];
        px[o + 2] = f.data[k + 2];
      }
    // background = median colour of the outer ring
    const ring: number[][] = [[], [], []];
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++)
        if (i < 2 || j < 2 || i >= N - 2 || j >= N - 2) for (let ch = 0; ch < 3; ch++) ring[ch].push(px[(j * N + i) * 3 + ch]);
    const bg = ring.map(median);
    const raw = new Uint8Array(N * N);
    let count = 0;
    for (let k = 0; k < N * N; k++) {
      const d = Math.abs(px[k * 3] - bg[0]) + Math.abs(px[k * 3 + 1] - bg[1]) + Math.abs(px[k * 3 + 2] - bg[2]);
      // ignore the ring so coordinates/borders don't count as pieces
      const i = k % N, j = (k / N) | 0;
      if (d > 60 && i > 1 && j > 1 && i < N - 2 && j < N - 2) (raw[k] = 1), count++;
    }
    const filled = fillHoles(raw, N, N);
    let area = 0, lum = 0;
    for (let k = 0; k < N * N; k++)
      if (filled[k]) {
        area++;
        lum += 0.299 * px[k * 3] + 0.587 * px[k * 3 + 1] + 0.114 * px[k * 3 + 2];
      }
    const occ = area / (N * N);
    if (occ < 0.08 || count < N) return { piece: null, confidence: clamp01(1 - occ / 0.16) };
    const color = lum / area > 128 ? "w" : "b";
    const shape = normalize(filled, N, N)!;
    const scores = this.templates.map((t) => ({ type: t.type, s: iou(shape, t.mask) })).sort((a, b) => b.s - a.s);
    const [best, second] = scores;
    const confidence = clamp01(best.s) * clamp01(0.55 + (best.s - second.s) * 5);
    return { piece: `${color}${best.type}` as PieceCode, confidence };
  }
}

export function createBoardVision(pieceUrl: (p: PieceCode) => string): BoardVision {
  return new HeuristicBoardVision(pieceUrl);
}

/** Snapshot the current video frame. */
export function grabFrame(video: HTMLVideoElement): { frame: VisionFrame; url: string } | null {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  return { frame: { data: img.data, width: w, height: h }, url: c.toDataURL("image/jpeg", 0.8) };
}

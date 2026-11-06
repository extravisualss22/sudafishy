import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cellToSquare,
  grabFrame,
  HeuristicBoardVision,
  validateFrameCrop,
  type VisionFrame,
} from "./boardVision";
import type { PieceCode } from "@/lib/chess/position";

const size = 64;
function silhouette(type: string, x: number, y: number): boolean {
  const base = x > 12 && x < 52 && y > 49 && y < 56;
  switch (type) {
    case "P":
      return base || (x - 32) ** 2 + (y - 20) ** 2 < 100 || (x > 24 && x < 40 && y > 24 && y < 50);
    case "R":
      return (
        base ||
        (x > 17 && x < 47 && y > 20 && y < 50) ||
        (y > 9 && y < 24 && x > 14 && x < 50 && (x < 23 || x > 41 || (x > 29 && x < 35)))
      );
    case "K":
      return (
        base || (x > 26 && x < 38 && y > 7 && y < 50) || (x > 17 && x < 47 && y > 15 && y < 23)
      );
    case "Q":
      return base || (y > 12 && y < 50 && Math.abs(x - 32) < 25 - (y - 12) / 2);
    case "B":
      return base || Math.abs(x - 32) / 17 + Math.abs(y - 28) / 23 < 1;
    default:
      return (
        base || (x > 14 && x < 30 && y > 25 && y < 50) || (x > 14 && x < 50 && y > 12 && y < 30)
      );
  }
}
function template(piece: string) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      data[(y * size + x) * 4 + 3] = silhouette(piece.slice(-1), x, y) ? 255 : 0;
  return { data, width: size, height: size };
}
function fixture(
  pieces: { row: number; col: number; piece: PieceCode; grey?: boolean }[],
): VisionFrame {
  const width = size * 8;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const row = Math.floor(y / size),
        col = Math.floor(x / size);
      const piece = pieces.find((item) => item.row === row && item.col === col);
      const foreground = piece && silhouette(piece.piece[1], x % size, y % size);
      const rgb = foreground
        ? Array(3).fill(piece.grey ? 130 : piece.piece[0] === "w" ? 248 : 25)
        : (row + col) % 2
          ? [110, 145, 100]
          : [222, 220, 200];
      const i = (y * width + x) * 4;
      data.set([...rgb, 255], i);
    }
  return { width, height: width, data };
}
function mockTemplates(failFirst = false) {
  let failure = failFirst;
  const decode = vi.fn(async () => {
    if (failure) {
      failure = false;
      throw new Error("Temporary image failure");
    }
  });
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    let source = "";
    return {
      drawImage: (image: { src: string }) => {
        source = image.src;
      },
      getImageData: () => template(source),
    } as unknown as CanvasRenderingContext2D;
  });
  return decode;
}
const crop = { x: 0, y: 0, w: 512, h: 512 };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("local board vision", () => {
  it("maps cells in both explicit orientations", () => {
    expect(cellToSquare(0, 0, "white")).toBe("a8");
    expect(cellToSquare(0, 0, "black")).toBe("h1");
    expect(cellToSquare(7, 7, "black")).toBe("a8");
  });
  it("rejects invalid frames and crops instead of clamping a wrong board", async () => {
    const frame = fixture([]);
    expect(() => validateFrameCrop({ ...frame, data: new Uint8ClampedArray(1) }, crop)).toThrow(
      /pixel data/,
    );
    expect(() => validateFrameCrop(frame, { ...crop, x: -1 })).toThrow(/outside/);
    expect(() => validateFrameCrop(frame, { ...crop, h: 400 })).toThrow(/square/);
    expect(() => validateFrameCrop(frame, { ...crop, w: NaN })).toThrow(/64 pixels/);
    expect(() => validateFrameCrop(frame, { ...crop, x: 5 })).toThrow(/outside/);
    const vision = new HeuristicBoardVision((piece) => piece);
    await expect(vision.read(frame, { ...crop, w: 1 }, "white")).rejects.toThrow(/64 pixels/);
  });
  it("estimates occupied squares, colors and piece silhouettes with a complete 64-square reading", async () => {
    mockTemplates();
    const vision = new HeuristicBoardVision((piece) => piece);
    const frame = fixture([
      { row: 0, col: 0, piece: "bR" },
      { row: 6, col: 4, piece: "wP" },
      { row: 7, col: 4, piece: "wK" },
    ]);
    const reading = await vision.read(frame, crop, "white");
    expect(reading.squares).toHaveLength(64);
    expect(reading.board).toEqual({ a8: "bR", e2: "wP", e1: "wK" });
    expect(reading.squares.find((square) => square.square === "e4")?.piece).toBeNull();
    expect(reading.orientationConfidence).toBe(1);
    expect(reading.confidence).toBeGreaterThan(0);
    expect(reading.confidence).toBeLessThan(1);
    expect(reading.placement).toBe("r7/8/8/8/8/8/4P3/4K3");
  });
  it("marks auto orientation as uncertain on an empty image and does not call an empty board confident", async () => {
    mockTemplates();
    const reading = await new HeuristicBoardVision((piece) => piece).read(
      fixture([]),
      crop,
      "auto",
    );
    expect(reading.orientationConfidence).toBe(0.5);
    expect(reading.confidence).toBe(0);
    expect(reading.board).toEqual({});
  });
  it("infers flipped orientation and discounts ambiguous piece color despite many empty squares", async () => {
    mockTemplates();
    const vision = new HeuristicBoardVision((piece) => piece);
    const frame = fixture([
      { row: 0, col: 0, piece: "wR" },
      { row: 7, col: 7, piece: "bR" },
    ]);
    const reading = await vision.read(frame, crop, "auto");
    expect(reading.orientation).toBe("black");
    expect(reading.orientationConfidence).toBeGreaterThan(0.8);
    expect(reading.board).toEqual({ h1: "wR", a8: "bR" });
    const ambiguous = await vision.read(
      fixture([{ row: 7, col: 0, piece: "wR", grey: true }]),
      crop,
      "white",
    );
    expect(ambiguous.confidence).toBeLessThan(0.5);
  });
  it("retries template loading after failure without accumulating partial templates", async () => {
    const decode = mockTemplates(true);
    const vision = new HeuristicBoardVision((piece) => piece);
    await expect(vision.ready()).rejects.toThrow(/local piece templates/);
    await expect(vision.ready()).resolves.toBeUndefined();
    expect(decode).toHaveBeenCalledTimes(12);
    await vision.ready();
    expect(decode).toHaveBeenCalledTimes(12);
  });
  it("handles missing frames/canvas and can avoid JPEG encoding during watch sampling", () => {
    const video = document.createElement("video");
    expect(grabFrame(video)).toBeNull();
    Object.defineProperties(video, { videoWidth: { value: 64 }, videoHeight: { value: 64 } });
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(() => grabFrame(video)).toThrow(/Canvas processing/);
    const image = template("wK");
    context.mockReturnValue({
      drawImage: vi.fn(),
      getImageData: () => image,
    } as unknown as CanvasRenderingContext2D);
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue("data:image/jpeg,test");
    expect(grabFrame(video, { preview: false })?.url).toBe("");
    expect(encode).not.toHaveBeenCalled();
    expect(grabFrame(video)?.url).toBe("data:image/jpeg,test");
  });
});

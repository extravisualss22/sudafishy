import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chess } from "chess.js";
import { parseFen, START_FEN, type BoardMap } from "@/lib/chess/position";
import type { BoardReading } from "@/lib/vision/boardVision";
import { ScreenSharePanel } from "./ScreenSharePanel";

const { read, grabFrame } = vi.hoisted(() => ({ read: vi.fn(), grabFrame: vi.fn() }));
vi.mock("@/lib/vision/boardVision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vision/boardVision")>();
  return {
    ...actual,
    createBoardVision: () => ({ name: "Test vision", read, ready: async () => {} }),
    grabFrame,
  };
});

const image = {
  frame: { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4) },
  url: "data:image/png;base64,test",
};
function reading(fen = START_FEN, confidence = 0.95): BoardReading {
  const board = parseFen(fen).board;
  return {
    board,
    placement: fen.split(" ")[0],
    confidence,
    orientation: "white",
    orientationConfidence: 0.95,
    squares: Array.from({ length: 64 }, (_, index) => {
      const square = "abcdefgh"[index % 8] + (8 - Math.floor(index / 8));
      return { square, piece: board[square] ?? null, confidence };
    }),
  };
}
let stopTrack: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;
let ended: (() => void) | undefined;
let stream: MediaStream;
beforeEach(() => {
  read.mockReset().mockResolvedValue(reading());
  grabFrame.mockReset().mockReturnValue(image);
  ended = undefined;
  stopTrack = vi.fn();
  const track = {
    stop: stopTrack,
    addEventListener: (_type: string, fn: () => void) => {
      ended = fn;
    },
  };
  stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  getDisplayMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getDisplayMedia },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function sharing() {
  fireEvent.click(screen.getByRole("button", { name: "Share Screen" }));
  await screen.findByRole("button", { name: "Detect Board" });
}
async function reviewPosition() {
  await sharing();
  fireEvent.click(screen.getByRole("button", { name: "Detect Board" }));
  fireEvent.click(screen.getByRole("button", { name: "Read board" }));
  await screen.findByRole("button", { name: "Use Position" });
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1750);
  });
}

describe("ScreenSharePanel", () => {
  it("captures locally, shows confidence, corrects pieces and turn, then applies for analysis", async () => {
    const detection = reading();
    detection.squares.find((square) => square.square === "e2")!.confidence = 0.3;
    read.mockResolvedValue(detection);
    const onApply = vi.fn();
    render(<ScreenSharePanel turn="w" onApply={onApply} />);
    await reviewPosition();
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText("95%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /e2: white pawn, low confidence/ })).toHaveAttribute(
      "data-low-confidence",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Brush white knight" }));
    fireEvent.click(screen.getByRole("button", { name: /e2: white pawn, low confidence/ }));
    expect(screen.getByRole("button", { name: "e2: white knight" })).toHaveAttribute(
      "data-low-confidence",
      "false",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Black to move" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Position" }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ e2: "wN" }), "b", true);
    expect(screen.getByRole("switch", { name: "Watch Board" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop Sharing" }));
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Share Screen" })).toBeInTheDocument();
  });

  it("keeps invalid reviewed positions for correction and allows erasing", async () => {
    const onApply = vi.fn();
    render(<ScreenSharePanel turn="w" onApply={onApply} />);
    await reviewPosition();
    fireEvent.click(screen.getByRole("button", { name: "Erase" }));
    fireEvent.click(screen.getByRole("button", { name: "e1: white king" }));
    fireEvent.click(screen.getByRole("button", { name: "Use Position" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/Please correct the position/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    expect(screen.getByRole("slider", { name: "Board crop area" })).toBeInTheDocument();
  });

  it("offers keyboard crop control and keeps Stop Sharing available during detection and review", async () => {
    let resolveRead!: (value: BoardReading) => void;
    read.mockImplementation(
      () =>
        new Promise<BoardReading>((resolve) => {
          resolveRead = resolve;
        }),
    );
    render(<ScreenSharePanel turn="w" onApply={vi.fn()} />);
    await sharing();
    fireEvent.click(screen.getByRole("button", { name: "Detect Board" }));
    const crop = screen.getByRole("slider", { name: "Board crop area" });
    fireEvent.keyDown(crop, { key: "ArrowLeft" });
    expect(crop).toHaveStyle({ left: "19%" });
    fireEvent.keyDown(crop, { key: "ArrowLeft", shiftKey: true });
    expect(crop).toHaveAttribute("aria-valuenow", "59");
    fireEvent.click(screen.getByRole("button", { name: "Read board" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Sharing" }));
    await act(async () => {
      resolveRead(reading());
    });
    expect(screen.queryByRole("button", { name: "Use Position" })).not.toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("handles unsupported capture, cancellation, and permission completion after unmount", async () => {
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: {} });
    const unsupported = render(<ScreenSharePanel turn="w" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Screen" }));
    expect(screen.getByText(/Screen sharing is unavailable/)).toBeInTheDocument();
    unsupported.unmount();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getDisplayMedia },
    });
    getDisplayMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const cancelled = render(<ScreenSharePanel turn="w" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Screen" }));
    await screen.findByText(/cancelled or blocked/);
    cancelled.unmount();
    let resolveMedia!: (value: MediaStream) => void;
    getDisplayMedia.mockImplementation(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveMedia = resolve;
        }),
    );
    const pending = render(<ScreenSharePanel turn="w" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Share Screen" }));
    pending.unmount();
    await act(async () => {
      resolveMedia(stream);
    });
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("requires two consecutive confident samples and opens review when auto-update is off", async () => {
    const onApply = vi.fn();
    render(<ScreenSharePanel turn="w" onApply={onApply} />);
    await reviewPosition();
    fireEvent.click(screen.getByRole("button", { name: "Use Position" }));
    const chess = new Chess();
    chess.move("e4");
    read.mockResolvedValue(reading(chess.fen()));
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("switch", { name: "Watch Board" }));
    await tick();
    expect(screen.queryByRole("button", { name: "Use Position" })).not.toBeInTheDocument();
    await tick();
    expect(screen.getByRole("button", { name: "Use Position" })).toBeInTheDocument();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("radio", { name: "Black to move" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("auto-updates stable legal changes, resets stability on weak readings, and does not guess turns", async () => {
    const onApply = vi.fn();
    render(<ScreenSharePanel turn="w" onApply={onApply} />);
    await reviewPosition();
    fireEvent.click(screen.getByRole("button", { name: "Use Position" }));
    const chess = new Chess();
    chess.move("e4");
    const next = reading(chess.fen());
    read
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(reading(chess.fen(), 0.4))
      .mockResolvedValue(next);
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("switch", { name: "Watch Board" }));
    fireEvent.click(screen.getByRole("switch", { name: "Auto-update and analyze" }));
    await tick();
    await tick();
    await tick();
    expect(onApply).toHaveBeenCalledTimes(1);
    await tick();
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(next.board, "b", true, expect.stringContaining(" b "));
    chess.move("e5");
    chess.move("Nf3");
    read.mockResolvedValue(reading(chess.fen()));
    await tick();
    await tick();
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Use Position" })).toBeInTheDocument();
    expect(screen.getByText(/next turn could not be verified/)).toBeInTheDocument();
  });

  it("pauses watching when the analyzer changes castling rights without moving pieces", async () => {
    const onApply = vi.fn();
    const initial = START_FEN.replace("KQkq", "-");
    const view = render(<ScreenSharePanel turn="w" fen={initial} onApply={onApply} />);
    await reviewPosition();
    fireEvent.click(screen.getByRole("button", { name: "Use Position" }));
    fireEvent.click(screen.getByRole("switch", { name: "Watch Board" }));
    view.rerender(<ScreenSharePanel turn="w" fen={START_FEN} onApply={onApply} />);
    expect(screen.getByRole("switch", { name: "Watch Board" })).toBeDisabled();
    expect(screen.getByText(/main position changed/)).toBeInTheDocument();
  });

  it("stops tracks when browser sharing ends and ignores pending watch results", async () => {
    const onApply = vi.fn();
    render(<ScreenSharePanel turn="w" onApply={onApply} />);
    await reviewPosition();
    fireEvent.click(screen.getByRole("button", { name: "Use Position" }));
    let resolveRead!: (value: BoardReading) => void;
    read.mockImplementation(
      () =>
        new Promise<BoardReading>((resolve) => {
          resolveRead = resolve;
        }),
    );
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("switch", { name: "Watch Board" }));
    await tick();
    await act(async () => {
      ended?.();
    });
    await act(async () => {
      resolveRead(reading());
    });
    expect(screen.getByRole("button", { name: "Share Screen" })).toBeInTheDocument();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(stopTrack).toHaveBeenCalledOnce();
  });
});

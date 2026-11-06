import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { START_FEN, type BoardMap } from "@/lib/chess/position";
import type { ChessEngine, EngineInfo } from "@/lib/chess/engine";

const mocks = vi.hoisted(() => ({
  createEngine: vi.fn(),
  apply: null as null | ((board: BoardMap, turn: "w" | "b", analyze: boolean) => boolean),
}));
vi.mock("@/lib/chess/engine", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createEngine: mocks.createEngine,
}));
vi.mock("./ScreenSharePanel", () => ({
  ScreenSharePanel: (props: { onApply: NonNullable<typeof mocks.apply> }) => {
    mocks.apply = props.onApply;
    return <div>Screen board reader</div>;
  },
}));
import { ChessAnalyzer } from "./ChessAnalyzer";

let engine: ChessEngine;
const result: EngineInfo = { lines: [], depth: 1, done: true, engineName: "Sudafish" };
beforeEach(() => {
  localStorage.clear();
  engine = {
    name: "Sudafish",
    analyze: vi.fn().mockResolvedValue(result),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  mocks.createEngine.mockReset().mockResolvedValue(engine);
});
afterEach(cleanup);
const reviewed: BoardMap = { e1: "wK", e8: "bK", a1: "wR" };

describe("screen-share analyzer integration", () => {
  it("loads the reviewed FEN, drops historical rights, automatically analyzes that exact position, and supports undo", async () => {
    render(<ChessAnalyzer />);
    act(() => {
      expect(mocks.apply!(reviewed, "b", true)).toBe(true);
    });
    const target = "4k3/8/8/8/8/8/8/R3K3 b - - 0 1";
    await waitFor(() =>
      expect(engine.analyze).toHaveBeenCalledWith(target, expect.any(Object), expect.any(Function)),
    );
    expect(screen.getByLabelText("FEN")).toHaveValue(target);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByLabelText("FEN")).toHaveValue(START_FEN);
  });

  it("rejects invalid corrected boards without altering the analyzer", () => {
    render(<ChessAnalyzer />);
    act(() => {
      expect(mocks.apply!({ e1: "wK" }, "w", true)).toBe(false);
    });
    expect(mocks.createEngine).not.toHaveBeenCalled();
    expect(screen.getByLabelText("FEN")).toHaveValue(START_FEN);
  });

  it("initializes one engine and only analyzes the latest position if the board changes during startup", async () => {
    let resolve!: (engine: ChessEngine) => void;
    mocks.createEngine.mockReturnValue(
      new Promise<ChessEngine>((r) => {
        resolve = r;
      }),
    );
    render(<ChessAnalyzer />);
    act(() => {
      mocks.apply!(reviewed, "b", true);
    });
    act(() => {
      mocks.apply!({ e1: "wK", e8: "bK", a2: "wR" }, "w", true);
    });
    await act(async () => {
      resolve(engine);
    });
    expect(mocks.createEngine).toHaveBeenCalledTimes(1);
    expect(engine.analyze).toHaveBeenCalledTimes(1);
    expect(engine.analyze).toHaveBeenCalledWith(
      "4k3/8/8/8/8/8/R7/4K3 w - - 0 1",
      expect.any(Object),
      expect.any(Function),
    );
  });
});

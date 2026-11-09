import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Spectator } from "./Spectator";
import { START_FEN } from "@/lib/chess/position";
import type { RunSnapshot } from "@/lib/sudalol/types";

const identity = { id: "gen0", name: "sudalol gen0", generation: "gen0", fingerprint: "test-fixture" };
// Explicit test fixture, never served by the app or simulator.
const snapshot: RunSnapshot = { schemaVersion: 1, runId: "fixture", status: "running", workers: 1, requestedGames: 10,
  completedGames: 2, elapsedSeconds: 20, gamesPerSecond: 0.1, gamesPerMinute: 6, moves: 10, nodes: 100,
  movesPerSecond: 0.5, nodesPerSecond: 5, averageGameLength: 4,
  observed: [{ gameId: "fixture-game", white: identity, black: identity, initialFen: START_FEN,
    moves: ["e2e4", "e7e5"], san: ["e4", "e5"], finished: false }] };
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("playback pauses independently while real telemetry continues polling", async () => {
  vi.useFakeTimers();
  let value = snapshot;
  const fetcher = vi.fn(async (_url: string, _options: RequestInit) => ({ ok: true, json: async () => value }));
  vi.stubGlobal("fetch", fetcher);
  render(<Spectator />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText("fixture-game")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Pause playback" }));
  fireEvent.change(screen.getByLabelText("Playback speed"), { target: { value: "4" } });
  value = { ...snapshot, completedGames: 3, nodes: 200 };
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect((screen.getByLabelText("Displayed move") as HTMLInputElement).value).toBe("0");
  expect(screen.getByText("200")).toBeInTheDocument();
  expect(fetcher.mock.calls.every((args) => args.length === 2 && ["/api/simulation/snapshot", "/api/simulation/training"].includes(args[0]))).toBe(true);
  expect(fetcher.mock.calls.filter((args) => args[0] === "/api/simulation/snapshot").length).toBeGreaterThan(1);
  fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect((screen.getByLabelText("Displayed move") as HTMLInputElement).value).toBe("1");
  fireEvent.click(screen.getByRole("button", { name: "Restart replay" }));
  expect((screen.getByLabelText("Displayed move") as HTMLInputElement).value).toBe("0");
});

it("shows disconnected state without inventing statistics", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("No local session")));
  render(<Spectator />);
  expect(await screen.findByText("No local session")).toBeInTheDocument();
  expect(screen.getByText("DISCONNECTED")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "SELECT GAME · WORKER 1" })).toBeDisabled();
});

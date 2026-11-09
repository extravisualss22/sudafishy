import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Chess } from "chess.js";
import { createOpponent } from "../sim/opponents.ts";
import { chooseMove, DEFAULT_SEARCH } from "../src/lib/sudalol/generations/gen0/engine.ts";
import { chooseNeuralMove } from "../src/lib/sudalol/neural/search.ts";
import { validateWeights } from "../src/lib/sudalol/neural/model.ts";
import { parseTraining } from "../src/lib/sudalol/training.ts";
import { runPlan, collectGames, openingFen } from "../learning/jobs.ts";

const weights = () =>
  validateWeights({
    schemaVersion: 1,
    encoder: "absolute-839-v1",
    valueBlend: 0.15,
    policyWeight: 40,
    layers: [
      { weight: Array.from({ length: 2 }, () => Array(839).fill(0)), bias: [0, 0] },
      {
        weight: [
          [0, 0],
          [0, 0],
        ],
        bias: [0, 0],
      },
      { weight: Array.from({ length: 134 }, () => [0, 0]), bias: Array(134).fill(0) },
    ],
  });
test("teacher files cannot alter gen0 or neural move selection", async () => {
  const model = weights(),
    board = new Chess(),
    settings = { ...DEFAULT_SEARCH, depth: 1, maxNodes: 100 };
  const original = process.env["SUDALOL_DATA"];
  const folder = await mkdtemp(join(process.cwd(), "work/teacher-isolation-"));
  try {
    process.env["SUDALOL_DATA"] = folder;
    const baseline = chooseMove(board, settings),
      neural = chooseNeuralMove(board, settings, model);
    await mkdir(join(folder, "reviews"));
    await writeFile(join(folder, "reviews", "injected.json"), JSON.stringify({ bestmove: "a1a8" }));
    assert.deepEqual(chooseMove(board, settings), baseline);
    assert.deepEqual(chooseNeuralMove(board, settings, model), neural);
    assert.equal(board.fen(), new Chess().fen());
    for (const path of [
      "src/lib/sudalol/generations/gen0/engine.ts",
      "src/lib/sudalol/neural/search.ts",
      "src/lib/sudalol/neural/model.ts",
    ])
      assert.doesNotMatch(
        await readFile(path, "utf8"),
        /from\s+["'][^"']*(teacher|stockfish|reviews)/i,
      );
  } finally {
    if (original === undefined) delete process.env["SUDALOL_DATA"];
    else process.env["SUDALOL_DATA"] = original;
    await rm(folder, { recursive: true, force: true });
  }
});
test("neural weights and missing model fail clearly", async () => {
  assert.throws(() => validateWeights({}));
  const bad = weights();
  bad.layers[0].weight[0][0] = NaN;
  assert.throws(() => validateWeights(bad));
  await assert.rejects(() => createOpponent("gen987654", 1));
});
test("explicit Stockfish opponent returns a legal move and is labeled separately", async () => {
  const item = await createOpponent("stockfish", 1, { threads: 1, hash: 16, depth: 2, nodes: 100 });
  try {
    assert.equal(item.identity.generation, null);
    assert.match(item.identity.name, /explicit opponent/);
    const board = new Chess();
    const decision = await item.opponent.chooseMove(board, DEFAULT_SEARCH);
    assert.ok(
      board
        .moves({ verbose: true })
        .some((move) => move.from + move.to + (move.promotion ?? "") === decision.move),
    );
  } finally {
    item.opponent.dispose?.();
  }
});
test("dashboard rejects fabricated shapes and inconsistent coaching", () => {
  const report = {
    schemaVersion: 2,
    savedAt: new Date().toISOString(),
    champion: "gen0",
    estimatedChessElo: { status: "unrated", value: null },
    totalGames: 0,
    totalPositions: 0,
    reviewedPositions: 0,
    trainingExamples: 0,
    ratings: [],
    training: [],
    pipeline: {},
    coaching: [],
    reviewedGames: [],
    matches: [],
  };
  assert.equal(parseTraining(report).champion, "gen0");
  assert.throws(() => parseTraining({ ...report, totalGames: -1 }));
  assert.throws(() =>
    parseTraining({ ...report, estimatedChessElo: { status: "rated", value: 1200 } }),
  );
  assert.throws(() =>
    parseTraining({
      ...report,
      coaching: [
        {
          id: "test",
          gameId: "missing",
          ply: 0,
          fen: new Chess().fen(),
          generation: "gen0",
          played: "e2e4",
          recommended: "d2d4",
          before: { cp: 0, mate: null },
          after: { cp: -30, mate: null },
          centipawnLoss: 30,
          classification: "normal",
          selectionReasons: [],
          inDataset: false,
        },
      ],
    }),
  );
});
test("simulation plans resume without replaying completed games and reject changed configuration", async () => {
  const folder = await mkdtemp(join(process.cwd(), "work/plan-recovery-")),
    old = process.env["SUDALOL_DATA"];
  try {
    process.env["SUDALOL_DATA"] = folder;
    const plan = {
      options: {
        workers: 1,
        maxMoves: 2,
        seed: 31,
        search: { ...DEFAULT_SEARCH, depth: 1, maxNodes: 100 },
      },
      jobs: [
        { index: 0, white: "gen0", black: "weak", initialFen: openingFen(0) },
        { index: 1, white: "weak", black: "gen0", initialFen: openingFen(0) },
      ],
    };
    const path = join(folder, "plan.json"),
      out = join(folder, "games");
    await writeFile(path, JSON.stringify(plan));
    await runPlan(path, out);
    const first = await collectGames(out);
    await runPlan(path, out);
    assert.deepEqual(await collectGames(out), first);
    plan.options.seed++;
    await writeFile(path, JSON.stringify(plan));
    await assert.rejects(() => runPlan(path, out), /changed/);
  } finally {
    if (old === undefined) delete process.env["SUDALOL_DATA"];
    else process.env["SUDALOL_DATA"] = old;
    await rm(folder, { recursive: true, force: true });
  }
});

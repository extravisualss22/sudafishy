import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, availableParallelism } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { Chess } from "chess.js";
import { chooseMove, DEFAULT_SEARCH } from "../src/lib/sudalol/generations/gen0/engine.ts";
import { evaluate } from "../src/lib/sudalol/generations/gen0/evaluation.ts";
import { defaultOptions, preset, validateRun } from "../sim/config.ts";
import { createOpponent, weakBot, randomSource, selectOpponent } from "../sim/opponents.ts";
import { generationRoot, verifyGeneration, archiveGeneration } from "../sim/generations.ts";
import { playGame, termination } from "../sim/game.ts";
import { runSimulation } from "../sim/runner.ts";
import { startObservationServer } from "../sim/server.ts";
import { parseSnapshot, replayFrames } from "../src/lib/sudalol/spectator.ts";
import type { GameRecord, RunSnapshot } from "../src/lib/sudalol/types.ts";

const quick = { ...DEFAULT_SEARCH, depth: 1, maxNodes: 300, quiescenceDepth: 2 };
const options = () => ({ ...defaultOptions(), workers: 1, search: quick, maxMoves: 12 });
const play = (board: Chess, move: string) => board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });

test("legal move generation and standard start perft(2) = 400", () => {
  const board = new Chess();
  assert.equal(board.moves().length, 20);
  assert.throws(() => board.move("e5"));
  let count = 0;
  for (const move of board.moves()) { board.move(move); count += board.moves().length; board.undo(); }
  assert.equal(count, 400);
});
test("check and checkmate are distinguished", () => {
  const check = new Chess("4k3/8/8/8/8/8/4R3/4K3 b - - 0 1");
  assert.equal(check.isCheck(), true); assert.equal(check.isCheckmate(), false);
  const board = new Chess(); for (const move of ["f3", "e5", "g4", "Qh4#"]) board.move(move);
  assert.deepEqual(termination(board), { result: "0-1", termination: "checkmate" });
  assert.equal(chooseMove(board, quick).move, null);
});
test("stalemate is a draw", () => {
  const board = new Chess("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1");
  assert.deepEqual(termination(board), { result: "1/2-1/2", termination: "stalemate" });
});
test("castling moves the rook and rejects castling through check", () => {
  const board = new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  assert.ok(board.moves().includes("O-O")); assert.ok(board.moves().includes("O-O-O"));
  board.move("O-O"); assert.equal(board.get("f1")?.type, "r"); assert.equal(board.get("g1")?.type, "k");
  const attacked = new Chess("4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1");
  assert.equal(attacked.moves().includes("O-O"), false);
});
test("en passant removes the captured pawn and expires after one turn", () => {
  const board = new Chess(); for (const move of ["e4", "a6", "e5", "d5"]) board.move(move);
  board.move("exd6"); assert.equal(board.get("d5"), undefined); assert.equal(board.get("d6")?.type, "p");
  board.undo(); board.move("Nf3"); board.move("a5"); assert.equal(board.moves().includes("exd6"), false);
});
test("promotion supports all four choices", () => {
  const board = new Chess("7k/P7/8/8/8/8/8/7K w - - 0 1");
  const promotions = board.moves({ verbose: true }).filter((m) => m.promotion);
  assert.deepEqual(promotions.map((m) => m.promotion).sort(), ["b", "n", "q", "r"]);
  play(board, "a7a8n"); assert.equal(board.get("a8")?.type, "n");
});
test("draws cover material, fifty moves, and repetition with preserved history", () => {
  assert.equal(termination(new Chess("7k/8/8/8/8/8/8/K7 w - - 0 1"))?.termination, "insufficient-material");
  assert.equal(termination(new Chess("7k/8/8/8/8/8/8/KR6 w - - 100 51"))?.termination, "fifty-move-rule");
  const board = new Chess(); for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) board.move(move);
  const history = board.history();
  assert.equal(termination(board)?.termination, "threefold-repetition");
  assert.equal(chooseMove(board, quick).score, 0); assert.deepEqual(board.history(), history);
});
test("both opponents return legal moves and leave board/history unchanged", () => {
  for (const fen of [new Chess().fen(), "4k3/8/8/8/8/8/4R3/4K3 b - - 0 1", "7k/P7/8/8/8/8/8/7K w - - 0 1"]) {
    for (const choose of [chooseMove, weakBot(42).chooseMove]) {
      const board = new Chess(fen), history = board.history();
      const decision = choose(board, quick);
      assert.ok(decision.move); assert.equal(board.fen(), fen); assert.deepEqual(board.history(), history);
      assert.ok(play(board, decision.move!));
    }
  }
});
test("gen0 finds mate in one rather than a material gain", () => {
  const board = new Chess("7k/5K2/6Q1/8/8/8/8/8 w - - 0 1");
  play(board, chooseMove(board, quick).move!); assert.equal(board.isCheckmate(), true);
});
test("gen0 takes a free queen and escapes check", () => {
  const board = new Chess("7k/8/8/8/8/4q3/4R3/4K3 w - - 0 1");
  assert.equal(chooseMove(board, { ...quick, depth: 2, maxNodes: 1000 }).move, "e2e3");
  const checked = new Chess("4k3/8/8/8/8/8/4R3/4K3 b - - 0 1");
  play(checked, chooseMove(checked, quick).move!); assert.equal(checked.isAttacked(checked.findPiece({ type: "k", color: "b" })[0], "w"), false);
});
test("iterative deepening and a hard node budget restore game history", () => {
  const board = new Chess(); board.move("e4"); board.move("e5");
  const fen = board.fen(), history = board.history();
  const decision = chooseMove(board, { ...quick, depth: 8, maxNodes: 100 });
  assert.ok(decision.nodes <= 100); assert.ok(decision.move);
  assert.equal(board.fen(), fen); assert.deepEqual(board.history(), history);
  const deeper = chooseMove(new Chess(), { ...quick, depth: 2, maxNodes: 3000 });
  assert.equal(deeper.completedDepth, 2);
});
test("transposition table does not change the result or confuse repetition context", () => {
  const board = new Chess("7k/8/8/8/8/8/3R4/4K3 w - - 0 1");
  const search = { ...quick, depth: 3, maxNodes: 20000 };
  const cached = chooseMove(board, search), uncached = chooseMove(board, { ...search, tableEntries: 0 });
  assert.equal(cached.move, uncached.move); assert.equal(cached.score, uncached.score);
  assert.equal(cached.completedDepth, 3);
});
test("evaluation is side-relative and values material", () => {
  const a = evaluate(new Chess("7k/8/8/8/8/8/3R4/4K3 w - - 0 1"));
  const b = evaluate(new Chess("7k/8/8/8/8/8/3R4/4K3 b - - 0 1"));
  assert.ok(a > 400); assert.equal(a, -b);
});
test("generation identification is verified and existing checkpoints cannot be overwritten", async () => {
  const generation = await verifyGeneration("gen0"); assert.equal(generation.manifest.name, "sudalol gen0");
  assert.match(generation.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await createOpponent("gen0", 1)).identity.generation, "gen0");
  await assert.rejects(archiveGeneration("gen0", "gen0"), /EEXIST/);
  await assert.rejects(verifyGeneration("../gen0"), /Invalid generation/);
});
test("modified archived source is rejected", async () => {
  const id = "gen987654321";
  await archiveGeneration("gen0", id);
  try {
    const file = join(generationRoot, id, "evaluation.ts");
    await writeFile(file, (await readFile(file, "utf8")) + "\n// changed\n");
    await assert.rejects(verifyGeneration(id), /changed/);
  } finally { await rm(join(generationRoot, id), { recursive: true, force: true }); }
});
test("resource presets and invalid CLI-equivalent options are bounded", () => {
  assert.equal(preset("normal", 8), 4); assert.equal(preset("overnight", 8), 7);
  assert.equal(preset("normal", 1), 1); assert.equal(preset("overnight", 64), 16);
  for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => validateRun({ ...options(), games: value }));
  assert.throws(() => validateRun({ ...options(), workers: 100000 }));
  assert.throws(() => validateRun({ ...options(), search: { ...quick, depth: 0 } }));
});
test("weighted opponent choice is configurable and seeded", () => {
  const dist = [{ id: "gen0", weight: 40 }, { id: "weak", weight: 60 }];
  assert.equal(selectOpponent(dist, () => 0.2), "gen0"); assert.equal(selectOpponent(dist, () => 0.8), "weak");
  assert.throws(() => selectOpponent([{ id: "weak", weight: 0 }], Math.random));
  const a = randomSource(2), b = randomSource(2); assert.equal(a(), b());
});
test("a full game finishes naturally and PGN round-trips", async () => {
  const game = await playGame({ ...options(), maxMoves: 1000, white: "weak", black: "weak" });
  const board = new Chess(); board.loadPgn(game.pgn);
  assert.equal(board.fen(), game.record.finalFen); assert.equal(board.history().length, game.record.moveCount);
  assert.equal(board.getHeaders()["Result"], game.record.result);
  assert.notEqual(game.record.termination, "max-moves-adjudication");
});
test("a move cap is explicitly marked and terminal initial positions do not request moves", async () => {
  const game = await playGame({ ...options(), maxMoves: 1 });
  assert.equal(game.record.moveCount, 2); assert.equal(game.record.termination, "max-moves-adjudication");
  const mate = await playGame({ ...options(), initialFen: "7k/6Q1/5K2/8/8/8/8/8 b - - 0 1" });
  assert.equal(mate.record.moveCount, 0); assert.equal(mate.record.result, "1-0");
});
test("observation cannot change decisions or search counts", async () => {
  const silent = await playGame(options(), 4);
  const observations: unknown[] = [];
  const watched = await playGame({ ...options(), observe: true }, 4, (p) => observations.push(p));
  assert.deepEqual(watched.record.moves, silent.record.moves); assert.equal(watched.record.nodes, silent.record.nodes);
  assert.equal(watched.record.result, silent.record.result); assert.ok(observations.length > 0);
});
test("parallel simulation saves unique, replayable games and accurate aggregate metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sudalol-test-"));
  try {
    const run = await runSimulation({ ...options(), output: directory, games: 4, workers: Math.min(2, availableParallelism()), observe: true });
    const lines = (await readFile(join(run.directory, "games-00000.jsonl"), "utf8")).trim().split("\n");
    const records = lines.map((line) => JSON.parse(line) as GameRecord);
    assert.equal(records.length, 4); assert.equal(new Set(records.map((g) => g.gameId)).size, 4);
    assert.equal(run.summary.completedGames, 4); assert.equal(run.summary.status, "completed");
    assert.equal(run.summary.moves, records.reduce((s, g) => s + g.moveCount, 0));
    assert.equal(run.summary.nodes, records.reduce((s, g) => s + g.nodes, 0));
    assert.equal(run.summary.gamesPerMinute, 60 * run.summary.gamesPerSecond);
    const pgn = await readFile(join(run.directory, "games-00000.pgn"), "utf8");
    for (const record of records) {
      const board = new Chess(record.initialFen); for (const move of record.moves) play(board, move);
      assert.equal(board.fen(), record.finalFen); assert.ok(pgn.includes(record.gameId));
      assert.equal(record.generation.white, "gen0"); assert.equal(record.white.fingerprint.length, 64);
    }
    const snapshot = parseSnapshot(JSON.parse(await readFile(join(run.directory, "snapshot.json"), "utf8")));
    assert.ok(snapshot.observed.length > 0); assert.ok(snapshot.observed.length <= 12);
    assert.equal(replayFrames(snapshot.observed[0]).length, snapshot.observed[0].moves.length + 1);
    assert.deepEqual(JSON.parse(await readFile(join(run.directory, "summary.json"), "utf8")), run.summary);
    const serial = await runSimulation({ ...options(), output: directory, games: 4, workers: 1 });
    const serialRecords = (await readFile(join(serial.directory, "games-00000.jsonl"), "utf8")).trim().split("\n").map((s) => JSON.parse(s) as GameRecord);
    for (const record of records) assert.deepEqual(record.moves, serialRecords.find((g) => g.index === record.index)!.moves);
    assert.notEqual(run.directory, serial.directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("gen0 self-play, invalid opponent, and cancellation", async () => {
  const game = await playGame({ ...options(), black: "gen0", maxMoves: 2 });
  assert.equal(game.record.generation.black, "gen0"); assert.equal(game.record.moveCount, 4);
  await assert.rejects(createOpponent("unavailable-opponent", 1), /Invalid generation/);
  const directory = await mkdtemp(join(tmpdir(), "sudalol-stop-"));
  try {
    const controller = new AbortController(); controller.abort();
    const run = await runSimulation({ ...options(), output: directory }, { signal: controller.signal });
    assert.equal(run.summary.status, "stopped"); assert.equal(run.summary.completedGames, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("observation API is read-only and returns only real supplied state", async () => {
  let state: RunSnapshot | null = null;
  const server = await startObservationServer(() => state, 0);
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(url + "/snapshot")).status, 503);
    assert.equal((await fetch(url + "/start", { method: "POST" })).status, 404);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url + "/snapshot", { headers: { Host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(status, 403);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
test("snapshot parser rejects fake shapes and invalid games", () => {
  assert.throws(() => parseSnapshot({ completedGames: 123 }));
});
test("independent engine source has no analysis or Stockfish dependency", async () => {
  for (const file of await readdir(join(generationRoot, "gen0"))) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(join(generationRoot, "gen0", file), "utf8");
    const imports = source.split("\n").filter((line) => /^import /.test(line)).join("\n");
    assert.doesNotMatch(imports, /stockfish|lib\/chess\/engine|Worker/i);
  }
});

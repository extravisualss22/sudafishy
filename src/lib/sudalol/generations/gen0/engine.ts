import type { Chess, Move } from "chess.js";
import type { Decision, SearchOptions } from "../../types.ts";
import { evaluate, VALUE } from "./evaluation.ts";

export const DEFAULT_SEARCH: SearchOptions = { depth: 2, maxNodes: 2000, quiescenceDepth: 4, tableEntries: 10000 };
const MATE = 100000;
const ABORT = Symbol("node budget exhausted");
interface Entry { depth: number; score: number; flag: "exact" | "lower" | "upper"; move?: string }
export const uci = (move: Move) => move.from + move.to + (move.promotion ?? "");
const positionKey = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

export function validateSearch(options: SearchOptions) {
  for (const [key, min, max] of [["depth", 1, 8], ["maxNodes", 100, 1000000], ["quiescenceDepth", 0, 12], ["tableEntries", 0, 100000]] as const) {
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
}

/** Independent negamax; never imports the browser analysis adapter or Stockfish. */
export function chooseMove(board: Chess, options: SearchOptions = DEFAULT_SEARCH): Decision {
  validateSearch(options);
  let nodes = 0, tableHits = 0;
  const table = new Map<string, Entry>();
  // Include repetition context in table keys: the same FEN can have a different draw value.
  let counts = new Map<string, number>();
  const history = board.history({ verbose: true });
  const reversiblePlies = Number(board.fen().split(" ")[4]);
  for (const fen of [history[0]?.before ?? board.fen(), ...history.map((m) => m.after)].slice(-reversiblePlies - 1)) {
    const key = positionKey(fen); counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  function visit() { if (nodes >= options.maxNodes) throw ABORT; nodes++; }
  function terminal(ply: number): number | undefined {
    if (board.isCheckmate()) return -MATE + ply;
    if (board.isDraw()) return 0;
    return undefined;
  }
  function ordered(moves: Move[], preferred?: string) {
    const score = (m: Move) => (uci(m) === preferred ? 1000000 : 0) +
      (m.captured ? 10 * VALUE[m.captured] - VALUE[m.piece] + 10000 : 0) +
      (m.promotion ? VALUE[m.promotion] + 8000 : 0) + (m.san.includes("+") ? 50 : 0);
    return moves.sort((a, b) => score(b) - score(a) || uci(a).localeCompare(uci(b)));
  }
  function withMove(move: Move, search: () => number) {
    board.move(move);
    const previousCounts = counts;
    if (move.piece === "p" || move.captured) counts = new Map();
    const key = positionKey(board.fen()); counts.set(key, (counts.get(key) ?? 0) + 1);
    try { return search(); }
    finally {
      const n = counts.get(key)! - 1;
      if (n) counts.set(key, n); else counts.delete(key);
      counts = previousCounts;
      board.undo();
    }
  }
  function quiet(alpha: number, beta: number, remaining: number, ply: number): number {
    visit();
    const end = terminal(ply); if (end !== undefined) return end;
    const check = board.isCheck();
    // In-check nodes must search evasions, never accept a stand-pat score.
    // The global node budget also bounds long checking sequences.
    if (!check) {
      const stand = evaluate(board);
      if (remaining <= 0 || stand >= beta) return stand;
      alpha = Math.max(alpha, stand);
    }
    const moves = ordered(board.moves({ verbose: true }).filter((m) => check || m.captured || m.promotion));
    for (const move of moves) {
      const score = withMove(move, () => -quiet(-beta, -alpha, remaining - 1, ply + 1));
      if (score >= beta) return score;
      alpha = Math.max(alpha, score);
    }
    return alpha;
  }
  function negamax(depth: number, alpha: number, beta: number, ply: number): number {
    if (depth <= 0) return quiet(alpha, beta, options.quiescenceDepth, ply);
    visit();
    const end = terminal(ply); if (end !== undefined) return end;
    const key = board.fen().split(" ").slice(0, 5).join(" ") + "|" + JSON.stringify([...counts].sort());
    const entry = table.get(key);
    // Mate scores are stored relative to this position, not the original search root.
    const decode = (s: number) => s > MATE - 1000 ? s - ply : s < -MATE + 1000 ? s + ply : s;
    if (entry && entry.depth >= depth) {
      tableHits++;
      const score = decode(entry.score);
      if (entry.flag === "exact" || (entry.flag === "lower" && score >= beta) || (entry.flag === "upper" && score <= alpha)) return score;
    }
    const originalAlpha = alpha;
    let best = -Infinity, bestMove: string | undefined;
    for (const move of ordered(board.moves({ verbose: true }), entry?.move)) {
      const score = withMove(move, () => -negamax(depth - 1, -beta, -alpha, ply + 1));
      if (score > best) { best = score; bestMove = uci(move); }
      alpha = Math.max(alpha, score);
      if (alpha >= beta) break;
    }
    if (options.tableEntries > 0) {
      if (table.size >= options.tableEntries && !table.has(key)) table.delete(table.keys().next().value!);
      table.set(key, { depth, move: bestMove, score: best > MATE - 1000 ? best + ply : best < -MATE + 1000 ? best - ply : best,
        flag: best <= originalAlpha ? "upper" : best >= beta ? "lower" : "exact" });
    }
    return best;
  }
  const end = terminal(0);
  if (end !== undefined) return { move: null, score: end, nodes, completedDepth: 0, tableHits };
  const rootMoves = ordered(board.moves({ verbose: true }));
  // A static one-ply fallback is useful even if the first complete iteration hits its budget.
  let move = uci(rootMoves[0]), score = -Infinity, completedDepth = 0;
  for (const candidate of rootMoves) {
    if (nodes >= options.maxNodes) break;
    const value = withMove(candidate, () => -(terminal(1) ?? evaluate(board)));
    nodes++;
    if (value > score) { score = value; move = uci(candidate); }
  }
  for (let depth = 1; depth <= options.depth; depth++) {
    let iterationMove = move, iterationScore = -Infinity;
    try {
      for (const candidate of ordered([...rootMoves], move)) {
        const value = withMove(candidate, () => -negamax(depth - 1, -Infinity, -iterationScore, 1));
        if (value > iterationScore) { iterationScore = value; iterationMove = uci(candidate); }
      }
      move = iterationMove; score = iterationScore; completedDepth = depth;
    } catch (error) { if (error !== ABORT) throw error; break; }
    if (Math.abs(score) >= MATE - 100) break;
  }
  return { move, score, nodes, completedDepth, tableHits };
}

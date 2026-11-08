# Phase 1 validation — sudalol

Validated on the user's Windows workspace on November 7, 2026 (America/Los_Angeles). Dataset identifiers use UTC timestamps. Runtime: Node 24.22.1; package manager: pnpm 11.25.0.

## Executed checks

- `pnpm install --frozen-lockfile --offline`: passed using installed dependencies and the committed pnpm lock.
- `pnpm typecheck`: passed, including simulation modules and tests.
- `pnpm test`: **55 passed, 0 failed** — 30 Vitest UI/analysis/vision tests and 25 Node simulation tests.
- `pnpm build`: passed for client, SSR, and the existing Cloudflare/Nitro target. Existing plugin notices about native tsconfig paths and code-splitting remain informational.
- `git diff --check`: passed.
- Original baseline before implementation: 28 tests passed. The first sandboxed attempt failed on Windows temporary-file renames; running outside that sandbox succeeded. No tests were waived.

Covered: legal generation/perft, check/checkmate, stalemate, both castles and through-check rejection, en passant/expiry, four promotions, insufficient material/fifty moves/repetition, legal moves from both bots, mate-in-one/free queen/check evasion, budget/history restoration, table/no-table equivalence, evaluation sign, generation identity/no-overwrite/tamper detection, resource bounds, weighted scheduling, full game PGN round-trip, capped and terminal games, observation equivalence, serial/parallel determinism, unique JSONL/PGN records, aggregates/snapshots, self-play/cancellation, read-only API, disconnected UI, and independent pause/speed controls while telemetry updates.

## Real simulation batch

Command:
```sh
node sim/cli.ts simulate --games 4 --workers 2 --search-depth 2 --max-moves 150 --max-nodes 2000
```

Run: `2026-11-08T04-00-38-184Z-e9ca0674`

| Game index | Result | Termination | Plies | Search nodes |
| --- | --- | --- | ---: | ---: |
| 0 | 1-0 | checkmate | 51 | 13,602 |
| 1 | 1-0 | checkmate | 13 | 1,328 |
| 2 | 1-0 | checkmate | 61 | 22,206 |
| 3 | 1-0 | checkmate | 25 | 4,695 |

Total: 4 games, 150 plies, 41,831 nodes, 23.829 seconds wall time, 10.072 games/minute. All games had gen0 as White and the seeded weak bot as Black. Completed JSONL and PGNs were checked. This small result is not a strength rating.

Self-play command:
```sh
node sim/cli.ts simulate --games 2 --workers 2 --white gen0 --black gen0 --search-depth 1 --max-nodes 500 --max-moves 150
```

Run `2026-11-08T04-08-40-213Z-4b0c3eca`: both games terminated by checkmate after 39 plies. Total 78 plies and 6,426 nodes in 2.553 seconds. Matching deterministic games are expected without opening variation.

## Executed benchmark

```sh
node sim/cli.ts benchmark --games 4 --worker-counts 1,2,4 --search-depth 1 --max-nodes 500 --max-moves 150
```

| Workers | Completed | Seconds | Games/s | Games/min | Moves/s | Nodes/s | Average plies |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4 | 7.669 | 0.522 | 31.294 | 25.818 | 1,721.304 | 49.5 |
| 2 | 4 | 4.571 | 0.875 | 52.502 | 43.314 | 2,887.826 | 49.5 |
| 4 | 4 | 3.414 | 1.172 | 70.293 | 57.991 | 3,866.382 | 49.5 |

All counts produced 198 plies and 13,201 search visits. These are short functional checks, affected by startup and background load, not a recommendation for best long-session settings. 8/16-worker benchmarks were not automatically run.

## Browser verification

The actual local app was opened in the in-app browser. The spectator loaded the completed live session through the local API, displayed real game IDs/generations and matching statistics, and showed legal move replay. Pause, restart, and 4x selection were checked. UI tests additionally verify that paused playback does not stop telemetry polling.

The preserved main analyzer loaded Stockfish and completed an analysis at depth 18 with a best move, evaluation, nodes, and candidate lines. No browser console errors were observed in those checks. A spectator screenshot is included in the deliverables.

No actual screen was captured through the board-reader feature. Existing mocked vision/screen-share unit tests passed; the optional pre-existing Playwright pixel/video scripts were not run in this session. No mobile-specific browser pass was performed.

## Scope and remaining limits

No Elo claim, GPU/thermal tuning, neural learning, reinforcement learning, teacher analysis, or generation promotion was implemented. The code is ready for Phase 1 review on its own branch; the live production site is not changed by creating that review branch. See `phase1.md` for all important created/modified files, dependency details, exact commands, architecture, and limitations.

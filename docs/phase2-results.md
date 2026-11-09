# Phase 2 measured validation

Completed November 8, 2026 (America/Los_Angeles). Persisted timestamps use UTC and fall on November 9. This is a functional, short-run validation, not an overnight training study.

## Actual benchmark games

| Run | W / D / L (named generation) | Games / colors | Average plies | Total nodes | Terminations |
|---|---|---|---|---|---|
| gen0-baseline-v1 vs weak | 31 / 0 / 1 | 32; 16 White, 16 Black | 53.59375 | 114,739 | 32 checkmates |
| gen1-gate-v1 vs gen0 | 14 / 8 / 10 | 32; 16 White, 16 Black | 94.8125 | 263,494 | 24 checkmates, 8 threefold repetitions |
| gen1-reference-v1 vs weak | 31 / 1 / 0 | 32; 16 White, 16 Black | 56.21875 | 128,528 | 31 checkmates, 1 threefold repetition |

All use depth 1, max 500 nodes per move, quiescence depth 4, TT 10,000 entries, max 100 full moves, two workers, seed 20261108, eight paired opening lines. Exact plans, player fingerprints, games, PGNs and results are saved. The baseline was completed and saved **before any training** and its full game shards/plan/results are permanently tracked under `research/baselines/gen0-v1`. The experiment root holds **96 games and 6,548 played plies**. Nodes are total counted work, not unique positions.

Gen1's gate score was 56.25%. Its approximate interval was [39.3253%, 71.8349%]; the lower threshold was >50%, so the candidate was **rejected**. Gen0 remains champion. Gen1 remains available for research. Internal ratings after this one generation match are approximately gen0 **995.5942**, gen1 **1004.4058**; these are relative generation ratings, not human Elo. Both human estimates remain **unrated**.

The weak-reference comparison is descriptive: its openings/opponent overlap training sources. The generation match has repeated deterministic openings; the interval assumes independence and is only a heuristic. These results do not prove general improvement.

## Actual teacher and training smoke run

- Stockfish 19 Lite WASM reviewed **253 positions** after the 32 completed baseline games. Limits: 2,000 deep nodes, depth 8, 150-node selection probes, one thread, 32 MiB hash, at most eight selected positions per game.
- Direct-position deduplication produced **245 examples: 196 train / 49 validation** from 32 source games.
- PyTorch **2.9.1+cu128** detected and used **NVIDIA GeForce RTX 2070 SUPER** (8 GiB reported by nvidia-smi).
- Two epochs, batch 32, Adam lr 0.001, seed 19, **14 optimizer steps**. Paused after one batch, then resumed to completion.
- Measured training-loop elapsed **1.7638718 seconds**, excluding installation, startup and simulation/teacher time. This tiny dataset is a plumbing smoke test.
- Final training loss **3.54993495**; validation loss **3.69061670**; validation policy accuracy **2.040816%**; validation value MSE **0.18360380**. The low policy accuracy is reported as measured.
- Immutable `gen1` stores the actual checkpoint, exported weights, search/encoder/inference source, training metadata and hashes. The original smoke trainer/teacher are preserved in `research/smoke-source`; subsequent recovery fixes and warm-start support did not alter gen1.

## Verification

The original 30 Vitest UI/analysis/vision tests and 25 Node simulation tests pass. Five new Node tests cover teacher isolation, missing/invalid models, the actual labeled Stockfish opponent, dashboard validation and resumable plans. Nine Python tests cover CPU checkpoint/resume equivalence, immutable generations/hash failures, streaming teacher/outcome datasets, split isolation, Python/TypeScript encoder and inference parity, policy promotion mappings, rating/gating/idempotence, seeded category scheduling and actual Stockfish review/resume. **69 tests total.** TypeScript checking, production build and whitespace checks pass. Existing build-tool advisory warnings remain; they did not fail the build.

A separate finite-loop smoke experiment (`work/loop-validation`, excluded from the 96-game dashboard total) ran eight capped training games, offline review, dataset build, one CPU epoch, archive, two capped gate games, and rejection for insufficient evidence. Repeating its `--iterations 1` command returned the completed state without more games or training. These capped games validate orchestration, not strength. Recovery unit tests verify resumed training matches uninterrupted CPU output exactly on this environment. An explicit CUDA checkpoint/resume was exercised in the main smoke run. Long-duration hard-power-loss behavior has not been tested.

Browser verification of `/spectator` confirmed real 96-game totals, separate ratings/unrated human Elo, CUDA losses, and a saved coaching move. Selecting gen0 `c3d5` at ply 17 paused its completed replay and showed Stockfish `f4f5`, +3.84→−1.72 pawns from the mover's perspective, 556 cp loss, blunder, and actual dataset membership. No browser console errors were observed. The existing analyzer tests remain passing; legacy optional external Playwright screen-capture scripts were not run.

## Review boundary

No long training session was started. No candidate was promoted. No permanent gen0 source changed. The source changes are prepared on a separate Phase 2 branch; the existing Phase 1 draft remains separate. Review the model limits and [Phase 2 architecture](phase2.md) before extending the experiment. Phase 3 has a working end-to-end foundation, but still needs better held-out evaluation, broader openings, stronger training data and calibrated reference opponents.

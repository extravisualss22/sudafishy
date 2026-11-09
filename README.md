# sudalol

An independent chess engine and local learning laboratory for a school project. Phase 2 adds offline Stockfish coaching, streaming datasets, PyTorch policy/value training, immutable neural generations, and evidence-based champion gating. **gen0 remains unchanged. Human chess Elo is unrated.**

The existing React chess analyzer remains at `/`. It explicitly identifies its separate Stockfish analysis engine. **Stockfish never selects sudalol gen0's simulation moves.** The new observation dashboard is at `/spectator`.

## Quick start

Use **Node.js 22.18+ or 24+** and pnpm. Native Node TypeScript support runs the simulation. The original simulator needs no Python or GPU; the Phase 2 learning commands below use Python 3.11 and PyTorch.

```sh
pnpm install --frozen-lockfile

# One automated game: sudalol gen0 (White) vs weak bot (Black)
pnpm simulate -- --games 1 --workers 1

# 100 games, with a conservative detected-CPU worker preset
pnpm simulate -- --games 100 --mode normal

# Independent self-play
pnpm simulate -- --games 10 --workers 2 --white gen0 --black gen0

# Sequential worker-count benchmark
pnpm benchmark -- --games 12 --worker-counts 1,2,4 --search-depth 1

# Simulator + local observation API + existing website
pnpm spectator -- --games 100 --workers 2 --search-depth 1
```

Open **http://127.0.0.1:5173/spectator**. The dashboard remains available for replay after the batch finishes. Ctrl+C ends the session and terminates its workers/server. Close other dev servers on port 5173 first; the read-only observation API uses 127.0.0.1:8787.

Website alone: `pnpm dev -- --host 127.0.0.1 --port 5173`. On a hosted site, import a real `snapshot.json`; the hosted website does not start local CPU workers. Existing position editing, PGN import, saved boards, analysis, and screen-share review remain available.

## Results and controls

Every run gets a unique `runs/<UTC-timestamp>-<id>/` directory:

- `games-00000.jsonl`: one complete structured game per line.
- `games-00000.pgn`: complete games with matching game IDs.
- Additional paired shards every 1,000 completed games; never one file per game.
- `config.json`, `summary.json`, `snapshot.json`: reproducibility, aggregate results, and a bounded observation feed.

`--max-moves` counts **full moves** (two player moves). JSONL `moveCount`, dashboard moves, and average game length count **plies** (one player's move). Nodes count search visits, including quiescence, not unique positions. Move caps are saved as `max-moves-adjudication`, distinct from rule-based draws.

Options: `--search-depth 1..8`, `--max-nodes 100..1000000`, `--max-moves 1..1000`, `--workers N`, `--white gen0|weak`, `--black gen0|weak`, `--seed N`, `--output PATH`, `--fen "FEN"`, and `--mode normal|overnight`. See `node sim/cli.ts simulate --help` and the [Phase 1 guide](docs/phase1.md).

## Validation

```sh
pnpm typecheck
pnpm test
pnpm build
work\venv\Scripts\python.exe -m unittest learning.test_learning -v
```

Tests cover the original website plus chess rules, legal/tactical decisions, search limits, generation protection, complete games, parallel saves, spectator independence, and observation API/UI behavior. See [actual validation results](docs/validation.md).

## Phase 2 Windows setup

Run in the repository root in PowerShell. This creates an isolated environment and does not change OS execution policies or hardware protections. The CUDA wheel below was validated on the detected RTX 2070 SUPER; choose the CPU command instead on a machine without compatible CUDA. See the [official PyTorch installer](https://pytorch.org/get-started/locally/) for other platforms.

```powershell
pnpm install --frozen-lockfile
py -3.11 -m venv work/venv
$py = "$PWD/work/venv/Scripts/python.exe"
& $py -m pip install --upgrade pip
& $py -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cu128
# CPU alternative to the preceding command:
# & $py -m pip install torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu
& $py -m pip install -r learning/requirements.txt
& $py -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

## Ten learning commands

These commands use new run names for your own experiment. If restoring the supplied evidence bundle, keep its original `gen1` and use the loop to allocate the next generation. Never delete or overwrite an existing generation to reuse its number. All steps are finite. The default data directory is `training-data`; set `$env:SUDALOL_DATA` to an absolute path **inside this repository** to isolate another experiment (Node's archived engines resolve `chess.js` from the repository).

```powershell
# 1. Establish gen0 before training; 32 color-balanced games.
& $py -m learning.cli benchmark gen0 --games 32 --name my-gen0-baseline

# 2. Generate training games. NORMAL explicitly has no older-gen allocation for gen0.
& $py -m learning.cli simulate --generation gen0 --config learning/configs/normal.json --name my-training-1

# 3. Offline teacher; repeat the same command for the next batch until "added": 0.
& $py -m learning.cli review --games training-data/simulations/my-training-1 --output training-data/reviews/my-review-1.sqlite --max-positions 256

# 4. Freeze a dataset version (optionally also pass --games PATH for outcome labels).
& $py -m learning.cli dataset --teacher training-data/reviews/my-review-1.sqlite --output training-data/datasets/my-dataset-1.sqlite

# 5. Train and archive gen1 on a fresh checkout/data root.
& $py -m learning.cli train --dataset training-data/datasets/my-dataset-1.sqlite --run training-data/training/my-gen1
& $py -m learning.cli archive --run training-data/training/my-gen1 --generation gen1 --parent gen0

# 6. Fixed-reference benchmark: same weak opponent/settings as gen0.
& $py -m learning.cli benchmark gen1 --games 32 --name my-gen1-reference

# 7. Independent champion match; only this explicit gate can promote.
& $py -m learning.cli compare gen1 --opponent gen0 --games 32 --name my-gen1-gate --gate --min-games 32 --min-score 0.55 --min-lower 0.50

# 8. Open http://127.0.0.1:5173/spectator (separate terminal).
pnpm dashboard

# 9. Continue for exactly one iteration, allocating the next unused generation.
& $py -m learning.cli loop --config learning/configs/normal.json --iterations 1 --run-id experiment

# 10. Request a safe stop from another terminal, then clear it and resume.
& $py -m learning.cli stop
& $py -m learning.cli resume
& $py -m learning.cli loop --config learning/configs/normal.json --iterations 1 --run-id experiment
```

`--iterations` is an **absolute target for that run ID**, so repeating `1` resumes without accidentally scheduling an additional iteration. Use `2` deliberately to extend it. Resume an individual review/train/simulation by repeating its original command. `train --max-batches 1` exercises checkpoint recovery. `--settings FILE.json` accepts teacher, training, or match settings; see [architecture, settings, metrics and recovery](docs/phase2.md). `learning/configs/overnight.json` is available but never started automatically, and fails if its older-generation category is unavailable.

Actual validation: gen0 versus weak **31 W / 0 D / 1 L**; gen1 versus gen0 **14 W / 8 D / 10 L**, rejected as champion; gen1 versus weak **31 W / 1 D / 0 L**. These are small shallow-search experiments, not a calibrated strength claim. The [Phase 2 results](docs/phase2-results.md) include exact counts and limitations.

## Existing screen-share board reader

Use **Share Screen** on HTTPS or localhost. Choose a screen, tab, or window in the browser prompt; no image leaves the browser.

1. **Detect Board** freezes a frame. Drag/resize the square crop over all 64 squares. Arrow keys move it; Shift + arrows resize it.
2. Select White/Black at bottom or Auto orientation, then **Read board**.
3. Review pieces and uncertain squares. Correct with the palette or Erase, and select the side to move.
4. **Use Position** loads the reviewed FEN into the separate Stockfish analyzer. Castling and en-passant rights are cleared because pixels cannot establish history. **Try Again** captures a fresh frame.
5. **Watch Board** samples about every 1.75 seconds and requires repeated high-confidence observations. Auto-update accepts only a unique legal next move; ambiguity requires review. Resize or manual board changes require a new crop/review.

**Stop Sharing**, browser Stop sharing, and unmounting stop the video tracks. Declined permission leaves manual analysis usable. Recognition is a local silhouette/template heuristic, not a general-purpose vision model; unfamiliar themes, overlays, small crops, and sparse positions may require correction. It never executes moves on another site.

Pre-existing optional pixel/video scripts remain in `tests/vision-browser.mjs` and `tests/screen-share-browser.mjs`; they require separately installed Playwright/Chromium and a dev server. They are not part of `pnpm test`.

For analysis and training. Do not use engine assistance in live rated games. Stockfish binaries and their GPL notice/source links are preserved under `public/engine/` and in the analyzer footer. The existing Lovable connection and repository history remain intact.

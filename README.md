# sudalol

An independent beginner chess engine and headless simulation foundation for a school project. **Phase 1 only:** no neural network, training, teacher analysis, or automatic generation promotion. No Elo claim is made.

The existing React chess analyzer remains at `/`. It explicitly identifies its separate Stockfish analysis engine. **Stockfish never selects sudalol gen0's simulation moves.** The new observation dashboard is at `/spectator`.

## Quick start

Use **Node.js 22.18+ or 24+** and pnpm. Native Node TypeScript support runs the simulation; no Python or GPU setup is needed.

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
```

Tests cover the original website plus chess rules, legal/tactical decisions, search limits, generation protection, complete games, parallel saves, spectator independence, and observation API/UI behavior. See [actual validation results](docs/validation.md).

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

# sudalol Phase 1 implementation guide

## Existing repository

The repository had a TypeScript React 19 app using TanStack Start/Router, Vite, Tailwind 4, shadcn/Radix, chess.js 1.4, and Vitest/Testing Library. It supported play/setup boards, FEN editing, PGN import/replay, castling/turn controls, undo/redo, saved positions/settings in localStorage, and screen-share recognition/review/watch. Stockfish 19 WASM/asm.js workers and GPL notices/source links were already shipped, plus a material-only analysis fallback.

There was an SSR/error-reporting shell, but no simulation backend, durable game dataset, independent generation system, worker pool, or ML training. The repository has a Lovable connection and generated route tree. No database schema or deployment integration was replaced.

Phase 1 reuses chess.js for rules, the board and SVG assets, React routes/styles, and the existing analysis adapter. That separate UI now accurately names Stockfish. The project brand is **sudalol**; the GitHub repository slug has not been renamed.

## How gen0 chooses a move

`generations/gen0/engine.ts` implements independent negamax with alpha-beta pruning. Iterative deepening tries depths 1, 2, … and retains the last fully completed iteration. A static one-ply evaluation supplies a legal, nonrandom fallback if the first iteration exhausts its node budget. It never calls the old analysis adapter, Stockfish, an external service, or an opening book.

Move ordering prefers the prior iteration/table move, captures ordered by victim/attacker value, promotions, and checks. Quiescence extends captures/promotions beyond the horizon. A checked king must search evasions instead of accepting a static score. The global node budget bounds long checking sequences. Every temporary move is undone in `finally`, including interrupted searches.

The bounded transposition table stores depth, bound type, best move, and score. Keys include position, half-move clock, and repetition counts since the last irreversible move; identical boards with different draw histories cannot reuse an inappropriate score. Mate scores are normalized for search ply. Entries are evicted at capacity, and tables are per decision.

`evaluation.ts` scores material, centralization/development, advanced rooks, controlled squares as a mobility proxy, middlegame king shelter/castling, endgame king activity, and doubled/isolated/passed/advanced pawns. These are educational handcrafted heuristics, not learned weights or an Elo estimate.

Defaults: depth 2, 2,000 nodes per decision, quiescence depth 4, 10,000 table entries maximum. The CLI exposes depth/node budgets; typed `SearchOptions` also controls quiescence/table size. Full settings are saved in each game. A node budget may stop search before its requested depth.

## Rules and opponents

chess.js supplies legality, check/checkmate, castling, en passant, promotion, stalemate, insufficient material, repetition, and fifty-move detection. Simulations automatically accept the library's threefold/fifty-move draw, with no human claim dialog. Game history stays on the live Chess object. Checkmate is checked before draw adjudication.

The `Opponent` contract contains identity/generation and `chooseMove(board, options)`. `sim/opponents.ts` loads generations and implements a seeded weak greedy bot. The weak bot prefers captures/promotions, immediate mate, and avoiding attacked destinations, with seeded tie variation. `--white` and `--black` independently select gen0 or weak, supporting self-play and reversed colors.

The tested `selectOpponent()` weighted scheduling seam accepts configurable weights. A future caller can supply older/current/weak/fixed/Stockfish = 40/25/15/15/5 or another mix. Phase 1 does not silently activate missing opponents. Seeds depend on game index rather than scheduling: equivalent serial/parallel runs produce the same moves; UUIDs, timings, and completion order differ.

## Simulation and storage

`sim/runner.ts` starts a bounded Node worker-thread pool. A worker plays one game at a time and receives another after finishing. There are no animations, artificial waits, normal chess clocks, or rendering in workers. Parallel games run in separate JavaScript workers.

One coordinator writes each complete game's JSONL line and PGN to paired shards, rotating every 1,000 games. Unique run directories and exclusive creation preserve earlier runs. It retains only a 12-game observation ring from worker 1, not the dataset in memory. Worker failure stops the run, writes a failed summary, and retains earlier completed games. Ctrl+C stops workers and retains complete records. In-progress games are not saved as finished; stopped summaries can include partial progress counters. Power loss can leave a partial final line; resume and transactional cross-format repair are not implemented.

Each game records player names/IDs/generations/fingerprints, game ID, seed, search settings, initial/final FEN, result, termination, UCI/SAN moves, ply count, elapsed seconds, and nodes. PGNs contain matching game IDs and generation/termination tags. Move caps are explicitly adjudicated draws. Node counts include both players and repeated visits, not unique positions.

Outputs under `runs/<UTC-timestamp>-<id>/`:
`config.json`, paired `games-NNNNN.jsonl`/`games-NNNNN.pgn`, `summary.json`, and `snapshot.json`.

## Resource modes

NORMAL: `max(1, min(4, floor(availableCPUs / 2)))` workers.
OVERNIGHT: `max(1, min(16, availableCPUs - 1))` workers.
Active workers are further capped by game count. Explicit workers must be positive integers no greater than Node's reported available parallelism.

No CPU model, GPU, RAM, cooling, or power limits are guessed. Presets bound parallelism; they do not reserve CPU cores or guarantee temperature. No thermal safeguards, power limits, hardware settings, or OS safeguards are altered. More workers can use more memory. Future training needs separate device/memory limits.

## Spectator

`pnpm spectator` launches the simulation, a read-only loopback HTTP API, and the existing Vite site. Vite proxies `/api/simulation/snapshot` to port 8787. Workers report every eight plies plus start/end; the coordinator publishes every 500 ms, and the browser polls at most once per second with one outstanding request. File snapshots use atomic replacement.

The dashboard selects games from worker 1's 12-game ring and retains the selected game if it leaves the ring. A new session resets selection. Frames are reconstructed from real UCI moves through chess.js. Playback speeds: 1x = 1 s, 2x = 0.5 s, 4x = 0.25 s, plus 5x and 10x. Pause, restart, scrubbing, and speed are browser-only. No API allows the dashboard to change simulation speed or submit moves. Bounded observation adds small serialization overhead, but workers never wait for animation or the viewer.

Every metric is received run/game data. Disconnection is explicit; final metrics freeze at completion. Imported `snapshot.json` is validated/replayed locally, allowing footage on the hosted site without exposing the PC's API. Snapshots only contain the recent observation ring; historical complete games remain in PGN/JSONL. An archive browser is not implemented.

## Generations and future work

`gen0/manifest.json` pins chess.js and SHA-256 hashes of engine/evaluation source, canonicalized to LF across platforms. Verification rejects changed source. `archiveGeneration(source, destination)` uses exclusive creation and cannot overwrite old generations. It copies code and parent provenance; it does not train or promote anything. New generations load by ID without replacing gen0. Preserve old directories, Git history, and lockfiles.

`src/lib/sudalol/future.ts` contains **types only** for teacher examples/checkpoints. Phase 2 can stream completed JSONL shards, reconstruct selected positions, run Stockfish afterward, normalize scores to the player who moved, store better moves/evaluation loss, and build versioned datasets. Mate scores stay explicit, not false centipawns. Teacher results must not choose a move during a running sudalol game.

Later work can add encoders, PyTorch/CUDA policy/value networks, supervised human-PGN/tactics/teacher data, replay buffers, metrics, immutable model artifacts, and separately approved generation benchmarking/promotion. None is implemented or started here.

## Exact commands

From the project root after `pnpm install --frozen-lockfile`:

| Task | Command |
| --- | --- |
| One automated game | `pnpm simulate -- --games 1 --workers 1` |
| 100 games | `pnpm simulate -- --games 100 --mode normal` |
| Explicit 8 workers, if available | `pnpm simulate -- --games 100 --workers 8 --search-depth 1` |
| Self-play | `pnpm simulate -- --games 10 --workers 2 --white gen0 --black gen0` |
| Benchmark 1/2/4 when available | `pnpm benchmark -- --games 12 --search-depth 1` |
| Larger explicit benchmark, if at least 16 CPUs | `pnpm benchmark -- --games 32 --worker-counts 1,2,4,8,16 --search-depth 1` |
| Spectator with simulation | `pnpm spectator -- --games 100 --workers 2 --search-depth 1` |
| Overnight batch | `pnpm simulate -- --games 1000 --mode overnight --search-depth 1` |
| Website only | `pnpm dev -- --host 127.0.0.1 --port 5173` |
| Verify | `pnpm typecheck`, `pnpm test`, `pnpm build` |

`--max-moves` uses full moves; recorded/displayed counts use plies. Benchmark counts run sequentially with identical game seeds, saving separate datasets and a combined `runs/benchmark-*.json`. It reports completed games, games/s, games/min, moves/s, nodes/s, average plies, elapsed real time (including startup/persistence), and actual workers. Use repeated longer batches with consistent background load for PC tuning; smoke numbers do not establish optimal overnight settings.

## Important created files

| File | Purpose |
| --- | --- |
| `src/lib/sudalol/types.ts` | Engine/opponent, player, game, snapshot contracts |
| `src/lib/sudalol/generations/gen0/engine.ts` | Independent permanent baseline search |
| `src/lib/sudalol/generations/gen0/evaluation.ts` | Handcrafted evaluation |
| `src/lib/sudalol/generations/gen0/manifest.json` | Generation identity and source hashes |
| `src/lib/sudalol/spectator.ts` | Snapshot validation and legal replay |
| `src/lib/sudalol/future.ts` | Phase 2 types only |
| `sim/config.ts` | Resource presets/validation |
| `sim/opponents.ts` | Factory, weak bot, weighted scheduling seam |
| `sim/generations.ts` | Verification/non-overwriting archives |
| `sim/game.ts` | Game lifecycle, outcomes, PGN/record production |
| `sim/worker.ts` | Worker entry point |
| `sim/runner.ts` | Pool, progress, sharded persistence, summaries |
| `sim/server.ts` | Read-only observation endpoint |
| `sim/cli.ts` | Simulation, benchmark, spectator launch/shutdown |
| `src/components/chess/Spectator.tsx` | Dashboard |
| `src/components/chess/spectator.css` | Dark responsive design |
| `src/components/chess/Spectator.test.tsx` | Viewer behavior tests |
| `src/routes/spectator.tsx` | New route |
| `tests/simulation.test.ts` | Rules, engine, generations, games, pool/API tests |
| `pnpm-lock.yaml` | Exact tested dependency resolution |
| `docs/phase1.md`, `docs/validation.md` | Architecture, commands, validation, inventory, limits |

## Important modified files

- `README.md`: working guide replacing scaffold prompt; retains screen-share instructions.
- `package.json`: name, Node minimum, chess.js pin, commands, combined tests.
- `bun.lock`: matching project metadata/chess.js pin, retaining resolutions.
- `.gitignore`: local datasets/scratch exclusions.
- `tsconfig.json`: typechecks simulator/tests too.
- `vite.config.ts`: observation proxy, preserving framework plugins.
- `src/routeTree.gen.ts`: regenerated by the existing router build, never edited manually.
- `src/routes/index.tsx`, `src/routes/__root.tsx`: lowercase branding and accurate metadata.
- `src/components/chess/Board.tsx`: optional read-only drag guard.
- `src/components/chess/ChessAnalyzer.tsx`: branding, spectator link, explicit Stockfish/fallback identity and license explanation.
- `src/components/chess/Dialogs.tsx`, `src/components/chess/ScreenSharePanel.tsx`: correct analysis-engine labels.
- `src/lib/chess/engine.ts`: labels only, preserving the existing lifecycle.
- `src/lib/chess/engine.test.ts`, `src/components/chess/ChessAnalyzer.test.tsx`: matching labels/assertions.

No runtime library was added. Existing chess.js is pinned to 1.4.0, existing zod validates snapshots, and concurrency/HTTP/storage/hashing use Node built-ins. Existing React/UI/piece assets are reused.

## Known limitations

Gen0 is educational TypeScript, not optimized native chess code. chess.js legal/SAN generation and evaluation limit throughput. Self-play is deterministic and can repeat games; the seeded weak bot adds variation, but opening suites and measured strength are future work. Endgames are basic and move-limit draws remain possible. No Elo claim is made.

Large explicit node/table/worker settings consume CPU/RAM. Presets are conservative defaults, not hardware tuning. Dataset resume, compression, teacher analysis, GPU use, training, and promotion are absent. Live spectator sessions are local-only; hosted viewing uses imported snapshots. See [validation](validation.md).

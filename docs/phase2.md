# sudalol Phase 2

## Architecture and separation

Normal play remains board → legal sudalol search → chosen move. The immutable handcrafted gen0 engine/evaluation/manifest are byte-for-byte unchanged from Phase 1. The browser's original Stockfish analyzer and screen-share workflow remain separate at `/`.

Completed, legally replayed JSONL games feed `learning.teacher` only after simulation finishes. This launches the existing Stockfish 19 Lite WASM through the small Node UCI wrapper; a configured native UCI executable is also supported. Teacher data has no live inference import path. A separately selected `stockfish` opponent controls only its own color and is labeled `explicit opponent` with its own binary/settings fingerprint.

SQLite adapters stream teacher rows and/or game-outcome labels into an immutable dataset. PyTorch trains an 839→32→16→134 MLP (29,686 parameters). Input uses twelve absolute piece planes, side to move, KQkq castling rights, en-passant square, clipped halfmove clock and repetition count. It does not encode the complete move history; the search/rules layer retains that history for draw handling.

Outputs are 64 from-square, 64 to-square and five promotion factors plus a tanh value. A legal move's logit is the sum of its three factors; cross entropy normalizes over **legal moves only**. Value targets are `tanh(teacher_cp/600)` from the mover's perspective, mate ±1, or a final game outcome ±1/0. Mate distances remain separate in teacher records; no fabricated centipawn mate score is stored. Value is a heuristic target, not a calibrated win probability.

Training exports real weights to JSON for synchronous TypeScript inference, avoiding a Python process call at every search node. Neural candidates retain gen0's iterative alpha-beta search structure, history-aware transpositions, tactical ordering, quiescence, and node limit in a separate archived implementation. Default evaluation is 85% handcrafted + 15% learned value scaled by 600; policy adds up to a configured weight to move ordering. This hybrid is experimental, not a guaranteed improvement. CPU/GPU training and TypeScript inference agree within a tested numerical tolerance.

## Datasets and selection

Teacher selection combines tactical moves/checks/promotions, random ordinary positions, positions from losses, cheap-probe mistakes, evaluation swings, and close top-two probe evaluations as an uncertainty heuristic. `maxPerGame` bounds deep reviews; cheap probes may inspect every eligible ply until that cap. Node/depth limits bound every analysis. Selecting early qualifying positions introduces a sampling bias; use more varied sampling in Phase 3. Mate changes and ≥200 cp losses classify as blunders; ≥80 cp as mistakes. Small Stockfish budgets and bound scores can make these classifications noisy, not ground truth.

Each teacher row retains FEN, repetitions, generation, mover, played/preferred UCI, before/after mover-relative cp or mate, nonnegative loss, reasons, engine/settings/fingerprint, game ID/ply/result, nodes and UTC timestamp. SQLite commits each row. Unique IDs combine game, ply and configuration; completed-game fingerprints prevent changed games from being silently reused. Repeat a review command to process the next batch. Different settings or teacher code require a new review DB.

Dataset rows are deduplicated by normalized first four FEN fields; counters deliberately do not allow identical boards to cross splits. A seeded SHA-256 position-group assignment selects train/validation. Teacher labels take precedence when also importing game outcomes. A staging database is renamed only after completion. Repeating identical inputs reuses the version; changed inputs require a new destination. Source adapters are the extension point for human PGNs/tactics. Direct duplicates cannot leak, but nearby positions from the same game may still be correlated; this is not a held-out tournament corpus. Dataset version hashes logical examples, not unstable SQLite file bytes. Training streams mini-batches; game recovery retains compact metadata per game, not all move arrays.

## Ratings and promotion

**Generation Rating** is internal Elo with a conventional 1000 starting anchor and K=16. For each actual generation-versus-generation game, `expected=1/(1+10^((opponent-rating)/400))`, then `rating += 16*(score-expected)`, with win/draw/loss score 1/0.5/0. Both players update from their pre-game ratings. Records include W/D/L, count, change for the match, peak after any game, timestamps and opponents. Games versus uncalibrated external bots do not enter this rating pool. Events are transactional and idempotent by match ID and content fingerprint; retrying a gate cannot promote twice. Elo depends on game ordering; matches use saved index order.

**Estimated Chess Elo** remains `unrated` and null. No human-calibrated reference set exists. A future estimate requires reference ratings for the same hardware/search/time controls and sufficient independent games; neither the internal 1000 anchor nor Stockfish's name is a human rating.

Matches alternate colors on identical opening FENs and use fixed seeded settings and opponent fingerprints. Default promotion requires ≥32 games, equal color counts, ≥55% score, and a Wilson-style score interval's lower endpoint >50%. Thresholds are configurable. The Wilson calculation treats draws as half-points and games as independent: it is an approximate screening heuristic, **not a valid statistical guarantee** for correlated/deterministic paired games. Eight opening lines repeat; 32 games can contain duplicate deterministic games. General strength needs a much broader held-out opening pool, pair-aware statistics and multiple independent tests. Candidates always remain archived even when rejected.

## Generations and recovery

`training-data/generations/genN` contains checkpoint.pt, model.json, copied search/evaluation/model/encoder/types/engine source, metrics.json and manifest.json. Manifest includes parent, dataset version, config, measured metrics/device/runtime, source fingerprint and every file hash. Existence is an error; gen0 cannot be a target. Missing or modified weights/checkpoints fail verification, never silently fall back. For best portability keep custom data roots inside the repository so the archived TypeScript module can resolve the pinned chess.js dependency.

Training checkpoints atomically include model, optimizer, epoch, row offset, steps, RNG states, elapsed training time, metrics and dataset/config/code fingerprints. Safe stopping occurs between mini-batches; a hard crash repeats at most the unsaved batches. The completed CUDA smoke checkpoint deliberately predates minor recovery fixes; its original trainer/teacher sources are retained in `research/smoke-source` and it is kept as evidence rather than silently migrated. New training uses the corrected implementation. Resuming after a code/settings/device change fails explicitly; create a new run. The loop warm-starts from a neural champion's checkpoint (fresh optimizer), while gen0 has no neural weights and starts from seeded initialization. Manual training defaults to fresh initialization; set `initializeFrom` in its settings to use a neural parent.

Simulation recovery checks a fixed plan and player fingerprints, scans completed shards, ignores only a torn final JSON fragment, and schedules missing indices. Original shards are preserved. In-progress games restart. Dataset builds are replayable from immutable inputs. Ratings and teaching use SQLite WAL/FULL transactions. Staging generation directories are replayable until the final rename. These protections are not substitutes for backups or disk-space monitoring, and abrupt power loss can still lose the last unflushed simulation writes.

The finite loop runs simulation → review → dataset → train → archive → gate sequentially under one data-root OS lock. `STOP` is polled during simulation, teacher and training; dataset/archive/gate complete their current safe stage. Ctrl+C stops child simulation or saves the trainer where practical; repeat the same command after `resume`. A stop during a match preserves its games for retry. Only one learning CLI workload can own a given root. Independent roots and raw Phase 1 CLI commands can still compete for resources; do not start them concurrently for an overnight experiment.

## Resource configuration

NORMAL uses two simulation workers, single-threaded Stockfish/32 MiB hash, batch 32, two PyTorch CPU threads, automatic CUDA/CPU, and two epochs. OVERNIGHT uses four workers, single-threaded Stockfish/128 MiB hash, batch 128, eight epochs and 64 gating games. These are configurable starting points, not hardware safety assurances. CPU worker limits are checked against available CPUs; teacher thread count/hash, batch size, search budgets and checkpoint interval are bounded. The bundled WASM supports one thread; choose a native executable to use more. No BIOS, power, thermal or OS hardware safeguards are modified.

Default scheduler concept is older/self/weak/fixed/Stockfish = 40/25/15/15/5. It allocates whole color pairs by largest remainders then seed-shuffles; small batches may round a small category to zero. Any positively weighted unavailable category fails even if rounding would produce zero games. The starter NORMAL config explicitly sets older=0, self=60%, weak=20%, fixed=15%, Stockfish=5%, because gen0 has no older generation. `fixed-gen0-d3` is the original engine with depth 3/8000 nodes, a stronger **search-budget reference**, not a calibrated external engine.

## Dashboard and metric definitions

`pnpm dashboard` serves the existing spectator plus a loopback-only, read-only `/training` endpoint. No start, train or move-selection endpoints exist. Simulation publishes bounded snapshots every 500 ms; UI polls once a second. Training reports refresh at stage boundaries and checkpoint files; metrics are not interpolated. `status.json` can be imported without a local backend, and includes at most 100 saved coaching examples and their complete game replays. Selecting one pauses replay at its played move; before/after evaluation always uses that mover's perspective. Dataset membership checks exact saved example IDs.

| Metric | Meaning |
|---|---|
| Games saved | Sum of completed planned jobs, excludes live unfinished games and separate experiment roots |
| Positions played | Saved plies, not unique board states and not simulated hours |
| Search nodes | Counted search visits, including quiescence; may revisit positions |
| Teacher reviewed | Deep-reviewed stored examples; excludes cheap selection probes |
| Dataset examples | Sum of positions across frozen dataset versions; overlaps across versions can count more than once |
| Loss | Legal-policy cross entropy + value mean squared error |
| Policy accuracy | Top legal move equals teacher/label target, not win rate |
| Value error | Mean squared error on bounded target values |
| Training elapsed | Measured training/checkpoint/evaluation loop time; excludes environment setup and process/model startup |
| Score | (wins + draws/2) / games |
| Peak rating | Highest internal rating after any recorded game; separate from champion status |
| Candidate | Current finite-loop candidate; unknown/dash when there is no active loop |

## Files and extension points

- `learning/common.py`: storage, hashing, OS lock and completed-game validation.
- `learning/matches.py`, `ratings.py`, `jobs.ts`: pairing, category scheduling, resumable Phase 1 runner, benchmark summaries, Elo and promotion.
- `learning/stockfish.cjs`, `uci.ts`, `teacher.py`: shared binary wrapper, explicit opponent, offline coach.
- `learning/dataset.py`, `model.py`, `train.py`: streaming adapters, encoder/legal policy/value, checkpoint/recovery and immutable archives.
- `learning/cli.py`, `report.py`, `dashboard.ts`, `configs/*.json`, `requirements.txt`: finite orchestration, observation and Windows setup.
- `src/lib/sudalol/neural/*`: independent hybrid inference/search implementation; gen0 is untouched.
- `src/lib/sudalol/training.ts`, `src/components/chess/TrainingPanel.tsx`: strict saved-data validation and coaching/ratings UI.
- Existing `sim/config.ts`, `game.ts`, `runner.ts`, `opponents.ts`, `generations.ts`, `server.ts`, engine types and Spectator component/styles were extended; existing browser analyzer source was not changed.
- `learning/test_learning.py`, `tests/learning.test.ts`: new regression/integration tests. Two existing test expectations were adapted for the added opponent and read-only training endpoint.
- `research/baselines/gen0-v1`, `research/smoke-source`, `docs/phase2-results.md`: permanent baseline and provenance. Local data/venv/checkpoints are gitignored and provided separately in the evidence bundle.

Phase 3 can build on real persisted games, teacher labels, CUDA/CPU training, versioned inference, finite loops and gates. Priorities: broader held-out openings/opponents, calibrated strength testing, pair-aware uncertainty, stronger architecture, incremental inference/export optimization, deeper teacher sampling, game-group holdouts and a replay buffer across iterations. No improvement or long-duration reliability claim is made from this smoke run.

Reference behavior: [PyTorch reproducibility limitations](https://docs.pytorch.org/docs/2.9/notes/randomness.html) (same seeds do not guarantee identical results across devices/versions); [python-chess UCI analysis and score perspective](https://python-chess.readthedocs.io/en/latest/engine.html). Stockfish's existing license/source notices remain in `public/engine`.

import { useEffect, useState } from "react";
import { parseTraining, type TrainingSnapshot } from "@/lib/sudalol/training";
import type { ObservedGame } from "@/lib/sudalol/types";

const number = (value: number | undefined, digits = 0) =>
  value === undefined ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const evaluation = (value: { cp: number | null; mate: number | null }) =>
  value.mate !== null ? `mate ${value.mate}` : `${number((value.cp ?? 0) / 100, 2)} pawns`;
export function TrainingPanel({
  gameId,
  ply,
  onReplay,
}: {
  gameId?: string;
  ply: number;
  onReplay: (game: ObservedGame, ply: number) => void;
}) {
  const [data, setData] = useState<TrainingSnapshot | null>(null);
  const [error, setError] = useState("");
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (offline) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch("/api/simulation/training", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error("Start the learning dashboard or import a saved status.json.");
        const next = parseTraining(await response.json());
        if (active) {
          setData(next);
          setError("");
        }
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "Training feed unavailable");
      } finally {
        if (active) timer = setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [offline]);
  const last = data?.training.at(-1);
  const loss = last?.history.at(-1);
  const coaching = data?.coaching.find((row) => row.gameId === gameId && row.ply === ply - 1);
  const replay = (id: string, position: number) => {
    const game = data?.reviewedGames.find((g) => g.gameId === id);
    if (game) onReplay(game, position + 1);
  };
  return (
    <section className="sudalol-training" aria-label="Training laboratory">
      <div className="sudalol-training-heading">
        <div>
          <div className="sudalol-eyebrow">PHASE 02 · EXPERIENCE → REVIEW → LEARN</div>
          <h2>Learning laboratory</h2>
          <p>Recorded evidence. Every candidate earns its place.</p>
        </div>
        <span className="sudalol-status">
          {offline ? "SAVED REPORT" : (data?.pipeline.phase?.toUpperCase() ?? "NO ACTIVE LOOP")}
        </span>
      </div>
      {error && (
        <p className="sudalol-notice" role="status">
          Training feed: {data ? "Showing the last received report. " : ""}
          {error}
        </p>
      )}
      <div className="sudalol-metrics">
        {[
          ["Champion", data?.champion ?? "—"],
          ["Candidate", data?.pipeline.candidate ?? "—"],
          ["Games saved", number(data?.totalGames)],
          ["Positions played", number(data?.totalPositions)],
          ["Teacher reviewed", number(data?.reviewedPositions)],
          ["Dataset examples", number(data?.trainingExamples)],
          ["Training loss", number(loss?.train.loss, 4)],
          ["Validation loss", number(loss?.validation.loss, 4)],
        ].map(([label, value]) => (
          <div className="sudalol-metric" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="sudalol-training-grid">
        <section className="sudalol-card">
          <h3>Generation rating</h3>
          <p className="sudalol-small">
            Internal competition · 1000 starting anchor · actual generation matches only
          </p>
          <div className="sudalol-rating-list">
            {data?.ratings.map((row) => (
              <div className="sudalol-rating" key={row.generation}>
                <strong>
                  {row.generation}
                  {row.generation === data.champion ? " · champion" : ""}
                </strong>
                <span>
                  {number(row.rating, 1)}{" "}
                  <small>
                    ({row.change >= 0 ? "+" : ""}
                    {number(row.change, 1)})
                  </small>
                </span>
                <progress
                  max={2000}
                  value={Math.min(row.rating, 2000)}
                  aria-label={`${row.generation} internal rating`}
                />
                <small>
                  {row.wins} W / {row.draws} D / {row.losses} L · peak {number(row.peak, 1)}
                </small>
              </div>
            )) ?? <p>No rated matches yet.</p>}
          </div>
          <div className="sudalol-elo">
            <span>Estimated Chess Elo</span>
            <strong>unrated</strong>
            <p>No human-calibrated reference set is available.</p>
          </div>
        </section>
        <section className="sudalol-card">
          <h3>Training telemetry</h3>
          <dl>
            <dt>Iteration completed</dt>
            <dd>{number(data?.pipeline.iteration)}</dd>
            <dt>Epochs completed</dt>
            <dd>{number(last?.epochsCompleted)}</dd>
            <dt>Optimizer steps</dt>
            <dd>{number(last?.steps)}</dd>
            <dt>Training elapsed</dt>
            <dd>{number(last?.elapsedSeconds, 2)} s</dd>
            <dt>Policy accuracy · validation</dt>
            <dd>{loss ? number(loss.validation.policyAccuracy * 100, 2) + "%" : "—"}</dd>
            <dt>Value error · validation MSE</dt>
            <dd>{number(loss?.validation.valueError, 4)}</dd>
            <dt>Device</dt>
            <dd>{last?.device ?? "unknown"}</dd>
          </dl>
          <p className="sudalol-small">
            {last?.hardware ?? "Hardware is detected when training starts."} Loss and accuracy
            describe imitation on this dataset; they do not measure playing strength.
          </p>
          {data?.matches.slice(-2).map((match) => (
            <p key={match.run} className="sudalol-small">
              {match.run}: {match.wins} W / {match.draws} D / {match.losses} L ({match.games} games)
            </p>
          ))}
        </section>
        <section className="sudalol-card">
          <h3>Stockfish coaching · after the game</h3>
          <p className="sudalol-small">
            Select a saved review to replay its move on the board above.
          </p>
          <select
            aria-label="Reviewed move"
            value={coaching?.id ?? ""}
            onChange={(event) => {
              const row = data?.coaching.find((r) => r.id === event.target.value);
              if (row) replay(row.gameId, row.ply);
            }}
          >
            <option value="">Choose a reviewed position</option>
            {data?.coaching.map((row) => (
              <option key={row.id} value={row.id}>
                {row.generation} · ply {row.ply + 1} · {row.played} · {row.classification}
              </option>
            ))}
          </select>
          {coaching ? (
            <>
              <dl>
                <dt>sudalol played</dt>
                <dd>{coaching.played}</dd>
                <dt>Stockfish preferred</dt>
                <dd>{coaching.recommended}</dd>
                <dt>Before → after (mover POV)</dt>
                <dd>
                  {evaluation(coaching.before)} → {evaluation(coaching.after)}
                </dd>
                <dt>Centipawn loss</dt>
                <dd>{coaching.centipawnLoss ?? "mate · separate scale"}</dd>
                <dt>Classification</dt>
                <dd>{coaching.classification}</dd>
                <dt>Added to dataset</dt>
                <dd>{coaching.inDataset ? "yes" : "no"}</dd>
              </dl>
              <p className="sudalol-small">Selected for: {coaching.selectionReasons.join(", ")}</p>
            </>
          ) : (
            <p className="sudalol-small">No saved review at the displayed move.</p>
          )}
        </section>
      </div>
      <div className="sudalol-import">
        <label className="sudalol-import-label">
          Import training status.json
          <input
            aria-label="Import training report"
            type="file"
            accept=".json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                if (file.size > 16 * 1024 * 1024) throw new Error("Training report exceeds 16 MB");
                setData(parseTraining(JSON.parse(await file.text())));
                setOffline(true);
                setError("");
              } catch (error) {
                setError(error instanceof Error ? error.message : "Invalid training report");
              }
              event.target.value = "";
            }}
          />
        </label>
        {offline && <button onClick={() => setOffline(false)}>Reconnect training feed</button>}
        <p className="sudalol-small">
          Updated {data?.savedAt ?? "unknown"} · workload snapshots update at saved checkpoints and
          stage boundaries. Dataset counts are summed across versions.
        </p>
      </div>
    </section>
  );
}

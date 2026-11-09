import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowLeft, Cpu, Pause, Play, RotateCcw, Upload } from "lucide-react";
import { Board } from "./Board";
import { parseFen, START_FEN } from "@/lib/chess/position";
import { parseSnapshot, replayFrames } from "@/lib/sudalol/spectator";
import type { ObservedGame, RunSnapshot } from "@/lib/sudalol/types";
import "./spectator.css";
import { TrainingPanel } from "./TrainingPanel";

const format = (n: number | undefined, decimals = 0) => n === undefined ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: decimals });
const elapsed = (seconds: number) => `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;

export function Spectator() {
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [selected, setSelected] = useState<ObservedGame | null>(null);
  const [ply, setPly] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(true);
  const [offline, setOffline] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const currentRun = useRef<string | null>(null);
  useEffect(() => {
    if (offline) return;
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const response = await fetch("/api/simulation/snapshot", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Start a local spectator session to connect, or import a saved snapshot.");
        const value = parseSnapshot(await response.json());
        if (active) { setSnapshot(value); setConnected(true); setError(""); }
      } catch (e) { if (active) { setConnected(false); setError(e instanceof Error ? e.message : "Connection lost"); } }
      finally { if (active) timer = setTimeout(poll, 1000); }
    }
    void poll();
    return () => { active = false; controller.abort(); clearTimeout(timer); };
  }, [offline]);
  useEffect(() => {
    if (!snapshot) return;
    if (currentRun.current !== snapshot.runId) {
      currentRun.current = snapshot.runId;
      setSelected(snapshot.observed[0] ?? null);
      setPly(0);
      return;
    }
    setSelected((previous) => previous ? snapshot.observed.find((game) => game.gameId === previous.gameId) ?? previous : snapshot.observed[0] ?? null);
  }, [snapshot]);
  const frames = useMemo(() => selected ? replayFrames(selected) : [START_FEN], [selected]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setPly((p) => Math.min(p + 1, frames.length - 1)), 1000 / speed);
    return () => clearInterval(timer);
  }, [playing, speed, frames.length]);
  const displayedPly = Math.min(ply, frames.length - 1);
  const fen = frames[displayedPly];
  const last = selected?.moves[displayedPly - 1];
  const games = snapshot?.observed ?? [];
  const choices = selected && !games.some((game) => game.gameId === selected.gameId) ? [selected, ...games] : games;
  const choose = (id: string) => { setSelected(choices.find((game) => game.gameId === id) ?? null); setPly(0); };
  const metric = (label: string, value: string, unit: string) => <div className="sudalol-metric"><span>{label}</span><strong>{value}<small>{unit}</small></strong></div>;
  return (
    <main className="sudalol-observer dark" data-board-theme="slate">
      <div className="sudalol-shell">
        <header className="sudalol-header">
          <a href="/" className="sudalol-wordmark">sudalol<span> / laboratory</span></a>
          <a href="/" className="sudalol-back"><ArrowLeft size={15} /> Position analyzer</a>
        </header>
        <section className="sudalol-heading">
          <div><div className="sudalol-eyebrow">sudalol · INDEPENDENT CHESS ENGINE</div><h1>Watch the thinking.</h1><p>Headless simulation. A front-row seat to every move.</p></div>
          <span className={`sudalol-status ${connected && snapshot?.status === "running" ? "is-live" : ""}`}><span />{offline ? "SAVED REPLAY" : !connected ? "DISCONNECTED" : snapshot?.status.toUpperCase()}</span>
        </section>
        <section className="sudalol-metrics" aria-label="Simulation statistics">
          {metric("Games completed", format(snapshot?.completedGames), snapshot ? ` / ${snapshot.requestedGames}` : "")}
          {metric("Throughput", format(snapshot?.gamesPerMinute, 2), " games/min")}
          {metric("Moves processed", format(snapshot?.moves), " plies")}
          {metric("Positions searched", format(snapshot?.nodes), " nodes")}
        </section>
        {error && <div className="sudalol-notice" role="status">{snapshot ? "Connection interrupted. Showing the last received data. " : ""}{error}</div>}
        {snapshot?.error && <div className="sudalol-notice" role="alert">{snapshot.error}</div>}
        <div className="sudalol-workspace">
          <section className="sudalol-board-panel">
            <div className="sudalol-player"><span className="sudalol-piece-dot black" /><div><strong>{selected?.black.name ?? "Waiting for a game"}</strong><span>BLACK · {selected?.black.generation ?? "—"}</span></div><span className="sudalol-player-role">{selected?.finished ? selected.result : "OBSERVING"}</span></div>
            <Board board={parseFen(fen).board} flipped={false} showCoords arrows={[]} selected={null} legalTargets={[]} onSquareClick={() => {}} onDrop={() => {}} readOnly lastMove={last ? { from: last.slice(0, 2), to: last.slice(2, 4) } : undefined} />
            <div className="sudalol-player"><span className="sudalol-piece-dot white" /><div><strong>{selected?.white.name ?? "sudalol gen0"}</strong><span>WHITE · {selected?.white.generation ?? "—"}</span></div><span className="sudalol-player-role">{selected ? `MOVE ${fen.split(" ")[5]} · ${fen.split(" ")[1] === "w" ? "WHITE" : "BLACK"} TO MOVE` : "NO DATA"}</span></div>
            <div className="sudalol-playback">
              <button aria-label={playing ? "Pause playback" : "Play replay"} onClick={() => setPlaying(!playing)}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
              <button aria-label="Restart replay" onClick={() => setPly(0)}><RotateCcw size={16} /></button>
              <input aria-label="Displayed move" type="range" min={0} max={Math.max(0, frames.length - 1)} value={displayedPly} onChange={(e) => setPly(Number(e.target.value))} />
              <span>{displayedPly} / {frames.length - 1}</span>
              <select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 2, 4, 5, 10].map((s) => <option key={s} value={s}>{s}x</option>)}</select>
            </div>
          </section>
          <aside className="sudalol-sidebar">
            <section className="sudalol-card"><div className="sudalol-card-title"><Activity size={17} /><h2>Observation feed</h2></div>
              <label htmlFor="observed-game">SELECT GAME · WORKER 1</label>
              <select id="observed-game" value={selected?.gameId ?? ""} onChange={(e) => choose(e.target.value)} disabled={!choices.length}>
                {!choices.length && <option value="">Waiting for simulation data</option>}
                {choices.map((game) => <option key={game.gameId} value={game.gameId}>{game.gameId.slice(0, 8)} · {game.finished ? game.result : "in progress"}</option>)}
              </select>
              <dl><dt>Game ID</dt><dd className="sudalol-id">{selected?.gameId ?? "—"}</dd><dt>Current move</dt><dd>{selected?.san[displayedPly - 1] ?? "Starting position"}</dd><dt>Termination</dt><dd>{selected?.termination ?? "—"}</dd></dl>
              <p className="sudalol-small">{selected?.finished ? "Replaying a completed simulation." : "Moves arrive as the worker advances."} Playback controls only change this board.</p>
            </section>
            <section className="sudalol-card"><div className="sudalol-card-title"><Cpu size={17} /><h2>Session telemetry</h2></div>
              <dl><dt>Elapsed simulation</dt><dd>{snapshot ? elapsed(snapshot.elapsedSeconds) : "—"}</dd><dt>Worker count</dt><dd>{format(snapshot?.workers)}</dd><dt>Moves / second</dt><dd>{format(snapshot?.movesPerSecond, 2)}</dd><dt>Nodes / second</dt><dd>{format(snapshot?.nodesPerSecond, 1)}</dd><dt>Average game</dt><dd>{format(snapshot?.averageGameLength, 1)} plies</dd></dl>
              <div className="sudalol-independence"><span /> sudalol chooses its own moves · Stockfish opponents are labeled</div>
            </section>
            <section className="sudalol-card sudalol-import"><label className="sudalol-import-label"><Upload size={16} /> Import snapshot.json<input aria-label="Import snapshot" type="file" accept=".json,application/json" onChange={async (event) => {
                const file = event.target.files?.[0]; if (!file) return;
                try { if (file.size > 8 * 1024 * 1024) throw new Error("Snapshot exceeds 8 MB"); const value = parseSnapshot(JSON.parse(await file.text())); setOffline(true); setConnected(false); setSnapshot(value); setSelected(value.observed[0] ?? null); setPly(0); setError(""); }
                catch (e) { setError(e instanceof Error ? e.message : "Invalid snapshot"); }
                event.target.value = "";
              }} /></label>
              {offline && <button onClick={() => { setOffline(false); setSelected(null); setPly(0); }}>Reconnect to local session</button>}
              <p className="sudalol-small">Start locally with <code>pnpm spectator -- --games 100</code>. Saved snapshots also work on the hosted site.</p>
            </section>
          </aside>
        </div>
        <TrainingPanel gameId={selected?.gameId} ply={displayedPly} onReplay={(game,position)=>{setSelected(game);setPly(position);setPlaying(false);}} />
        <footer className="sudalol-footer"><span>sudalol · gen0 preserved permanently</span><span>Actual games · offline teaching · measured promotion</span></footer>
      </div>
    </main>
  );
}

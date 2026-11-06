// Screen-share board reader. Analysis/training only: it never controls or interacts with the shared site.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, Loader2, MonitorUp, RefreshCw, ScanSearch, Square as StopIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { FILES, type BoardMap, type PieceCode } from "@/lib/chess/position";
import { createBoardVision, grabFrame, placementOf, type BoardReading, type CropRect, type Orientation, type VisionFrame } from "@/lib/vision/boardVision";
import { pieceSrc } from "./Board";

const PIECES: PieceCode[] = ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"];
type Phase = "idle" | "sharing" | "crop" | "detecting" | "review";

export function ScreenSharePanel({ turn, onApply }: { turn: "w" | "b"; onApply: (board: BoardMap, turn: "w" | "b", analyze: boolean) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vision = useRef(createBoardVision(pieceSrc));
  const [phase, setPhase] = useState<Phase>("idle");
  const [shot, setShot] = useState<{ frame: VisionFrame; url: string } | null>(null);
  const [crop, setCrop] = useState({ x: 0.2, y: 0.1, s: 0.6 }); // fractions; s = side as fraction of width
  const [orient, setOrient] = useState<Orientation>("auto");
  const [reading, setReading] = useState<BoardReading | null>(null);
  const [draft, setDraft] = useState<BoardMap>({});
  const [draftTurn, setDraftTurn] = useState(turn);
  const [brush, setBrush] = useState<PieceCode | "empty">("wP");
  const [watch, setWatch] = useState(false);
  const [auto, setAuto] = useState(false);
  const lastPlacement = useRef<string | null>(null);
  const candidate = useRef<string | null>(null);

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setWatch(false);
    setPhase("idle");
    setShot(null);
  };
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streamRef.current = s;
      s.getVideoTracks()[0].addEventListener("ended", stop);
      setPhase("sharing");
      requestAnimationFrame(() => {
        if (videoRef.current) (videoRef.current.srcObject = s), void videoRef.current.play();
      });
    } catch {
      toast.error("Screen sharing was cancelled or blocked");
    }
  };

  const toRect = (f: VisionFrame): CropRect => {
    const side = crop.s * f.width;
    return { x: crop.x * f.width, y: crop.y * f.height, w: side, h: side };
  };

  const capture = () => {
    const g = videoRef.current && grabFrame(videoRef.current);
    if (!g) return toast.error("No video frame yet");
    setShot(g);
    const ar = g.frame.width / g.frame.height;
    setCrop((c) => ({ ...c, s: Math.min(c.s, 1 - c.x, (1 - c.y) / ar) }));
    setPhase("crop");
  };

  const detect = async (frame = shot?.frame) => {
    if (!frame) return;
    setPhase("detecting");
    try {
      const r = await vision.current.read(frame, toRect(frame), orient);
      setReading(r);
      setDraft(r.board);
      setDraftTurn(turn);
      setPhase("review");
    } catch (e) {
      toast.error("Detection failed", { description: String(e) });
      setPhase("crop");
    }
  };

  const accept = (analyze: boolean) => {
    lastPlacement.current = placementOf(draft);
    onApply(draft, draftTurn, analyze);
    setPhase("sharing");
  };

  // Watch mode: sample periodically, react only to stable, confident changes.
  useEffect(() => {
    if (!watch || phase !== "sharing") return;
    const id = setInterval(async () => {
      const g = videoRef.current && grabFrame(videoRef.current);
      if (!g) return;
      const r = await vision.current.read(g.frame, toRect(g.frame), orient);
      if (r.placement === lastPlacement.current || r.confidence < 0.7) return (candidate.current = null);
      if (candidate.current !== r.placement) return (candidate.current = r.placement); // wait for a second identical sample
      candidate.current = null;
      if (auto) {
        lastPlacement.current = r.placement;
        onApply(r.board, turn, true);
        toast.message("Board change detected — analyzing");
      } else {
        setShot(g);
        setReading(r);
        setDraft(r.board);
        setPhase("review");
      }
    }, 1500);
    return () => clearInterval(id);
  });

  const label = { idle: "Off", sharing: watch ? "Watching" : "Sharing", crop: "Select board", detecting: "Detecting", review: "Review Position" }[phase];

  // crop dragging
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = (e: React.PointerEvent, kind: "move" | "size") => {
    e.preventDefault();
    e.stopPropagation();
    const el = boxRef.current!.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY, c0 = crop;
    const ar = el.width / el.height;
    const mv = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / el.width, dy = (ev.clientY - sy) / el.height;
      if (kind === "move")
        setCrop({ ...c0, x: Math.max(0, Math.min(1 - c0.s, c0.x + dx)), y: Math.max(0, Math.min(1 - c0.s * ar, c0.y + dy)) });
      else setCrop({ ...c0, s: Math.max(0.05, Math.min(1 - c0.x, (1 - c0.y) / ar, c0.s + Math.max(dx, dy * (1 / ar)))) });
    };
    const up = () => (window.removeEventListener("pointermove", mv), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
  };

  return (
    <Card className="gap-3 p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Screen board reader</h3>
        <span className={cn("rounded-full border px-2 py-0.5 text-[11px]", phase !== "idle" && "border-primary text-primary")}>{label}</span>
      </div>
      {phase === "idle" ? (
        <Button variant="outline" onClick={start}><MonitorUp /> Share Screen</Button>
      ) : (
        <>
          <video ref={videoRef} muted playsInline className={cn("w-full rounded-md border bg-muted", phase !== "sharing" && "hidden")} />
          {(phase === "crop" || phase === "detecting") && shot && (
            <div ref={boxRef} className="relative w-full select-none overflow-hidden rounded-md border no-touch">
              <img src={shot.url} alt="Captured frame" className="block w-full" draggable={false} />
              <div
                role="slider"
                aria-label="Board crop area"
                aria-valuenow={Math.round(crop.s * 100)}
                className="absolute cursor-move border-2 border-primary bg-primary/10"
                style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.s * 100}%`, aspectRatio: "1" }}
                onPointerDown={(e) => drag(e, "move")}
              >
                <div className="pointer-events-none grid h-full w-full grid-cols-8 grid-rows-8">
                  {Array.from({ length: 64 }, (_, i) => <div key={i} className="border border-primary/30" />)}
                </div>
                <div className="absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-sm bg-primary" onPointerDown={(e) => drag(e, "size")} />
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">Orientation</Label>
            <ToggleGroup type="single" size="sm" variant="outline" value={orient} onValueChange={(v) => v && setOrient(v as Orientation)}>
              <ToggleGroupItem value="auto" className="text-xs">Auto</ToggleGroupItem>
              <ToggleGroupItem value="white" className="text-xs">White ↓</ToggleGroupItem>
              <ToggleGroupItem value="black" className="text-xs">Black ↓</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {phase === "review" && reading ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Confidence <b className="text-foreground">{Math.round(reading.confidence * 100)}%</b> · {reading.orientation === "white" ? "White" : "Black"} at bottom. Click squares to correct.
              </p>
              <div className="grid grid-cols-8 overflow-hidden rounded border">
                {Array.from({ length: 64 }, (_, i) => {
                  const r = (i / 8) | 0, c = i % 8;
                  const sq = `${FILES[c]}${8 - r}`;
                  const low = (reading.squares.find((s) => s.square === sq)?.confidence ?? 1) < 0.5;
                  return (
                    <button
                      key={sq}
                      aria-label={sq}
                      className={cn("aspect-square p-0.5", (r + c) % 2 ? "bg-board-dark" : "bg-board-light", low && "ring-2 ring-inset ring-destructive")}
                      onClick={() => setDraft((d) => { const n = { ...d }; if (brush === "empty") delete n[sq]; else n[sq] = brush; return n; })}
                    >
                      {draft[sq] && <img src={pieceSrc(draft[sq])} alt="" className="h-full w-full" draggable={false} />}
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-1">
                {PIECES.map((p) => (
                  <button key={p} aria-label={`Brush ${p}`} onClick={() => setBrush(p)} className={cn("h-7 w-7 rounded border", brush === p && "border-primary bg-primary/10")}>
                    <img src={pieceSrc(p)} alt="" />
                  </button>
                ))}
                <button onClick={() => setBrush("empty")} className={cn("h-7 rounded border px-2 text-[11px]", brush === "empty" && "border-primary bg-primary/10")}>Erase</button>
              </div>
              <ToggleGroup type="single" size="sm" variant="outline" value={draftTurn} onValueChange={(v) => v && setDraftTurn(v as "w" | "b")}>
                <ToggleGroupItem value="w" className="text-xs">White to move</ToggleGroupItem>
                <ToggleGroupItem value="b" className="text-xs">Black to move</ToggleGroupItem>
              </ToggleGroup>
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" onClick={() => accept(true)}>Use Position</Button>
                <Button size="sm" variant="outline" onClick={() => setPhase(shot ? "crop" : "sharing")}><RefreshCw /> Try Again</Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {phase === "sharing" ? (
                <Button size="sm" onClick={capture}><ScanSearch /> Detect Board</Button>
              ) : (
                <Button size="sm" onClick={() => detect()} disabled={phase === "detecting"}>
                  {phase === "detecting" ? <Loader2 className="animate-spin" /> : <ScanSearch />} Read board
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={stop}><StopIcon /> Stop Sharing</Button>
            </div>
          )}
          {phase === "crop" && <Button size="sm" variant="ghost" onClick={() => setPhase("sharing")}>Back to live feed</Button>}

          {phase === "sharing" && (
            <div className="space-y-2 rounded-md border p-2">
              <label className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1"><Eye className="h-3.5 w-3.5" /> Watch Board (uses last crop)</span>
                <Switch checked={watch} onCheckedChange={setWatch} />
              </label>
              <label className="flex items-center justify-between text-xs">
                <span>Auto-update &amp; analyze without review</span>
                <Switch checked={auto} onCheckedChange={setAuto} disabled={!watch} />
              </label>
            </div>
          )}
        </>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        Capture stays local in your browser — nothing is uploaded. For analysis and training. This feature does not play moves on other sites.
      </p>
    </Card>
  );
}

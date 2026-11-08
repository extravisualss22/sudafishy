// Local, read-only screen capture. No interaction with the shared website.
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2, MonitorUp, RefreshCw, ScanSearch, Square as StopIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { FILES, parseFen, type BoardMap, type PieceCode } from "@/lib/chess/position";
import {
  createBoardVision,
  grabFrame,
  type BoardReading,
  type CropRect,
  type Orientation,
  type VisionFrame,
} from "@/lib/vision/boardVision";
import { conservativeFen, inferWatchedFen } from "@/lib/vision/reviewPosition";
import { pieceName, pieceSrc } from "./Board";

const PIECES: PieceCode[] = [
  "wK",
  "wQ",
  "wR",
  "wB",
  "wN",
  "wP",
  "bK",
  "bQ",
  "bR",
  "bB",
  "bN",
  "bP",
];
const LOW_CONFIDENCE = 0.65;
const SAMPLE_INTERVAL = 1750;
type Phase = "idle" | "starting" | "sharing" | "crop" | "detecting" | "review";
type Crop = { x: number; y: number; s: number };
type Shot = { frame: VisionFrame; url: string };
interface Props {
  turn: "w" | "b";
  fen?: string;
  onApply: (
    board: BoardMap,
    turn: "w" | "b",
    analyze: boolean,
    verifiedFen?: string,
  ) => boolean | void;
}

function boundedCrop(c: Crop, aspect: number): Crop {
  const s = Math.min(Math.max(0.05, c.s), 1, 1 / aspect);
  return { s, x: Math.max(0, Math.min(1 - s, c.x)), y: Math.max(0, Math.min(1 - s * aspect, c.y)) };
}
function rectFor(crop: Crop, frame: VisionFrame): CropRect {
  const c = boundedCrop(crop, frame.width / frame.height);
  return {
    x: c.x * frame.width,
    y: c.y * frame.height,
    w: c.s * frame.width,
    h: c.s * frame.width,
  };
}

export function ScreenSharePanel({ turn, fen, onApply }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const vision = useRef<ReturnType<typeof createBoardVision> | null>(null);
  if (!vision.current) vision.current = createBoardVision(pieceSrc);
  const latest = useRef({ turn, onApply });
  latest.current = { turn, onApply };
  const generation = useRef(0);
  const watchReadBusy = useRef(false);
  const dragCleanup = useRef<(() => void) | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [shot, setShot] = useState<Shot | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0.2, y: 0.1, s: 0.6 });
  const [orient, setOrient] = useState<Orientation>("auto");
  const [reading, setReading] = useState<BoardReading | null>(null);
  const [draft, setDraft] = useState<BoardMap>({});
  const [draftTurn, setDraftTurn] = useState(turn);
  const [brush, setBrush] = useState<PieceCode | "empty">("wP");
  const [watch, setWatch] = useState(false);
  const [auto, setAuto] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [corrected, setCorrected] = useState<Set<string>>(new Set());
  const lastFen = useRef<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const stop = useCallback(() => {
    generation.current++;
    dragCleanup.current?.();
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    lastFen.current = null;
    setWatch(false);
    setAuto(false);
    setConfirmed(false);
    setPhase("idle");
    setShot(null);
    setReading(null);
    setMessage("Screen sharing stopped.");
  }, []);

  useEffect(
    () => () => {
      generation.current++;
      dragCleanup.current?.();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    },
    [],
  );

  // A position changed in the main analyzer must not be silently overwritten by
  // an older watch session. The user can capture/review to establish a new seed.
  useEffect(() => {
    if (!fen || !lastFen.current || !confirmed) return;
    if (fen !== lastFen.current) {
      generation.current++;
      setWatch(false);
      setConfirmed(false);
      setMessage(
        "The main position changed. Detect and review the shared board again before watching.",
      );
    }
  }, [fen, confirmed]);

  const start = async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setMessage(
        "Screen sharing is unavailable in this browser. Use a supported browser on HTTPS, or enter a position manually.",
      );
      return;
    }
    const run = ++generation.current;
    setPhase("starting");
    setMessage("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      if (run !== generation.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error("No video track was supplied.");
      track.addEventListener(
        "ended",
        () => {
          if (streamRef.current === stream) stop();
        },
        { once: true },
      );
      const video = videoRef.current;
      if (!video) throw new Error("The video preview is unavailable.");
      video.srcObject = stream;
      await video.play();
      if (run !== generation.current) return;
      setPhase("sharing");
      setMessage("Select Detect Board, then align the square crop with all 64 squares.");
    } catch (error) {
      if (run !== generation.current) return;
      stop();
      setMessage(
        typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "NotAllowedError"
          ? "Screen sharing was cancelled or blocked. You can continue using the main analysis board."
          : `Screen sharing could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const capture = () => {
    try {
      const frame = videoRef.current && grabFrame(videoRef.current);
      if (!frame) {
        setMessage("No video frame yet. Wait for the preview to load and try again.");
        return;
      }
      generation.current++;
      setWatch(false);
      setConfirmed(false);
      setShot(frame);
      setCrop((c) => boundedCrop(c, frame.frame.width / frame.frame.height));
      setPhase("crop");
      setMessage(
        "Drag the square over the board and resize using its corner. Arrow keys move it; Shift + arrow keys resize it.",
      );
    } catch (error) {
      setMessage(
        `Could not capture this frame: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const review = (result: BoardReading, frame: Shot, nextTurn: "w" | "b") => {
    setShot(frame);
    setReading(result);
    setDraft({ ...result.board });
    setDraftTurn(nextTurn);
    setCorrected(new Set());
    setPhase("review");
  };

  const detect = async () => {
    if (!shot) return;
    const run = ++generation.current;
    setPhase("detecting");
    setMessage("Estimating pieces locally. You will review the result before it is applied.");
    try {
      const result = await vision.current!.read(shot.frame, rectFor(crop, shot.frame), orient);
      if (run !== generation.current || !streamRef.current) return;
      review(result, shot, latest.current.turn);
      setMessage(
        "Detection is an estimate, not a guarantee. Correct any pieces and choose the side to move before using the position.",
      );
    } catch (error) {
      if (run !== generation.current) return;
      setMessage(`Detection failed: ${error instanceof Error ? error.message : String(error)}`);
      setPhase("crop");
    }
  };

  const accept = () => {
    try {
      const nextFen = conservativeFen(draft, draftTurn);
      if (latest.current.onApply({ ...draft }, draftTurn, true) === false) return;
      lastFen.current = nextFen;
      setConfirmed(true);
      setPhase("sharing");
      setMessage(
        "Position loaded into Stockfish. Castling and en-passant rights were cleared because an image cannot establish them.",
      );
    } catch (error) {
      setMessage(
        `Please correct the position: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  useEffect(() => {
    if (!watch || !confirmed || phase !== "sharing" || !shot) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let candidate: string | null = null;
    const run = generation.current;
    const dimensions = { width: shot.frame.width, height: shot.frame.height };
    const sample = async () => {
      if (watchReadBusy.current) {
        timer = setTimeout(() => {
          void sample();
        }, SAMPLE_INTERVAL);
        return;
      }
      watchReadBusy.current = true;
      try {
        if (document.hidden) {
          candidate = null;
          return;
        }
        const frame = videoRef.current && grabFrame(videoRef.current);
        if (!frame) {
          candidate = null;
          return;
        }
        if (frame.frame.width !== dimensions.width || frame.frame.height !== dimensions.height) {
          setWatch(false);
          setConfirmed(false);
          setMessage("The shared screen size changed. Select Detect Board to realign the crop.");
          return;
        }
        const result = await vision.current!.read(frame.frame, rectFor(crop, frame.frame), orient);
        if (cancelled || generation.current !== run || !streamRef.current) return;
        const previous = lastFen.current;
        const confident =
          result.confidence >= 0.8 &&
          result.squares.length === 64 &&
          result.squares.every((square) => square.confidence >= LOW_CONFIDENCE) &&
          (orient !== "auto" || (result.orientationConfidence ?? 0) >= 0.75);
        if (!previous || !confident || result.placement === previous.split(" ")[0]) {
          candidate = null;
          if (!confident)
            setMessage(
              "Watching: uncertain squares or orientation; waiting for a clearer stable position. You can detect and review manually.",
            );
          return;
        }
        const key = `${result.orientation}:${result.placement}`;
        if (candidate !== key) {
          candidate = key;
          return;
        }
        candidate = null;
        const inferred = inferWatchedFen(previous, result);
        const nextTurn = inferred ? parseFen(inferred).turn : latest.current.turn;
        if (auto && inferred) {
          if (latest.current.onApply({ ...result.board }, nextTurn, true, inferred) !== false) {
            lastFen.current = inferred;
            setMessage("Stable board change detected. Stockfish is analyzing the updated position.");
            return;
          }
        }
        review(result, frame, nextTurn);
        setMessage(
          inferred
            ? "A stable board change was detected. Review it before loading."
            : "Stable change detected, but the next turn could not be verified. Review the position and choose who moves next.",
        );
      } catch (error) {
        candidate = null;
        if (!cancelled && generation.current === run) {
          setWatch(false);
          setMessage(
            `Watching paused: ${error instanceof Error ? error.message : String(error)}. Try detecting the board again.`,
          );
        }
      } finally {
        watchReadBusy.current = false;
        if (!cancelled && generation.current === run)
          timer = setTimeout(() => {
            void sample();
          }, SAMPLE_INTERVAL);
      }
    };
    timer = setTimeout(() => {
      void sample();
    }, SAMPLE_INTERVAL);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [watch, confirmed, phase, crop, orient, auto, shot]);

  const changeCrop = (next: Crop) => {
    if (!shot) return;
    setCrop(boundedCrop(next, shot.frame.width / shot.frame.height));
  };
  const drag = (event: React.PointerEvent, kind: "move" | "size") => {
    if (phase !== "crop" || !boxRef.current || !shot) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanup.current?.();
    const bounds = boxRef.current.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const startX = event.clientX,
      startY = event.clientY,
      initial = crop;
    const aspect = shot.frame.width / shot.frame.height;
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - startX) / bounds.width,
        dy = (e.clientY - startY) / bounds.height;
      if (kind === "move")
        setCrop(boundedCrop({ ...initial, x: initial.x + dx, y: initial.y + dy }, aspect));
      else
        setCrop(
          boundedCrop(
            {
              ...initial,
              s: Math.min(
                1 - initial.x,
                (1 - initial.y) / aspect,
                initial.s + (Math.abs(dx) >= Math.abs(dy / aspect) ? dx : dy / aspect),
              ),
            },
            aspect,
          ),
        );
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      dragCleanup.current = null;
    };
    dragCleanup.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  };
  const label = {
    idle: "Off",
    starting: "Choose a screen",
    sharing: watch ? "Watching" : "Sharing",
    crop: "Select board",
    detecting: "Detecting",
    review: "Review Position",
  }[phase];
  const active = phase !== "idle";

  return (
    <Card className="gap-3 p-4 shadow-card" aria-label="Screen board reader">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Screen board reader</h3>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[11px]",
            active && "border-primary text-primary",
          )}
        >
          {label}
        </span>
      </div>
      {message && (
        <p className="text-xs leading-relaxed text-muted-foreground" role="status">
          {message}
        </p>
      )}
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label="Shared screen live preview"
        className={cn(
          "max-h-40 w-full rounded-md border bg-muted object-contain",
          !active && "hidden",
        )}
      />
      {!active ? (
        <Button
          variant="outline"
          onClick={() => {
            void start();
          }}
        >
          <MonitorUp /> Share Screen
        </Button>
      ) : (
        <>
          <Button size="sm" variant="outline" onClick={stop}>
            <StopIcon /> Stop Sharing
          </Button>
          {phase === "starting" && (
            <p className="text-xs text-muted-foreground">
              Choose a screen, window, or tab in your browser’s sharing dialog.
            </p>
          )}
          {(phase === "crop" || phase === "detecting") && shot && (
            <div
              ref={boxRef}
              className="relative w-full touch-none select-none overflow-hidden rounded-md border"
            >
              <img
                src={shot.url}
                alt="Captured screen frame for selecting the chessboard"
                className="block w-full"
                draggable={false}
              />
              <div
                role="slider"
                tabIndex={0}
                aria-label="Board crop area"
                aria-valuemin={5}
                aria-valuemax={100}
                aria-valuenow={Math.round(crop.s * 100)}
                aria-disabled={phase === "detecting"}
                className="absolute touch-none cursor-move border-2 border-primary bg-primary/10"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.s * 100}%`,
                  aspectRatio: "1",
                }}
                onPointerDown={(e) => drag(e, "move")}
                onKeyDown={(e) => {
                  if (
                    phase !== "crop" ||
                    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
                  )
                    return;
                  e.preventDefault();
                  const direction = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -0.01 : 0.01;
                  if (e.shiftKey) changeCrop({ ...crop, s: crop.s + direction });
                  else
                    changeCrop({
                      ...crop,
                      x:
                        crop.x +
                        (e.key.includes("Left") || e.key.includes("Right") ? direction : 0),
                      y: crop.y + (e.key.includes("Up") || e.key.includes("Down") ? direction : 0),
                    });
                }}
              >
                <div className="pointer-events-none grid h-full w-full grid-cols-8 grid-rows-8">
                  {Array.from({ length: 64 }, (_, i) => (
                    <div key={i} className="border border-primary/30" />
                  ))}
                </div>
                <div
                  aria-hidden="true"
                  className="absolute bottom-0 right-0 h-5 w-5 cursor-nwse-resize rounded-sm bg-primary"
                  onPointerDown={(e) => drag(e, "size")}
                />
              </div>
            </div>
          )}
          {phase !== "starting" && (
            <div className="space-y-1">
              <Label className="text-xs">Orientation</Label>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={orient}
                className="flex-wrap justify-start"
                disabled={phase === "detecting"}
                onValueChange={(value) => {
                  if (!value) return;
                  generation.current++;
                  setOrient(value as Orientation);
                  setWatch(false);
                  setConfirmed(false);
                  if (shot) setPhase("crop");
                }}
              >
                <ToggleGroupItem value="auto" className="text-xs">
                  Auto orientation
                </ToggleGroupItem>
                <ToggleGroupItem value="white" className="text-xs">
                  White at bottom
                </ToggleGroupItem>
                <ToggleGroupItem value="black" className="text-xs">
                  Black at bottom
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          )}
          {phase === "review" && reading && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Estimated confidence{" "}
                <b className="text-foreground">{Math.round(reading.confidence * 100)}%</b> ·{" "}
                {reading.orientation === "white" ? "White" : "Black"} at bottom. Highlighted squares
                need extra attention. Review every piece.
              </p>
              {reading.warnings?.map((warning) => (
                <p key={warning} className="text-xs text-amber-700 dark:text-amber-300">
                  {warning}
                </p>
              ))}
              <div
                className="grid grid-cols-8 overflow-hidden rounded border"
                aria-label="Review detected board"
              >
                {Array.from({ length: 64 }, (_, i) => {
                  const row = (i / 8) | 0,
                    col = i % 8;
                  const sq =
                    reading.orientation === "white"
                      ? `${FILES[col]}${8 - row}`
                      : `${FILES[7 - col]}${row + 1}`;
                  const confidence =
                    reading.squares.find((square) => square.square === sq)?.confidence ?? 0;
                  const low = confidence < LOW_CONFIDENCE && !corrected.has(sq);
                  return (
                    <button
                      key={sq}
                      type="button"
                      aria-label={`${sq}: ${draft[sq] ? `${draft[sq][0] === "w" ? "white" : "black"} ${pieceName(draft[sq])}` : "empty"}${low ? ", low confidence" : ""}`}
                      title={`${sq}: ${Math.round(confidence * 100)}% estimated confidence${corrected.has(sq) ? " (corrected)" : ""}`}
                      data-low-confidence={low}
                      className={cn(
                        "relative aspect-square p-0.5",
                        (row + col) % 2 ? "bg-sq-dark" : "bg-sq-light",
                        low && "ring-2 ring-inset ring-destructive",
                      )}
                      onClick={() => {
                        setDraft((current) => {
                          const next = { ...current };
                          if (brush === "empty") delete next[sq];
                          else next[sq] = brush;
                          return next;
                        });
                        setCorrected((current) => new Set(current).add(sq));
                      }}
                    >
                      {draft[sq] && (
                        <img
                          src={pieceSrc(draft[sq])}
                          alt=""
                          className="h-full w-full"
                          draggable={false}
                        />
                      )}
                      <span className="absolute bottom-0 right-0 bg-background/75 px-0.5 text-[9px] text-foreground">
                        {sq}
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-1" aria-label="Correction pieces">
                {PIECES.map((piece) => (
                  <button
                    key={piece}
                    type="button"
                    aria-label={`Brush ${piece[0] === "w" ? "white" : "black"} ${pieceName(piece)}`}
                    aria-pressed={brush === piece}
                    onClick={() => setBrush(piece)}
                    className={cn(
                      "h-8 w-8 rounded border",
                      brush === piece && "border-primary bg-primary/10",
                    )}
                  >
                    <img src={pieceSrc(piece)} alt="" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setBrush("empty")}
                  aria-pressed={brush === "empty"}
                  className={cn(
                    "h-8 rounded border px-2 text-xs",
                    brush === "empty" && "border-primary bg-primary/10",
                  )}
                >
                  Erase
                </button>
              </div>
              <ToggleGroup
                type="single"
                size="sm"
                variant="outline"
                value={draftTurn}
                onValueChange={(value) => {
                  if (value) setDraftTurn(value as "w" | "b");
                }}
              >
                <ToggleGroupItem value="w" className="text-xs">
                  White to move
                </ToggleGroupItem>
                <ToggleGroupItem value="b" className="text-xs">
                  Black to move
                </ToggleGroupItem>
              </ToggleGroup>
              <div className="grid grid-cols-2 gap-2">
                <Button size="sm" onClick={accept}>
                  Use Position
                </Button>
                <Button size="sm" variant="outline" onClick={capture}>
                  <RefreshCw /> Try Again
                </Button>
              </div>
            </div>
          )}
          {phase === "sharing" && (
            <Button size="sm" onClick={capture}>
              <ScanSearch /> Detect Board
            </Button>
          )}
          {(phase === "crop" || phase === "detecting") && (
            <Button
              size="sm"
              onClick={() => {
                void detect();
              }}
              disabled={phase === "detecting"}
            >
              {phase === "detecting" ? <Loader2 className="animate-spin" /> : <ScanSearch />} Read
              board
            </Button>
          )}
          {phase === "crop" && (
            <Button size="sm" variant="ghost" onClick={() => setPhase("sharing")}>
              Back to live feed
            </Button>
          )}
          {phase === "sharing" && (
            <div className="space-y-2 rounded-md border p-2">
              <label className="flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" /> Watch Board
                </span>
                <Switch
                  aria-label="Watch Board"
                  checked={watch}
                  onCheckedChange={setWatch}
                  disabled={!confirmed}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs">
                <span>Auto-update &amp; analyze</span>
                <Switch
                  aria-label="Auto-update and analyze"
                  checked={auto}
                  onCheckedChange={setAuto}
                  disabled={!watch}
                />
              </label>
              <p className="text-[11px] text-muted-foreground">
                {confirmed
                  ? "Samples about every 1.75 seconds. Only stable, confident changes qualify; uncertain turns return to review."
                  : "Detect, review, and use a position before watching."}
              </p>
            </div>
          )}
        </>
      )}
      <p className="text-[11px] leading-snug text-muted-foreground">
        Capture stays local in your browser — nothing is uploaded. For analysis and training. This
        feature does not play moves on other sites.
      </p>
    </Card>
  );
}

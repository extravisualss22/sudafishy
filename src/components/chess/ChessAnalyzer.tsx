// Workflow inspired by position-analysis sites (e.g. NextChessMove.com); all code,
// copy and branding here are original to travis.suda.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  BookmarkPlus,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Copy,
  Cpu,
  Eraser,
  FileUp,
  Loader2,
  Pencil,
  Play,
  Redo2,
  RotateCcw,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Board, pieceName, pieceSrc, type DragSource } from "./Board";
import {
  DEFAULT_SETTINGS,
  PgnDialog,
  SavedBoardsDialog,
  SettingsDialog,
  type SavedBoard,
  type Settings,
} from "./Dialogs";
import {
  buildFen,
  EMPTY_FEN,
  parseFen,
  sanitizeCastling,
  START_FEN,
  type BoardMap,
  type Castling,
  type PieceCode,
} from "@/lib/chess/position";
import {
  createEngine,
  formatScore,
  pvToSan,
  type ChessEngine,
  type EngineInfo,
} from "@/lib/chess/engine";

import { ScreenSharePanel } from "./ScreenSharePanel";
import { conservativeFen, inferWatchedFen } from "@/lib/vision/reviewPosition";
import { placementOf } from "@/lib/vision/boardVision";

const WHITE: PieceCode[] = ["wK", "wQ", "wR", "wB", "wN", "wP"];
const BLACK: PieceCode[] = ["bK", "bQ", "bR", "bB", "bN", "bP"];

interface PgnState {
  fens: string[];
  sans: string[];
  idx: number;
}

function legalityError(fen: string): string | null {
  try {
    new Chess(fen);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Invalid FEN:\s*/i, "") : "Invalid position";
  }
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
  kbd,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  kbd?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className="transition-transform active:scale-95"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {kbd && <span className="ml-2 font-mono opacity-70">{kbd}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function ChessAnalyzer() {
  const [history, setHistory] = useState<string[]>([START_FEN]);
  const [hIdx, setHIdx] = useState(0);
  const fen = history[hIdx];
  const parsed = useMemo(() => parseFen(fen), [fen]);
  const [mode, setMode] = useState<"play" | "edit">("play");
  const [flipped, setFlipped] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [spare, setSpare] = useState<PieceCode | "trash" | null>(null);
  const [lastMove, setLastMove] = useState<{ from: string; to: string }>();
  const [pgn, setPgn] = useState<PgnState | null>(null);
  const [fenDraft, setFenDraft] = useState(fen);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<SavedBoard[]>([]);
  const [dlg, setDlg] = useState<null | "settings" | "pgn" | "saved">(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [infoFen, setInfoFen] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "thinking">("idle");
  const engineRef = useRef<ChessEngine | null>(null);
  const engineReadyRef = useRef<Promise<ChessEngine> | null>(null);
  const analysisRequest = useRef(0);
  const mounted = useRef(true);
  const dragRef = useRef<((src: DragSource, e: React.PointerEvent) => void) | null>(null);

  // persistence
  useEffect(() => {
    try {
      const s = localStorage.getItem("ts.settings");
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(s) });
      const b = localStorage.getItem("ts.boards");
      if (b) setSaved(JSON.parse(b));
    } catch {
      /* ignore */
    }
  }, []);
  const updateSettings = (s: Settings) => {
    setSettings(s);
    localStorage.setItem("ts.settings", JSON.stringify(s));
  };
  const updateSaved = (b: SavedBoard[]) => {
    setSaved(b);
    localStorage.setItem("ts.boards", JSON.stringify(b));
  };
  useEffect(() => {
    document.documentElement.classList.toggle("dark", settings.dark);
  }, [settings.dark]);
  useEffect(() => setFenDraft(fen), [fen]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      analysisRequest.current++;
      engineRef.current?.dispose();
    };
  }, []);

  const stopAnalysis = useCallback(() => {
    analysisRequest.current++;
    engineRef.current?.stop();
    setStatus("idle");
  }, []);

  const commit = useCallback(
    (next: string, move?: { from: string; to: string }) => {
      setHistory((h) => [...h.slice(0, hIdx + 1), next]);
      setHIdx((i) => i + 1);
      setLastMove(move);
      setSelected(null);
      stopAnalysis();
      setInfo(null);
      setInfoFen(null);
    },
    [hIdx, stopAnalysis],
  );

  const legalErr = useMemo(() => legalityError(fen), [fen]);
  const chess = useMemo(() => (legalErr ? null : new Chess(fen)), [fen, legalErr]);
  const legalTargets = useMemo(() => {
    if (mode !== "play" || !selected || !chess) return [];
    return chess
      .moves({ square: selected as import("chess.js").Square, verbose: true })
      .map((m) => m.to);
  }, [mode, selected, chess]);

  const tryMove = (from: string, to: string) => {
    if (!chess) {
      toast.error("This position isn't legal yet", {
        description: "Switch to Edit mode to fix it.",
      });
      return false;
    }
    try {
      const c = new Chess(fen);
      const m = c.move({ from, to, promotion: "q" });
      setPgn(null);
      commit(c.fen(), { from: m.from, to: m.to });
      return true;
    } catch {
      return false;
    }
  };

  const editBoard = (mut: (b: Record<string, PieceCode>) => void) => {
    const p = parseFen(fen);
    const board = { ...p.board };
    mut(board);
    const next = { ...p, board, ep: "-" };
    next.castling = sanitizeCastling(next);
    setPgn(null);
    commit(buildFen(next));
  };

  const onDrop = (src: DragSource, target: string | null) => {
    if (mode === "play" && src.kind === "square") {
      if (target && !tryMove(src.square, target)) toast.error("Illegal move", { duration: 1500 });
      return;
    }
    // edit mode (or palette drag, which always edits)
    editBoard((b) => {
      if (src.kind === "square") delete b[src.square];
      if (target) b[target] = src.piece;
    });
  };

  const onSquareClick = (sq: string) => {
    const piece = parsed.board[sq];
    if (mode === "edit") {
      if (spare === "trash") return piece && editBoard((b) => delete b[sq]);
      if (spare) return editBoard((b) => (b[sq] === spare ? delete b[sq] : (b[sq] = spare)));
      if (selected) {
        const from = selected;
        if (from !== sq)
          editBoard((b) => {
            b[sq] = b[from];
            delete b[from];
          });
        setSelected(null);
      } else if (piece) setSelected(sq);
      return;
    }
    if (selected && selected !== sq && (legalTargets as string[]).includes(sq))
      return void tryMove(selected, sq);
    if (piece && piece[0] === parsed.turn) setSelected(sq === selected ? null : sq);
    else setSelected(null);
  };

  const setMeta = (patch: Partial<{ turn: "w" | "b"; castling: Castling }>) => {
    const p = parseFen(fen);
    const next = { ...p, ...patch, ep: "-" };
    next.castling = sanitizeCastling(next);
    if (patch.castling) {
      const k = (Object.keys(patch.castling) as (keyof Castling)[]).find(
        (x) => patch.castling![x] && !next.castling[x],
      );
      if (k)
        toast.message("Castling right unavailable", {
          description: "King and rook must be on their starting squares.",
        });
    }
    commit(buildFen(next));
  };

  const undo = () =>
    hIdx > 0 && (stopAnalysis(), setHIdx(hIdx - 1), setLastMove(undefined), setSelected(null));
  const redo = () =>
    hIdx < history.length - 1 &&
    (stopAnalysis(), setHIdx(hIdx + 1), setLastMove(undefined), setSelected(null));

  const goPgn = (idx: number) => {
    if (!pgn) return;
    stopAnalysis();
    const i = Math.max(0, Math.min(pgn.fens.length - 1, idx));
    setPgn({ ...pgn, idx: i });
    setHistory((h) => [...h.slice(0, hIdx + 1), pgn.fens[i]]);
    setHIdx((x) => x + 1);
    setLastMove(undefined);
  };

  const importPgn = (text: string) => {
    try {
      const c = new Chess();
      c.loadPgn(text);
      const moves = c.history({ verbose: true });
      if (!moves.length) throw new Error("No moves");
      const fens = [moves[0].before, ...moves.map((m) => m.after)];
      setPgn({ fens, sans: moves.map((m) => m.san), idx: fens.length - 1 });
      setMode("play");
      commit(fens[fens.length - 1], { from: moves.at(-1)!.from, to: moves.at(-1)!.to });
      toast.success(`Imported ${moves.length} plies`);
      return true;
    } catch {
      toast.error("Couldn't read that PGN");
      return false;
    }
  };

  const applyFenDraft = () => {
    const v = fenDraft.trim();
    if (v === fen) return;
    if (v.split("/").length !== 8) {
      toast.error("FEN needs 8 ranks");
      setFenDraft(fen);
      return;
    }
    const p = parseFen(v);
    setPgn(null);
    commit(buildFen(p));
  };

  const analyze = async (target = fen) => {
    const error = legalityError(target);
    if (error) {
      toast.error("Position isn't legal", { description: error });
      return;
    }
    const position = new Chess(target);
    if (position.isGameOver()) {
      toast.message(position.isCheckmate() ? "Checkmate — no moves left" : "Game is drawn");
      return;
    }
    const request = ++analysisRequest.current;
    engineRef.current?.stop();
    setInfo(null);
    setInfoFen(target);
    try {
      if (!engineRef.current) {
        setStatus("loading");
        engineReadyRef.current ??= createEngine()
          .then((engine) => {
            if (!mounted.current) {
              engine.dispose();
              throw new Error("Analyzer closed");
            }
            engineRef.current = engine;
            if (engine.name === "Sudafish Basic")
              toast.warning("Sudafish unavailable — using Sudafish Basic");
            return engine;
          })
          .catch((error) => {
            engineReadyRef.current = null;
            throw error;
          });
        await engineReadyRef.current;
      }
      if (request !== analysisRequest.current || !mounted.current) return;
      setStatus("thinking");
      await engineRef.current!.analyze(
        target,
        { depth: settings.depth, movetimeMs: settings.movetime * 1000, multiPv: settings.multiPv },
        (info) => {
          if (request === analysisRequest.current && mounted.current) {
            setInfoFen(target);
            setInfo(info);
          }
        },
      );
    } catch (e) {
      if (request === analysisRequest.current && mounted.current) {
        engineRef.current?.dispose();
        engineRef.current = null;
        engineReadyRef.current = null;
        toast.error("Engine error", { description: String(e) });
      }
    } finally {
      if (request === analysisRequest.current && mounted.current) setStatus("idle");
    }
  };

  const applyScreenPosition = (
    board: BoardMap,
    turn: "w" | "b",
    shouldAnalyze: boolean,
    verifiedFen?: string,
  ): boolean => {
    try {
      let next = conservativeFen(board, turn);
      // Preserve known rights/counters only for a verified legal watch transition.
      if (verifiedFen) {
        const inferred = inferWatchedFen(fen, { board, placement: placementOf(board) });
        if (inferred !== verifiedFen || parseFen(verifiedFen).turn !== turn) {
          throw new Error("The analysis board changed. Review the shared position again.");
        }
        next = inferred;
      }
      setPgn(null);
      setMode("play");
      setSpare(null);
      commit(next);
      if (shouldAnalyze) void analyze(next);
      return true;
    } catch (error) {
      toast.error("Review the detected position", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  // keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [role=dialog], [aria-label="Screen board reader"]')) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === "f" && !e.metaKey && !e.ctrlKey) setFlipped((f) => !f);
      else if (pgn && e.key === "ArrowLeft" && !t.closest("[role=grid]")) goPgn(pgn.idx - 1);
      else if (pgn && e.key === "ArrowRight" && !t.closest("[role=grid]")) goPgn(pgn.idx + 1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const showInfo = info && infoFen === fen ? info : null;
  const best = showInfo?.lines[0];
  const arrows = showInfo
    ? showInfo.lines
        .filter((l) => l.pv[0])
        .map((l, i) => ({ from: l.pv[0].slice(0, 2), to: l.pv[0].slice(2, 4), primary: i === 0 }))
    : [];
  const bestSan = best ? pvToSan(fen, best.pv, 1)[0] : null;
  const evalPct = best
    ? best.mate !== undefined
      ? best.mate > 0
        ? 100
        : 0
      : 50 + 50 * (2 / (1 + Math.exp(-(best.cp ?? 0) / 400)) - 1)
    : 50;
  const moveNo = parsed.full;

  return (
    <TooltipProvider delayDuration={300}>
      <div data-board-theme={settings.boardTheme} className="flex min-h-screen flex-col">
        <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between px-4 lg:px-6">
            <a href="/" className="flex items-center gap-2">
              <span className="grid h-8 w-8 grid-cols-2 overflow-hidden rounded-md ring-1 ring-border">
                <span className="bg-sq-light" />
                <span className="bg-sq-dark" />
                <span className="bg-sq-dark" />
                <span className="bg-brand" />
              </span>
              <span className="font-display text-xl font-bold tracking-tight">
                travis<span className="text-primary">.</span>suda
              </span>
            </a>
            <nav className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setDlg("pgn")}>
                <FileUp /> <span className="hidden sm:inline">Import PGN</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDlg("saved")}>
                <BookmarkPlus /> <span className="hidden sm:inline">Saved boards</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Settings"
                onClick={() => setDlg("settings")}
              >
                <SettingsIcon />
              </Button>
            </nav>
          </div>
        </header>

        <main className="mx-auto grid w-full max-w-[1400px] flex-1 gap-5 px-4 py-5 lg:grid-cols-[minmax(0,1fr)_240px_340px] lg:px-6 lg:py-8">
          {/* Board column */}
          <section className="mx-auto w-full max-w-[680px] space-y-3">
            <div className="flex gap-2">
              <div
                className="relative w-3 shrink-0 overflow-hidden rounded-full bg-eval-black ring-1 ring-border"
                aria-hidden
              >
                <div
                  className={cn(
                    "absolute inset-x-0 bg-eval-white transition-all duration-700",
                    flipped ? "top-0" : "bottom-0",
                  )}
                  style={{ height: `${evalPct}%` }}
                />
              </div>
              <div className="min-w-0 flex-1">
                <Board
                  board={parsed.board}
                  flipped={flipped}
                  showCoords={settings.coords}
                  arrows={arrows}
                  lastMove={lastMove}
                  selected={selected}
                  legalTargets={legalTargets}
                  onSquareClick={onSquareClick}
                  onDrop={onDrop}
                  dragRef={dragRef}
                />
              </div>
            </div>

            {pgn && (
              <Card className="flex items-center gap-2 p-2 shadow-card animate-in fade-in slide-in-from-top-1">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="First move"
                  onClick={() => goPgn(0)}
                >
                  <ChevronFirst />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Previous move"
                  onClick={() => goPgn(pgn.idx - 1)}
                >
                  <ChevronLeft />
                </Button>
                <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-1 font-mono text-xs">
                  {pgn.sans.map((s, i) => (
                    <button
                      key={i}
                      onClick={() => goPgn(i + 1)}
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 transition-colors hover:bg-muted",
                        pgn.idx === i + 1 && "bg-primary text-primary-foreground hover:bg-primary",
                      )}
                    >
                      {i % 2 === 0 && <span className="mr-0.5 opacity-60">{i / 2 + 1}.</span>}
                      {s}
                    </button>
                  ))}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Next move"
                  onClick={() => goPgn(pgn.idx + 1)}
                >
                  <ChevronRight />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Last move"
                  onClick={() => goPgn(pgn.fens.length - 1)}
                >
                  <ChevronLast />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Close game"
                  onClick={() => setPgn(null)}
                >
                  <X />
                </Button>
              </Card>
            )}

            <div className="flex gap-2">
              <Input
                value={fenDraft}
                onChange={(e) => setFenDraft(e.target.value)}
                onBlur={applyFenDraft}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                className="font-mono text-xs"
                aria-label="FEN"
                spellCheck={false}
              />
              <IconBtn
                label="Copy FEN"
                onClick={() =>
                  navigator.clipboard.writeText(fen).then(() => toast.success("FEN copied"))
                }
              >
                <Copy />
              </IconBtn>
            </div>
            {legalErr && (
              <p className="text-xs text-destructive" role="status">
                Not a legal position yet: {legalErr}
              </p>
            )}
          </section>

          {/* Controls column */}
          <section className="space-y-4">
            <ScreenSharePanel turn={parsed.turn} fen={fen} onApply={applyScreenPosition} />
            <Card className="gap-0 space-y-4 p-4 shadow-card">
              <ToggleGroup
                type="single"
                variant="outline"
                value={mode}
                onValueChange={(v) => {
                  if (!v) return;
                  setMode(v as "play" | "edit");
                  setSelected(null);
                  setSpare(null);
                }}
                className="w-full"
              >
                <ToggleGroupItem value="play" className="flex-1 gap-1.5">
                  <Play className="h-4 w-4" /> Play
                </ToggleGroupItem>
                <ToggleGroupItem value="edit" className="flex-1 gap-1.5">
                  <Pencil className="h-4 w-4" /> Edit
                </ToggleGroupItem>
              </ToggleGroup>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">
                  {mode === "edit"
                    ? "Click or drag pieces onto the board"
                    : "Piece palette — drag or click to place"}
                </p>
                {[WHITE, BLACK].map((row, ri) => (
                  <div key={ri} className="grid grid-cols-6 gap-1">
                    {row.map((pc) => (
                      <button
                        key={pc}
                        type="button"
                        aria-label={`${pc[0] === "w" ? "White" : "Black"} ${pieceName(pc)}`}
                        aria-pressed={spare === pc}
                        onClick={() => {
                          setMode("edit");
                          setSpare(spare === pc ? null : pc);
                          setSelected(null);
                        }}
                        onPointerDown={(e) =>
                          e.button === 0 && dragRef.current?.({ kind: "spare", piece: pc }, e)
                        }
                        className={cn(
                          "no-touch aspect-square rounded-md border bg-muted/50 p-0.5 transition-all hover:-translate-y-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          spare === pc && "border-primary bg-accent ring-2 ring-primary",
                        )}
                      >
                        <img
                          src={pieceSrc(pc)}
                          alt=""
                          draggable={false}
                          className="pointer-events-none h-full w-full"
                        />
                      </button>
                    ))}
                  </div>
                ))}
                {mode === "edit" && (
                  <Button
                    variant={spare === "trash" ? "default" : "ghost"}
                    size="sm"
                    className="w-full"
                    onClick={() => setSpare(spare === "trash" ? null : "trash")}
                  >
                    <Eraser /> Remove pieces by click
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Side to move</Label>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={parsed.turn}
                  onValueChange={(v) => v && v !== parsed.turn && setMeta({ turn: v as "w" | "b" })}
                  className="w-full"
                >
                  <ToggleGroupItem value="w" className="flex-1 gap-1.5 text-xs">
                    <span className="h-3 w-3 rounded-full bg-eval-white ring-1 ring-foreground/30" />{" "}
                    White
                  </ToggleGroupItem>
                  <ToggleGroupItem value="b" className="flex-1 gap-1.5 text-xs">
                    <span className="h-3 w-3 rounded-full bg-eval-black ring-1 ring-foreground/30" />{" "}
                    Black
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>

              <fieldset className="space-y-2">
                <legend className="mb-2 text-xs font-medium text-muted-foreground">
                  Castling rights
                </legend>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {(
                    [
                      ["K", "White O-O"],
                      ["Q", "White O-O-O"],
                      ["k", "Black O-O"],
                      ["q", "Black O-O-O"],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="flex cursor-pointer items-center gap-2">
                      <Checkbox
                        checked={parsed.castling[k]}
                        onCheckedChange={(v) =>
                          setMeta({ castling: { ...parsed.castling, [k]: v === true } })
                        }
                      />
                      <span className="text-xs">{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="flex flex-wrap gap-1.5">
                <IconBtn
                  label="Reset"
                  onClick={() => {
                    setPgn(null);
                    commit(START_FEN);
                  }}
                >
                  <RotateCcw />
                </IconBtn>
                <IconBtn
                  label="Clear board"
                  onClick={() => {
                    setPgn(null);
                    setMode("edit");
                    commit(buildFen({ ...parseFen(EMPTY_FEN), turn: parsed.turn }));
                  }}
                >
                  <Eraser />
                </IconBtn>
                <IconBtn label="Flip board" kbd="F" onClick={() => setFlipped((f) => !f)}>
                  <ArrowLeftRight />
                </IconBtn>
                <IconBtn label="Undo" kbd="⌘Z" onClick={undo} disabled={hIdx === 0}>
                  <Undo2 />
                </IconBtn>
                <IconBtn
                  label="Redo"
                  kbd="⇧⌘Z"
                  onClick={redo}
                  disabled={hIdx >= history.length - 1}
                >
                  <Redo2 />
                </IconBtn>
              </div>
            </Card>
          </section>

          {/* Analysis column */}
          <section className="space-y-4">
            <Button
              size="lg"
              className="h-14 w-full text-base font-semibold shadow-card transition-transform active:scale-[0.98]"
              onClick={status === "thinking" ? stopAnalysis : () => void analyze()}
              disabled={status === "loading"}
            >
              {status === "loading" ? (
                <>
                  <Loader2 className="animate-spin" /> Starting Sudafish…
                </>
              ) : status === "thinking" ? (
                <>
                  <Square /> Stop analysis
                </>
              ) : (
                <>
                  <Sparkles /> Calculate Next Move
                </>
              )}
            </Button>

            <Card className="gap-0 overflow-hidden p-0 shadow-card">
              <div className="border-b bg-muted/40 p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Best move · {parsed.turn === "w" ? "White" : "Black"} to play</span>
                  {status === "thinking" && (
                    <span className="flex items-center gap-1 text-primary">
                      <Loader2 className="h-3 w-3 animate-spin" /> thinking
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-end justify-between gap-2">
                  <div className="font-display text-4xl font-bold tracking-tight">
                    {bestSan ? (
                      <span className="animate-in fade-in">
                        <span className="mr-1 text-lg text-muted-foreground">
                          {moveNo}
                          {parsed.turn === "w" ? "." : "…"}
                        </span>
                        {bestSan}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </div>
                  <div
                    className={cn(
                      "rounded-md px-2 py-1 font-mono text-lg font-semibold",
                      best ? "bg-foreground text-background" : "bg-muted text-muted-foreground",
                    )}
                  >
                    {best ? formatScore(best) : "0.00"}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  {[
                    ["Depth", showInfo?.depth ?? "—"],
                    ["Nodes", showInfo?.nodes ? compact(showInfo.nodes) : "—"],
                    ["NPS", showInfo?.nps ? compact(showInfo.nps) : "—"],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-md border bg-card px-2 py-1.5">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-mono font-semibold">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="space-y-2 p-4">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Candidate lines
                </h3>
                {!showInfo && status !== "thinking" && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Set up a position and press{" "}
                    <span className="font-semibold text-foreground">Calculate</span>.
                  </p>
                )}
                {status === "thinking" &&
                  !showInfo?.lines.length &&
                  Array.from({ length: settings.multiPv }).map((_, i) => (
                    <div key={i} className="h-12 animate-pulse rounded-lg bg-muted" />
                  ))}
                {showInfo?.lines.map((l, i) => (
                  <button
                    key={l.multipv}
                    onClick={() => l.pv[0] && tryMove(l.pv[0].slice(0, 2), l.pv[0].slice(2, 4))}
                    className={cn(
                      "w-full rounded-lg border p-2.5 text-left transition-colors hover:bg-muted",
                      i === 0 && "border-primary/40 bg-accent/40",
                    )}
                    title="Play this move"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs font-semibold">{formatScore(l)}</span>
                      <span className="text-[10px] text-muted-foreground">d{l.depth}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 font-mono text-xs leading-relaxed text-muted-foreground">
                      {pvToSan(fen, l.pv, 10).join(" ")}
                    </p>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 border-t px-4 py-2 text-[11px] text-muted-foreground">
                <Cpu className="h-3 w-3" />
                {showInfo?.engineName ?? engineRef.current?.name ?? "Sudafish"}
              </div>
            </Card>
          </section>
        </main>

        <footer className="space-y-1 border-t px-4 py-4 text-center text-xs text-muted-foreground">
          <p>For analysis and training. Do not use engine assistance in live rated games.</p>
          <p>
            Sudafish is powered by Stockfish 19 and distributed under the GNU GPL.{" "}
            <a
              className="underline underline-offset-2"
              href={`${import.meta.env.BASE_URL}engine/Copying.txt`}
              target="_blank"
              rel="noopener noreferrer"
            >
              License
            </a>
            {" · "}
            <a
              className="underline underline-offset-2"
              href="https://github.com/nmrugg/stockfish.js/tree/v19.0.1"
              target="_blank"
              rel="noopener noreferrer"
            >
              Browser build source
            </a>
            {" · "}
            <a
              className="underline underline-offset-2"
              href="https://github.com/official-stockfish/Stockfish/tree/sf_19"
              target="_blank"
              rel="noopener noreferrer"
            >
              Stockfish source
            </a>
          </p>
        </footer>

        <SettingsDialog
          open={dlg === "settings"}
          onOpenChange={(o) => setDlg(o ? "settings" : null)}
          settings={settings}
          onChange={updateSettings}
        />
        <PgnDialog
          open={dlg === "pgn"}
          onOpenChange={(o) => setDlg(o ? "pgn" : null)}
          onImport={importPgn}
        />
        <SavedBoardsDialog
          open={dlg === "saved"}
          onOpenChange={(o) => setDlg(o ? "saved" : null)}
          boards={saved}
          onSave={(name) => {
            updateSaved([{ id: crypto.randomUUID(), name, fen, createdAt: Date.now() }, ...saved]);
            toast.success("Position saved");
          }}
          onLoad={(b) => {
            setPgn(null);
            commit(b.fen);
            setDlg(null);
          }}
          onRename={(id, name) => updateSaved(saved.map((b) => (b.id === id ? { ...b, name } : b)))}
          onDelete={(id) => updateSaved(saved.filter((b) => b.id !== id))}
        />
      </div>
    </TooltipProvider>
  );
}

function compact(n: number) {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

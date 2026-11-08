import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { FILES, type BoardMap, type PieceCode } from "@/lib/chess/position";

export const pieceSrc = (p: PieceCode) => `/pieces/${p}.svg`;

export type DragSource = { kind: "square"; square: string; piece: PieceCode } | { kind: "spare"; piece: PieceCode };

interface Drag {
  src: DragSource;
  x: number;
  y: number;
  size: number;
}

interface BoardProps {
  readOnly?: boolean;
  board: BoardMap;
  flipped: boolean;
  showCoords: boolean;
  arrows: { from: string; to: string; primary?: boolean }[];
  lastMove?: { from: string; to: string };
  selected: string | null;
  legalTargets: string[];
  onSquareClick: (sq: string) => void;
  onDrop: (src: DragSource, target: string | null) => void;
  /** register a starter so the palette can initiate drags onto this board */
  dragRef?: React.MutableRefObject<((src: DragSource, e: React.PointerEvent) => void) | null>;
}

function squareCenter(sq: string, flipped: boolean) {
  const f = FILES.indexOf(sq[0]);
  const r = Number(sq[1]);
  const x = flipped ? 7 - f : f;
  const y = flipped ? r - 1 : 8 - r;
  return { x: x + 0.5, y: y + 0.5 };
}

export function Board(p: BoardProps) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focus, setFocus] = useState("e2");
  const boardRef = useRef<HTMLDivElement>(null);
  const dropRef = useRef(p.onDrop);
  dropRef.current = p.onDrop;

  const start = useCallback((src: DragSource, e: React.PointerEvent) => {
    e.preventDefault();
    const size = (boardRef.current?.clientWidth ?? 480) / 8;
    setDrag({ src, x: e.clientX, y: e.clientY, size });
  }, []);

  useEffect(() => {
    if (p.dragRef) p.dragRef.current = start;
  }, [p.dragRef, start]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    const up = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-square]");
      const target = el?.getAttribute("data-square") ?? null;
      const src = drag.src;
      setDrag(null);
      if (src.kind === "square" && target === src.square) {
        // treated as click
        return;
      }
      dropRef.current(src, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [drag?.src]); // eslint-disable-line react-hooks/exhaustive-deps

  const ranks = p.flipped ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = p.flipped ? [...FILES].reverse() : [...FILES];

  const onKey = (e: React.KeyboardEvent) => {
    const f = FILES.indexOf(focus[0]);
    const r = Number(focus[1]);
    const dir = p.flipped ? -1 : 1;
    let nf = f,
      nr = r;
    if (e.key === "ArrowUp") nr += dir;
    else if (e.key === "ArrowDown") nr -= dir;
    else if (e.key === "ArrowRight") nf += dir;
    else if (e.key === "ArrowLeft") nf -= dir;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      p.onSquareClick(focus);
      return;
    } else return;
    e.preventDefault();
    nf = Math.max(0, Math.min(7, nf));
    nr = Math.max(1, Math.min(8, nr));
    const sq = `${FILES[nf]}${nr}`;
    setFocus(sq);
    (boardRef.current?.querySelector(`[data-square="${sq}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <div className="relative w-full">
      <div
        ref={boardRef}
        role="grid"
        aria-label="Chessboard"
        onKeyDown={onKey}
        className="no-touch relative grid aspect-square w-full grid-cols-8 overflow-hidden rounded-xl shadow-board ring-1 ring-border"
      >
        {ranks.map((r, ri) =>
          files.map((f, fi) => {
            const sq = `${f}${r}`;
            const piece = p.board[sq];
            const light = (FILES.indexOf(f) + r) % 2 === 1;
            const isDragging = drag?.src.kind === "square" && drag.src.square === sq;
            const isLast = p.lastMove && (p.lastMove.from === sq || p.lastMove.to === sq);
            const isTarget = p.legalTargets.includes(sq);
            return (
              <button
                key={sq}
                type="button"
                data-square={sq}
                tabIndex={sq === focus ? 0 : -1}
                aria-label={`${sq}${piece ? `, ${piece[0] === "w" ? "white" : "black"} ${pieceName(piece)}` : ""}`}
                onFocus={() => setFocus(sq)}
                onClick={() => p.onSquareClick(sq)}
                onPointerDown={(e) => {
                  if (!p.readOnly && piece && e.button === 0) start({ kind: "square", square: sq, piece }, e);
                }}
                className={cn(
                  "relative aspect-square outline-none focus-visible:z-10 focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-ring",
                  light ? "bg-sq-light" : "bg-sq-dark",
                )}
              >
                {(isLast || p.selected === sq) && <span className="absolute inset-0 bg-sq-highlight" />}
                {isTarget && (
                  <span
                    className={cn(
                      "pointer-events-none absolute inset-0 m-auto rounded-full",
                      piece ? "h-[92%] w-[92%] ring-4 ring-foreground/25" : "h-1/4 w-1/4 bg-foreground/25",
                    )}
                  />
                )}
                {piece && (
                  <img
                    src={pieceSrc(piece)}
                    alt=""
                    draggable={false}
                    className={cn(
                      "pointer-events-none relative z-[1] h-full w-full p-[4%] transition-opacity",
                      isDragging && "opacity-25",
                    )}
                  />
                )}
                {p.showCoords && fi === 0 && (
                  <span
                    className={cn(
                      "pointer-events-none absolute left-1 top-0.5 z-[2] text-[10px] font-bold sm:text-xs",
                      light ? "text-sq-dark" : "text-sq-light",
                    )}
                  >
                    {r}
                  </span>
                )}
                {p.showCoords && ri === 7 && (
                  <span
                    className={cn(
                      "pointer-events-none absolute bottom-0 right-1 z-[2] text-[10px] font-bold sm:text-xs",
                      light ? "text-sq-dark" : "text-sq-light",
                    )}
                  >
                    {f}
                  </span>
                )}
              </button>
            );
          }),
        )}
        <svg viewBox="0 0 8 8" className="pointer-events-none absolute inset-0 z-[3] h-full w-full">
          <defs>
            <marker id="ah" markerWidth="4" markerHeight="4" refX="2.2" refY="2" orient="auto">
              <path d="M0,0 L4,2 L0,4 z" className="fill-arrow" />
            </marker>
            <marker id="ah2" markerWidth="4" markerHeight="4" refX="2.2" refY="2" orient="auto">
              <path d="M0,0 L4,2 L0,4 z" className="fill-primary/50" />
            </marker>
          </defs>
          {[...p.arrows].reverse().map((a, i) => {
            const s = squareCenter(a.from, p.flipped);
            const t = squareCenter(a.to, p.flipped);
            const dx = t.x - s.x,
              dy = t.y - s.y;
            const len = Math.hypot(dx, dy) || 1;
            const ex = t.x - (dx / len) * 0.35,
              ey = t.y - (dy / len) * 0.35;
            return (
              <line
                key={i + a.from + a.to}
                x1={s.x}
                y1={s.y}
                x2={ex}
                y2={ey}
                strokeWidth={a.primary ? 0.17 : 0.11}
                strokeLinecap="round"
                markerEnd={a.primary ? "url(#ah)" : "url(#ah2)"}
                className={cn(
                  "animate-in fade-in duration-300",
                  a.primary ? "stroke-arrow" : "stroke-primary/50",
                )}
              />
            );
          })}
        </svg>
      </div>
      {drag && (
        <img
          src={pieceSrc(drag.src.piece)}
          alt=""
          className="pointer-events-none fixed z-50 drop-shadow-xl"
          style={{
            width: drag.size * 1.1,
            height: drag.size * 1.1,
            left: drag.x - drag.size * 0.55,
            top: drag.y - drag.size * 0.55,
          }}
        />
      )}
    </div>
  );
}

export function pieceName(p: PieceCode) {
  return { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight", P: "pawn" }[p[1]] ?? "";
}

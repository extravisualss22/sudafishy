import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Check, Pencil, Trash2, Upload, X } from "lucide-react";

export interface Settings {
  depth: number;
  movetime: number; // seconds
  multiPv: number;
  coords: boolean;
  boardTheme: "meadow" | "walnut" | "slate";
  dark: boolean;
}
export const DEFAULT_SETTINGS: Settings = {
  depth: 18,
  movetime: 3,
  multiPv: 3,
  coords: true,
  boardTheme: "meadow",
  dark: false,
};

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  onChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => onChange({ ...settings, [k]: v });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Settings</DialogTitle>
          <DialogDescription>Stockfish strength and board appearance. Saved on this device.</DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-2">
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <Label>Max depth</Label>
              <span className="font-mono text-muted-foreground">{settings.depth}</span>
            </div>
            <Slider min={6} max={30} step={1} value={[settings.depth]} onValueChange={([v]) => set("depth", v)} />
          </div>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <Label>Think time</Label>
              <span className="font-mono text-muted-foreground">{settings.movetime}s</span>
            </div>
            <Slider min={1} max={20} step={1} value={[settings.movetime]} onValueChange={([v]) => set("movetime", v)} />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Candidate lines</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={String(settings.multiPv)}
              onValueChange={(v) => v && set("multiPv", Number(v))}
              className="justify-start"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <ToggleGroupItem key={n} value={String(n)} className="w-10">
                  {n}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="space-y-2">
            <Label className="text-sm">Board theme</Label>
            <ToggleGroup
              type="single"
              variant="outline"
              value={settings.boardTheme}
              onValueChange={(v) => v && set("boardTheme", v as Settings["boardTheme"])}
              className="justify-start"
            >
              {(["meadow", "walnut", "slate"] as const).map((t) => (
                <ToggleGroupItem key={t} value={t} className="gap-2 px-3 capitalize">
                  <span data-board-theme={t} className="flex h-4 w-4 overflow-hidden rounded-sm ring-1 ring-border">
                    <span className="w-1/2 bg-sq-light" />
                    <span className="w-1/2 bg-sq-dark" />
                  </span>
                  {t}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="coords">Show coordinates</Label>
            <Switch id="coords" checked={settings.coords} onCheckedChange={(v) => set("coords", v)} />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="dark">Dark interface</Label>
            <Switch id="dark" checked={settings.dark} onCheckedChange={(v) => set("dark", v)} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PgnDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onImport: (pgn: string) => boolean;
}) {
  const [text, setText] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Import PGN</DialogTitle>
          <DialogDescription>Paste a game, then step through it move by move.</DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={9}
          placeholder={'[Event "Casual"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'}
          className="font-mono text-xs"
          aria-label="PGN text"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!text.trim()}
            onClick={() => {
              if (onImport(text)) {
                setText("");
                onOpenChange(false);
              }
            }}
          >
            <Upload /> Import game
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface SavedBoard {
  id: string;
  name: string;
  fen: string;
  createdAt: number;
}

export function SavedBoardsDialog({
  open,
  onOpenChange,
  boards,
  onSave,
  onLoad,
  onRename,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  boards: SavedBoard[];
  onSave: (name: string) => void;
  onLoad: (b: SavedBoard) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-2xl">Saved boards</DialogTitle>
          <DialogDescription>Positions are stored in this browser only.</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSave(name.trim() || `Position ${boards.length + 1}`);
            setName("");
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this position" aria-label="Board name" />
          <Button type="submit">Save current</Button>
        </form>
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {boards.length === 0 && (
            <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
              No saved boards yet.
            </p>
          )}
          {boards.map((b) => (
            <div key={b.id} className="group flex items-center gap-2 rounded-lg border bg-card p-2 pl-3 transition-colors hover:bg-muted">
              {editing === b.id ? (
                <form
                  className="flex flex-1 gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onRename(b.id, editName.trim() || b.name);
                    setEditing(null);
                  }}
                >
                  <Input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8" aria-label="New name" />
                  <Button size="icon" variant="ghost" type="submit" aria-label="Confirm rename">
                    <Check />
                  </Button>
                  <Button size="icon" variant="ghost" type="button" onClick={() => setEditing(null)} aria-label="Cancel rename">
                    <X />
                  </Button>
                </form>
              ) : (
                <>
                  <button className="min-w-0 flex-1 text-left" onClick={() => onLoad(b)}>
                    <div className="truncate text-sm font-semibold">{b.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{b.fen}</div>
                  </button>
                  <Button size="icon" variant="ghost" aria-label={`Rename ${b.name}`} onClick={() => { setEditing(b.id); setEditName(b.name); }}>
                    <Pencil />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={`Delete ${b.name}`} onClick={() => onDelete(b.id)}>
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

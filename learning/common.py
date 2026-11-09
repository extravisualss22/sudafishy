from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time

REPO = Path(__file__).resolve().parents[1]


def root() -> Path:
    return Path(os.environ.get("SUDALOL_DATA", REPO / "training-data")).resolve()


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def file_hash(path: Path, text=False) -> str:
    if text:
        return hashlib.sha256(path.read_text(encoding="utf-8").replace("\r\n", "\n").encode()).hexdigest()
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def connect(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=FULL")
    return connection


@contextlib.contextmanager
def exclusive_lock(path: Path):
    """OS-released lock: a killed process cannot strand a stale lock file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        if os.name == "nt":
            import msvcrt
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise RuntimeError("Another learning workload owns this data directory") from error
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)


def source_files(directory: Path):
    files = sorted(directory.rglob("games-*.jsonl"))
    if not files:
        raise ValueError(f"No completed-game shards found: {directory}")
    return files


def games(directory: Path):
    """One game in memory. Ignore only a torn final line, never corrupt interior data."""
    for path in source_files(directory):
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    if not line.endswith("\n") and stream.read() == "":
                        break
                    raise
                if record.get("schemaVersion") != 1 or record.get("result") not in ["1-0", "0-1", "1/2-1/2"]:
                    raise ValueError("Teacher/evaluator accepts completed games only")
                yield record


def input_fingerprint(directory: Path):
    return digest([(str(p.relative_to(directory)).replace("\\", "/"), file_hash(p)) for p in source_files(directory)])


def verify_game(game):
    import chess
    board = chess.Board(game["initialFen"])
    if len(game["moves"]) != game["moveCount"]:
        raise ValueError("Game move count mismatch")
    for text in game["moves"]:
        move = chess.Move.from_uci(text)
        if move not in board.legal_moves:
            raise ValueError("Illegal move in saved game")
        board.push(move)
    if board.fen(en_passant="legal") != game["finalFen"]:
        raise ValueError("Saved game final FEN mismatch")
    return board

"""Internal generation Elo is a relative competition measure, never human Elo."""
from __future__ import annotations

import json
import math
from pathlib import Path
from .common import connect, now, digest, atomic_json


def expected(a, b):
    return 1 / (1 + 10 ** ((b - a) / 400))


def wilson(score, count, z=1.96):
    if count < 1:
        return [0.0, 1.0]
    center = (score + z * z / (2 * count)) / (1 + z * z / count)
    margin = z * math.sqrt(score * (1 - score) / count + z * z / (4 * count * count)) / (1 + z * z / count)
    return [max(0, center - margin), min(1, center + margin)]


def summarize(records, candidate):
    result = {"generation": candidate, "games": 0, "wins": 0, "draws": 0, "losses": 0,
              "moves": 0, "nodes": 0, "colors": {"white": 0, "black": 0}, "terminations": {}, "opponents": {}, "searchSettings": []}
    settings = {}
    seen = set()
    for game in records:
        if game["gameId"] in seen:
            continue
        seen.add(game["gameId"])
        color = "white" if game["white"]["id"] == candidate else "black" if game["black"]["id"] == candidate else None
        if color is None:
            continue
        opponent = game["black" if color == "white" else "white"]["id"]
        score = 0.5 if game["result"] == "1/2-1/2" else float(game["result"] == ("1-0" if color == "white" else "0-1"))
        result["wins" if score == 1 else "draws" if score == .5 else "losses"] += 1
        result["games"] += 1
        result["moves"] += game["moveCount"]
        result["nodes"] += game["nodes"]
        result["colors"][color] += 1
        result["opponents"][opponent] = result["opponents"].get(opponent, 0) + 1
        reason = game["termination"]
        result["terminations"][reason] = result["terminations"].get(reason, 0) + 1
        settings[digest(game["search"])] = game["search"]
    result["searchSettings"] = list(settings.values())
    result["score"] = (result["wins"] + result["draws"] / 2) / result["games"] if result["games"] else None
    result["averageGameLength"] = result["moves"] / result["games"] if result["games"] else None
    result["scoreInterval95"] = wilson(result["score"] or 0, result["games"])
    # There are currently no human-calibrated reference engines in this project.
    result["estimatedChessElo"] = {"status": "unrated", "value": None, "reason": "Reference opponents have no validated human-Elo calibration"}
    return result


def acceptance(summary, min_games=32, min_score=.55, min_lower=.50):
    if not (2 <= min_games <= 100000 and .5 <= min_score <= 1 and 0 <= min_lower <= 1):
        raise ValueError("Invalid acceptance criteria")
    balanced = summary["colors"]["white"] == summary["colors"]["black"]
    accepted = summary["games"] >= min_games and balanced and summary["score"] >= min_score and summary["scoreInterval95"][0] > min_lower
    return {"accepted": accepted, "criteria": {"minGames": min_games, "minScore": min_score, "minLower95": min_lower},
            "balancedColors": balanced, "score": summary["score"], "interval95": summary["scoreInterval95"]}


class RatingBook:
    def __init__(self, path: Path):
        self.db = connect(path)
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS ratings (generation TEXT PRIMARY KEY, rating REAL, games INTEGER, wins INTEGER, draws INTEGER, losses INTEGER, peak REAL, change REAL, updated TEXT);
        CREATE TABLE IF NOT EXISTS events (match_id TEXT PRIMARY KEY, fingerprint TEXT, data TEXT);
        CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
        """)

    def ensure(self, generation):
        self.db.execute("INSERT OR IGNORE INTO ratings VALUES (?,1000,0,0,0,0,1000,0,?)", (generation, now()))

    def update(self, match_id, records):
        # Match-sized input; large simulation datasets are not rating matches.
        records = sorted(records, key=lambda game: game["index"])
        fingerprint = digest([(g["gameId"], g["white"], g["black"], g["result"]) for g in records])
        with self.db:
            prior = self.db.execute("SELECT * FROM events WHERE match_id=?", (match_id,)).fetchone()
            if prior:
                if prior["fingerprint"] != fingerprint:
                    raise ValueError("Rating event ID reused with different games")
                return json.loads(prior["data"])
            before, opponents = {}, {}
            for game in records:
                a, b = game["white"]["generation"], game["black"]["generation"]
                if not a or not b or a == b:
                    continue
                self.ensure(a); self.ensure(b)
                ra = dict(self.db.execute("SELECT * FROM ratings WHERE generation=?", (a,)).fetchone())
                rb = dict(self.db.execute("SELECT * FROM ratings WHERE generation=?", (b,)).fetchone())
                before.setdefault(a, ra["rating"]); before.setdefault(b, rb["rating"])
                score = {"1-0": 1, "0-1": 0, "1/2-1/2": .5}[game["result"]]
                change = 16 * (score - expected(ra["rating"], rb["rating"]))
                for row, delta, outcome, opponent in [(ra, change, score, b), (rb, -change, 1-score, a)]:
                    rating = row["rating"] + delta
                    self.db.execute("UPDATE ratings SET rating=?,games=games+1,wins=wins+?,draws=draws+?,losses=losses+?,peak=?,change=?,updated=? WHERE generation=?",
                                    (rating, int(outcome == 1), int(outcome == .5), int(outcome == 0), max(rating, row["peak"]), rating-before[row["generation"]], now(), row["generation"]))
                    opponents.setdefault(row["generation"], set()).add(opponent)
            event = {"matchId": match_id, "date": now(), "opponents": {key: sorted(value) for key,value in opponents.items()},
                     "ratings": [dict(row) for row in self.db.execute("SELECT * FROM ratings ORDER BY generation")], "games": len(records), "k": 16}
            self.db.execute("INSERT INTO events VALUES (?,?,?)", (match_id, fingerprint, json.dumps(event)))
            return event

    def champion(self):
        row = self.db.execute("SELECT value FROM state WHERE key='champion'").fetchone()
        return row[0] if row else "gen0"

    def promote(self, previous, candidate, decision, match_id):
        with self.db:
            prior = self.db.execute('SELECT value FROM state WHERE key=?', ('gate:'+match_id,)).fetchone()
            if prior:
                saved = json.loads(prior[0])
                if saved['candidate'] != candidate or saved['previous'] != previous or any(saved.get(key) != value for key,value in decision.items()):
                    raise ValueError('Existing promotion decision differs')
                return
            if self.champion() != previous:
                raise ValueError("Champion changed since this candidate match")
            if decision["accepted"]:
                self.db.execute("INSERT OR REPLACE INTO state VALUES ('champion',?)", (candidate,))
            self.db.execute("INSERT OR REPLACE INTO state VALUES (?,?)", ("gate:" + match_id, json.dumps({**decision, "candidate": candidate, "previous": previous, "date": now()})))

    def snapshot(self):
        return {"champion": self.champion(), "ratings": [dict(row) for row in self.db.execute("SELECT * FROM ratings ORDER BY generation")],
                "history": [json.loads(row[0]) for row in self.db.execute("SELECT data FROM events ORDER BY rowid")]}

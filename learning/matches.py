"""Reproducible paired openings, explicit opponents, and resumable matches."""
import os
import random
import subprocess
from pathlib import Path
import chess
from .common import REPO, atomic_json, read_json, games, digest, now, root
from .ratings import summarize, RatingBook, acceptance

OPENINGS = [[], ['e4','e5'], ['d4','d5'], ['Nf3','d5'], ['c4','e5'], ['e4','c5'], ['d4','Nf6'], ['e4','e6']]
DEFAULT_MIX = {'older': .40, 'self': .25, 'weak': .15, 'fixed': .15, 'stockfish': .05}

def options(seed=20261108, workers=2, depth=1, nodes=500, max_moves=100):
    return {'seed': seed, 'workers': workers, 'maxMoves': max_moves, 'mode': 'normal',
            'search': {'depth': depth, 'maxNodes': nodes, 'quiescenceDepth': 4, 'tableEntries': 10000},
            'stockfish': {'threads': 1, 'hash': 32, 'depth': 6, 'nodes': 2000}}

def paired_jobs(candidate, opponents):
    jobs = []
    for pair, opponent in enumerate(opponents):
        board = chess.Board()
        for san in OPENINGS[pair % len(OPENINGS)]: board.push_san(san)
        for white, black in [(candidate, opponent), (opponent, candidate)]:
            jobs.append({'index': len(jobs), 'white': white, 'black': black, 'initialFen': board.fen()})
    return jobs

def schedule(current, count, seed, mix=None, pools=None):
    if count < 2 or count % 2: raise ValueError('Games must be positive color pairs')
    mix = DEFAULT_MIX if mix is None else mix
    pools = pools or {'older': [], 'self': [current], 'weak': ['weak'], 'fixed': ['fixed-gen0-d3'], 'stockfish': ['stockfish']}
    if set(mix) - set(DEFAULT_MIX) or any(not isinstance(v, (int,float)) or v < 0 for v in mix.values()) or abs(sum(mix.values())-1)>1e-8:
        raise ValueError('Opponent weights must be nonnegative and sum to one')
    for key, weight in mix.items():
        if weight and not pools.get(key): raise ValueError(f'Requested opponent category unavailable: {key}; configure its pool or set its weight to zero')
    # Largest-remainder allocation gives an exact, inspectable mix in color pairs.
    pairs = count//2
    allocation = {key: int(pairs*weight) for key, weight in mix.items()}
    for key in sorted(mix, key=lambda k: (pairs*mix[k]-allocation[k], k), reverse=True)[:pairs-sum(allocation.values())]: allocation[key] += 1
    rng = random.Random(seed)
    opponents = [rng.choice(pools[key]) for key in sorted(allocation) for _ in range(allocation[key])]
    rng.shuffle(opponents)
    return paired_jobs(current, opponents)

def run_plan(directory, plan):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory/'plan.json'
    if path.exists() and read_json(path) != plan: raise ValueError('Existing run has a different plan; choose a new run ID')
    if not path.exists(): atomic_json(path, plan)
    subprocess.run(['node', str(REPO/'learning/jobs.ts'), str(path), str(directory)], cwd=REPO, env={**os.environ, 'SUDALOL_DATA': str(root())}, check=True)
    return directory

def benchmark(generation, opponent='weak', count=32, name=None, settings=None):
    if count < 2 or count % 2: raise ValueError('Benchmark needs an even game count')
    name = name or f'{generation}-vs-{opponent}'
    if not name.replace('-','').replace('_','').isalnum(): raise ValueError('Invalid run name')
    directory = root()/'matches'/name
    plan = {'options': settings or options(), 'jobs': paired_jobs(generation, [opponent]*(count//2))}
    run_plan(directory, plan)
    result = {**summarize(games(directory), generation), 'schemaVersion': 2, 'createdAt': now(), 'planFingerprint': digest(plan), 'run': name}
    report = directory/'result.json'
    if report.exists(): return read_json(report)
    atomic_json(report, result)
    return result

def compare(candidate, champion, count=32, name=None, settings=None, gate=False, criteria=None):
    if candidate == champion: raise ValueError('Candidate and champion must differ')
    name = name or f'{candidate}-vs-{champion}'
    result = benchmark(candidate, champion, count, name, settings)
    book = RatingBook(root()/'ratings.sqlite')
    event = book.update(name, list(games(root()/'matches'/name)))
    decision = acceptance(result, **(criteria or {}))
    if gate: book.promote(champion, candidate, decision, name)
    atomic_json(root()/'matches'/name/'gate.json', {'result': result, 'ratingEvent': event, 'decision': decision, 'applied': gate})
    return result, decision

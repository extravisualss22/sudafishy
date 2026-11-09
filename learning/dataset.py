"""Streaming adapters -> immutable, position-grouped SQLite training datasets."""
import json
import math
import os
from pathlib import Path
import chess
from .common import connect, digest, games, verify_game, input_fingerprint, file_hash, atomic_json, now

def position_key(fen):
    # Ignore counters deliberately: the same board cannot cross train/validation.
    return ' '.join(chess.Board(fen).fen().split()[:4])

def split_for(fen, seed=17, validation=.2):
    return 'validation' if int(digest([seed, position_key(fen)])[:16],16)/2**64 < validation else 'train'

def teacher_rows(path):
    db = connect(path)
    try:
        for row in db.execute('SELECT data FROM examples ORDER BY id'):
            example = json.loads(row[0])
            evaluation = example['before']
            value = math.tanh(evaluation['cp']/600) if evaluation['cp'] is not None else (1.0 if evaluation['mate'] > 0 else -1.0)
            yield {**example, 'targetMove': example['recommended'], 'targetValue': value, 'source': 'teacher'}
    finally: db.close()

def game_rows(path):
    for game in games(path):
        verify_game(game)
        board = chess.Board(game['initialFen'])
        for ply, move in enumerate(game['moves']):
            generation = game['white' if board.turn else 'black']['generation']
            if generation:
                value = 0 if game['result']=='1/2-1/2' else (1 if game['result']==('1-0' if board.turn else '0-1') else -1)
                yield {'id': digest([game['gameId'],ply,'outcome']), 'fen': board.fen(), 'repetitions': 3 if board.is_repetition(3) else 2 if board.is_repetition(2) else 1,
                       'gameId': game['gameId'], 'generation': generation, 'targetMove': move, 'targetValue': value, 'source': 'game-outcome'}
            board.push_uci(move)

def build(destination: Path, teacher=None, source_games=None, seed=17, validation=.2):
    if not 0 < validation < 1: raise ValueError('Validation fraction must be between zero and one')
    if not teacher and not source_games: raise ValueError('Supply teacher examples and/or completed games')
    # Hash logical rows, not a live SQLite/WAL file.
    inputs = {'teacher': None, 'games': input_fingerprint(source_games) if source_games else None, 'seed': seed, 'validation': validation, 'schemaVersion': 1}
    if teacher:
        import hashlib
        hash_value = hashlib.sha256()
        for row in teacher_rows(teacher): hash_value.update(json.dumps(row,sort_keys=True).encode())
        inputs['teacher'] = hash_value.hexdigest()
    version = digest(inputs)
    if destination.exists():
        db = connect(destination)
        row = db.execute('SELECT data FROM metadata').fetchone(); db.close()
        if not row or json.loads(row[0])['version'] != version: raise ValueError('Dataset exists with different inputs; choose a new version path')
        return json.loads(row[0])
    temporary = destination.with_suffix('.building.sqlite')
    # A build is replayable from streaming source; discard only our incomplete staging DB.
    if temporary.exists(): temporary.unlink()
    db = connect(temporary)
    db.executescript('''CREATE TABLE examples (id TEXT PRIMARY KEY, position_key TEXT UNIQUE, split TEXT, data TEXT);
    CREATE INDEX examples_split ON examples(split); CREATE TABLE metadata (data TEXT); CREATE TABLE source_games (id TEXT PRIMARY KEY);''')
    generations, settings = set(), {}
    # Teacher wins over weaker game-outcome labels for directly duplicated positions.
    for iterator in ([teacher_rows(teacher)] if teacher else []) + ([game_rows(source_games)] if source_games else []):
        for example in iterator:
            board = chess.Board(example['fen'])
            if chess.Move.from_uci(example['targetMove']) not in board.legal_moves: raise ValueError('Illegal policy target')
            db.execute('INSERT OR IGNORE INTO examples VALUES (?,?,?,?)', (example['id'],position_key(example['fen']),split_for(example['fen'],seed,validation),json.dumps(example)))
            db.execute('INSERT OR IGNORE INTO source_games VALUES (?)', (example['gameId'],))
            generations.add(example['generation'])
            if example.get('settings'): settings[digest(example['settings'])] = example['settings']
            if db.total_changes % 500 == 0: db.commit()
    counts = dict(db.execute('SELECT split,count(*) FROM examples GROUP BY split'))
    metadata = {'schemaVersion': 1, 'version': version, 'createdAt': now(), 'inputs': inputs, 'positions': sum(counts.values()),
                'games': db.execute('SELECT count(*) FROM source_games').fetchone()[0], 'generations': sorted(generations), 'teacherSettings': list(settings.values()),
                'train': counts.get('train',0), 'validation': counts.get('validation',0), 'deduplication': 'first four normalized FEN fields; teacher labels preferred'}
    db.execute('INSERT INTO metadata VALUES (?)', (json.dumps(metadata),)); db.commit()
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)'); db.close()
    os.replace(temporary,destination)
    atomic_json(destination.with_suffix('.json'),metadata)
    return metadata

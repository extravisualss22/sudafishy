"""Offline-only coaching. This module has no route into live move selection."""
import json
import random
from pathlib import Path
import chess
import chess.engine
from .common import REPO, connect, digest, file_hash, games, verify_game, now, read_json

DEFAULTS = {'nodes': 2000, 'depth': 8, 'probeNodes': 150, 'threads': 1, 'hash': 32,
            'maxPerGame': 8, 'randomRate': .15, 'seed': 11, 'executable': None}

def score_json(score, color):
    point = score.pov(color)
    return {'cp': point.score(), 'mate': point.mate()}

def classify(before, after):
    loss = max(0, before['cp']-after['cp']) if before['cp'] is not None and after['cp'] is not None else None
    mate_worsened = (before['mate'] is not None and before['mate'] > 0 and (after['mate'] is None or after['mate'] <= 0)) or (after['mate'] is not None and after['mate'] <= 0 and (before['mate'] is None or before['mate'] > 0))
    return loss, 'blunder' if mate_worsened or (loss is not None and loss >= 200) else 'mistake' if loss is not None and loss >= 80 else 'normal'

def review(source: Path, destination: Path, settings=None, max_positions=256, stop=lambda: False):
    config = {**DEFAULTS, **(settings or {})}
    import os
    if not (1 <= config['threads'] <= (os.cpu_count() or 1) and 1 <= config['hash'] <= 1024 and 1 <= config['depth'] <= 30 and 100 <= config['nodes'] <= 10000000 and 1 <= config['probeNodes'] <= config['nodes'] and 1 <= config['maxPerGame'] <= 1000 and 0 <= config['randomRate'] <= 1 and max_positions >= 1):
        raise ValueError('Invalid teacher resource/selection settings')
    binary = Path(config['executable']) if config['executable'] else REPO/'public/engine/stockfish-19-lite-single.wasm'
    if not config['executable'] and config['threads'] != 1: raise ValueError('Bundled WASM is single-threaded; configure a native UCI executable for multiple threads')
    fingerprint = digest({'settings': config, 'binary': file_hash(binary), 'teacherCode': file_hash(Path(__file__), text=True)})
    db = connect(destination)
    db.executescript('''CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS examples (id TEXT PRIMARY KEY, game_id TEXT, ply INTEGER, data TEXT);
    CREATE TABLE IF NOT EXISTS completed (game_id TEXT PRIMARY KEY, fingerprint TEXT);''')
    prior = db.execute("SELECT value FROM metadata WHERE key='fingerprint'").fetchone()
    if prior and prior[0] != fingerprint:
        db.close()
        raise ValueError('Teacher configuration changed; use a new review database')
    with db:
        db.execute("INSERT OR IGNORE INTO metadata VALUES ('fingerprint',?)", (fingerprint,))
        db.execute("INSERT OR IGNORE INTO metadata VALUES ('settings',?)", (json.dumps(config),))
    command = [config['executable']] if config['executable'] else ['node', str(REPO/'learning/stockfish.cjs')]
    try: engine = chess.engine.SimpleEngine.popen_uci(command, timeout=120)
    except BaseException:
        db.close(); raise
    added = 0
    try:
        engine.configure({'Threads': config['threads'], 'Hash': config['hash']})
        for game in games(source):
            if stop() or added >= max_positions: break
            game_hash = digest(game)
            previous = db.execute('SELECT fingerprint FROM completed WHERE game_id=?', (game['gameId'],)).fetchone()
            if previous:
                if previous[0] != game_hash: raise ValueError('Completed game changed after review')
                continue
            verify_game(game)
            board = chess.Board(game['initialFen'])
            selected = db.execute('SELECT count(*) FROM examples WHERE game_id=?', (game['gameId'],)).fetchone()[0]
            interrupted = False
            for ply, uci in enumerate(game['moves']):
                move = chess.Move.from_uci(uci)
                color = board.turn
                player = game['white' if color else 'black']
                example_id = digest([game['gameId'], ply, fingerprint])
                exists = db.execute('SELECT 1 FROM examples WHERE id=?', (example_id,)).fetchone()
                if not player['generation'] or exists or selected >= config['maxPerGame']:
                    board.push(move); continue
                if stop() or added >= max_positions: interrupted = True; break
                reasons = []
                rng = random.Random(digest([config['seed'], game['gameId'], ply]))
                if board.is_capture(move) or board.is_check() or board.gives_check(move) or move.promotion: reasons.append('tactical')
                if game['result'] == ('0-1' if color else '1-0') and rng.random() < .30: reasons.append('lost-game')
                if rng.random() < config['randomRate']: reasons.append('random')
                # Cheap probes discover quiet mistakes/swings, without deep-reviewing every ply.
                probe = engine.analyse(board, chess.engine.Limit(nodes=config['probeNodes']), multipv=2, game=game['gameId'])
                best_probe = score_json(probe[0]['score'], color)
                board.push(move)
                played_probe = score_json(engine.analyse(board, chess.engine.Limit(nodes=config['probeNodes']), game=game['gameId'])['score'], color)
                board.pop()
                probe_loss, probe_class = classify(best_probe, played_probe)
                if probe_class != 'normal': reasons.append('mistake-probe')
                if probe_loss is not None and probe_loss >= 150: reasons.append('evaluation-swing')
                if len(probe)>1:
                    second = score_json(probe[1]['score'], color)
                    if best_probe['cp'] is not None and second['cp'] is not None and abs(best_probe['cp']-second['cp']) < 25: reasons.append('uncertain')
                if not reasons: board.push(move); continue
                limit = chess.engine.Limit(nodes=config['nodes'], depth=config['depth'])
                info = engine.analyse(board, limit, game=game['gameId'])
                before = score_json(info['score'], color)
                recommended = info['pv'][0].uci()
                fen = board.fen()
                repetitions = 3 if board.is_repetition(3) else 2 if board.is_repetition(2) else 1
                board.push(move)
                after_info = engine.analyse(board, limit, game=game['gameId'])
                after = score_json(after_info['score'], color)
                loss, classification = classify(before, after)
                record = {'schemaVersion': 1, 'id': example_id, 'fen': fen, 'repetitions': repetitions, 'generation': player['generation'],
                          'sideToMove': 'white' if color else 'black', 'played': uci, 'recommended': recommended, 'before': before, 'after': after,
                          'centipawnLoss': loss, 'classification': classification, 'selectionReasons': reasons, 'settings': config,
                          'engine': engine.id, 'teacherFingerprint': fingerprint, 'gameId': game['gameId'], 'ply': ply,
                          'result': game['result'], 'createdAt': now(), 'analysisNodes': info.get('nodes',0)+after_info.get('nodes',0)}
                with db: db.execute('INSERT INTO examples VALUES (?,?,?,?)', (example_id, game['gameId'], ply, json.dumps(record)))
                selected += 1; added += 1
            if not interrupted:
                with db: db.execute('INSERT INTO completed VALUES (?,?)', (game['gameId'], game_hash))
        return {'added': added, 'reviewedPositions': db.execute('SELECT count(*) FROM examples').fetchone()[0], 'fingerprint': fingerprint}
    finally:
        engine.quit(); db.close()

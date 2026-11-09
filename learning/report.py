import json
from .common import root, read_json, atomic_json, connect, now, games
from .ratings import RatingBook

def report(state=None):
    base = root()
    book = RatingBook(base/'ratings.sqlite')
    with book.db: book.ensure('gen0')
    ratings = book.snapshot(); book.db.close()
    runs = [read_json(path) for path in sorted(base.glob('**/job-summary.json'))]
    reviewed = 0; coaching = []
    dataset_ids = set()
    datasets = []
    for path in sorted((base/'datasets').glob('*.sqlite')):
        if '.building.' in path.name: continue
        db = connect(path)
        datasets.append(json.loads(db.execute('SELECT data FROM metadata').fetchone()[0]))
        # Do not retain the whole dataset in memory: coaching membership is checked below.
        db.close()
    for path in sorted((base/'reviews').glob('*.sqlite')):
        db = connect(path)
        reviewed += db.execute('SELECT count(*) FROM examples').fetchone()[0]
        coaching.extend(json.loads(row[0]) for row in db.execute('SELECT data FROM examples ORDER BY rowid DESC LIMIT 100'))
        db.close()
    coaching = coaching[-100:]
    for path in sorted((base/'datasets').glob('*.sqlite')):
        if '.building.' in path.name: continue
        db = connect(path)
        for example in coaching:
            if db.execute('SELECT 1 FROM examples WHERE id=?',(example['id'],)).fetchone(): dataset_ids.add(example['id'])
        db.close()
    wanted = {row['gameId'] for row in coaching}
    replay = {}
    for directory in sorted(base.glob('**/job-summary.json')):
        for game in games(directory.parent):
            if game['gameId'] in wanted:
                replay[game['gameId']] = {**game, 'finished': True}
    for row in coaching: row['inDataset'] = row['id'] in dataset_ids
    training = [read_json(path) for path in sorted((base/'training').glob('*/metrics.json'))]
    previous = read_json(base/'status.json') if (base/'status.json').exists() else {}
    if state is None: state=previous.get('pipeline',{})
    value = {'schemaVersion':2,'savedAt':now(),'champion':ratings['champion'],'ratings':ratings['ratings'], 'history':ratings['history'],
             'estimatedChessElo':{'status':'unrated','value':None}, 'totalGames':sum(run['games'] for run in runs),'totalPositions':sum(run['moves'] for run in runs),
             'reviewedPositions':reviewed,'datasets':datasets,'trainingExamples':sum(d['positions'] for d in datasets),'training':training[-10:],
             'pipeline':state,'coaching':coaching,'reviewedGames':list(replay.values()),
             'matches':[read_json(path) for path in sorted((base/'matches').glob('*/result.json'))],
             'gates':[read_json(path) for path in sorted((base/'matches').glob('*/gate.json'))]}
    atomic_json(base/'status.json',value)
    return value

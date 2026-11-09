"""Finite, sequential local workloads. All mutations use one OS-released root lock."""
import argparse
import json
import os
import signal
from pathlib import Path
from .common import root, read_json, atomic_json, exclusive_lock, digest, now
from .matches import benchmark, compare, run_plan, schedule, options
from .ratings import RatingBook
from .report import report

stopping = False
def stop_requested(): return stopping or (root()/'STOP').exists()
def signal_stop(*_):
    global stopping
    stopping = True

def pipeline(config_path, iterations, run_id):
    from .teacher import review
    from .dataset import build
    from .train import train, archive
    if not 1 <= iterations <= 1000: raise ValueError('Explicit iterations must be between 1 and 1000')
    config = read_json(config_path)
    folder = root()/'pipelines'/run_id
    folder.mkdir(parents=True,exist_ok=True)
    path = folder/'state.json'
    fingerprint = digest(config)
    state = read_json(path) if path.exists() else {'configFingerprint':fingerprint,'iteration':0,'phase':'ready','completed':[], 'runId':run_id}
    if state['configFingerprint'] != fingerprint: raise ValueError('Pipeline config changed; use a different run ID')
    def publish(phase):
        state['phase']=phase; state['updatedAt']=now(); atomic_json(path,state); report(state)
    target = iterations # Absolute target; rerunning the same command resumes, it does not append more iterations.
    while state['iteration'] < target:
        if stop_requested(): publish('stopped'); return state
        number = state['iteration']+1
        prefix = f'{run_id}-{number}'
        if 'candidate' not in state:
            book = RatingBook(root()/'ratings.sqlite'); champion = book.champion(); book.db.close()
            used = [int(p.name[3:]) for p in (root()/'generations').glob('gen*') if p.name[3:].isdigit()]
            state.update({'champion':champion,'candidate':f'gen{max(used,default=0)+1}'})
        champion, candidate = state['champion'],state['candidate']
        publish('simulate')
        pools = dict(config.get('pools',{})); pools['self']=[champion]
        pools.setdefault('older',[p.name for p in (root()/'generations').glob('gen*') if p.name[3:].isdigit() and p.name!=champion]+(['gen0'] if champion!='gen0' else []))
        pools.setdefault('weak',['weak']); pools.setdefault('fixed',['fixed-gen0-d3']); pools.setdefault('stockfish',['stockfish'])
        simulation = {**options(),**config.get('simulation',{})}
        simulation['seed'] += number
        plan = {'options':simulation,'jobs':schedule(champion,config.get('games',20),simulation['seed'],config.get('mix'),pools)}
        source = run_plan(root()/'simulations'/prefix,plan)
        if stop_requested(): publish('stopped'); return state
        publish('review')
        review_path = root()/'reviews'/f'{prefix}.sqlite'
        # Batch until the configured completed-game selection is exhausted, or stopped.
        while True:
            result = review(source,review_path,config.get('teacher'),config.get('reviewBatch',256),stop_requested)
            report(state)
            if result['added']==0 or stop_requested(): break
        if stop_requested(): publish('stopped'); return state
        publish('dataset')
        dataset = root()/'datasets'/f'{prefix}.sqlite'
        build(dataset,teacher=review_path,seed=config.get('splitSeed',17))
        publish('train')
        training_path = root()/'training'/prefix
        trained = train(dataset,training_path,{**config.get('training',{}),'initializeFrom':champion},stop_requested)
        if trained['status']!='completed': publish('stopped'); return state
        publish('archive')
        if not (root()/'generations'/candidate).exists(): archive(training_path,candidate,champion)
        else:
            manifest=read_json(root()/'generations'/candidate/'manifest.json')
            if manifest['training']['fingerprint'] != trained['fingerprint'] or manifest['parent'] != champion: raise ValueError('Candidate conflicts with resumed pipeline')
        if stop_requested(): publish('stopped'); return state
        publish('gate')
        result,decision=compare(candidate,champion,config.get('matchGames',32),prefix+'-gate',config.get('matchSettings',simulation),True,config.get('acceptance'))
        state['completed'].append({'iteration':number,'candidate':candidate,'champion':champion,'decision':decision,'match':result['run']})
        state['iteration']=number
        del state['candidate']; del state['champion']
        publish('completed')
    return state

def main():
    parser=argparse.ArgumentParser(description='sudalol offline learning laboratory')
    parser.add_argument('--data',type=Path,help='Data root; defaults to training-data')
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ['benchmark','compare']:
        p=sub.add_parser(name); p.add_argument('generation'); p.add_argument('--opponent',default='weak' if name=='benchmark' else 'gen0'); p.add_argument('--games',type=int,default=32); p.add_argument('--name'); p.add_argument('--settings',type=Path)
        if name=='compare': p.add_argument('--gate',action='store_true'); p.add_argument('--min-games',type=int,default=32); p.add_argument('--min-score',type=float,default=.55); p.add_argument('--min-lower',type=float,default=.5)
    p=sub.add_parser('simulate'); p.add_argument('--config',type=Path,required=True); p.add_argument('--name',required=True); p.add_argument('--generation',default='gen0')
    p=sub.add_parser('review'); p.add_argument('--games',type=Path,required=True); p.add_argument('--output',type=Path,required=True); p.add_argument('--settings',type=Path); p.add_argument('--max-positions',type=int,default=256)
    p=sub.add_parser('dataset'); p.add_argument('--teacher',type=Path); p.add_argument('--games',type=Path); p.add_argument('--output',type=Path,required=True)
    p=sub.add_parser('train'); p.add_argument('--dataset',type=Path,required=True); p.add_argument('--run',type=Path,required=True); p.add_argument('--settings',type=Path); p.add_argument('--max-batches',type=int)
    p=sub.add_parser('archive'); p.add_argument('--run',type=Path,required=True); p.add_argument('--generation',required=True); p.add_argument('--parent',default='gen0')
    p=sub.add_parser('loop'); p.add_argument('--config',type=Path,required=True); p.add_argument('--iterations',type=int,required=True); p.add_argument('--run-id',required=True)
    sub.add_parser('report'); sub.add_parser('stop'); sub.add_parser('resume')
    args=parser.parse_args()
    if args.data: os.environ['SUDALOL_DATA']=str(args.data.resolve())
    if args.command=='stop': root().mkdir(parents=True,exist_ok=True); (root()/'STOP').touch(); print('Stop requested at the next safe boundary'); return
    if args.command=='resume': (root()/'STOP').unlink(missing_ok=True); print('Stop flag cleared. Repeat the original command to resume.'); return
    for name in ['name','run_id']:
        value=getattr(args,name,None)
        if value and not value.replace('-','').replace('_','').isalnum(): raise ValueError('Run names must be letters, numbers, hyphens or underscores')
    signal.signal(signal.SIGTERM,signal_stop)
    with exclusive_lock(root()/'.workload.lock'):
        if stop_requested(): raise RuntimeError('STOP flag exists; run resume before starting work')
        config=read_json(args.settings) if getattr(args,'settings',None) else None
        if args.command=='benchmark': result=benchmark(args.generation,args.opponent,args.games,args.name,config)
        elif args.command=='compare': result=compare(args.generation,args.opponent,args.games,args.name,config,args.gate,{'min_games':args.min_games,'min_score':args.min_score,'min_lower':args.min_lower})
        elif args.command=='simulate':
            c=read_json(args.config); settings={**options(),**c.get('simulation',{})}
            plan={'options':settings,'jobs':schedule(args.generation,c.get('games',20),settings['seed'],c.get('mix'),c.get('pools'))}
            result=str(run_plan(root()/'simulations'/args.name,plan))
        elif args.command=='review':
            from .teacher import review
            result=review(args.games,args.output,config,args.max_positions,stop_requested)
        elif args.command=='dataset':
            from .dataset import build
            result=build(args.output,args.teacher,args.games)
        elif args.command=='train':
            from .train import train
            result=train(args.dataset,args.run,config,stop_requested,args.max_batches)
        elif args.command=='archive':
            from .train import archive
            result=archive(args.run,args.generation,args.parent)
        elif args.command=='loop': result=pipeline(args.config,args.iterations,args.run_id)
        else: result={}
        report()
        print(json.dumps(result,indent=2))

if __name__=='__main__': main()

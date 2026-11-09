import json
import os
import random
import shutil
import time
from pathlib import Path
import numpy as np
import torch
from .common import REPO, root, connect, digest, atomic_json, read_json, file_hash, now
from .model import PolicyValue, losses, ENCODER

DEFAULTS = {'epochs': 2, 'batchSize': 32, 'learningRate': .001, 'device': 'auto', 'seed': 19,
            'checkpointEvery': 5, 'cpuThreads': 2, 'valueBlend': .15, 'policyWeight': 40, 'initializeFrom': None}

def rows(db, split, size, skip=0):
    cursor = db.execute('SELECT data FROM examples WHERE split=? ORDER BY id LIMIT -1 OFFSET ?', (split,skip))
    while values := cursor.fetchmany(size): yield [json.loads(row[0]) for row in values]

def save_checkpoint(path, state):
    temporary = path.with_suffix('.tmp')
    with temporary.open('wb') as stream:
        torch.save(state,stream)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary,path)

def train(dataset: Path, directory: Path, settings=None, stop=lambda: False, max_batches=None):
    config = {**DEFAULTS, **(settings or {})}
    if not (1 <= config['epochs'] <= 10000 and 1 <= config['batchSize'] <= 4096 and 0 < config['learningRate'] <= 1 and 1 <= config['checkpointEvery'] <= 1000 and 1 <= config['cpuThreads'] <= (os.cpu_count() or 1) and 0 <= config['valueBlend'] <= 1 and 0 <= config['policyWeight'] <= 1000): raise ValueError('Invalid training configuration')
    device = ('cuda' if torch.cuda.is_available() else 'cpu') if config['device']=='auto' else config['device']
    if device not in ['cpu','cuda'] or device=='cuda' and not torch.cuda.is_available(): raise ValueError('Requested training device is unavailable')
    os.environ.setdefault('CUBLAS_WORKSPACE_CONFIG', ':4096:8')
    torch.set_num_threads(config['cpuThreads']); torch.use_deterministic_algorithms(True)
    random.seed(config['seed']); np.random.seed(config['seed']); torch.manual_seed(config['seed'])
    db = connect(dataset)
    metadata = json.loads(db.execute('SELECT data FROM metadata').fetchone()[0])
    db.close()
    if not metadata['train'] or not metadata['validation']: raise ValueError('Need nonempty training and validation splits; review more positions')
    initial_checkpoint = None
    if config['initializeFrom'] and config['initializeFrom'] != 'gen0':
        import re
        if not re.fullmatch(r'gen[1-9][0-9]*',config['initializeFrom']): raise ValueError('Invalid initial generation')
        parent = root()/'generations'/config['initializeFrom']
        manifest = read_json(parent/'manifest.json')
        initial_checkpoint = parent/'checkpoint.pt'
        if file_hash(initial_checkpoint) != manifest['files']['checkpoint.pt']: raise ValueError('Initial checkpoint changed')
    fingerprint = digest({'config':config,'dataset':metadata['version'],'initialCheckpoint':file_hash(initial_checkpoint) if initial_checkpoint else None,'code':{name:file_hash(REPO/'learning'/name,text=True) for name in ['model.py','train.py']}})
    directory.mkdir(parents=True,exist_ok=True)
    checkpoint = directory/'checkpoint.pt'
    model = PolicyValue().to(device); optimizer = torch.optim.Adam(model.parameters(),lr=config['learningRate'])
    if initial_checkpoint and not checkpoint.exists(): model.load_state_dict(torch.load(initial_checkpoint,map_location=device,weights_only=True)['model'])
    epoch,offset,steps,elapsed,history = 0,0,0,0,[]
    if checkpoint.exists():
        state = torch.load(checkpoint,map_location=device,weights_only=True)
        if state['fingerprint'] != fingerprint: raise ValueError('Checkpoint configuration/dataset/code changed; use a new training run')
        if state['device'] != device: raise ValueError('Resume on the same device, or start a separately identified training run')
        model.load_state_dict(state['model']); optimizer.load_state_dict(state['optimizer'])
        epoch,offset,steps,elapsed,history = (state[k] for k in ['epoch','offset','steps','elapsed','history'])
        torch.set_rng_state(state['rng'].cpu())
        if device=='cuda': torch.cuda.set_rng_state_all([s.cpu() for s in state['cudaRng']])
    started = time.perf_counter(); invocation_batches = 0
    def persist():
        seconds = elapsed+time.perf_counter()-started
        save_checkpoint(checkpoint, {'model':model.state_dict(),'optimizer':optimizer.state_dict(),'epoch':epoch,'offset':offset,'steps':steps,'elapsed':seconds,'history':history,
                                    'fingerprint':fingerprint,'config':config,'dataset':metadata,'device':device,'rng':torch.get_rng_state(),'cudaRng':torch.cuda.get_rng_state_all() if device=='cuda' else []})
        atomic_json(directory/'metrics.json', {'schemaVersion':1,'status':'completed' if epoch>=config['epochs'] else 'paused','epochsCompleted':epoch,'steps':steps,'elapsedSeconds':seconds,
                    'history':history,'device':device,'hardware':torch.cuda.get_device_name(0) if device=='cuda' else 'CPU','torch':str(torch.__version__),'config':config,'dataset':metadata,'fingerprint':fingerprint})
    db = connect(dataset)
    try:
        while epoch < config['epochs']:
            model.train()
            for examples in rows(db,'train',config['batchSize'],offset):
                if stop() or max_batches is not None and invocation_batches >= max_batches: persist(); return read_json(directory/'metrics.json')
                optimizer.zero_grad(set_to_none=True)
                loss,_ = losses(model,examples,device); loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(),1); optimizer.step()
                offset += len(examples); steps += 1; invocation_batches += 1
                if steps % config['checkpointEvery']==0: persist()
            model.eval(); metrics = {'epoch':epoch+1}
            with torch.no_grad():
                for split in ['train','validation']:
                    sums = {'loss':0.,'policyLoss':0.,'valueError':0.,'policyAccuracy':0.}; count=0
                    for examples in rows(db,split,config['batchSize']):
                        loss,values = losses(model,examples,device); count+=len(examples)
                        for key,value in {'loss':loss.item(),**values}.items(): sums[key]+=value*len(examples)
                    metrics[split] = {key:value/count for key,value in sums.items()}
            history.append(metrics); epoch+=1; offset=0; persist()
        persist()
        atomic_json(directory/'model.json',model.export(config['valueBlend'],config['policyWeight']))
        return read_json(directory/'metrics.json')
    except KeyboardInterrupt:
        persist(); raise
    finally: db.close()

def archive(directory: Path, generation: str, parent='gen0'):
    import re
    if not re.fullmatch(r'gen[1-9][0-9]*',generation) or not re.fullmatch(r'gen[0-9]+',parent): raise ValueError('Invalid generation ID; gen0 cannot be overwritten')
    parent_dir = REPO/'src/lib/sudalol/generations/gen0' if parent=='gen0' else root()/'generations'/parent
    if not (parent_dir/'manifest.json').exists(): raise ValueError('Parent generation missing')
    metrics = read_json(directory/'metrics.json')
    if metrics['status'] != 'completed': raise ValueError('Finish training before archiving a candidate')
    target = root()/'generations'/generation
    if target.exists(): raise FileExistsError('Generation already exists; immutable archives cannot be overwritten')
    staging = target.with_name(generation+'.staging')
    if staging.exists(): shutil.rmtree(staging) # fixed validated child under generations; incomplete staging only
    staging.mkdir(parents=True)
    for name in ['checkpoint.pt','model.json','metrics.json']: shutil.copyfile(directory/name,staging/name)
    for name in ['search.ts','evaluation.ts','encoder.ts','model.ts']:
        source = (REPO/'src/lib/sudalol/neural'/name).read_text(encoding='utf-8').replace('../types.ts','./types.ts')
        (staging/name).write_text(source,encoding='utf-8',newline='\n')
    shutil.copyfile(REPO/'src/lib/sudalol/types.ts',staging/'types.ts')
    (staging/'engine.ts').write_text('import { readFileSync } from "node:fs";\nimport { validateWeights } from "./model.ts";\nimport { chooseNeuralMove } from "./search.ts";\nimport type { Chess } from "chess.js";\nimport type { SearchOptions } from "./types.ts";\nconst weights = validateWeights(JSON.parse(readFileSync(new URL("./model.json", import.meta.url), "utf8")));\nexport const chooseMove = (board: Chess, options: SearchOptions) => chooseNeuralMove(board, options, weights);\n',encoding='utf-8',newline='\n')
    manifest = {'id':generation,'name':f'sudalol {generation}','kind':'neural','rules':'chess.js@1.4.0','parent':parent,'createdAt':now(),
                'datasetVersion':metrics['dataset']['version'],'training':metrics,'encoder':ENCODER,
                'sourceFingerprint':digest({str(p.relative_to(REPO)).replace('\\','/'):file_hash(p,text=True) for folder in ['learning','src/lib/sudalol/neural'] for p in sorted((REPO/folder).glob('*')) if p.suffix in ['.ts','.py']}),
                'files':{p.name:file_hash(p,text=p.suffix!='.pt') for p in sorted(staging.iterdir())}}
    atomic_json(staging/'manifest.json',manifest)
    os.rename(staging,target)
    return manifest

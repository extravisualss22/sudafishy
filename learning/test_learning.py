import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import chess
import torch
from .common import REPO, atomic_json, connect, digest, games, verify_game, exclusive_lock
from .dataset import build, split_for, position_key
from .model import encode, policy_indices, PolicyValue
from .ratings import expected, summarize, acceptance, RatingBook
from .matches import schedule, paired_jobs
from .teacher import review, classify
from .train import train, archive

def record(index=0, result='1-0',white='gen1',black='gen0'):
    board=chess.Board()
    moves=['e2e4','e7e5','g1f3','b8c6']
    for move in moves: board.push_uci(move)
    player=lambda name:{'id':name,'generation':name,'name':name,'fingerprint':'test-fixture'}
    return {'schemaVersion':1,'gameId':f'test-{index}','index':index,'white':player(white),'black':player(black),'moves':moves,'moveCount':len(moves),
            'initialFen':chess.STARTING_FEN,'finalFen':board.fen(),'result':result,'termination':'move-limit','nodes':100,'search':{},'seed':index}

class LearningTests(unittest.TestCase):
    def setUp(self):
        (REPO/'work').mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=REPO/'work')
        self.path=Path(self.temp.name)
        self.environment=patch.dict(os.environ,{'SUDALOL_DATA':str(self.path)})
        self.environment.start()
    def tearDown(self): self.environment.stop(); self.temp.cleanup()
    def make_dataset(self):
        db=connect(self.path/'teacher.sqlite')
        db.execute('CREATE TABLE examples (id TEXT PRIMARY KEY,data TEXT)')
        board=chess.Board()
        import random
        rng=random.Random(18)
        for i in range(60):
            if board.is_game_over(): board=chess.Board()
            move=rng.choice(list(board.legal_moves))
            row={'id':f'test-{i}','gameId':'fixture','fen':board.fen(),'repetitions':1,'generation':'gen0','recommended':move.uci(),'before':{'cp':i*3,'mate':None},'settings':{'test':True}}
            db.execute('INSERT INTO examples VALUES (?,?)',(row['id'],json.dumps(row)));board.push(move)
        db.commit();db.close()
        build(self.path/'dataset.sqlite',teacher=self.path/'teacher.sqlite')
        return self.path/'dataset.sqlite'
    def test_encoding_and_policy_mapping(self):
        x=encode(chess.STARTING_FEN)
        self.assertEqual(len(x),839);self.assertEqual(sum(x[:768]),32);self.assertEqual(x[768],1);self.assertEqual(list(x[769:773]),[1]*4)
        self.assertEqual(policy_indices('e7e8q'),[52,124,129]);self.assertEqual(policy_indices('a2a1n'),[8,64,132])
        self.assertNotEqual(policy_indices('a7a8r'),policy_indices('a7a8b'))
        self.assertEqual(encode('4k3/8/8/3pP3/8/8/8/4K3 w - d6 40 10',2)[773+43],1)
    def test_cross_language_encoder_and_inference(self):
        torch.manual_seed(7);model=PolicyValue()
        fen='r3k2r/8/8/3pP3/8/8/8/R3K2R w KQkq d6 40 10'
        atomic_json(self.path/'weights.json',model.export())
        script="import {readFileSync} from 'node:fs'; import {forward,validateWeights} from './src/lib/sudalol/neural/model.ts';import {encodeFen,policyIndices} from './src/lib/sudalol/neural/encoder.ts';const model=validateWeights(JSON.parse(readFileSync(process.argv[1],'utf8')));console.log(JSON.stringify({features:encodeFen(process.argv[2],2),output:forward(model,process.argv[2],2),policy:policyIndices('e7e8n')}));"
        actual=json.loads(subprocess.check_output(['node','--input-type=module','-e',script,str(self.path/'weights.json'),fen],cwd=REPO,text=True))
        import numpy as np
        np.testing.assert_allclose(actual['features'],encode(fen,2),atol=1e-7)
        with torch.no_grad(): policy,value=model(torch.tensor(encode(fen,2)).unsqueeze(0))
        np.testing.assert_allclose(actual['output']['policy'],policy[0].tolist(),atol=1e-6)
        self.assertAlmostEqual(actual['output']['value'],value.item(),places=6)
        self.assertEqual(actual['policy'],policy_indices('e7e8n'))
    def test_dataset_streaming_deduplication_splits_and_rebuild(self):
        path=self.make_dataset();db=connect(path)
        self.assertGreater(db.execute("SELECT count(*) FROM examples WHERE split='validation'").fetchone()[0],0)
        self.assertEqual(db.execute('SELECT count(*) FROM (SELECT position_key FROM examples GROUP BY position_key HAVING count(DISTINCT split)>1)').fetchone()[0],0)
        db.close()
        self.assertEqual(split_for(chess.STARTING_FEN),split_for(chess.STARTING_FEN.replace('0 1','83 42')))
        self.assertEqual(build(path,teacher=self.path/'teacher.sqlite')['positions'],60)
        with self.assertRaises(ValueError): build(path,teacher=self.path/'teacher.sqlite',seed=9)
    def test_completed_game_adapter_and_corruption(self):
        folder=self.path/'games';folder.mkdir();p=folder/'games-00000.jsonl';game=record()
        p.write_text(json.dumps(game)+'\n',encoding='utf-8')
        verify_game(game);meta=build(self.path/'outcome.sqlite',source_games=folder)
        self.assertEqual(meta['positions'],4)
        p.write_text(json.dumps({**game,'result':'*'})+'\n',encoding='utf-8')
        with self.assertRaises(ValueError): list(games(folder))
        p.write_text(json.dumps(game)+'\n{"torn":',encoding='utf-8');self.assertEqual(len(list(games(folder))),1)
        p.write_text('{bad}\n',encoding='utf-8')
        with self.assertRaises(json.JSONDecodeError): list(games(folder))
    def test_checkpoint_resume_equivalence_and_generation_preservation(self):
        dataset=self.make_dataset();config={'device':'cpu','epochs':2,'batchSize':16,'checkpointEvery':1}
        full=train(dataset,self.path/'full',config)
        partial=train(dataset,self.path/'resumed',config,max_batches=1)
        self.assertEqual(partial['status'],'paused')
        resumed=train(dataset,self.path/'resumed',config)
        self.assertEqual(full['history'],resumed['history'])
        self.assertEqual(json.loads((self.path/'full/model.json').read_text()),json.loads((self.path/'resumed/model.json').read_text()))
        with self.assertRaises(ValueError): train(dataset,self.path/'resumed',{**config,'seed':99})
        archive(self.path/'resumed','gen17')
        with self.assertRaises(FileExistsError): archive(self.path/'resumed','gen17')
        with self.assertRaises(ValueError): archive(self.path/'resumed','gen0')
        command=['node','--input-type=module','-e',"import {verifyGeneration} from './sim/generations.ts';await verifyGeneration('gen17');"]
        subprocess.run(command,cwd=REPO,check=True,capture_output=True)
        (self.path/'generations/gen17/model.json').write_text('{}')
        self.assertNotEqual(subprocess.run(command,cwd=REPO,capture_output=True).returncode,0)
    def test_ratings_match_and_idempotent_gate(self):
        self.assertEqual(expected(1000,1000),.5)
        records=[record(i,'1-0' if i%2==0 else '0-1','gen1' if i%2==0 else 'gen0','gen0' if i%2==0 else 'gen1') for i in range(32)]
        summary=summarize(records,'gen1');decision=acceptance(summary)
        self.assertEqual(summary['wins'],32);self.assertTrue(decision['accepted']);self.assertEqual(summary['estimatedChessElo']['status'],'unrated')
        self.assertFalse(acceptance({**summary,'score':.5,'scoreInterval95':[.3,.7]})['accepted'])
        book=RatingBook(self.path/'ratings.sqlite');event=book.update('test',records)
        self.assertEqual(event,book.update('test',records));self.assertAlmostEqual(sum(r['rating'] for r in event['ratings']),2000)
        book.promote('gen0','gen1',decision,'test');book.promote('gen0','gen1',decision,'test');self.assertEqual(book.champion(),'gen1')
        with self.assertRaises(ValueError): book.update('test',[record(99)])
        book.db.close()
    def test_scheduler_explicit_categories_and_balanced_openings(self):
        with self.assertRaises(ValueError): schedule('gen0',20,11)
        jobs=schedule('gen0',20,11,{'weak':1})
        self.assertEqual(jobs,schedule('gen0',20,11,{'weak':1}))
        for a,b in zip(jobs[::2],jobs[1::2]): self.assertEqual(a['white'],b['black']);self.assertEqual(a['initialFen'],b['initialFen'])
        with self.assertRaises(ValueError): schedule('gen0',3,1,{'weak':1})
    def test_mate_evaluations_not_fake_cp(self):
        loss,label=classify({'cp':20,'mate':None},{'cp':None,'mate':-3})
        self.assertIsNone(loss);self.assertEqual(label,'blunder')
        self.assertEqual(classify({'cp':100,'mate':None},{'cp':0,'mate':None}),(100,'mistake'))
    def test_real_offline_teacher_resume(self):
        folder=self.path/'games';folder.mkdir();(folder/'games-00000.jsonl').write_text(json.dumps(record())+'\n')
        settings={'nodes':100,'probeNodes':50,'depth':2,'maxPerGame':2,'randomRate':1}
        a=review(folder,self.path/'review.sqlite',settings,max_positions=1)
        b=review(folder,self.path/'review.sqlite',settings,max_positions=2)
        c=review(folder,self.path/'review.sqlite',settings,max_positions=2)
        self.assertEqual([a['added'],b['added'],c['added']],[1,1,0])
        with self.assertRaises(ValueError): review(folder,self.path/'review.sqlite',{**settings,'nodes':200})

if __name__=='__main__': unittest.main()

import chess
import numpy as np
import torch
from torch import nn

ENCODER = 'absolute-839-v1'
INPUT_SIZE = 839

def encode(fen, repetitions=1):
    board = chess.Board(fen)
    features = np.zeros(INPUT_SIZE, dtype=np.float32)
    for square, piece in board.piece_map().items():
        plane = piece.piece_type-1+(0 if piece.color else 6)
        features[plane*64+square] = 1
    features[768] = float(board.turn)
    features[769:773] = [board.has_kingside_castling_rights(chess.WHITE),board.has_queenside_castling_rights(chess.WHITE),board.has_kingside_castling_rights(chess.BLACK),board.has_queenside_castling_rights(chess.BLACK)]
    if board.ep_square is not None: features[773+board.ep_square] = 1
    features[837] = min(board.halfmove_clock,100)/100
    features[838] = (min(max(repetitions,1),3)-1)/2
    return features

def policy_indices(uci):
    move = chess.Move.from_uci(uci)
    if not move: raise ValueError('Null policy move')
    promotion = {None:0,chess.QUEEN:1,chess.ROOK:2,chess.BISHOP:3,chess.KNIGHT:4}[move.promotion]
    return [move.from_square,64+move.to_square,128+promotion]

class PolicyValue(nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = nn.Sequential(nn.Linear(INPUT_SIZE,32),nn.ReLU(),nn.Linear(32,16),nn.ReLU(),nn.Linear(16,134))
    def forward(self, features):
        output = self.layers(features)
        return output[:,:133], output[:,133].tanh()
    def export(self, blend=.15, policy_weight=40):
        return {'schemaVersion':1,'encoder':ENCODER,'valueBlend':blend,'policyWeight':policy_weight,
                'layers':[{'weight': layer.weight.detach().cpu().tolist(), 'bias':layer.bias.detach().cpu().tolist()} for layer in self.layers if isinstance(layer,nn.Linear)]}

def batch(rows, device):
    boards = [chess.Board(row['fen']) for row in rows]
    legal = [[move.uci() for move in board.legal_moves] for board in boards]
    width = max(map(len,legal))
    indices = np.zeros((len(rows),width,3),dtype=np.int64)
    mask = np.zeros((len(rows),width),dtype=bool)
    targets = []
    for i,moves in enumerate(legal):
        for j,move in enumerate(moves): indices[i,j] = policy_indices(move); mask[i,j] = True
        targets.append(moves.index(rows[i]['targetMove']))
    return (torch.as_tensor(np.stack([encode(row['fen'],row['repetitions']) for row in rows]),device=device),
            torch.as_tensor(indices,device=device),torch.as_tensor(mask,device=device),torch.tensor(targets,device=device),
            torch.tensor([row['targetValue'] for row in rows],device=device,dtype=torch.float32))

def losses(model, rows, device):
    x,indices,mask,targets,values = batch(rows,device)
    policy,value = model(x)
    logits = policy.gather(1,indices.reshape(len(rows),-1)).reshape(indices.shape).sum(2).masked_fill(~mask,float('-inf'))
    policy_loss = nn.functional.cross_entropy(logits,targets)
    value_loss = nn.functional.mse_loss(value,values)
    return policy_loss+value_loss, {'policyLoss':policy_loss.item(),'valueError':value_loss.item(),'policyAccuracy':(logits.argmax(1)==targets).float().mean().item()}

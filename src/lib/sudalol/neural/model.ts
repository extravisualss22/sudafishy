import { encodeFen, ENCODER_VERSION, INPUT_SIZE, policyIndices } from "./encoder.ts";
export interface Layer { weight: number[][]; bias: number[] }
export interface NeuralWeights {
  schemaVersion: 1;
  encoder: string;
  layers: Layer[];
  valueBlend: number;
  policyWeight: number;
}
export function validateWeights(value: unknown): NeuralWeights {
  const model = value as NeuralWeights;
  if (model?.schemaVersion !== 1 || model.encoder !== ENCODER_VERSION || !Array.isArray(model.layers) || model.layers.length !== 3) throw new Error("Unsupported neural model format");
  if (!Number.isFinite(model.valueBlend) || model.valueBlend < 0 || model.valueBlend > 1 || !Number.isFinite(model.policyWeight) || model.policyWeight < 0 || model.policyWeight > 1000) throw new Error("Invalid neural blend settings");
  let width = INPUT_SIZE;
  for (const layer of model.layers) {
    if (!Array.isArray(layer.bias) || !layer.bias.length || layer.bias.length > 256 || !Array.isArray(layer.weight) || layer.weight.length !== layer.bias.length) throw new Error("Invalid neural layer");
    if (!layer.bias.every(Number.isFinite) || !layer.weight.every((row) => Array.isArray(row) && row.length === width && row.every(Number.isFinite))) throw new Error("Invalid neural weights");
    width = layer.bias.length;
  }
  if (width !== 134) throw new Error("Expected 133 policy factors and one value");
  return model;
}
export function forward(model: NeuralWeights, fen: string, repetitions = 1) {
  let input = encodeFen(fen, repetitions);
  for (let i = 0; i < model.layers.length; i++) {
    const layer = model.layers[i];
    const output = layer.bias.map((bias, j) => {
      let sum = bias;
      for (let k = 0; k < input.length; k++) if (input[k] !== 0) sum += layer.weight[j][k] * input[k];
      return i < 2 ? Math.max(0, sum) : sum;
    });
    input = output;
  }
  return { policy: input.slice(0, 133), value: Math.tanh(input[133]) };
}
export function policyScore(policy: number[], move: string) { return policyIndices(move).reduce((sum, index) => sum + policy[index], 0); }

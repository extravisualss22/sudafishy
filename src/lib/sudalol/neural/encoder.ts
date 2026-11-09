export const ENCODER_VERSION = "absolute-839-v1";
export const INPUT_SIZE = 839;
export function squareIndex(square: string) { return (Number(square[1]) - 1) * 8 + square.charCodeAt(0) - 97; }
/** Absolute a1=0; white P/N/B/R/Q/K, black p/n/b/r/q/k; state follows. */
export function encodeFen(fen: string, repetitions = 1): number[] {
  const [placement, turn, castling, ep, halfmove] = fen.split(" ");
  const input = Array<number>(INPUT_SIZE).fill(0);
  placement.split("/").forEach((row, rowIndex) => {
    let file = 0;
    for (const piece of row) {
      if (/\d/.test(piece)) file += Number(piece);
      else { const plane = "PNBRQKpnbrqk".indexOf(piece); if (plane < 0) throw new Error("Invalid piece"); input[plane * 64 + (7 - rowIndex) * 8 + file++] = 1; }
    }
  });
  input[768] = turn === "w" ? 1 : 0;
  [..."KQkq"].forEach((right, i) => { input[769 + i] = castling.includes(right) ? 1 : 0; });
  if (ep !== "-") input[773 + squareIndex(ep)] = 1;
  input[837] = Math.min(Number(halfmove), 100) / 100;
  input[838] = (Math.min(Math.max(repetitions, 1), 3) - 1) / 2;
  return input;
}
/** Factorized policy: from[64] + to[64] + promotion[none,q,r,b,n]. */
export function policyIndices(uci: string): [number, number, number] {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error("Invalid UCI move");
  return [squareIndex(uci.slice(0, 2)), 64 + squareIndex(uci.slice(2, 4)), 128 + (uci[4] ? "qr bn".replace(" ", "").indexOf(uci[4]) + 1 : 0)];
}

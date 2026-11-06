// Optional actual-pixel integration check. Start `npm run dev -- --port 5173` first.
// Requires Playwright and Chromium; no shared-screen or network permissions needed.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  // A static same-origin document avoids unrelated app/HMR navigation while
  // still loading the real Vite module and local piece assets.
  await page.goto((process.env.VISION_TEST_URL || "http://127.0.0.1:5173") + "/robots.txt");
  const results = await page.evaluate(async () => {
    const { createBoardVision, placementOf } = await import("/src/lib/vision/boardVision.ts");
    const { parseFen, START_FEN } = await import("/src/lib/chess/position.ts");
    const vision = createBoardVision((piece) => `/pieces/${piece}.svg`);
    const cache = new Map();
    async function image(piece) {
      if (!cache.has(piece)) {
        const img = new Image();
        img.src = `/pieces/${piece}.svg`;
        await img.decode();
        cache.set(piece, img);
      }
      return cache.get(piece);
    }
    async function render(fen, orientation, cell = 80) {
      const { board } = parseFen(fen);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = cell * 8;
      const ctx = canvas.getContext("2d");
      for (let row = 0; row < 8; row++)
        for (let col = 0; col < 8; col++) {
          const square =
            orientation === "white" ? "abcdefgh"[col] + (8 - row) : "hgfedcba"[col] + (row + 1);
          ctx.fillStyle = (row + col) % 2 ? "#769656" : "#eeeed2";
          ctx.fillRect(col * cell, row * cell, cell, cell);
          if (board[square])
            ctx.drawImage(await image(board[square]), col * cell, row * cell, cell, cell);
        }
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const reading = await vision.read(
        { data: pixels.data, width: canvas.width, height: canvas.height },
        { x: 0, y: 0, w: canvas.width, h: canvas.height },
        orientation,
      );
      const auto = await vision.read(
        { data: pixels.data, width: canvas.width, height: canvas.height },
        { x: 0, y: 0, w: canvas.width, h: canvas.height },
        "auto",
      );
      const mismatches = Object.keys({ ...board, ...reading.board })
        .filter((square) => board[square] !== reading.board[square])
        .map((square) => ({ square, expected: board[square], actual: reading.board[square] }));
      return {
        orientation,
        cell,
        correct: placementOf(board) === reading.placement,
        mismatches,
        confidence: reading.confidence,
        minPieceConfidence: Math.min(
          ...reading.squares.filter((square) => square.piece).map((square) => square.confidence),
        ),
        autoOrientation: auto.orientation,
        autoConfidence: auto.orientationConfidence,
      };
    }
    const midgame = "r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 8";
    return [
      await render(START_FEN, "white"),
      await render(START_FEN, "black"),
      await render(midgame, "white"),
      await render(midgame, "black", 48),
    ];
  });
  console.log(JSON.stringify(results, null, 2));
  assert.ok(
    results.every((result) => result.correct),
    "Known piece SVGs should reconstruct correctly in both orientations",
  );
} finally {
  await browser.close();
}

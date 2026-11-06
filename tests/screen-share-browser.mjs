// End-to-end local fixture: real video, canvas vision, review, FEN, and Sudafish.
// Start npm run dev -- --port 5173; requires Playwright and Chromium.
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.log("Browser error:", error.message);
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async (options) => {
        window.captureOptions = options;
        if (!window.fixtureStream) throw new DOMException("Canceled", "NotAllowedError");
        return window.fixtureStream;
      },
    });
  });
  await page.goto(process.env.VISION_TEST_URL || "http://127.0.0.1:5173", {
    waitUntil: "domcontentloaded",
  });
  console.log("App loaded");
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((button) =>
      Object.keys(button).some((key) => key.startsWith("__reactProps")),
    ),
  );
  const reader = page.getByLabel("Screen board reader", { exact: true });
  await reader.getByRole("button", { name: "Share Screen" }).click();
  await reader.getByText(/cancelled or blocked/).waitFor();
  await page.evaluate(async () => {
    const { parseFen, START_FEN } = await import("/src/lib/chess/position.ts");
    const cache = new Map();
    for (const piece of ["wK", "wQ", "wR", "wB", "wN", "wP", "bK", "bQ", "bR", "bB", "bN", "bP"]) {
      const img = new Image();
      img.src = `/pieces/${piece}.svg`;
      await img.decode();
      cache.set(piece, img);
    }
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 640;
    const context = canvas.getContext("2d");
    window.paintSharedPosition = (fen) => {
      const { board } = parseFen(fen);
      for (let row = 0; row < 8; row++)
        for (let col = 0; col < 8; col++) {
          const square = "abcdefgh"[col] + (8 - row);
          context.fillStyle = (row + col) % 2 ? "#769656" : "#eeeed2";
          context.fillRect(col * 80, row * 80, 80, 80);
          if (board[square])
            context.drawImage(cache.get(board[square]), col * 80, row * 80, 80, 80);
        }
    };
    window.paintSharedPosition(START_FEN);
    window.fixtureStream = canvas.captureStream(8);
  });
  await reader.getByRole("button", { name: "Share Screen" }).click();
  await reader.getByRole("button", { name: "Detect Board" }).click();
  const crop = reader.getByRole("slider", { name: "Board crop area" });
  await crop.focus();
  for (let i = 0; i < 20; i++) await crop.press("ArrowLeft");
  for (let i = 0; i < 10; i++) await crop.press("ArrowUp");
  for (let i = 0; i < 40; i++) await crop.press("Shift+ArrowRight");
  await reader.getByRole("radio", { name: "White at bottom" }).click();
  await reader.getByRole("button", { name: "Read board", exact: true }).click();
  console.log("Crop captured");
  await reader.getByRole("button", { name: "Use Position" }).waitFor();
  assert.equal(await reader.locator('[aria-label="Review detected board"] button').count(), 64);
  assert.equal(await reader.getByRole("radio", { name: "White to move" }).isChecked(), true);
  await reader.getByRole("button", { name: "Use Position" }).click();
  console.log("Reviewed position applied");
  const initial = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1";
  assert.equal(await page.getByRole("textbox", { name: "FEN", exact: true }).inputValue(), initial);
  await reader.getByRole("switch", { name: "Watch Board", exact: true }).click();
  await reader.getByRole("switch", { name: "Auto-update and analyze", exact: true }).click();
  const next = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b - - 0 1";
  await page.evaluate((fen) => window.paintSharedPosition(fen), next);
  await page.waitForFunction(
    (expected) => document.querySelector('input[aria-label="FEN"]').value === expected,
    next,
    { timeout: 15000 },
  );
  await page
    .getByRole("button", { name: "Calculate Next Move", exact: true })
    .waitFor({ timeout: 20000 });
  assert.equal(await page.getByText("Sudafish Basic", { exact: true }).count(), 0);
  await page.screenshot({ path: "/tmp/sudafish-screen-share-desktop.png", fullPage: true });
  await reader.getByRole("button", { name: "Stop Sharing", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.fixtureStream.getVideoTracks()[0].readyState),
    "ended",
  );
  assert.deepEqual(await page.evaluate(() => window.captureOptions), { video: true, audio: false });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: "/tmp/sudafish-screen-share-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: denied permission, live canvas capture, crop, actual SVG detection, review, conservative FEN apply, stable watch auto-update, real Sudafish, stream cleanup, mobile layout.",
  );
} finally {
  await browser.close();
}

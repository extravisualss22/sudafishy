# Sudafishy

Build a polished responsive web app named "travis.suda" inspired by the workflow of NextChessMove.com, but do NOT copy its proprietary code, logos, text, or branding. Recreate the core chess-analysis experience with an original Travis-branded visual identity.

Reference behavior/layout:
- Desktop: large interactive 8x8 chessboard on the left, compact controls immediately to the right, and an analysis/settings panel farther right. Mobile: stack into one column.
- Allow dragging pieces to configure any position.
- Piece palette for adding white/black chess pieces.
- Controls: White to move / Black to move; castling rights checkboxes for White kingside, White queenside, Black kingside, Black queenside.
- Actions: Reset, Clear/Capture All, Flip board, Undo, Redo.
- Show editable FEN below the board with copy button.
- PGN import field/modal and ability to step through imported moves.
- Main CTA: "Calculate Next Move".
- Run Stockfish locally in the browser using a Web Worker/WebAssembly-compatible approach if feasible. If the dependency cannot run in preview, implement a clean engine adapter with a working fallback/mock so the UI remains testable, and make the integration point obvious.
- When analysis runs, show best move, evaluation (+/- pawns or mate), depth, nodes/NPS if available, principal variation, and top 3 candidate lines.
- Draw the recommended move as an arrow/highlight on the board.
- A settings modal with engine think time/depth, number of lines, coordinates on/off, and theme.
- Saved Boards modal using localStorage: create, rename, load, delete positions.
- No login or paywall. All implemented local features should be available.
- Add a small footer note: "For analysis and training. Do not use engine assistance in live rated games."

Brand/design:
- Header brand text: "travis.suda"
- Original modern chess aesthetic, not a pixel-perfect clone. Clean off-white/light theme by default, dark mode optional.
- Green/cream chessboard palette reminiscent of traditional analysis boards but use original styling.
- Crisp cards, subtle borders/shadows, responsive spacing, accessible controls.
- Use shadcn/ui + Tailwind.
- Make it feel production-ready with tasteful microinteractions and loading states.

Technical:
- Full-stack TypeScript project, but keep analysis local/client-side unless needed.
- Use a reliable chess rules library such as chess.js for legal move/FEN/PGN handling.
- Prefer a robust React chessboard component or implement the board cleanly.
- Ensure illegal moves can be rejected in play mode, while a setup/edit mode allows arbitrary board construction.
- Include keyboard accessibility where practical.
- Do not use Next Chess Move trademarks except in source-code comments explaining inspiration, and do not copy text from their site.

Deliver a complete functional first version, not just a static mockup.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://sudafishy.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/9662ef0b-e317-417d-b6d1-5702d0fd9e61).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

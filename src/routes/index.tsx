import { createFileRoute } from "@tanstack/react-router";
import { ChessAnalyzer } from "@/components/chess/ChessAnalyzer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "travis.suda — Chess position analyzer" },
      {
        name: "description",
        content: "Set up any chess position, import a PGN, and get the best next move from Sudafish running in your browser.",
      },
      { property: "og:title", content: "travis.suda — Chess position analyzer" },
      { property: "og:description", content: "Set up any position and find the best next move with in-browser Sudafish." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ChessAnalyzer,
});

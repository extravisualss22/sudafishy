import { createFileRoute } from "@tanstack/react-router";
import { Spectator } from "@/components/chess/Spectator";

export const Route = createFileRoute("/spectator")({
  head: () => ({ meta: [{ title: "sudalol · simulation laboratory" }, { name: "description", content: "Watch independent sudalol gen0 simulations and inspect real session telemetry." }] }),
  component: Spectator,
});

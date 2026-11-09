import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

export const generationRoot = fileURLToPath(new URL("../src/lib/sudalol/generations/", import.meta.url));
export interface Manifest {
  id: string;
  name: string;
  kind: "handcrafted" | "neural";
  rules: string;
  files: Record<string, string>;
  parent: string | null;
}
export function generationDirectory(id: string) {
  if (!/^gen\d+$/.test(id)) throw new Error(`Invalid generation: ${id}`);
  if (id === "gen0" || existsSync(join(generationRoot, id))) return join(generationRoot, id);
  return resolve(process.env["SUDALOL_DATA"] ?? "training-data", "generations", id);
}
export async function verifyGeneration(id: string): Promise<{ manifest: Manifest; fingerprint: string }> {
  if (!/^gen\d+$/.test(id)) throw new Error(`Invalid generation: ${id}`);
  const directory = generationDirectory(id);
  const raw = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest: Manifest = JSON.parse(raw);
  if (manifest.id !== id || manifest.rules !== "chess.js@1.4.0") throw new Error(`Invalid generation manifest: ${id}`);
  const files = manifest.kind === "neural" ? Object.keys(manifest.files) : ["engine.ts", "evaluation.ts"];
  if (manifest.kind === "neural" && ["engine.ts", "search.ts", "evaluation.ts", "model.ts", "encoder.ts", "types.ts", "model.json", "checkpoint.pt"].some((name) => !manifest.files[name])) throw new Error("Incomplete neural generation");
  for (const file of files) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(file)) throw new Error("Invalid generation file path");
    // Canonical LF makes fingerprints identical on Windows and Unix checkouts.
    const content = file.endsWith(".pt") ? await readFile(join(directory, file)) : (await readFile(join(directory, file), "utf8")).replace(/\r\n/g, "\n");
    if (createHash("sha256").update(content).digest("hex") !== manifest.files[file]) throw new Error(`${id}/${file} changed: preserve old generations and create a new one`);
  }
  return { manifest, fingerprint: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
}

/** Explicit archival operation only; never trains or promotes a generation. */
export async function archiveGeneration(source: string, destination: string) {
  if (!/^gen\d+$/.test(destination)) throw new Error("Generation IDs must be gen followed by digits");
  const { manifest } = await verifyGeneration(source);
  if (manifest.kind !== "handcrafted") throw new Error("Neural generations are created by the training pipeline");
  const target = join(generationRoot, destination);
  await mkdir(target); // EEXIST is intentional: never overwrite a checkpoint.
  for (const file of ["engine.ts", "evaluation.ts"]) await copyFile(join(generationRoot, source, file), join(target, file), constants.COPYFILE_EXCL);
  await writeFile(join(target, "manifest.json"), JSON.stringify({ ...manifest, id: destination, name: `sudalol ${destination}`, parent: source }, null, 2) + "\n", { flag: "wx" });
}

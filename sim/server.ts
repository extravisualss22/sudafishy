import { createServer } from "node:http";
import type { RunSnapshot } from "../src/lib/sudalol/types.ts";

/** Read-only, loopback-only observation API. No start/stop or command endpoints. */
export async function startObservationServer(read: () => RunSnapshot | null, port = 8787, readTraining?: () => unknown) {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json");
    const host = request.headers.host?.split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") { response.writeHead(403).end('{"error":"Local access only"}'); return; }
    if (request.method !== "GET" || (request.url !== "/snapshot" && (request.url !== "/training" || !readTraining))) { response.writeHead(404).end('{"error":"Not found"}'); return; }
    const value = request.url === "/training" ? readTraining?.() : read();
    response.writeHead(value ? 200 : 503).end(JSON.stringify(value ?? { error: "Simulation is starting" }));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}

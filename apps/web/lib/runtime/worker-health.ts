import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { knowledgeDb } from "@/lib/knowledge/db";
import type { ProcessRole } from "./process-contracts";

type WorkerRole = Exclude<ProcessRole, "web">;

export async function resolveWorkerBuildId() {
  const configured = process.env.KESTREL_BUILD_ID?.trim();
  const value = configured || (await readFile("/workspace/.kestrel-build-id", "utf8")).trim();
  if (!/^production-[1-9][0-9]*-[1-9][0-9]*$/u.test(value)) {
    throw new Error("Worker build ID is invalid.");
  }
  return value;
}

export async function assertWorkerDatabaseReady() {
  await knowledgeDb.execute(sql`SELECT 1 AS ready`);
}

export async function startWorkerHealthServer(input: {
  role: WorkerRole;
  buildId: string;
  port?: number;
}) {
  let ready = false;
  let closing = false;
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    if (!(ready && !closing)) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        role: input.role,
        buildId: input.buildId,
      }),
    );
  });
  const port = input.port ?? Number(process.env.KESTREL_WORKER_HEALTH_PORT ?? "8081");
  if (!(Number.isInteger(port) && port >= 0 && port <= 65_535)) {
    throw new Error("KESTREL_WORKER_HEALTH_PORT must be a valid TCP port.");
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!(address && typeof address === "object")) {
    throw new Error("Worker health server did not bind a TCP address.");
  }
  return {
    port: address.port,
    markReady() {
      ready = true;
    },
    markUnhealthy() {
      ready = false;
      closing = true;
    },
    async close() {
      ready = false;
      closing = true;
      await closeServer(server);
    },
  };
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

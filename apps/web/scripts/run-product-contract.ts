import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_PORT_MIN = 20_000;
const PRODUCT_PORT_MAX = 29_999;
const PRODUCT_PORT_COUNT = 7;
const MAX_ALLOCATION_ATTEMPTS = 100;

export interface ProductContractPorts {
  app: number;
  fakeOpenRouter: number;
  postgres: number;
  redis: number;
  minioApi: number;
  minioConsole: number;
  runner: number;
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function allocateProductContractPorts(): Promise<ProductContractPorts> {
  for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
    const firstPort = randomInt(
      PRODUCT_PORT_MIN,
      PRODUCT_PORT_MAX - PRODUCT_PORT_COUNT + 2
    );
    const servers: net.Server[] = [];

    try {
      for (let offset = 0; offset < PRODUCT_PORT_COUNT; offset += 1) {
        const server = net.createServer();
        await listen(server, firstPort + offset);
        servers.push(server);
      }

      await Promise.all(servers.map(close));
      return {
        app: firstPort,
        fakeOpenRouter: firstPort + 1,
        postgres: firstPort + 2,
        redis: firstPort + 3,
        minioApi: firstPort + 4,
        minioConsole: firstPort + 5,
        runner: firstPort + 6,
      };
    } catch {
      await Promise.all(
        servers.filter((server) => server.listening).map(close)
      );
    }
  }

  throw new Error("Unable to allocate ports for the product contract suite.");
}

async function runProductContract(): Promise<number> {
  const ports = await allocateProductContractPorts();
  const runId = `${String(process.pid)}-${String(Date.now())}`;
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(
    "pnpm",
    ["exec", "playwright", "test", "--config", "playwright.product.config.ts"],
    {
      cwd: webRoot,
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: `kestrel-one-product-contract-${runId}`,
        KESTREL_PRODUCT_APP_PORT: String(ports.app),
        KESTREL_PRODUCT_FAKE_OPENROUTER_PORT: String(ports.fakeOpenRouter),
        KESTREL_PRODUCT_POSTGRES_PORT: String(ports.postgres),
        KESTREL_PRODUCT_REDIS_PORT: String(ports.redis),
        KESTREL_PRODUCT_MINIO_API_PORT: String(ports.minioApi),
        KESTREL_PRODUCT_MINIO_CONSOLE_PORT: String(ports.minioConsole),
        KESTREL_PRODUCT_RUNNER_PORT: String(ports.runner),
        KESTREL_PRODUCT_WORKER_READY_FILE: `/tmp/kestrel-one-product-contract-${runId}.ready`,
      },
      stdio: "inherit",
    }
  );

  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Product contract suite exited from signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;

if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runProductContract();
}

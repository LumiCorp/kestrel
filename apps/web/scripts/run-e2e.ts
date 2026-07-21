import { execFile, spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateProductContractPorts } from "./run-product-contract.js";

const execFileAsync = promisify(execFile);

async function runE2e(): Promise<number> {
  const ports = await allocateProductContractPorts();
  const runId = `${String(process.pid)}-${String(Date.now())}`;
  const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PLAYWRIGHT: "True",
    PLAYWRIGHT_PORT: String(ports.app),
    COMPOSE_PROJECT_NAME: `kestrel-one-e2e-${runId}`,
    KESTREL_DISABLE_DOTENV: "1",
    KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID: "e2e-v1",
    KESTREL_GATEWAY_CREDENTIAL_KEYS:
      '{"e2e-v1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}',
    KESTREL_ONE_CREDENTIAL_BROKER_TOKEN: "e2e-credential-broker",
    LOCAL_POSTGRES_PORT: String(ports.postgres),
    LOCAL_REDIS_PORT: String(ports.redis),
    LOCAL_MINIO_API_PORT: String(ports.minioApi),
    LOCAL_MINIO_CONSOLE_PORT: String(ports.minioConsole),
    DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${String(ports.postgres)}/better_auth`,
    POSTGRES_URL: `postgresql://postgres:postgres@127.0.0.1:${String(ports.postgres)}/better_auth`,
    REDIS_URL: `redis://127.0.0.1:${String(ports.redis)}`,
    STORAGE_ACCESS_KEY_ID: "minioadmin",
    STORAGE_BUCKET: "unified-app-storage",
    STORAGE_ENDPOINT: `http://127.0.0.1:${String(ports.minioApi)}`,
    STORAGE_FORCE_PATH_STYLE: "true",
    STORAGE_PROVIDER: "local-s3",
    STORAGE_REGION: "us-east-1",
    STORAGE_SECRET_ACCESS_KEY: "minioadmin",
    KESTREL_RUNNER_SERVICE_PORT: String(ports.runner),
    KESTREL_SKIP_RAG_FIXTURES: "true",
  };
  const child = spawn(
    "pnpm",
    ["exec", "playwright", "test", ...process.argv.slice(2)],
    {
      cwd: webRoot,
      env: environment,
      stdio: "inherit",
    },
  );

  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`Playwright suite exited from signal ${signal}.`));
          return;
        }
        resolve(code ?? 1);
      });
    });
  } finally {
    try {
      await execFileAsync(
        "docker",
        ["compose", "down", "--volumes", "--remove-orphans"],
        { cwd: webRoot, env: environment },
      );
    } finally {
      await rm(path.join(webRoot, ".next", "dev", "lock"), { force: true });
    }
  }
}

process.exitCode = await runE2e();

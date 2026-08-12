import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import postgres from "postgres";
import {
  LEGACY_RELEASE_CONTROLLER_QUEUES,
  RELEASE_CONTROLLER_CONTRACT_REVISION,
} from "@/lib/releases/controller-contract";
import { restoreControlWorkerMachine } from "./control-worker-machine";

const app = "kestrel-one-control-worker";
const vercelProject = "one";
const vercelScope = "lumi-kestrel";
const repositoryRoot = resolve(import.meta.dirname, "../../..");

export const CONTROL_WORKER_SECRET_ALLOWLIST = [
  "CRON_SECRET",
  "DATABASE_URL",
  "POSTGRES_URL",
  "FLY_API_TOKEN",
  "KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID",
  "KESTREL_APP_CREDENTIAL_KEYS",
  "KESTREL_ENVIRONMENTS_ENABLED",
  "KESTREL_ENVIRONMENT_DEFAULT_REGION",
  "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
  "KESTREL_FLY_ORGANIZATION_SLUG",
  "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
  "KESTREL_GATEWAY_CREDENTIAL_KEYS",
  "KESTREL_ONE_APP_URL",
  "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
  "KESTREL_ONE_PROFILE_ID",
  "KESTREL_ONE_TOOL_TOKEN",
  "KESTREL_PREVIEW_EDGE_PUBLIC_ORIGIN",
  "KESTREL_PREVIEW_EDGE_SERVICE_TOKEN",
  "KESTREL_PREVIEW_HOST_SUFFIX",
  "KESTREL_WORKSPACE_BACKUP_KEY",
  "KESTREL_WORKSPACE_BACKUP_KEY_ID",
  "KESTREL_WORKSPACE_RUNTIME_IMAGE",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_BUCKET",
  "STORAGE_ENDPOINT",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_KEY_PREFIX",
  "STORAGE_PROVIDER",
  "STORAGE_REGION",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

const REQUIRED_CONTROL_WORKER_SECRETS = [
  "CRON_SECRET",
  "FLY_API_TOKEN",
  "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
  "KESTREL_FLY_ORGANIZATION_SLUG",
  "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
  "KESTREL_GATEWAY_CREDENTIAL_KEYS",
  "KESTREL_ONE_APP_URL",
  "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
  "KESTREL_ONE_TOOL_TOKEN",
  "KESTREL_WORKSPACE_BACKUP_KEY",
  "KESTREL_WORKSPACE_BACKUP_KEY_ID",
  "KESTREL_WORKSPACE_RUNTIME_IMAGE",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_BUCKET",
  "STORAGE_ENDPOINT",
  "STORAGE_PROVIDER",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

function run(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; quiet?: boolean } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    input: options.input,
    stdio: options.quiet ? ["pipe", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed${
        options.quiet && result.stderr ? `: ${result.stderr.trim()}` : ""
      }`,
    );
  }
  return result.stdout ?? "";
}

function currentRevision() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  if (dirty)
    throw new Error("Control worker release requires a clean worktree.");
  return revision;
}

export function selectControlWorkerSecrets(source: Record<string, string>) {
  const selected = new Map<string, string>();
  for (const key of CONTROL_WORKER_SECRET_ALLOWLIST) {
    const value = source[key]?.trim();
    if (value) selected.set(key, value);
  }
  const missing: string[] = REQUIRED_CONTROL_WORKER_SECRETS.filter(
    (key) => !selected.has(key),
  );
  if (!(selected.has("DATABASE_URL") || selected.has("POSTGRES_URL"))) {
    missing.unshift("DATABASE_URL or POSTGRES_URL");
  }
  if (missing.length > 0) {
    throw new Error(
      `Vercel production is missing control worker secrets: ${missing.join(", ")}.`,
    );
  }
  return selected;
}

async function assertLegacyQueuesIdle(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const queues = Object.values(LEGACY_RELEASE_CONTROLLER_QUEUES);
    const rows = await sql<
      Array<{ name: string; state: string; count: number }>
    >`
      SELECT name, state, count(*)::int AS count
      FROM pgboss.job
      WHERE name = ANY(${queues}) AND state IN ('active', 'created', 'retry')
      GROUP BY name, state
      ORDER BY name, state
    `;
    if (rows.length > 0) {
      throw new Error(
        `Legacy lifecycle queues are not idle: ${rows
          .map((row) => `${row.name}:${row.state}=${row.count}`)
          .join(", ")}.`,
      );
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
}

async function ensureApp(organizationSlug: string) {
  const status = spawnSync("fly", ["status", "--app", app, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (status.status === 0) return;
  run("fly", ["apps", "create", app, "--org", organizationSlug]);
}

async function verifyHeartbeat(databaseUrl: string) {
  const deadline = Date.now() + 90_000;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    while (Date.now() < deadline) {
      const [heartbeat] = await sql<
        Array<{ contractRevision: number; ageSeconds: number }>
      >`
        SELECT
          contract_revision AS "contractRevision",
          EXTRACT(EPOCH FROM (now() - heartbeat_at))::float8 AS "ageSeconds"
        FROM release_controller_heartbeats
        WHERE id = 'platform'
      `;
      if (
        heartbeat?.contractRevision === RELEASE_CONTROLLER_CONTRACT_REVISION &&
        heartbeat.ageSeconds < 90
      ) {
        return;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
    }
  } finally {
    await sql.end({ timeout: 0 });
  }
  throw new Error("Release controller heartbeat did not become healthy.");
}

async function main() {
  const revision = currentRevision();
  const directory = await mkdtemp(join(tmpdir(), "kestrel-control-worker-"));
  const envFile = join(directory, "production.env");
  try {
    run(
      "vercel",
      [
        "link",
        "--cwd",
        directory,
        "--project",
        vercelProject,
        "--scope",
        vercelScope,
        "--yes",
      ],
      { quiet: true },
    );
    run(
      "vercel",
      [
        "env",
        "pull",
        envFile,
        "--environment=production",
        "--cwd",
        directory,
        "--yes",
      ],
      { quiet: true },
    );
    const parsed = dotenv.parse(await readFile(envFile, "utf8"));
    const secrets = selectControlWorkerSecrets(parsed);
    const databaseUrl =
      parsed.POSTGRES_URL_NON_POOLING?.trim() ||
      parsed.DATABASE_URL_UNPOOLED?.trim() ||
      parsed.POSTGRES_URL?.trim() ||
      parsed.DATABASE_URL?.trim();
    if (!databaseUrl)
      throw new Error("Production database URL is unavailable.");
    await assertLegacyQueuesIdle(databaseUrl);
    await ensureApp(secrets.get("KESTREL_FLY_ORGANIZATION_SLUG")!);
    const secretInput = [...secrets]
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    run("fly", ["secrets", "import", "--app", app], {
      input: `${secretInput}\n`,
      quiet: true,
    });
    run("fly", [
      "deploy",
      ".",
      "--app",
      app,
      "--config",
      "deploy/fly/kestrel-one-control-worker/fly.toml",
      "--dockerfile",
      "deploy/fly/kestrel-one-control-worker/Dockerfile",
      "--remote-only",
      "--build-arg",
      `KESTREL_GIT_SHA=${revision}`,
    ]);
    await restoreControlWorkerMachine({
      app,
      expectedRevision: revision,
      flyCommand: "fly",
      accessToken: secrets.get("FLY_API_TOKEN")!,
    });
    run("fly", [
      "ssh",
      "console",
      "--app",
      app,
      "--command",
      `grep -q release-controller-v${RELEASE_CONTROLLER_CONTRACT_REVISION} /tmp/kestrel-control-worker-ready`,
    ]);
    await verifyHeartbeat(databaseUrl);
    process.stdout.write(
      `Control worker release passed for ${revision} (release-controller-v${RELEASE_CONTROLLER_CONTRACT_REVISION}).\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Control worker release failed."}\n`,
    );
    process.exitCode = 1;
  });
}

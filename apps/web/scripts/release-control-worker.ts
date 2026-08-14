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
import { buildControlWorkerArtifact } from "./control-worker-artifact";
import { restoreControlWorkerMachine } from "./control-worker-machine";
import { publishControlWorkerImage } from "./deploy-control-worker-candidate";
import { assertControlWorkerProcessConfiguration } from "../lib/runtime/process-contracts";

const app = "kestrel-one-control-worker";
const vercelProject = "one";
const vercelScope = "lumi-kestrel";
const repositoryRoot = resolve(import.meta.dirname, "../../..");

export const CONTROL_WORKER_SECRET_ALLOWLIST = [
  "CRON_SECRET",
  "DATABASE_URL",
  "POSTGRES_URL",
  "KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID",
  "KESTREL_APP_CREDENTIAL_KEYS",
  "KESTREL_ENVIRONMENTS_ENABLED",
  "KESTREL_ENVIRONMENT_DEFAULT_REGION",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
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
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
  "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
  "KESTREL_GATEWAY_CREDENTIAL_KEYS",
  "KESTREL_ONE_APP_URL",
  "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
  "KESTREL_ONE_TOOL_TOKEN",
  "KESTREL_WORKSPACE_BACKUP_KEY",
  "KESTREL_WORKSPACE_BACKUP_KEY_ID",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_BUCKET",
  "STORAGE_ENDPOINT",
  "STORAGE_PROVIDER",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

const PRESERVED_PLATFORM_FLY_SECRET_NAMES = [
  "FLY_API_TOKEN",
  "KESTREL_FLY_ORGANIZATION_SLUG",
] as const;

export const CONTROL_WORKER_KNOWN_REMOVALS = [
  "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
  "KESTREL_WORKSPACE_RUNTIME_IMAGE",
] as const;

function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    input?: string;
    quiet?: boolean;
  } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.environment ?? process.env,
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
  assertControlWorkerProcessConfiguration({
    ...Object.fromEntries(selected),
    FLY_API_TOKEN: "preserved-on-control-worker",
    KESTREL_FLY_ORGANIZATION_SLUG: "preserved-on-control-worker",
  });
  return selected;
}

export function controlWorkerSecretSetArgs(secrets: Map<string, string>) {
  return [
    "secrets",
    "set",
    "--stage",
    "--app",
    app,
    ...[...secrets].map(([key, value]) => `${key}=${value}`),
  ];
}

export function controlWorkerSecretRemovalNames(secretListJson: string) {
  const rows = JSON.parse(secretListJson) as Array<Record<string, unknown>>;
  const names = new Set(
    rows
      .map((row) => row.Name ?? row.name)
      .filter((name): name is string => typeof name === "string"),
  );
  return CONTROL_WORKER_KNOWN_REMOVALS.filter((name) => names.has(name));
}

export function assertPreservedPlatformFlyAuthority(secretListJson: string) {
  const rows = JSON.parse(secretListJson) as Array<Record<string, unknown>>;
  const names = new Set(
    rows
      .map((row) => row.Name ?? row.name)
      .filter((name): name is string => typeof name === "string"),
  );
  const missing = PRESERVED_PLATFORM_FLY_SECRET_NAMES.filter(
    (name) => !names.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `The control-worker Fly app is missing preserved platform authority: ${missing.join(", ")}. Configure it directly on the control-worker app before release.`,
    );
  }
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
    const operatorOrganization = process.env.KESTREL_FLY_ORGANIZATION_SLUG?.trim();
    const appStatus = spawnSync("fly", ["status", "--app", app, "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (appStatus.status !== 0) {
      if (!operatorOrganization) {
        throw new Error(
          "Creating the control-worker app requires operator KESTREL_FLY_ORGANIZATION_SLUG configuration.",
        );
      }
      await ensureApp(operatorOrganization);
    }
    const existingSecrets = run(
      "fly",
      ["secrets", "list", "--app", app, "--json"],
      { quiet: true },
    );
    assertPreservedPlatformFlyAuthority(existingSecrets);
    run("fly", controlWorkerSecretSetArgs(secrets), { quiet: true });
    const removals = controlWorkerSecretRemovalNames(existingSecrets);
    if (removals.length) {
      run(
        "fly",
        ["secrets", "unset", "--stage", "--app", app, ...removals],
        { quiet: true },
      );
    }
    run("fly", ["auth", "docker"]);
    run("pnpm", ["run", "build:shared"]);
    const artifact = await buildControlWorkerArtifact();
    try {
      const published = await publishControlWorkerImage({
        appName: app,
        artifact,
        flyCommand: "fly",
        revision,
        dependencies: {
          capture: async (command, args) =>
            run(command, args, { quiet: true }).trimEnd(),
          run: async (command, args, environment) => {
            run(command, args, { environment });
          },
          wait: (milliseconds) =>
            new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
        },
      });
      run("fly", [
        "deploy",
        ".",
        "--app",
        app,
        "--config",
        "deploy/fly/kestrel-one-control-worker/fly.toml",
        "--image",
        published.taggedImage,
        "--remote-only",
      ]);
    } finally {
      await artifact.dispose();
    }
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

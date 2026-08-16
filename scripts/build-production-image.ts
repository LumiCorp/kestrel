import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { flyImageCatalogSchema } from "./production-image-contract.js";

const READINESS_TIMEOUT_MS = 15 * 60 * 1000;
const READINESS_POLL_INTERVAL_MS = 5000;
const READINESS_REQUEST_TIMEOUT_MS = 15_000;
const TRANSIENT_READINESS_STATUSES = new Set([404, 502, 503, 504]);

type NotifyOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  readinessPollIntervalMs?: number;
  readinessTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

async function main() {
  const role = process.argv[2];
  const runNumber = requireEnv("GITHUB_RUN_NUMBER");
  const runAttempt = requireEnv("GITHUB_RUN_ATTEMPT");
  if (
    !(/^[1-9][0-9]*$/u.test(runNumber) && /^[1-9][0-9]*$/u.test(runAttempt))
  ) {
    throw new Error("GitHub run number and attempt must be positive integers.");
  }
  const buildId = `production-${runNumber}-${runAttempt}`;
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(await readFile("deploy/fly/image-catalog.json", "utf8")),
  );
  const image = catalog.images.find((candidate) => candidate.role === role);
  if (!image)
    throw new Error(`Unknown production image role: ${role ?? "missing"}.`);
  const taggedImage = `${image.repository}:${buildId}`;
  run("docker", [
    "build",
    "--load",
    "--file",
    image.dockerfile,
    "--tag",
    taggedImage,
    "--build-arg",
    `KESTREL_BUILD_ID=${buildId}`,
    ".",
  ]);
  run("bash", [image.smoke, taggedImage]);
  run("docker", ["push", taggedImage]);
  if (image.channel !== "environment-runtime") {
    await notifyKestrel({
      kind: "platform",
      role: image.role,
      image: taggedImage,
    });
  }
  process.stdout.write(`Published ${image.role} as ${taggedImage}.\n`);
}

export async function notifyKestrel(
  payload: unknown,
  options: NotifyOptions = {},
) {
  const baseUrl = requireEnv("KESTREL_ONE_PRODUCTION_URL").replace(/\/+$/u, "");
  const token = requireEnv("PRODUCTION_IMAGE_DEPLOY_TOKEN");
  const endpoint = `${baseUrl}/api/internal/production-images`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const requiredMigration = await latestProductionMigration();
  await waitForKestrelProductionReceiver({
    endpoint,
    token,
    kind: notificationKind(payload),
    requiredMigration,
    fetchImpl,
    now: options.now,
    pollIntervalMs: options.readinessPollIntervalMs,
    sleep: options.sleep,
    timeoutMs: options.readinessTimeoutMs,
  });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(810_000),
  });
  if (!response.ok) {
    throw new Error(`Kestrel returned HTTP ${response.status}.`);
  }
}

export async function waitForKestrelProductionReceiver(input: {
  endpoint: string;
  token: string;
  kind: "platform" | "environment-runtime";
  requiredMigration: string;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
  pollIntervalMs?: number | undefined;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  timeoutMs?: number | undefined;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const pollIntervalMs =
    input.pollIntervalMs ?? READINESS_POLL_INTERVAL_MS;
  const sleep = input.sleep ?? wait;
  const deadline = now() + (input.timeoutMs ?? READINESS_TIMEOUT_MS);
  const readinessUrl = new URL(input.endpoint);
  readinessUrl.searchParams.set("kind", input.kind);
  readinessUrl.searchParams.set("requiredMigration", input.requiredMigration);

  while (now() < deadline) {
    let status: number | null = null;
    try {
      const response = await fetchImpl(readinessUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(
          Math.min(READINESS_REQUEST_TIMEOUT_MS, Math.max(1, deadline - now())),
        ),
      });
      status = response.status;
      if (response.ok) {
        const readiness = (await response.json().catch(() => null)) as {
          migration?: unknown;
        } | null;
        if (readiness?.migration === input.requiredMigration) return;
        status = 503;
      }
    } catch {
      status = null;
    }

    if (status !== null && !TRANSIENT_READINESS_STATUSES.has(status)) {
      throw new Error(
        `Kestrel production receiver readiness returned HTTP ${status}.`,
      );
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  throw new Error("Kestrel production receiver was not ready within 15 minutes.");
}

async function latestProductionMigration() {
  const journal = JSON.parse(
    await readFile(
      "apps/web/lib/db/migrations/meta/_journal.json",
      "utf8",
    ),
  ) as { entries?: Array<{ tag?: unknown }> };
  const tag = journal.entries?.at(-1)?.tag;
  if (typeof tag !== "string" || !/^[0-9]{4}_[a-z0-9_]+$/u.test(tag)) {
    throw new Error("The production migration journal has no valid head.");
  }
  return tag;
}

function notificationKind(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "kind" in payload &&
    (payload.kind === "platform" || payload.kind === "environment-runtime")
  ) {
    return payload.kind;
  }
  throw new Error("Production image notification kind is invalid.");
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args[0] ?? ""} failed.`);
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

if (process.argv[1]?.endsWith("build-production-image.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Production image build failed."}\n`,
    );
    process.exit(1);
  });
}

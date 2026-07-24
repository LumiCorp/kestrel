import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import dotenv from "dotenv";
import {
  assertGatewayKeyringParity,
  summarizeGatewayKeyring,
  type GatewayKeyringSummary,
} from "@/lib/ai/gateway-keyring-parity";

const app =
  process.env.KESTREL_TURN_WORKER_APP?.trim() || "kestrel-one-turn-worker";
const mode = process.argv.includes("--verify") ? "verify" : "sync";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function readSource(path: string): {
  activeKeyId: string;
  keys: string;
  summary: GatewayKeyringSummary;
} {
  const parsed = dotenv.config({ path, quiet: true }).parsed ?? {};
  const activeKeyId = parsed.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID?.trim();
  const keys = parsed.KESTREL_GATEWAY_CREDENTIAL_KEYS?.trim();
  if (!(activeKeyId && keys))
    throw new Error("Vercel production keyring is incomplete.");
  return {
    activeKeyId,
    keys,
    summary: summarizeGatewayKeyring({ activeKeyId, keys }),
  };
}

function readWorkerSummary() {
  const script =
    "const c=require('node:crypto');const raw=process.env.KESTREL_GATEWAY_CREDENTIAL_KEYS||'';console.log(JSON.stringify({activeKeyId:process.env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID,configuredKeyIds:Object.keys(JSON.parse(raw)).sort(),keyringFingerprint:c.createHash('sha256').update(raw).digest('hex')}))";
  const output = run("fly", [
    "ssh",
    "console",
    "--app",
    app,
    "--command",
    `node -e ${JSON.stringify(script)}`,
  ]);
  const line = output.trim().split("\n").at(-1);
  if (!line)
    throw new Error("Fly worker keyring verification returned no result.");
  return JSON.parse(line) as GatewayKeyringSummary;
}

async function main() {
  const directory = await mkdtemp(
    join(tmpdir(), `kestrel-keyring-${randomUUID()}-`),
  );
  const envFile = join(directory, "production.env");
  try {
    run("vercel", [
      "env",
      "pull",
      envFile,
      "--environment=production",
      "--yes",
    ]);
    const source = readSource(envFile);
    if (mode === "sync") {
      run("fly", [
        "secrets",
        "set",
        `KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID=${source.activeKeyId}`,
        `KESTREL_GATEWAY_CREDENTIAL_KEYS=${source.keys}`,
        "--app",
        app,
      ]);
    }
    const worker = readWorkerSummary();
    assertGatewayKeyringParity({ canonical: source.summary, worker });
    process.stdout.write(
      `Kestrel One worker keyring ${mode} passed: ${source.summary.keyringFingerprint}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Keyring synchronization failed."}\n`,
  );
  process.exitCode = 1;
});

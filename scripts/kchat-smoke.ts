import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createConfiguredCliProtocolClient } from "../cli/client/configuredClient.js";
import { ensureCliLocalCoreReady } from "../cli/localCoreShell.js";

async function main(): Promise<void> {
  const configuredHome = process.env.KESTREL_KCHAT_SMOKE_HOME?.trim();
  const explicitHome = configuredHome !== undefined && configuredHome.length > 0
    ? configuredHome
    : undefined;
  const ownsHome = explicitHome === undefined;
  const home = explicitHome ?? await mkdtemp(path.join(os.tmpdir(), "kestrel-kchat-smoke-"));
  process.env.KESTREL_CORE_HOME = home;
  process.env.KESTREL_HOME = home;
  process.env.KESTREL_CORE_IDLE_TIMEOUT_MS = "500";
  process.env.KESTREL_DISABLE_DOTENV = "1";
  process.env.DATABASE_URL = "";
  delete process.env.KESTREL_DATABASE_URL_SOURCE;
  delete process.env.KESTREL_LOCAL_CORE_API_SOCKET;
  delete process.env.KESTREL_LOCAL_CORE_API_TOKEN;

  let socketPath: string | undefined;
  let client: ReturnType<typeof createConfiguredCliProtocolClient> | undefined;
  try {
    const status = await ensureCliLocalCoreReady();
    socketPath = status.lock.state === "live" ? status.lock.lock.socketPath : undefined;
    client = createConfiguredCliProtocolClient();
    const pong = await client.sendCommand("runner.ping", { nonce: "kchat-smoke" });
    if (pong.type !== "runner.pong" || pong.payload.nonce !== "kchat-smoke") {
      throw new Error("runner.ping did not round-trip");
    }

    const described = await client.sendCommand("session.describe", {
      sessionId: "smoke-session",
    });
    if (described.type !== "session.described" || described.payload.sessionId !== "smoke-session") {
      throw new Error("session.describe did not return expected session");
    }

    process.stdout.write("kchat smoke: protocol ok\n");
  } finally {
    await client?.close();
    if (ownsHome) {
      if (socketPath !== undefined) {
        await waitForPathRemoval(socketPath, 5000);
      }
      await rm(home, { recursive: true, force: true });
    }
  }
}

async function waitForPathRemoval(targetPath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (existsSync(targetPath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Local Core did not stop after kchat smoke: ${targetPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

void main().catch((error) => {
  process.stderr.write(`kchat smoke failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

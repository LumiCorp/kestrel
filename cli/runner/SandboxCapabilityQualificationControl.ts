import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type {
  SandboxCapabilityQualificationObserver,
  SandboxCapabilityQualificationCheckpoint,
} from "../../src/code/contracts.js";

const CHECKPOINTS = new Set<SandboxCapabilityQualificationCheckpoint>([
  "lease_issued",
  "before_provider_invocation",
  "provider_response_received",
  "provider_result_committed",
  "before_exact_result_persistence",
  "exact_result_persisted",
  "before_lease_cleanup",
  "lease_cleanup_completed",
]);

export async function createSandboxCapabilityQualificationObserver(input: {
  controlDir: string;
  token: string;
}): Promise<SandboxCapabilityQualificationObserver> {
  if (input.token.trim().length < 32) {
    throw new Error("Qualification control token must contain at least 32 characters.");
  }
  const controlDir = path.resolve(input.controlDir);
  await mkdir(controlDir, { recursive: true, mode: 0o700 });
  await chmod(controlDir, 0o700);
  const details = await stat(controlDir);
  if (!details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new Error("Qualification control directory must be a private directory.");
  }

  return {
    async checkpoint(event) {
      if (!CHECKPOINTS.has(event.checkpoint)) {
        throw new Error("Unknown sandbox capability qualification checkpoint.");
      }
      const actionId = createHash("sha256")
        .update(`${event.runId}\0${event.toolCallId}\0${event.leaseId}`)
        .digest("hex");
      const prefix = path.join(controlDir, `${actionId}.${event.checkpoint}`);
      const globalPrefix = path.join(controlDir, event.checkpoint);
      const pause = await readFile(`${prefix}.pause`, "utf8").catch(async () =>
        await readFile(`${globalPrefix}.pause`, "utf8").catch(() => undefined));
      const barrierNonce = pause === undefined ? undefined : parseControlFile(pause, input.token);
      await appendFile(
        path.join(controlDir, "events.ndjson"),
        `${JSON.stringify({ ...event, actionId, ...(barrierNonce === undefined ? {} : { barrierNonce }), observedAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (barrierNonce === undefined) return;

      const signal = AbortSignal.timeout(120_000);
      while (!signal.aborted) {
        const release = await readFile(`${prefix}.release`, "utf8").catch(async () =>
          await readFile(`${globalPrefix}.release`, "utf8").catch(() => undefined));
        if (release !== undefined && parseControlFile(release, input.token) === barrierNonce) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Qualification checkpoint '${event.checkpoint}' was not released.`);
    },
  };
}

function parseControlFile(value: string, expectedToken: string): string | undefined {
  const [candidateToken, nonce, ...extra] = value.trim().split("\n");
  if (extra.length > 0 || candidateToken === undefined || nonce === undefined || !tokenMatches(candidateToken, expectedToken)) return undefined;
  return /^[a-f0-9-]{36}$/u.test(nonce) ? nonce : undefined;
}

function tokenMatches(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

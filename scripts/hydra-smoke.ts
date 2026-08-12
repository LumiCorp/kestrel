import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  HYDRA_SMOKE_VERSION,
  type HydraSmokeEvidenceV1,
  validateHydraSmokeEvidence,
} from "./hydra-smoke-contract.js";
import { runHydraCandidateSmoke } from "./hydra-smoke-candidate.js";
import { runHydraLocalSmoke } from "./hydra-smoke-local.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  assert.equal(
    process.env.KESTREL_HYDRA_SMOKE_APPROVED,
    "1",
    "Set KESTREL_HYDRA_SMOKE_APPROVED=1 for this provider-spending smoke.",
  );
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"]);
  assert.equal(status.trim(), "", "Hydra smoke requires a clean worktree.");
  const sourceSha = await currentSourceSha();
  assert.match(sourceSha, /^[a-f0-9]{40}$/u);
  const startedAt = new Date().toISOString();
  const requestedPhase = process.argv.includes("--local")
    ? "local"
    : process.argv.includes("--candidate")
      ? "candidate"
      : "all";
  const artifactRoot = path.join(process.cwd(), ".artifacts", "hydra", sourceSha);
  await mkdir(artifactRoot, { recursive: true });

  if (requestedPhase === "local") {
    await assertCurrentSourceSha(sourceSha);
    const local = await runHydraLocalSmoke({ sourceSha });
    await writeSanitized(path.join(artifactRoot, "local.json"), {
      version: HYDRA_SMOKE_VERSION,
      sourceSha,
      startedAt,
      completedAt: new Date().toISOString(),
      local,
    });
    assert.equal(local.status, "passed", "Hydra local smoke failed.");
    return;
  }
  if (requestedPhase === "candidate") {
    await assertCurrentSourceSha(sourceSha);
    const candidate = await runHydraCandidateSmoke({ sourceSha });
    await writeSanitized(path.join(artifactRoot, "candidate.json"), {
      version: HYDRA_SMOKE_VERSION,
      sourceSha,
      startedAt,
      completedAt: new Date().toISOString(),
      candidate,
    });
    assert.equal(candidate.status, "passed", "Hydra candidate smoke failed.");
    return;
  }

  await assertCurrentSourceSha(sourceSha);
  const local = await runHydraLocalSmoke({ sourceSha });
  await assertCurrentSourceSha(sourceSha);
  const candidate = await runHydraCandidateSmoke({ sourceSha });
  await assertCurrentSourceSha(sourceSha);
  const evidence: HydraSmokeEvidenceV1 = {
    version: HYDRA_SMOKE_VERSION,
    sourceSha,
    startedAt,
    completedAt: new Date().toISOString(),
    status:
      local.status === "passed" && candidate.status === "passed"
        ? "passed"
        : "failed",
    local,
    candidate,
  };
  validateHydraSmokeEvidence(evidence);
  const evidencePath = path.join(artifactRoot, "evidence.json");
  await writeSanitized(evidencePath, evidence);
  process.stdout.write(`[hydra-smoke] ${evidence.status}: ${evidencePath}\n`);
  assert.equal(evidence.status, "passed", "Hydra smoke failed.");
}

async function currentSourceSha(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  const sourceSha = stdout.trim().toLowerCase();
  assert.match(sourceSha, /^[a-f0-9]{40}$/u);
  return sourceSha;
}

async function assertCurrentSourceSha(expected: string): Promise<void> {
  assert.equal(
    await currentSourceSha(),
    expected,
    "Hydra smoke source revision changed while qualification was running.",
  );
}

async function writeSanitized(filePath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  assert.equal(
    /(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|BEGIN PRIVATE KEY|session_id|nativeSession|credentialFingerprint)/u.test(serialized),
    false,
    "Hydra evidence contains prohibited secret or native correlation material.",
  );
  await writeFile(filePath, serialized, { mode: 0o600 });
}

void main().catch((error) => {
  process.stderr.write(
    `[hydra-smoke] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

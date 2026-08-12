import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { request as playwrightRequest } from "@playwright/test";

import type {
  HydraRuntimeEvidence,
  HydraRuntimeId,
} from "./hydra-smoke-contract.js";

const TURN_TIMEOUT_MS = 180_000;

export async function runHydraCandidateSmoke(input: {
  sourceSha: string;
}): Promise<{
  status: "passed" | "failed";
  origin: string;
  deploymentRevision: string;
  runtimes: HydraRuntimeEvidence[];
}> {
  const origin = requiredEnvironment("KESTREL_HYDRA_CANDIDATE_URL");
  const storageStatePath = requiredEnvironment(
    "KESTREL_HYDRA_CANDIDATE_STORAGE_STATE",
  );
  await readFile(storageStatePath);
  const projectId = requiredEnvironment("KESTREL_HYDRA_CANDIDATE_PROJECT_ID");
  const api = await playwrightRequest.newContext({
    baseURL: origin,
    storageState: storageStatePath,
  });
  let deploymentRevision = "unknown";
  try {
    const health = await api.get("/api/health");
    assert.equal(health.ok(), true, `Candidate health returned ${health.status()}`);
    const healthBody = await health.json() as { revision?: string };
    deploymentRevision = healthBody.revision ?? "unknown";
    assert.equal(deploymentRevision, input.sourceSha, "Candidate revision mismatch");
    const runtimes: HydraRuntimeEvidence[] = [];
    for (const runtimeId of ["codex", "claude"] as const) {
      runtimes.push(
        await runCandidateRuntime(api, runtimeId, projectId),
      );
    }
    return {
      status: runtimes.every((runtime) =>
        runtime.scenarios.length === 5 &&
        runtime.scenarios.every((scenario) => scenario.status === "passed"),
      ) ? "passed" : "failed",
      origin: new URL(origin).origin,
      deploymentRevision,
      runtimes,
    };
  } finally {
    await api.dispose();
  }
}

async function runCandidateRuntime(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  runtimeId: HydraRuntimeId,
  projectId: string,
): Promise<HydraRuntimeEvidence> {
  const modelId = requiredEnvironment(
    runtimeId === "codex" ? "KESTREL_HYDRA_CODEX_MODEL" : "KESTREL_HYDRA_CLAUDE_MODEL",
  );
  const scenarios: HydraRuntimeEvidence["scenarios"] = [];
  const threadId = randomUUID();
  const record = async (id: string, action: () => Promise<void>) => {
    const started = Date.now();
    try {
      await action();
      scenarios.push({ id, status: "passed", durationMs: Date.now() - started });
    } catch (error) {
      scenarios.push({
        id,
        status: "failed",
        durationMs: Date.now() - started,
        failureCode: failureCode(error),
      });
      throw error;
    }
  };
  try {
    await record("descriptor", async () => {
      const response = await api.post("/api/runtimes/describe", {
        data: { runtimeId, modelId, projectId },
      });
      assert.equal(response.ok(), true, await response.text());
      const body = await response.json() as {
        resolution?: { descriptor?: { availability?: string; runtimeId?: string } };
      };
      assert.equal(body.resolution?.descriptor?.availability, "ready");
      assert.equal(body.resolution?.descriptor?.runtimeId, runtimeId);
    });
    await record("fresh-admission", async () => {
      const response = await api.post("/api/threads", {
        data: { id: threadId, projectId, runtimeId },
      });
      assert.equal(response.status(), 201, await response.text());
      const thread = await response.json() as { runtimeId?: string };
      assert.equal(thread.runtimeId, runtimeId);
    });
    const nonce = `HYDRA_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    await record("first-turn", async () => {
      await submitAndAwait(api, threadId, modelId, `Remember ${nonce}. Reply exactly FIRST_OK.`);
    });
    await record("ordinary-resume", async () => {
      const snapshot = await submitAndAwait(
        api,
        threadId,
        modelId,
        `Reply exactly CONTINUITY_OK:${nonce} using the prior marker.`,
      );
      assert.match(JSON.stringify(snapshot), new RegExp(`CONTINUITY_OK:${nonce}`, "u"));
    });
    await record("immutable-runtime", async () => {
      const other = runtimeId === "codex" ? "claude" : "codex";
      const response = await api.post(`/api/threads/${threadId}`, {
        data: {
          runtimeId: other,
          model: modelId,
          message: {
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: "This must be rejected." }],
          },
        },
      });
      assert.equal(response.status(), 409, await response.text());
      const body = await response.json() as { code?: string };
      assert.equal(body.code, "RUNTIME_BINDING_IMMUTABLE");
    });
  } catch {
    // Preserve the sanitized scenario result and continue to cleanup.
  } finally {
    await api.patch(`/api/threads/${threadId}`, { data: { archived: true } }).catch(() => undefined);
    await api.delete(`/api/threads/${threadId}`).catch(() => undefined);
  }
  return { runtimeId, modelId, scenarios };
}

async function submitAndAwait(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  threadId: string,
  modelId: string,
  text: string,
): Promise<unknown> {
  const response = await api.post(`/api/threads/${threadId}/turns`, {
    data: {
      model: modelId,
      interactionMode: "chat",
      message: {
        id: randomUUID(),
        parts: [{ type: "text", text }],
      },
    },
    headers: { "idempotency-key": randomUUID() },
  });
  assert.ok(response.status() === 200 || response.status() === 202, await response.text());
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshotResponse = await api.get(`/api/threads/${threadId}`);
    assert.equal(snapshotResponse.ok(), true, await snapshotResponse.text());
    const snapshot = await snapshotResponse.json() as {
      turns?: Array<{ status?: string }>;
    };
    const latest = snapshot.turns?.at(-1);
    if (latest?.status === "completed") return snapshot;
    if (latest?.status === "failed" || latest?.status === "cancelled") {
      throw Object.assign(new Error(`Candidate Turn ended ${latest.status}.`), {
        code: "HYDRA_CANDIDATE_TURN_FAILED",
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw Object.assign(new Error("Candidate Turn timed out."), {
    code: "HYDRA_SMOKE_TIMEOUT",
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function failureCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)) return error.code;
  return "HYDRA_CANDIDATE_SCENARIO_FAILED";
}

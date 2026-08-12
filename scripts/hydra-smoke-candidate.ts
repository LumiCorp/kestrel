import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { request as playwrightRequest } from "@playwright/test";

import type {
  HydraRuntimeEvidence,
  HydraRuntimeId,
} from "./hydra-smoke-contract.js";
import { continuityPrompt } from "./hydra-smoke-prompts.js";

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
        runtime.scenarios.length === 6 &&
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
  let threadCreated = false;
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
      return false;
    }
    return true;
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
      data: { id: threadId, projectId, runtimeId, modelId },
    });
    assert.equal(response.status(), 201, await response.text());
    const thread = await response.json() as { runtimeId?: string };
    assert.equal(thread.runtimeId, runtimeId);
    threadCreated = true;
  });
    const nonce = `HYDRA_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    await record("first-turn", async () => {
    assert.equal(threadCreated, true, "Fresh Runtime admission did not create a Thread.");
    const snapshot = await submitAndAwait(
      api,
      runtimeId,
      threadId,
      modelId,
      `Remember the exact marker ${nonce}. Reply exactly FIRST_OK.`,
    );
    assert.equal(latestAssistantText(snapshot), "FIRST_OK");
  });
    await record("ordinary-resume", async () => {
    assert.equal(threadCreated, true, "Fresh Runtime admission did not create a Thread.");
    const snapshot = await submitAndAwait(
      api,
      runtimeId,
      threadId,
      modelId,
      continuityPrompt(),
    );
    assert.equal(latestAssistantText(snapshot), `CONTINUITY_OK:${nonce}`);
  });
    await record("immutable-runtime", async () => {
    assert.equal(threadCreated, true, "Fresh Runtime admission did not create a Thread.");
    const other = runtimeId === "codex" ? "claude" : "codex";
    const response = await api.post(`/api/threads/${threadId}/turns`, {
      data: {
        runtimeId: other,
        model: modelId,
        message: {
          id: randomUUID(),
          role: "user",
          parts: [{ type: "text", text: "This must be rejected." }],
        },
      },
      headers: { "idempotency-key": randomUUID() },
    });
    assert.equal(response.status(), 409, await response.text());
    const body = await response.json() as { code?: string };
    assert.equal(body.code, "RUNTIME_BINDING_IMMUTABLE");
  });
  } finally {
    await record("cleanup", async () => {
      if (!threadCreated) return;
      let archiveFailure: Error | undefined;
      const archived = await api.patch(`/api/threads/${threadId}`, {
        data: { archived: true },
      });
      if (!archived.ok()) {
        archiveFailure = new Error(await archived.text());
      }
      // Permanent deletion is attempted even if the archival preparation
      // failed, so cleanup evidence cannot hide an orphaned canary Thread.
      const deleted = await api.delete(`/api/threads/${threadId}`);
      assert.equal(deleted.ok(), true, await deleted.text());
      if (archiveFailure) throw archiveFailure;
    });
  }
  return { runtimeId, modelId, scenarios };
}

async function submitAndAwait(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  runtimeId: HydraRuntimeId,
  threadId: string,
  modelId: string,
  text: string,
): Promise<unknown> {
  const response = await api.post(`/api/threads/${threadId}/turns`, {
    data: {
      model: modelId,
      runtimeId,
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

function latestAssistantText(snapshot: unknown): string {
  assert.ok(typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot));
  const messages = (snapshot as { messages?: unknown }).messages;
  assert.ok(Array.isArray(messages), "Candidate Thread snapshot did not include messages.");
  const assistant = [...messages].reverse().find((message) =>
    typeof message === "object" &&
    message !== null &&
    !Array.isArray(message) &&
    (message as { role?: unknown }).role === "assistant"
  ) as { parts?: unknown } | undefined;
  assert.ok(assistant && Array.isArray(assistant.parts), "Candidate snapshot lacks an assistant message.");
  return assistant.parts.map((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
    return typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : "";
  }).join("");
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

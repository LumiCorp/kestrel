import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runHydraCandidateSmoke } from "../../scripts/hydra-smoke-candidate.js";
import {
  HYDRA_CANDIDATE_SCENARIOS,
  HYDRA_LOCAL_SCENARIOS,
  validateHydraSmokeEvidence,
} from "../../scripts/hydra-smoke-contract.js";
import { runHydraLocalSmoke } from "../../scripts/hydra-smoke-local.js";

const sourceSha = "a".repeat(40);

test("Hydra smoke entrypoints remain loadable through the checked TypeScript graph", () => {
  assert.equal(typeof runHydraLocalSmoke, "function");
  assert.equal(typeof runHydraCandidateSmoke, "function");
});

function evidence() {
  const runtime = (runtimeId: "codex" | "claude", local: boolean) => ({
    runtimeId,
    modelId: `${runtimeId}-model`,
    ...(local
      ? { nativeVersion: "test", authenticationSource: "native-login" }
      : {}),
    scenarios: (local ? HYDRA_LOCAL_SCENARIOS : HYDRA_CANDIDATE_SCENARIOS)
      .map((id) => ({ id, status: "passed", durationMs: 1 })),
  });
  return {
    version: "hydra_smoke_evidence_v1",
    sourceSha,
    startedAt: "2026-08-12T12:00:00.000Z",
    completedAt: "2026-08-12T12:01:00.000Z",
    status: "passed",
    local: {
      status: "passed",
      runtimes: [runtime("codex", true), runtime("claude", true)],
    },
    candidate: {
      status: "passed",
      origin: "https://candidate.example.test",
      deploymentRevision: sourceSha,
      runtimes: [runtime("codex", false), runtime("claude", false)],
    },
  };
}

test("Hydra smoke evidence requires both Runtimes and passed scenarios", () => {
  assert.doesNotThrow(() =>
    validateHydraSmokeEvidence(evidence(), { requirePassed: true }),
  );
  const incomplete = evidence();
  incomplete.local.runtimes.pop();
  assert.throws(
    () => validateHydraSmokeEvidence(incomplete, { requirePassed: true }),
    /exactly Codex and Claude/u,
  );
  const failed = evidence();
  failed.candidate.runtimes[0]!.scenarios[0]!.status = "failed";
  assert.throws(
    () => validateHydraSmokeEvidence(failed, { requirePassed: true }),
  );
});

test("Hydra smoke evidence rejects private Runtime correlation", () => {
  const leaked = {
    ...evidence(),
    credentialFingerprint: "private",
  };
  assert.throws(
    () => validateHydraSmokeEvidence(leaked),
    /prohibited/u,
  );
});

test("Hydra smoke evidence requires exact scenarios and exact deployment revision", () => {
  const wrongOrder = evidence();
  wrongOrder.local.runtimes[0]!.scenarios.reverse();
  assert.throws(
    () => validateHydraSmokeEvidence(wrongOrder),
    /exact checked-in contract/u,
  );

  const stale = evidence();
  stale.candidate.deploymentRevision = "b".repeat(40);
  assert.throws(
    () => validateHydraSmokeEvidence(stale),
    /must match the smoke source SHA/u,
  );

  const absolutePath = { ...evidence(), debug: "/tmp/private-config" };
  assert.throws(
    () => validateHydraSmokeEvidence(absolutePath),
    /absolute filesystem path/u,
  );
});

test("Hydra candidate smoke fences revision, proves immutable Runtimes, and cleans Threads", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "hydra-candidate-test-"));
  const storageState = path.join(temporary, "storage-state.json");
  await writeFile(storageState, JSON.stringify({ cookies: [], origins: [] }));
  const threads = new Map<string, {
    runtimeId: string;
    response: string;
    marker?: string;
  }>();
  const deleted = new Set<string>();
  let failDelete = false;
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readJsonBody(request);
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/api/health") {
        return sendJson(response, 200, { revision: sourceSha });
      }
      if (pathname === "/api/runtimes/describe") {
        const runtimeId = String(body.runtimeId);
        return sendJson(response, 200, {
          resolution: { descriptor: { availability: "ready", runtimeId } },
        });
      }
      if (pathname === "/api/threads" && request.method === "POST") {
        const id = String(body.id);
        const runtimeId = String(body.runtimeId);
        threads.set(id, { runtimeId, response: "FIRST_OK" });
        return sendJson(response, 201, { id, runtimeId });
      }
      const match = /^\/api\/threads\/([^/]+)(?:\/(turns))?$/u.exec(pathname);
      if (match) {
        const id = match[1]!;
        const thread = threads.get(id);
        if (!thread) return sendJson(response, 404, { code: "NOT_FOUND" });
        if (match[2] === "turns" && request.method === "POST") {
          if (body.runtimeId !== thread.runtimeId) {
            return sendJson(response, 409, { code: "RUNTIME_BINDING_IMMUTABLE" });
          }
          const text = String((body.message as { parts?: Array<{ text?: string }> })?.parts?.[0]?.text ?? "");
          const firstMarker = /HYDRA_[A-Z0-9]+/u.exec(text)?.[0];
          if (firstMarker) {
            thread.marker = firstMarker;
            thread.response = "FIRST_OK";
          } else {
            assert.ok(thread.marker, "continuity Turn ran without a stored marker");
            assert.equal(text.includes(thread.marker), false, "continuity prompt leaked the marker");
            thread.response = `CONTINUITY_OK:${thread.marker}`;
          }
          return sendJson(response, 202, { accepted: true });
        }
        if (request.method === "GET") {
          return sendJson(response, 200, {
            runtimeId: thread.runtimeId,
            turns: [{ status: "completed" }],
            messages: [{
              id: `assistant-${id}`,
              role: "assistant",
              parts: [{ type: "text", text: thread.response }],
            }],
          });
        }
        if (request.method === "POST") {
          return sendJson(response, 409, { code: "RUNTIME_BINDING_IMMUTABLE" });
        }
        if (request.method === "PATCH") return sendJson(response, 200, { archived: true });
        if (request.method === "DELETE") {
          if (failDelete) {
            return sendJson(response, 503, { code: "TEST_DELETE_FAILED" });
          }
          deleted.add(id);
          return sendJson(response, 204, undefined);
        }
      }
      return sendJson(response, 404, { code: "NOT_FOUND" });
    })().catch((error) => {
      sendJson(response, 500, { code: "TEST_SERVER_FAILED", message: String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = {
    url: process.env.KESTREL_HYDRA_CANDIDATE_URL,
    state: process.env.KESTREL_HYDRA_CANDIDATE_STORAGE_STATE,
    project: process.env.KESTREL_HYDRA_CANDIDATE_PROJECT_ID,
    codex: process.env.KESTREL_HYDRA_CODEX_MODEL,
    claude: process.env.KESTREL_HYDRA_CLAUDE_MODEL,
  };
  Object.assign(process.env, {
    KESTREL_HYDRA_CANDIDATE_URL: `http://127.0.0.1:${address.port}`,
    KESTREL_HYDRA_CANDIDATE_STORAGE_STATE: storageState,
    KESTREL_HYDRA_CANDIDATE_PROJECT_ID: "hydra-project",
    KESTREL_HYDRA_CODEX_MODEL: "codex-test-model",
    KESTREL_HYDRA_CLAUDE_MODEL: "claude-test-model",
  });
  try {
    const result = await runHydraCandidateSmoke({ sourceSha });
    assert.equal(result.status, "passed");
    assert.deepEqual(result.runtimes.map((runtime) => runtime.runtimeId), ["codex", "claude"]);
    assert.deepEqual(
      result.runtimes[0]!.scenarios.map((scenario) => scenario.id),
      HYDRA_CANDIDATE_SCENARIOS,
    );
    assert.equal(deleted.size, 2);

    failDelete = true;
    const failedCleanup = await runHydraCandidateSmoke({ sourceSha });
    assert.equal(failedCleanup.status, "failed");
    assert.ok(failedCleanup.runtimes.every((runtime) =>
      runtime.scenarios.at(-1)?.id === "cleanup" &&
      runtime.scenarios.at(-1)?.status === "failed"
    ));
  } finally {
    restoreEnvironment("KESTREL_HYDRA_CANDIDATE_URL", previous.url);
    restoreEnvironment("KESTREL_HYDRA_CANDIDATE_STORAGE_STATE", previous.state);
    restoreEnvironment("KESTREL_HYDRA_CANDIDATE_PROJECT_ID", previous.project);
    restoreEnvironment("KESTREL_HYDRA_CODEX_MODEL", previous.codex);
    restoreEnvironment("KESTREL_HYDRA_CLAUDE_MODEL", previous.claude);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true, force: true });
  }
});

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  if (value === undefined) {
    response.end();
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

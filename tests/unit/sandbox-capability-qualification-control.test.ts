import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createSandboxCapabilityQualificationObserver } from "../../cli/runner/SandboxCapabilityQualificationControl.js";
import { parseNetworkObservations, parseQualificationRunStream } from "../../scripts/qualification/sandbox-capability-evidence.js";

test("qualification observer records a secret-free checkpoint without pausing by default", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-qualification-control-"));
  try {
    const token = "qualification-control-token-1234567890";
    const observer = await createSandboxCapabilityQualificationObserver({ controlDir: root, token });
    await observer.checkpoint({ checkpoint: "lease_issued", leaseId: "lease-1", runId: "run-1", toolCallId: "call-1" });
    const evidence = await readFile(path.join(root, "events.ndjson"), "utf8");
    assert.match(evidence, /"checkpoint":"lease_issued"/u);
    assert.match(evidence, /"actionId":"[a-f0-9]{64}"/u);
    assert.equal(evidence.includes(token), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qualification observer pauses only for the exact token and releases through the host channel", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-qualification-control-"));
  try {
    const token = "qualification-control-token-1234567890";
    const nonce = "11111111-1111-4111-8111-111111111111";
    const observer = await createSandboxCapabilityQualificationObserver({ controlDir: root, token });
    await writeFile(path.join(root, "before_provider_invocation.pause"), `${token}\n${nonce}\n`, { mode: 0o600 });
    let completed = false;
    const pending = observer.checkpoint({ checkpoint: "before_provider_invocation", leaseId: "lease-1", runId: "run-1", toolCallId: "call-1" }).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(completed, false);
    await writeFile(path.join(root, "before_provider_invocation.release"), `wrong-token\n${nonce}\n`, { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(completed, false);
    await writeFile(path.join(root, "before_provider_invocation.release"), `${token}\n${nonce}\n`, { mode: 0o600 });
    await pending;
    assert.equal(completed, true);
    const evidence = await readFile(path.join(root, "events.ndjson"), "utf8");
    assert.match(evidence, new RegExp(`"barrierNonce":"${nonce}"`, "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qualification observer rejects short control tokens", async () => {
  await assert.rejects(
    createSandboxCapabilityQualificationObserver({ controlDir: path.join(os.tmpdir(), "unused"), token: "short" }),
    /at least 32 characters/u,
  );
});

test("qualification evidence ignores audited source strings and parses only structured stdout observations", () => {
  const sourceOnly = sse({
    id: "event-log",
    type: "run.log",
    ts: "2026-08-24T12:00:00.000Z",
    runId: "run-a",
    sessionId: "session-a",
    payload: { entry: { source: "console.log('DIRECT_NETWORK_UNEXPECTED')" } },
  });
  const parsed = parseQualificationRunStream(sourceOnly);
  assert.equal(parsed.runId, "run-a");
  assert.deepEqual(parsed.codeResults, []);
  assert.deepEqual(parseNetworkObservations("DIRECT_NETWORK_BLOCKED:{\"url\":\"https://example.com\",\"error\":\"TimeoutError\"}\nDIRECT_NETWORK_UNEXPECTED:{\"url\":\"http://127.0.0.1:80\",\"status\":200}"), [
    { outcome: "blocked", url: "https://example.com", error: "TimeoutError" },
    { outcome: "unexpected", url: "http://127.0.0.1:80", status: 200 },
  ]);
  const withTruncatedTail = parseQualificationRunStream(`${sourceOnly}data: {\"id\":\"truncated`);
  assert.equal(withTruncatedTail.events.length, 1);
  assert.equal(withTruncatedTail.runId, "run-a");
});

function sse(event: unknown): string {
  return `event: run.log\ndata: ${JSON.stringify(event)}\n\n`;
}

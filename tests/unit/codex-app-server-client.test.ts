import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServerClient } from "../../src/runtimes/codex/CodexAppServerClient.js";

type TestableClient = {
  handleLine(line: string): void;
};

function testClient(onExit: (error: Error) => void): TestableClient {
  return new CodexAppServerClient({ onExit }) as unknown as TestableClient;
}

test("Codex client terminates on invalid JSON and non-JSON-RPC output", () => {
  const failures: Error[] = [];
  testClient((error) => failures.push(error)).handleLine("not-json");
  assert.equal((failures[0] as Error & { code?: string }).code, "CODEX_PROTOCOL_INVALID");

  const second: Error[] = [];
  testClient((error) => second.push(error)).handleLine(JSON.stringify([]));
  assert.equal((second[0] as Error & { code?: string }).code, "CODEX_PROTOCOL_INVALID");
});

test("Codex client rejects stale response IDs and malformed error envelopes", () => {
  const stale: Error[] = [];
  testClient((error) => stale.push(error)).handleLine(
    JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }),
  );
  assert.equal((stale[0] as Error & { code?: string }).code, "CODEX_PROTOCOL_INVALID");

  const malformed: Error[] = [];
  testClient((error) => malformed.push(error)).handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: "bad", message: 42 },
    }),
  );
  assert.equal(
    (malformed[0] as Error & { code?: string }).code,
    "CODEX_PROTOCOL_INVALID",
  );
});

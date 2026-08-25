import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("spawned runtime processes can use the isolated pinned-provider transport preload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-capability-preload-"));
  const evidencePath = path.join(root, "provider.ndjson");
  const preloadPath = path.resolve(
    process.cwd(),
    "tests/fixtures/sandbox-capability-fetch-preload.mjs",
  );
  const script = [
    "const response = await fetch('https://api.tavily.com/search', {",
    "  method: 'POST',",
    "  headers: { authorization: 'Bearer fixture-secret', 'content-type': 'application/json' },",
    "  body: JSON.stringify({ query: 'qualification', max_results: 2 }),",
    "});",
    "process.stdout.write(await response.text());",
  ].join("\n");

  const result = await execFileAsync(process.execPath, [
    "--import",
    preloadPath,
    "--input-type=module",
    "--eval",
    script,
  ], {
    env: {
      ...process.env,
      KESTREL_TEST_SANDBOX_CAPABILITY_EVIDENCE: evidencePath,
    },
  });

  assert.deepEqual(JSON.parse(result.stdout), {
    results: [{
      title: "Isolated provider fixture",
      url: "https://example.test/kestrel",
      content: "Deterministic sandbox capability result.",
    }],
  });
  const evidence = JSON.parse((await readFile(evidencePath, "utf8")).trim()) as Record<string, unknown>;
  assert.equal(evidence.url, "https://api.tavily.com/search");
  assert.equal(evidence.authorizationPresent, true);
  assert.equal(evidence.authorizationScheme, "Bearer");
  assert.equal(JSON.stringify(evidence).includes("fixture-secret"), false);
  assert.equal(evidence.query, "qualification");
  assert.equal(evidence.maxResults, 2);
});

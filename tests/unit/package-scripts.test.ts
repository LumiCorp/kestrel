import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "runtime package publishes only the public executable boundary", async () => {
  const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
    main?: string;
    types?: string;
    files?: string[];
    dependencies?: Record<string, string>;
  };
  const files = pkg.files ?? [];

  assert.equal(pkg.main, "dist/src/index.js");
  assert.equal(pkg.types, "dist/src/index.d.ts");
  assert.equal(pkg.dependencies?.["@kestrel-agents/protocol"], "workspace:*");
  for (const required of [
    "dist/src",
    "dist/agents",
    "dist/models",
    "dist/tools",
    "dist/cli",
    "bin",
    "cli",
    "src",
    "agents",
    "models",
    "tools",
    "db/migrations",
  ]) {
    assert.ok(files.includes(required), `published files must include ${required}`);
  }
  for (const forbidden of [
    "apps",
    "packages",
    "tests",
    "docs",
    ".github",
    "benchmarks",
    "coding-agent-review",
    "node_modules",
  ]) {
    assert.ok(!files.includes(forbidden), `published files must exclude ${forbidden}`);
  }
});

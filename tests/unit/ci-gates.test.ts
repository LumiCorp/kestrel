import assert from "node:assert/strict";
import test from "node:test";
import {
  CI_GATE_IDS,
  classifyOwnedPath,
  parseCiNameStatus,
  planCiGates,
} from "../../src/governance/gates.js";

const plan = (...paths: string[]) =>
  planCiGates({
    base: "base",
    head: "head",
    changes: paths.map((path) => ({ status: "M" as const, path })),
  });

test("durable turn storage selects web, PostgreSQL, and build gates", () => {
  const result = plan("apps/web/lib/turns/store.ts");
  for (const gate of [
    "static-policy",
    "web-unit",
    "web-build",
    "postgres-integration",
    "kestrel-one-product",
  ] as const)
    assert.equal(result.gates[gate].selected, true, gate);
  assert.equal(result.risk, "critical");
});

test("docs remain narrow while shared build inputs select every gate", () => {
  const docs = plan("docs/index.md");
  assert.deepEqual(
    CI_GATE_IDS.filter((gate) => docs.gates[gate].selected),
    ["static-policy", "docs-contracts"]
  );
  const shared = plan("pnpm-lock.yaml");
  assert.ok(CI_GATE_IDS.every((gate) => shared.gates[gate].selected));
});

test("runtime, service, desktop, and package paths select owned gates", () => {
  assert.equal(
    plan("src/runtime/agent.ts").gates["runtime-unit"].selected,
    true
  );
  assert.equal(
    plan("src/runtime/agent.ts").gates["kestrel-one-product"].selected,
    true
  );
  assert.equal(
    plan("packages/protocol/src/index.ts").gates["package-contracts"].selected,
    true
  );
  assert.equal(
    plan("apps/mcp-service/src/server.ts").gates["service-contracts"].selected,
    true
  );
  assert.equal(
    plan("apps/desktop/src/main.ts").gates["package-macos"].selected,
    true
  );
});

test("unknown paths fail closed and full mode selects every gate", () => {
  const unknown = plan("new-product/source.ts");
  assert.deepEqual(unknown.unownedPaths, ["new-product/source.ts"]);
  assert.ok(CI_GATE_IDS.every((gate) => unknown.gates[gate].selected));
  const full = planCiGates({
    base: "base",
    head: "head",
    changes: [],
    full: true,
  });
  assert.ok(CI_GATE_IDS.every((gate) => full.gates[gate].selected));
});

test("name-status parsing preserves deletions and both rename paths", () => {
  assert.deepEqual(
    parseCiNameStatus(
      "D\0docs/old.md\0R100\0apps/web/old.ts\0apps/web/new.ts\0"
    ),
    [
      { status: "D", path: "docs/old.md" },
      { status: "R", previousPath: "apps/web/old.ts", path: "apps/web/new.ts" },
    ]
  );
});

test("representative repository paths have explicit ownership", () => {
  for (const path of [
    "AGENTS.md",
    ".env.example",
    ".worktreeinclude",
    "apps/cli/.gitignore",
    "benchmarks/terminal.json",
    "deploy/fly.toml",
  ])
    assert.notEqual(classifyOwnedPath(path).length, 0, path);
});

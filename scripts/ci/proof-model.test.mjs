import assert from "node:assert/strict";
import test from "node:test";
import { assertRequiredLaneResults, CI_LANES, createCiPlan, parseNameStatus } from "./proof-model.mjs";

const plan = (...paths) =>
  createCiPlan({
    base: "base",
    head: "head",
    changes: paths.map((path) => ({ status: "M", path })),
  });

test("documentation changes select only policy and documentation proofs", () => {
  const result = plan("docs/index.md");
  assert.deepEqual(
    CI_LANES.filter((lane) => result.lanes[lane].selected),
    ["policy", "docs"],
  );
});

test("database changes propagate through web, product, and PostgreSQL proofs", () => {
  const result = plan("apps/web/lib/turns/store.ts");
  assert.deepEqual(
    CI_LANES.filter((lane) => result.lanes[lane].selected),
    ["policy", "web", "postgres", "product"],
  );
});

test("runtime changes do not imply web, Desktop, product, or macOS packaging", () => {
  const result = plan("src/runtime/agent.ts");
  assert.deepEqual(
    CI_LANES.filter((lane) => result.lanes[lane].selected),
    ["policy", "runtime"],
  );
});

test("macOS-only proofs select only the packaging environment", () => {
  const result = plan("tests/macos/darwin-dependency-bundle.test.ts");
  assert.deepEqual(CI_LANES.filter((lane) => result.lanes[lane].selected), ["package-macos"]);
});

test("TUI operations select their required PostgreSQL environment", () => {
  const result = plan("tests/ops/tui/tui.ops.ts");
  assert.deepEqual(CI_LANES.filter((lane) => result.lanes[lane].selected), ["postgres"]);
});

test("CI changes request the complete deterministic proof system", () => {
  const result = plan(".github/workflows/ci.yml");
  assert.ok(CI_LANES.every((lane) => result.lanes[lane].selected));
});

test("unknown files fail ownership instead of selecting speculative tests", () => {
  const result = plan("new-surface/source.ts");
  assert.deepEqual(result.unownedPaths, ["new-surface/source.ts"]);
  assert.ok(CI_LANES.every((lane) => !result.lanes[lane].selected));
});

test("manual full mode selects every lane", () => {
  const result = createCiPlan({ base: "base", head: "head", changes: [], full: true });
  assert.ok(CI_LANES.every((lane) => result.lanes[lane].selected));
});

test("name-status parsing preserves deletions and both rename paths", () => {
  assert.deepEqual(
    parseNameStatus("D\0docs/old.md\0R100\0apps/web/old.ts\0apps/web/new.ts\0"),
    [
      { status: "D", path: "docs/old.md" },
      { status: "R", previousPath: "apps/web/old.ts", path: "apps/web/new.ts" },
    ],
  );
});

test("aggregate accepts exactly the selected successful lanes", () => {
  const selections = Object.fromEntries(CI_LANES.map((lane) => [lane, lane === "runtime"]));
  const results = Object.fromEntries(CI_LANES.map((lane) => [lane, lane === "runtime" ? "success" : "skipped"]));
  assert.doesNotThrow(() => assertRequiredLaneResults({ planResult: "success", selections, results }));
});

test("aggregate rejects a failed selected lane", () => {
  const selections = Object.fromEntries(CI_LANES.map((lane) => [lane, lane === "runtime"]));
  const results = Object.fromEntries(CI_LANES.map((lane) => [lane, lane === "runtime" ? "failure" : "skipped"]));
  assert.throws(
    () => assertRequiredLaneResults({ planResult: "success", selections, results }),
    /runtime: expected success, received failure/u,
  );
});

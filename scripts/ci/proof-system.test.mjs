import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "check-test-proofs.mjs");
const AUDITOR = path.join(HERE, "audit-mutations.mjs");

test("proof registry rejects orphan tests and prohibited skips", () => {
  const root = fixture();
  write(root, "sample.test.ts", 'import test from "node:test";\ntest.skip("disabled contract", () => {});\n');
  const result = run(CHECKER, root, ["--write-catalog"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /skip is prohibited/u);
  assert.match(result.stderr, /no proof contract owns this test/u);
});

test("proof registry rejects duplicate dimensions and stale executable entries", () => {
  const root = fixture({ prefix: "tests/" });
  write(root, "tests/sample.test.ts", 'import test from "node:test";\ntest("same dimension", () => {});\ntest("same dimension", () => {});\n');
  let result = run(CHECKER, root, ["--write-catalog"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate test identity/u);
  write(root, "tests/sample.test.ts", 'import test from "node:test";\ntest("current contract", () => {});\n');
  result = run(CHECKER, root, ["--write-catalog"]);
  assert.equal(result.status, 0, result.stderr);
  write(root, "tests/sample.test.ts", 'import test from "node:test";\ntest("changed contract", () => {});\n');
  result = run(CHECKER, root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catalog\.json is stale/u);
});

test("proof registry rejects invalid mutation specifications", () => {
  const root = fixture({ prefix: "tests/" });
  write(root, "tests/sample.test.ts", 'import test from "node:test";\ntest("contract", () => {});\n');
  write(root, "source.ts", "export const enabled = true;\n");
  const mutation = JSON.parse(read(root, "tests/proof/mutations.json"));
  mutation.mutations.push({ id: "invalid", contractId: "fixture.contract", target: "source.ts", find: "missing", replace: "false", command: "node", args: [], testFiles: ["tests/sample.test.ts"] });
  write(root, "tests/proof/mutations.json", `${JSON.stringify(mutation)}\n`);
  const result = run(CHECKER, root, ["--write-catalog"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /one exact, behavior-changing target/u);
});

test("mutation audit distinguishes killed and surviving mutations and restores source", () => {
  const root = fixture({ prefix: "tests/", risk: "high" });
  write(root, "source.txt", "enabled=true\n");
  write(root, "tests/kills.test.mjs", 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; import test from "node:test"; test("kills mutation", () => assert.match(readFileSync("source.txt", "utf8"), /enabled=true/u));\n');
  write(root, "tests/survives.test.mjs", 'import test from "node:test"; test("survives mutation", () => {});\n');
  const base = { contractId: "fixture.contract", target: "source.txt", find: "enabled=true", replace: "enabled=false", command: "node" };
  write(root, "tests/proof/mutations.json", `${JSON.stringify({ version: 1, mutations: [{ ...base, id: "killed", args: ["--test", "tests/kills.test.mjs"], testFiles: ["tests/kills.test.mjs"] }, { ...base, id: "survived", args: ["--test", "tests/survives.test.mjs"], testFiles: ["tests/survives.test.mjs"] }] })}\n`);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Kestrel Proof", "-c", "user.email=proof@kestrel.invalid", "commit", "-qm", "proof fixture"], { cwd: root });
  let result = run(AUDITOR, root, ["killed"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /killed killed/u);
  assert.equal(read(root, "source.txt"), "enabled=true\n");
  result = run(AUDITOR, root, ["survived"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /mutation survived/u);
  assert.equal(read(root, "source.txt"), "enabled=true\n");
});

function fixture({ prefix = "owned/", risk = "low" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "kestrel-proof-"));
  mkdirSync(path.join(root, "tests/proof"), { recursive: true });
  write(root, "tests/proof/registry.json", `${JSON.stringify({ version: 1, contracts: [{ id: "fixture.contract", owner: "test", risk, counterexample: "A concrete fixture counterexample executes.", lane: "policy", environment: "linux", prefixes: [prefix] }] })}\n`);
  write(root, "tests/proof/catalog.json", `${JSON.stringify({ version: 1, tests: [] }, null, 2)}\n`);
  write(root, "tests/proof/mutations.json", '{"version":1,"mutations":[]}\n');
  write(root, "tests/proof/mutation-evidence.json", '{"version":1,"evidence":[]}\n');
  execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

function write(root, relative, content) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content, "utf8");
}
function read(root, relative) { return readFileSync(path.join(root, relative), "utf8"); }
function run(script, cwd, args = []) { return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" }); }

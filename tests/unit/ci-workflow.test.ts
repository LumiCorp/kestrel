import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

test("CI workflow exposes parallel owned gates behind one stable aggregate", async () => {
  const workflow = await readFile(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8"
  );
  const setup = await readFile(
    path.join(ROOT, ".github/actions/setup/action.yml"),
    "utf8"
  );

  assert.match(workflow, /^\s{2}ci-required:\s*$/mu);
  assert.match(workflow, /^\s{4}name: ci-required\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}validate:\s*$/mu);
  assert.doesNotMatch(workflow, /run: pnpm run test\s*$/mu);
  assert.equal(workflow.match(/run: pnpm run ci:runtime\s*$/gmu)?.length, 1);
  assert.match(
    workflow,
    /if: needs\.ci-plan\.outputs\.package_macos == 'true'/u
  );
  assert.match(setup, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /cron: "0 7 \* \* \*"/u);
  assert.doesNotMatch(workflow, /apt-get update/u);
});

test("CI runtime owns the prompt and eval gates exactly once", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
  const runtime = packageJson.scripts["ci:runtime"] ?? "";

  assert.equal(runtime.match(/prompt-suite/gu)?.length, 1);
  assert.equal(runtime.match(/evals:release-check/gu)?.length, 1);
  assert.doesNotMatch(packageJson.scripts.test ?? "", /eval/u);
  assert.doesNotMatch(packageJson.scripts["governance:check"] ?? "", /eval/u);
});

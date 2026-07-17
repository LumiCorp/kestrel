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
  assert.equal(workflow.match(/pnpm run ci:runtime\s*$/gmu)?.length, 1);
  assert.match(
    workflow,
    /if: needs\.ci-plan\.outputs\.package_macos == 'true'/u
  );
  assert.match(setup, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /cron: "0 7 \* \* \*"/u);
  assert.match(workflow, /image: pgvector\/pgvector:pg16/u);
  assert.match(workflow, /postgres-integration -- pnpm run ci:postgres/u);
  assert.match(workflow, /^\s{2}kestrel-one-product:\s*$/mu);
  assert.match(workflow, /kestrel-one-product -- pnpm run ci:product/u);
  assert.match(workflow, /pnpm run ci:run-gate/u);
  assert.match(workflow, /Full-repository Ultracite/u);
  assert.match(workflow, /static-policy\/lint -- pnpm run ci:lint:full/u);
  assert.match(workflow, /KESTREL_PRODUCT_WEBKIT/u);
  assert.match(workflow, /Upload failed product evidence/u);
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

test("product-contract bootstrap waits for Compose health before database setup", async () => {
  const bootstrap = await readFile(
    path.join(ROOT, "apps", "web", "scripts", "product-dev-all.sh"),
    "utf8"
  );

  assert.match(
    bootstrap,
    /docker compose up -d --wait --wait-timeout 60 postgres/u
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  LEGACY_RELEASE_CONTROLLER_QUEUES,
  RELEASE_CONTROLLER_QUEUES,
} from "./controller-contract";
import {
  CONTROL_WORKER_SECRET_ALLOWLIST,
  selectControlWorkerSecrets,
} from "../../scripts/release-control-worker";

const root = new URL("../../../../", import.meta.url);

test("controller queues are revision-fenced from legacy turn workers", () => {
  for (const key of Object.keys(RELEASE_CONTROLLER_QUEUES) as Array<
    keyof typeof RELEASE_CONTROLLER_QUEUES
  >) {
    assert.match(RELEASE_CONTROLLER_QUEUES[key], /\.controller-v1$/u);
    assert.notEqual(
      RELEASE_CONTROLLER_QUEUES[key],
      LEGACY_RELEASE_CONTROLLER_QUEUES[key],
    );
  }
});

test("control worker secrets are explicitly allowlisted and fail closed", () => {
  const source = Object.fromEntries(
    CONTROL_WORKER_SECRET_ALLOWLIST.map((key) => [key, `${key}-value`]),
  );
  source.UNRELATED_SECRET = "must-not-cross-boundary";
  const selected = selectControlWorkerSecrets(source);

  assert.equal(selected.has("UNRELATED_SECRET"), false);
  assert.deepEqual([...selected.keys()], [...CONTROL_WORKER_SECRET_ALLOWLIST]);
  assert.throws(
    () => selectControlWorkerSecrets({ ...source, CRON_SECRET: "" }),
    /missing control worker secrets: CRON_SECRET/u,
  );
  assert.throws(
    () =>
      selectControlWorkerSecrets({
        ...source,
        DATABASE_URL: "",
        POSTGRES_URL: "",
      }),
    /missing control worker secrets: DATABASE_URL or POSTGRES_URL/u,
  );
});

test("release workflow waits for exact production identity before publication", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/fly-image-release.yml", root),
    "utf8",
  );
  const wait = workflow.indexOf("Wait for the exact Kestrel One production revision");
  const publish = workflow.indexOf("Build, smoke, and publish candidate images");
  assert.ok(wait >= 0);
  assert.ok(publish > wait);
  assert.match(
    workflow,
    /wait-for-kestrel-production-revision\.ts \$\{\{ github\.sha \}\}/u,
  );
});

test("release workflow bounds controller readiness polling", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/fly-image-release.yml", root),
    "utf8",
  );
  assert.match(workflow, /for attempt in \$\(seq 1 45\); do/u);
  assert.match(
    workflow,
    /grep -q release-controller-v1 \/tmp\/kestrel-control-worker-ready/u,
  );
  assert.match(workflow, /did not become ready within 90 seconds/u);
});

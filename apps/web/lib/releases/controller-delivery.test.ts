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
import { selectControlWorkerMachineAction } from "../../scripts/control-worker-machine";

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

const revision = "a".repeat(40);

function machine(input: {
  id: string;
  state: string;
  standbys?: string[] | undefined;
  imageRevision?: string | undefined;
}) {
  return {
    id: input.id,
    state: input.state,
    config: { standbys: input.standbys ?? [] },
    image_ref: {
      labels: {
        "org.opencontainers.image.revision": input.imageRevision ?? revision,
      },
    },
  };
}

test("control worker restoration starts a stopped primary and not its standby", () => {
  assert.deepEqual(
    selectControlWorkerMachineAction({
      expectedRevision: revision,
      inventory: [
        machine({ id: "primary", state: "stopped" }),
        machine({ id: "standby", state: "stopped", standbys: ["primary"] }),
      ],
    }),
    { action: "start", machineId: "primary" },
  );
});

test("control worker restoration keeps the only running primary", () => {
  assert.deepEqual(
    selectControlWorkerMachineAction({
      expectedRevision: revision,
      inventory: [
        machine({ id: "primary", state: "started" }),
        machine({ id: "standby", state: "stopped", standbys: ["primary"] }),
      ],
    }),
    { action: "use", machineId: "primary" },
  );
});

test("control worker restoration keeps a promoted standby", () => {
  assert.deepEqual(
    selectControlWorkerMachineAction({
      expectedRevision: revision,
      inventory: [
        machine({ id: "primary", state: "stopped" }),
        machine({ id: "standby", state: "started", standbys: ["primary"] }),
      ],
    }),
    { action: "use", machineId: "standby" },
  );
});

test("control worker restoration fails closed on ambiguous or unrelated inventory", () => {
  assert.throws(
    () =>
      selectControlWorkerMachineAction({
        expectedRevision: revision,
        inventory: [
          machine({ id: "primary-a", state: "stopped" }),
          machine({ id: "primary-b", state: "stopped" }),
        ],
      }),
    /one unique primary Machine/u,
  );
  assert.throws(
    () =>
      selectControlWorkerMachineAction({
        expectedRevision: revision,
        inventory: [
          machine({ id: "primary", state: "started" }),
          machine({ id: "other", state: "stopped", standbys: ["missing"] }),
        ],
      }),
    /unrelated Machines/u,
  );
});

test("control worker restoration rejects two running Machines", () => {
  assert.throws(
    () =>
      selectControlWorkerMachineAction({
        expectedRevision: revision,
        inventory: [
          machine({ id: "primary", state: "started" }),
          machine({ id: "standby", state: "started", standbys: ["primary"] }),
        ],
      }),
    /at most one running Machine/u,
  );
});

test("control worker restoration rejects revision drift", () => {
  assert.throws(
    () =>
      selectControlWorkerMachineAction({
        expectedRevision: revision,
        inventory: [
          machine({ id: "primary", state: "started" }),
          machine({
            id: "standby",
            state: "stopped",
            standbys: ["primary"],
            imageRevision: "b".repeat(40),
          }),
        ],
      }),
    /revision mismatch/u,
  );
});

test("release workflow waits for exact production identity before controller deployment and publication", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/fly-image-release.yml", root),
    "utf8",
  );
  const wait = workflow.indexOf(
    "Wait for the exact Kestrel One production revision",
  );
  const deployController = workflow.indexOf("Deploy the release controller");
  const publish = workflow.indexOf(
    "Build, smoke, and publish candidate images",
  );
  assert.ok(wait >= 0);
  assert.ok(deployController > wait);
  assert.ok(publish > deployController);
  assert.match(
    workflow,
    /wait-for-kestrel-production-revision\.ts \$\{\{ github\.sha \}\}/u,
  );
  const waitScript = await readFile(
    new URL("scripts/wait-for-kestrel-production-revision.ts", root),
    "utf8",
  );
  assert.match(
    waitScript,
    /releaseCompatibilitySchema\?\.ready === true/u,
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
    /--command "pnpm --filter @kestrel\/kestrel-one exec tsx scripts\/verify-control-worker-readiness\.ts \$\{\{ github\.sha \}\}"/u,
  );
  assert.match(workflow, /did not become ready within 90 seconds/u);
  assert.match(workflow, /flyctl logs --app kestrel-one-control-worker --no-tail 2>&1 \| tail -n 200/u);
  assert.doesNotMatch(workflow, /machine status[^\n]*--json/u);
  assert.match(
    workflow,
    /if: \$\{\{ failure\(\) && \(steps\.deploy-release-controller\.outcome == 'failure' \|\| steps\.restore-release-controller\.outcome == 'failure' \|\| steps\.verify-release-controller\.outcome == 'failure'\) \}\}/u,
  );
});

test("release workflow restores one controller before readiness and image publication", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/fly-image-release.yml", root),
    "utf8",
  );
  const deploy = workflow.indexOf("id: deploy-release-controller");
  const restore = workflow.indexOf("id: restore-release-controller");
  const verify = workflow.indexOf("id: verify-release-controller");
  const publish = workflow.indexOf("Build, smoke, and publish candidate images");
  assert.ok(deploy >= 0);
  assert.ok(restore > deploy);
  assert.ok(verify > restore);
  assert.ok(publish > verify);
});

test("controller startup reconciles Environment operations before reporting readiness", async () => {
  const controller = await readFile(
    new URL("apps/web/scripts/control-worker.ts", root),
    "utf8",
  );
  const reconcile = controller.indexOf(
    "await startEnvironmentLifecycleWorker()",
  );
  const heartbeat = controller.indexOf("await heartbeat()", reconcile);
  const ready = controller.indexOf("await markReady()", heartbeat);
  assert.ok(reconcile >= 0);
  assert.ok(heartbeat > reconcile);
  assert.ok(ready > heartbeat);
});

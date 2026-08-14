import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  LEGACY_RELEASE_CONTROLLER_QUEUES,
  RELEASE_CONTROLLER_QUEUES,
} from "./controller-contract";
import {
  controlWorkerSecretSetArgs,
  CONTROL_WORKER_SECRET_ALLOWLIST,
  selectControlWorkerSecrets,
} from "../../scripts/release-control-worker";
import {
  canSkipControlWorkerMachineDeploy,
  findControlWorkerMachine,
  isControlWorkerMachinePostcondition,
  selectControlWorkerMachineAction,
  selectControlWorkerMachineUpdatePlan,
} from "../../scripts/control-worker-machine";
import {
  buildControlWorkerArtifact,
  CONTROL_WORKER_FINGERPRINT_PATHS,
  fingerprintControlWorkerArtifact,
} from "../../scripts/control-worker-artifact";
import {
  deployControlWorkerCandidate,
  deployStoredControlWorkerCandidate,
  type ControlWorkerDeployDependencies,
} from "../../scripts/deploy-control-worker-candidate";
import { publishControlWorkerCandidate } from "../../scripts/publish-control-worker-candidate";

const root = new URL("../../../../", import.meta.url);
const execFileAsync = promisify(execFile);

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

test("control worker secrets preserve multiline values as one Fly argument", () => {
  const multilineValue = "line-one\nline-two\nline-three";
  const args = controlWorkerSecretSetArgs(
    new Map([
      ["CRON_SECRET", "cron-secret"],
      ["KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY", multilineValue],
    ]),
  );

  assert.deepEqual(args.slice(0, 4), [
    "secrets",
    "set",
    "--app",
    "kestrel-one-control-worker",
  ]);
  assert.equal(args[4], "CRON_SECRET=cron-secret");
  assert.equal(
    args[5],
    `KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY=${multilineValue}`,
  );
  assert.equal(args.length, 6);
});

const revision = "a".repeat(40);

function machine(input: {
  id: string;
  state: string;
  standbys?: string[] | undefined;
  command?: string[] | undefined;
  imageRevision?: string | undefined;
  fingerprint?: string | null | undefined;
  digest?: string | undefined;
  environment?: Record<string, string> | undefined;
}) {
  return {
    id: input.id,
    state: input.state,
    config: {
      init: {
        cmd: input.command ?? [
          "pnpm",
          "--filter",
          "@kestrel/kestrel-one",
          "worker:control",
        ],
      },
      standbys: input.standbys ?? [],
      env: input.environment ?? {},
    },
    image_ref: {
      digest: input.digest ?? `sha256:${"1".repeat(64)}`,
      labels: {
        "org.opencontainers.image.revision": input.imageRevision ?? revision,
        "org.kestrel.control-worker.fingerprint":
          input.fingerprint === undefined ? "fingerprint-a" : input.fingerprint,
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

test("control worker update preserves a stopped standby and waits for the running primary", () => {
  assert.deepEqual(
    selectControlWorkerMachineUpdatePlan({
      inventory: [
        machine({ id: "primary", state: "started" }),
        machine({ id: "standby", state: "stopped", standbys: ["primary"] }),
      ],
    }),
    {
      runningMachineId: "primary",
      updates: [
        { machineId: "standby", expectedState: "stopped", skipStart: true },
        { machineId: "primary", expectedState: "started", skipStart: false },
      ],
    },
  );
});

test("control worker topology rejects more than one standby", () => {
  assert.throws(
    () =>
      selectControlWorkerMachineUpdatePlan({
        inventory: [
          machine({ id: "primary", state: "started" }),
          machine({ id: "standby-a", state: "stopped", standbys: ["primary"] }),
          machine({ id: "standby-b", state: "stopped", standbys: ["primary"] }),
        ],
      }),
    /at most one standby Machine/u,
  );
});

test("control worker update preserves a promoted standby as the only running Machine", () => {
  assert.deepEqual(
    selectControlWorkerMachineUpdatePlan({
      inventory: [
        machine({ id: "primary", state: "stopped" }),
        machine({ id: "standby", state: "started", standbys: ["primary"] }),
      ],
    }),
    {
      runningMachineId: "standby",
      updates: [
        { machineId: "primary", expectedState: "stopped", skipStart: true },
        { machineId: "standby", expectedState: "started", skipStart: false },
      ],
    },
  );
});

test("control worker deploy skip requires matching fingerprint and a running Machine", () => {
  assert.equal(
    canSkipControlWorkerMachineDeploy({
      expectedFingerprint: "fingerprint-a",
      inventory: [
        machine({
          id: "primary",
          state: "started",
          command: ["node", "/app/control-worker.cjs"],
        }),
        machine({
          id: "standby",
          state: "stopped",
          standbys: ["primary"],
          command: ["node", "/app/control-worker.cjs"],
        }),
      ],
    }),
    true,
  );
  assert.equal(
    canSkipControlWorkerMachineDeploy({
      expectedFingerprint: "fingerprint-a",
      inventory: [
        machine({ id: "primary", state: "started" }),
        machine({
          id: "standby",
          state: "stopped",
          standbys: ["primary"],
          fingerprint: "fingerprint-b",
        }),
      ],
    }),
    false,
  );
  assert.equal(
    canSkipControlWorkerMachineDeploy({
      expectedFingerprint: "fingerprint-a",
      inventory: [machine({ id: "primary", state: "started" })],
    }),
    false,
  );
  assert.equal(
    canSkipControlWorkerMachineDeploy({
      expectedFingerprint: "fingerprint-a",
      inventory: [
        machine({ id: "primary", state: "stopped" }),
        machine({ id: "standby", state: "stopped", standbys: ["primary"] }),
      ],
    }),
    false,
  );
});

test("control worker postcondition requires exact persisted runtime images", () => {
  const expectedEnvironment = {
    KESTREL_ENVIRONMENT_ROUTER_IMAGE: `ghcr.io/lumicorp/kestrel-environment-router@sha256:${"2".repeat(64)}`,
    KESTREL_WORKSPACE_RUNTIME_IMAGE: `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"3".repeat(64)}`,
  };
  const current = findControlWorkerMachine({
    inventory: [
      machine({
        id: "primary",
        state: "started",
        command: ["node", "/app/control-worker.cjs"],
        environment: {
          ...expectedEnvironment,
          KESTREL_ENVIRONMENT_ROUTER_IMAGE: `ghcr.io/lumicorp/kestrel-environment-router@sha256:${"4".repeat(64)}`,
        },
      }),
    ],
    machineId: "primary",
  });
  assert.equal(
    isControlWorkerMachinePostcondition({
      machine: current,
      expectedState: "started",
      expectedFingerprint: "fingerprint-a",
      expectedRevision: revision,
      expectedEnvironment,
    }),
    false,
  );
  current.environment = expectedEnvironment;
  assert.equal(
    isControlWorkerMachinePostcondition({
      machine: current,
      expectedState: "started",
      expectedFingerprint: "fingerprint-a",
      expectedRevision: revision,
      expectedEnvironment,
    }),
    true,
  );
});

test("controller deployment survives Fly manifest transcoding after stopped-first tagged updates", async () => {
  const fingerprint = "f".repeat(64);
  const digest = `sha256:${"2".repeat(64)}`;
  const flyDeploymentDigest = `sha256:${"3".repeat(64)}`;
  const inventory = [
    machine({ id: "primary", state: "started", fingerprint: "old" }),
    machine({
      id: "standby",
      state: "stopped",
      standbys: ["primary"],
      fingerprint: "old",
    }),
  ];
  const commands: Array<{ command: string; args: string[] }> = [];
  let disposed = false;
  const dependencies: ControlWorkerDeployDependencies = {
    buildArtifact: async () => ({
      contextDirectory: "/tmp/controller-context",
      dockerfile: "/tmp/controller-context/Dockerfile",
      fingerprint,
      runtimeInputs: [],
      workerBundle: "/tmp/controller-context/control-worker.cjs",
      readinessBundle:
        "/tmp/controller-context/verify-control-worker-readiness.cjs",
      dispose: async () => {
        disposed = true;
      },
    }),
    capture: async (command, args) => {
      assert.equal(command, "docker");
      assert.equal(args[0], "image");
      return JSON.stringify([
        `registry.fly.io/kestrel-one-control-worker@${digest}`,
      ]);
    },
    readInventory: async () => structuredClone(inventory),
    run: async (command, args, environment) => {
      commands.push({ command, args });
      if (command === "bash") {
        assert.equal(environment?.EXPECTED_GIT_SHA, revision);
        assert.equal(
          environment?.EXPECTED_CONTROL_WORKER_FINGERPRINT,
          fingerprint,
        );
      }
      if (command === "flyctl" && args[0] === "machine") {
        const target = inventory.find((item) => item.id === args[2]);
        assert.ok(target);
        target.state = args.includes("--skip-start") ? "stopped" : "started";
        target.config.init.cmd = ["node", "/app/control-worker.cjs"];
        target.image_ref.digest = flyDeploymentDigest;
        target.image_ref.labels["org.kestrel.control-worker.fingerprint"] =
          fingerprint;
      }
    },
    wait: async () => {},
    write: () => {},
  };

  await deployControlWorkerCandidate({
    revision,
    accessToken: "token",
    dependencies,
  });

  const smokeIndex = commands.findIndex(({ command }) => command === "bash");
  const build = commands.find(
    ({ command, args }) => command === "flyctl" && args[0] === "deploy",
  );
  assert.ok(build);
  const configPath = build.args[build.args.indexOf("--config") + 1]!;
  assert.equal(isAbsolute(configPath), true);
  assert.equal(
    configPath.endsWith("deploy/fly/kestrel-one-control-worker/fly.toml"),
    true,
  );
  const updates = commands.filter(
    ({ command, args }) => command === "flyctl" && args[0] === "machine",
  );
  const firstUpdateIndex = commands.findIndex(
    ({ command, args }) => command === "flyctl" && args[0] === "machine",
  );
  assert.ok(smokeIndex >= 0 && smokeIndex < firstUpdateIndex);
  assert.deepEqual(
    updates.map(({ args }) => args[2]),
    ["standby", "primary"],
  );
  for (const { args } of updates) {
    const image = args[args.indexOf("--image") + 1]!;
    assert.equal(image.includes("@sha256:"), false);
    assert.match(image, /:control-worker-a{12}-f{12}$/u);
    assert.equal(
      args[args.indexOf("--command") + 1],
      "node /app/control-worker.cjs",
    );
    assert.equal(
      args[args.indexOf("--env") + 1],
      `KESTREL_RELEASE_IMAGE=registry.fly.io/kestrel-one-control-worker@${digest}`,
    );
  }
  assert.equal(updates[0]?.args.includes("--skip-start"), true);
  assert.equal(updates[1]?.args.includes("--skip-start"), false);
  assert.equal(disposed, true);
});

test("stored controller preparation injects the candidate runtime image digests", async () => {
  const controllerDigest = `sha256:${"2".repeat(64)}`;
  const routerImage = `ghcr.io/lumicorp/kestrel-environment-router@sha256:${"3".repeat(64)}`;
  const workspaceImage = `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"4".repeat(64)}`;
  const inventory = [
    machine({ id: "primary", state: "started", fingerprint: "old" }),
  ];
  const updates: string[][] = [];

  await deployStoredControlWorkerCandidate({
    revision,
    image: `registry.fly.io/kestrel-one-control-worker@${controllerDigest}`,
    fingerprint: `sha256:${"f".repeat(64)}`,
    routerImage,
    workspaceImage,
    accessToken: "token",
    dependencies: {
      readInventory: async () => structuredClone(inventory),
      run: async (command, args) => {
        if (command === "flyctl" && args[0] === "machine") {
          updates.push(args);
          inventory[0]!.state = "started";
          inventory[0]!.config.init.cmd = ["node", "/app/control-worker.cjs"];
          inventory[0]!.image_ref.labels[
            "org.kestrel.control-worker.fingerprint"
          ] = "f".repeat(64);
          inventory[0]!.image_ref.labels["org.opencontainers.image.revision"] =
            revision;
          for (let index = 0; index < args.length; index += 1) {
            if (args[index] !== "--env") continue;
            const [key, ...value] = args[index + 1]!.split("=");
            inventory[0]!.config.env[key!] = value.join("=");
          }
        }
      },
      wait: async () => {},
      write: () => {},
    },
  });

  assert.equal(updates.length, 1);
  assert.equal(
    updates[0]!.includes(`KESTREL_ENVIRONMENT_ROUTER_IMAGE=${routerImage}`),
    true,
  );
  assert.equal(
    updates[0]!.includes(`KESTREL_WORKSPACE_RUNTIME_IMAGE=${workspaceImage}`),
    true,
  );
  await assert.rejects(
    deployStoredControlWorkerCandidate({
      revision,
      image: `registry.fly.io/kestrel-one-control-worker@${controllerDigest}`,
      fingerprint: `sha256:${"f".repeat(64)}`,
      routerImage: "registry.fly.io/kestrel-environment-router:latest",
      workspaceImage,
      accessToken: "token",
      dependencies: {
        readInventory: async () => structuredClone(inventory),
        run: async () => assert.fail("invalid images must fail before mutation"),
        wait: async () => {},
        write: () => {},
      },
    }),
    /candidate's immutable Environment Router and Workspace Runtime images/u,
  );
});

test("controller candidate publication builds, smokes, and disposes without Machine authority", async () => {
  const fingerprint = "f".repeat(64);
  let disposed = false;
  let published = false;
  const messages: string[] = [];
  const result = await publishControlWorkerCandidate({
    revision,
    dependencies: {
      buildArtifact: async () => ({
        contextDirectory: "/tmp/controller-context",
        dockerfile: "/tmp/controller-context/Dockerfile",
        fingerprint,
        runtimeInputs: [],
        workerBundle: "/tmp/controller-context/control-worker.cjs",
        readinessBundle:
          "/tmp/controller-context/verify-control-worker-readiness.cjs",
        dispose: async () => {
          disposed = true;
        },
      }),
      publishImage: async ({ appName, artifact, revision: inputRevision }) => {
        published = true;
        assert.equal(appName, "kestrel-one-control-worker");
        assert.equal(artifact.fingerprint, fingerprint);
        assert.equal(inputRevision, revision);
        return {
          digest: `sha256:${"2".repeat(64)}`,
          immutableImage: `registry.fly.io/kestrel-one-control-worker@sha256:${"2".repeat(64)}`,
          label: "candidate",
          taggedImage: "registry.fly.io/kestrel-one-control-worker:candidate",
        };
      },
      write: (message) => messages.push(message),
    },
  });

  assert.equal(published, true);
  assert.equal(disposed, true);
  assert.equal(result.fingerprint, fingerprint);
  assert.match(
    messages.join(""),
    /Published and smoked release controller candidate/u,
  );
});

test("controller deployment retries incomplete post-update inventory", async () => {
  const fingerprint = "f".repeat(64);
  const digest = `sha256:${"2".repeat(64)}`;
  const inventory = [
    machine({ id: "primary", state: "started", fingerprint: "old" }),
  ];
  let inventoryReads = 0;
  const waits: number[] = [];

  await deployControlWorkerCandidate({
    revision,
    accessToken: "token",
    dependencies: {
      buildArtifact: async () => ({
        contextDirectory: "/tmp/controller-context",
        dockerfile: "/tmp/controller-context/Dockerfile",
        fingerprint,
        runtimeInputs: [],
        workerBundle: "/tmp/controller-context/control-worker.cjs",
        readinessBundle:
          "/tmp/controller-context/verify-control-worker-readiness.cjs",
        dispose: async () => {},
      }),
      capture: async () =>
        JSON.stringify([
          `registry.fly.io/kestrel-one-control-worker@${digest}`,
        ]),
      readInventory: async () => {
        inventoryReads += 1;
        if (inventoryReads === 3) {
          const incomplete = structuredClone(inventory);
          delete (incomplete[0] as { image_ref?: unknown }).image_ref;
          return incomplete;
        }
        return structuredClone(inventory);
      },
      run: async (command, args) => {
        if (command === "flyctl" && args[0] === "machine") {
          inventory[0]!.config.init.cmd = ["node", "/app/control-worker.cjs"];
          inventory[0]!.image_ref.digest = digest;
          inventory[0]!.image_ref.labels[
            "org.kestrel.control-worker.fingerprint"
          ] = fingerprint;
        }
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      write: () => {},
    },
  });

  assert.equal(inventoryReads, 4);
  assert.deepEqual(waits, [2_000]);
});

test("controller smoke failure prevents every Machine update", async () => {
  const fingerprint = "f".repeat(64);
  const commands: Array<{ command: string; args: string[] }> = [];
  let disposed = false;
  await assert.rejects(
    deployControlWorkerCandidate({
      revision,
      accessToken: "token",
      dependencies: {
        buildArtifact: async () => ({
          contextDirectory: "/tmp/controller-context",
          dockerfile: "/tmp/controller-context/Dockerfile",
          fingerprint,
          runtimeInputs: [],
          workerBundle: "/tmp/controller-context/control-worker.cjs",
          readinessBundle:
            "/tmp/controller-context/verify-control-worker-readiness.cjs",
          dispose: async () => {
            disposed = true;
          },
        }),
        capture: async () =>
          JSON.stringify([
            `registry.fly.io/kestrel-one-control-worker@sha256:${"2".repeat(64)}`,
          ]),
        readInventory: async () => [
          machine({ id: "primary", state: "started", fingerprint: "old" }),
        ],
        run: async (command, args) => {
          commands.push({ command, args });
          if (command === "bash") throw new Error("smoke failed");
        },
        wait: async () => {},
        write: () => {},
      },
    }),
    /smoke failed/u,
  );
  assert.equal(
    commands.some(
      ({ command, args }) => command === "flyctl" && args[0] === "machine",
    ),
    false,
  );
  assert.equal(disposed, true);
});

test("matching controller fingerprint performs only the heartbeat verification", async () => {
  const fingerprint = "f".repeat(64);
  const commands: Array<{ command: string; args: string[] }> = [];
  const result = await deployControlWorkerCandidate({
    revision,
    accessToken: "token",
    dependencies: {
      buildArtifact: async () => ({
        contextDirectory: "/tmp/controller-context",
        dockerfile: "/tmp/controller-context/Dockerfile",
        fingerprint,
        runtimeInputs: [],
        workerBundle: "/tmp/controller-context/control-worker.cjs",
        readinessBundle:
          "/tmp/controller-context/verify-control-worker-readiness.cjs",
        dispose: async () => {},
      }),
      capture: async () => "",
      readInventory: async () => [
        machine({
          id: "primary",
          state: "started",
          fingerprint,
          command: ["node", "/app/control-worker.cjs"],
        }),
      ],
      run: async (command, args) => {
        commands.push({ command, args });
      },
      wait: async () => {},
      write: () => {},
    },
  });
  assert.equal(result.action, "skipped");
  assert.deepEqual(commands, [
    {
      command: "flyctl",
      args: [
        "ssh",
        "console",
        "--app",
        "kestrel-one-control-worker",
        "--command",
        "node /app/verify-control-worker-readiness.cjs --contract-only",
      ],
    },
  ]);
});

test("controller deployment retries readiness while initialization completes", async () => {
  const fingerprint = "f".repeat(64);
  const digest = `sha256:${"2".repeat(64)}`;
  const inventory = [
    machine({ id: "primary", state: "started", fingerprint: "old" }),
  ];
  let readinessChecks = 0;
  const waits: number[] = [];

  await deployControlWorkerCandidate({
    revision,
    accessToken: "token",
    dependencies: {
      buildArtifact: async () => ({
        contextDirectory: "/tmp/controller-context",
        dockerfile: "/tmp/controller-context/Dockerfile",
        fingerprint,
        runtimeInputs: [],
        workerBundle: "/tmp/controller-context/control-worker.cjs",
        readinessBundle:
          "/tmp/controller-context/verify-control-worker-readiness.cjs",
        dispose: async () => {},
      }),
      capture: async () =>
        JSON.stringify([
          `registry.fly.io/kestrel-one-control-worker@${digest}`,
        ]),
      readInventory: async () => structuredClone(inventory),
      run: async (command, args) => {
        if (command === "flyctl" && args[0] === "machine") {
          inventory[0]!.config.init.cmd = ["node", "/app/control-worker.cjs"];
          inventory[0]!.image_ref.digest = digest;
          inventory[0]!.image_ref.labels[
            "org.kestrel.control-worker.fingerprint"
          ] = fingerprint;
        }
        if (command === "flyctl" && args[0] === "ssh") {
          readinessChecks += 1;
          if (readinessChecks < 3) throw new Error("controller not ready");
        }
      },
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      write: () => {},
    },
  });

  assert.equal(readinessChecks, 3);
  assert.deepEqual(waits, [2_000, 2_000]);
});

test("release workflow waits for exact production identity before non-deploying candidate publication", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/fly-image-release.yml", root),
    "utf8",
  );
  const wait = workflow.indexOf(
    "Wait for the exact Kestrel One production revision",
  );
  const preflight = workflow.indexOf("Preflight release publication");
  const publish = workflow.indexOf(
    "Build, smoke, and publish the complete candidate",
  );
  assert.ok(wait >= 0);
  assert.ok(preflight > wait);
  assert.ok(publish > preflight);
  assert.match(
    workflow,
    /wait-for-kestrel-production-revision\.ts \$\{\{ github\.sha \}\}/u,
  );
  assert.match(workflow, /run: pnpm release:fly-images/u);
  const waitScript = await readFile(
    new URL("scripts/wait-for-kestrel-production-revision.ts", root),
    "utf8",
  );
  assert.match(waitScript, /releaseCompatibilitySchema\?\.ready === true/u);
});

test("release workflow publishes controller evidence without Machine mutation", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/fly-image-release.yml", root),
    "utf8",
  );
  const publisherScript = await readFile(
    new URL("apps/web/scripts/publish-control-worker-candidate.ts", root),
    "utf8",
  );
  assert.doesNotMatch(workflow, /for attempt in \$\(seq 1 45\); do/u);
  assert.match(publisherScript, /publishControlWorkerImage/u);
  assert.doesNotMatch(publisherScript, /deployControlWorkerCandidate/u);
  assert.doesNotMatch(publisherScript, /readInventory|machine["',\s]+update/u);
  assert.doesNotMatch(workflow, /deploy-control-worker-candidate/u);
  assert.doesNotMatch(workflow, /machine (?:list|status|update)|flyctl logs/u);
});

test("publish-candidate contains no controller deployment step", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/fly-image-release.yml", root),
    "utf8",
  );
  const publish = workflow.indexOf(
    "Build, smoke, and publish the complete candidate",
  );
  assert.ok(publish >= 0);
  assert.doesNotMatch(
    workflow,
    /id: (?:deploy|restore|verify)-release-controller/u,
  );
  assert.doesNotMatch(workflow, /release:control-worker/u);
});

test("controller image and Fly process use the bundled entrypoint", async () => {
  const [dockerfile, flyConfig] = await Promise.all([
    readFile(
      new URL("deploy/fly/kestrel-one-control-worker/Dockerfile", root),
      "utf8",
    ),
    readFile(
      new URL("deploy/fly/kestrel-one-control-worker/fly.toml", root),
      "utf8",
    ),
  ]);
  assert.equal(dockerfile.match(/^FROM /gmu)?.length, 1);
  assert.match(dockerfile, /FROM node:22-bookworm-slim/u);
  assert.match(
    dockerfile,
    /COPY control-worker\.cjs verify-control-worker-readiness\.cjs/u,
  );
  assert.match(dockerfile, /CMD \["node", "\/app\/control-worker\.cjs"\]/u);
  assert.match(
    dockerfile,
    /LABEL org\.opencontainers\.image\.revision=\$KESTREL_GIT_SHA/u,
  );
  assert.match(
    dockerfile,
    /LABEL org\.kestrel\.control-worker\.fingerprint=\$KESTREL_CONTROL_WORKER_FINGERPRINT/u,
  );
  assert.doesNotMatch(dockerfile, /web:prepare/u);
  assert.doesNotMatch(dockerfile, /next:build/u);
  assert.doesNotMatch(dockerfile, /pnpm|node_modules|apps\/web|packages\//u);
  assert.match(flyConfig, /worker = "node \/app\/control-worker\.cjs"/u);
  assert.doesNotMatch(flyConfig, /pnpm/u);
});

test("manual controller recovery publishes and smokes the shared artifact before rolling deploy", async () => {
  const releaseScript = await readFile(
    new URL("apps/web/scripts/release-control-worker.ts", root),
    "utf8",
  );
  const buildShared = releaseScript.indexOf(
    'run("pnpm", ["run", "build:shared"])',
  );
  const buildArtifact = releaseScript.indexOf(
    "await buildControlWorkerArtifact()",
  );
  const publish = releaseScript.indexOf("await publishControlWorkerImage");
  const rollingDeploy = releaseScript.indexOf(
    '"--image",\n        published.taggedImage',
    publish,
  );
  assert.ok(buildShared >= 0);
  assert.ok(buildArtifact > buildShared);
  assert.ok(publish > buildArtifact);
  assert.ok(rollingDeploy > publish);
  assert.match(releaseScript, /buildControlWorkerArtifact/u);
  assert.match(releaseScript, /artifact\.dispose\(\)/u);
});

test("controller bundles are deterministic and load their complete entrypoints", async () => {
  const first = await buildControlWorkerArtifact();
  const second = await buildControlWorkerArtifact();
  try {
    assert.equal(first.fingerprint, second.fingerprint);
    assert.ok(
      first.runtimeInputs.some((path) =>
        path.endsWith("apps/web/lib/environments/reconcile-schedule.ts"),
      ),
    );
    await assert.rejects(
      execFileAsync("node", [first.workerBundle]),
      /Hosted Environment configuration is incomplete/u,
    );
    await assert.rejects(
      execFileAsync("node", [first.readinessBundle]),
      /Expected controller revision is required/u,
    );
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
  }
});

test("controller fingerprint includes artifact bytes and migration inputs", async () => {
  assert.ok(
    CONTROL_WORKER_FINGERPRINT_PATHS.includes("apps/web/lib/db/migrations"),
  );
  assert.ok(
    CONTROL_WORKER_FINGERPRINT_PATHS.includes(
      "apps/web/lib/db/contract-migrations",
    ),
  );
  const directory = await mkdtemp(
    join(tmpdir(), "controller-fingerprint-test-"),
  );
  const worker = join(directory, "control-worker.cjs");
  const readiness = join(directory, "verify-control-worker-readiness.cjs");
  const migration = join(directory, "migration.sql");
  await Promise.all([
    writeFile(worker, "worker-a"),
    writeFile(readiness, "readiness-a"),
    writeFile(migration, "migration-a"),
  ]);
  const fingerprint = () =>
    fingerprintControlWorkerArtifact({
      root: directory,
      bundles: [worker, readiness],
      dependencies: { capture: async () => "migration.sql" },
    });
  try {
    const initial = await fingerprint();
    await writeFile(migration, "migration-b");
    assert.notEqual(await fingerprint(), initial);
    await writeFile(migration, "migration-a");
    await writeFile(worker, "worker-b");
    assert.notEqual(await fingerprint(), initial);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

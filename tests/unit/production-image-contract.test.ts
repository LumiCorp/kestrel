import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  flyImageCatalogSchema,
  productionImageTagSchema,
} from "../../scripts/production-image-contract.js";
import {
  deployProductionFlyMachine,
  flyMachineListArgs,
  flyMachineStateArgs,
  flyMachineUpdateArgs,
  flyMachineWaitArgs,
  parseFlyMachineDeploymentArgs,
  summarizeFlyMachineForOutput,
} from "../../scripts/deploy-production-fly-machine.js";
import {
  assertProductionImageCanaryEnvironment,
  parsePublishProductionImageArgs,
  productionImageBuildCommands,
  publishProductionImage,
} from "../../scripts/publish-production-image.js";

const tag = "operator-aug16";

const previewEdgeServices = [
  {
    protocol: "tcp",
    internal_port: 8080,
    ports: [
      { port: 80, handlers: ["http"], force_https: true },
      { port: 443, handlers: ["tls", "http"] },
    ],
  },
];

test("operator tags follow the ordinary container tag contract", () => {
  assert.equal(
    productionImageTagSchema.parse("operator-aug16"),
    "operator-aug16",
  );
  assert.throws(() => productionImageTagSchema.parse("not a tag"));
});

test("local publication builds one amd64 image, smokes it, then pushes", () => {
  assert.deepEqual(
    parsePublishProductionImageArgs([
      "--",
      "--role",
      "preview-edge",
      "--tag",
      tag,
    ]),
    { role: "preview-edge", tag },
  );
  const commands = productionImageBuildCommands({
    dockerfile: "Dockerfile",
    image: `registry.fly.io/example:${tag}`,
    tag,
    smoke: "smoke.sh",
  });
  assert.deepEqual(
    commands.map((command) => `${command.command} ${command.args[0]}`),
    ["docker buildx", "bash smoke.sh", "docker push", "docker image"],
  );
  assert.match(commands[0].args.join(" "), /--platform linux\/amd64/u);
});

test("hosted approval image publication has no protocol selector", () => {
  assert.deepEqual(
    parsePublishProductionImageArgs(["--role", "turn-worker", "--tag", tag]),
    { role: "turn-worker", tag },
  );
  assert.throws(() =>
    parsePublishProductionImageArgs([
      "--role",
      "turn-worker",
      "--tag",
      tag,
      "--approval-protocol",
      "v4",
    ]),
  );
});

test("Browser worker publishes normally but cannot use the fixed-Machine updater", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const result = await publishProductionImage(
    ["--role", "browser-worker", "--tag", tag],
    (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout:
          command === "docker" && args[0] === "image"
            ? `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}\n`
            : "",
      };
    },
    {},
  );

  assert.equal(
    result.digestImage,
    `registry.fly.io/kestrel-one-browser-worker@sha256:${"a".repeat(64)}`,
  );
  assert.deepEqual(
    calls.map(({ command, args }) => `${command} ${args[0]}`),
    [
      "pnpm run",
      "docker buildx",
      "bash deploy/fly/kestrel-one-browser-worker/smoke.sh",
      "docker push",
      "docker image",
    ],
  );
  assert.match(
    calls[1]!.args.join(" "),
    /deploy\/fly\/kestrel-one-browser-worker\/Dockerfile/u,
  );
  assert.deepEqual(calls[0], {
    command: "pnpm",
    args: ["run", "browser:runtime:stage:hosted"],
  });
  assert.throws(
    () =>
      parseFlyMachineDeploymentArgs([
        "--role",
        "browser-worker",
        "--machine",
        "abc123",
        "--tag",
        tag,
      ]),
    /not a directly deployed Fly Machine role/u,
  );
});

test("Browser worker catalog contract requires session rollout and verified asset staging", async () => {
  const catalog = JSON.parse(
    await readFile("deploy/fly/image-catalog.json", "utf8"),
  ) as {
    images: Array<{ role: string; rollout: string; prepare?: string }>;
  };
  assert.doesNotThrow(() => flyImageCatalogSchema.parse(catalog));

  const wrongRollout = structuredClone(catalog);
  wrongRollout.images.find(({ role }) => role === "browser-worker")!.rollout =
    "global-app";
  assert.throws(
    () => flyImageCatalogSchema.parse(wrongRollout),
    /Browser worker must use session rollout/u,
  );

  const missingPrepare = structuredClone(catalog);
  delete missingPrepare.images.find(({ role }) => role === "browser-worker")!
    .prepare;
  assert.throws(
    () => flyImageCatalogSchema.parse(missingPrepare),
    /verified runtime staging/u,
  );
});

test("attachment-owning image publication requires the live signed canary environment", () => {
  for (const role of ["turn-worker", "workspace-runtime"]) {
    assert.throws(
      () => assertProductionImageCanaryEnvironment(role, {}),
      /KESTREL_ONE_APP_URL/u,
    );
    assert.throws(
      () =>
        assertProductionImageCanaryEnvironment(role, {
          KESTREL_ONE_APP_URL: "https://kestrelagents.dev",
        }),
      /KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY/u,
    );
    assert.doesNotThrow(() =>
      assertProductionImageCanaryEnvironment(role, {
        KESTREL_ONE_APP_URL: "https://kestrelagents.dev",
        KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY: "configured",
      }),
    );
  }
  assert.doesNotThrow(() =>
    assertProductionImageCanaryEnvironment("preview-edge", {}),
  );
});

test("attachment-owning image smokes gate publication on exact-build canary evidence", async () => {
  const [
    turnWorkerSmoke,
    workspaceRuntimeSmoke,
    workspaceDockerfile,
    turnWorkerDockerfile,
  ] = await Promise.all([
    readFile("deploy/fly/kestrel-one-turn-worker/smoke.sh", "utf8"),
    readFile("apps/workspace-runtime/scripts/image-smoke.sh", "utf8"),
    readFile("apps/workspace-runtime/Dockerfile", "utf8"),
    readFile("deploy/fly/kestrel-one-turn-worker/Dockerfile", "utf8"),
  ]);
  for (const source of [turnWorkerSmoke, workspaceRuntimeSmoke]) {
    assert.match(source, /KESTREL_ONE_APP_URL/u);
    assert.match(source, /KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY/u);
    assert.match(source, /attachment-canary/u);
    assert.match(source, /evidence\.buildId !== process\.argv\[2\]/u);
    assert.match(source, /\$\{image##\*:\}/u);
  }
  for (const dockerfile of [workspaceDockerfile, turnWorkerDockerfile]) {
    assert.doesNotMatch(dockerfile, /KESTREL_HOSTED_APPROVAL_PROTOCOL/u);
    assert.doesNotMatch(dockerfile, /hosted-approval-producer/u);
  }
  assert.match(workspaceDockerfile, /KESTREL_BUILD_ID=\$KESTREL_BUILD_ID/u);
});

test("local real-model qualification accepts and preserves exact prebuilt runtime images", async () => {
  const canary = await readFile(
    "apps/workspace-runtime/scripts/local-image-pair-canary.ts",
    "utf8",
  );
  assert.match(canary, /--workspace-image/u);
  assert.match(canary, /--router-image/u);
  assert.match(canary, /must be provided together/u);
  assert.match(canary, /imageSource: selectedImages \? "prebuilt"/u);
  assert.match(
    canary,
    /if \(!selectedImages\) \{[\s\S]*docker\("image", "rm"/u,
  );
  assert.match(canary, /modelTimeoutMs: 60_000/u);
  assert.match(canary, /signal: AbortSignal\.timeout\(90_000\)/u);
  assert.match(canary, /abortBehavior: "cancel"/u);
  assert.match(canary, /`FLY_MACHINE_ID=\$\{gatewayId\}`/u);
  assert.match(canary, /additionalToolNames: \["exec_command"\]/u);
  assert.match(
    canary,
    /kestrelOneAppApprovalModes: \{ exec_command: "auto" \}/u,
  );
});

test("partial Docker build contexts include root pnpm patches before install", async () => {
  const dockerfiles = await Promise.all(
    [
      "apps/environment-router/Dockerfile",
      "apps/mcp-service/Dockerfile",
      "apps/preview-edge/Dockerfile",
      "apps/workspace-runtime/Dockerfile",
    ].map((file) => readFile(file, "utf8")),
  );

  for (const dockerfile of dockerfiles) {
    const patchCopy = dockerfile.indexOf("COPY patches patches");
    const dependencyInstall = dockerfile.indexOf(
      "RUN pnpm install --frozen-lockfile",
    );
    assert.ok(
      patchCopy >= 0 && patchCopy < dependencyInstall,
      "root pnpm patches must be available before a partial-context install",
    );
  }
});

test("Environment Router image closes over every workspace dependency", async () => {
  const [dockerfile, manifestSource, server, smoke] = await Promise.all([
    readFile("apps/environment-router/Dockerfile", "utf8"),
    readFile("apps/environment-router/package.json", "utf8"),
    readFile("apps/environment-router/src/server.ts", "utf8"),
    readFile("apps/environment-router/scripts/image-smoke.sh", "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource) as {
    dependencies: Record<string, string>;
    scripts: { build: string };
  };
  const packageDirectories: Record<string, string> = {
    "@kestrel-agents/conversation": "packages/conversation",
    "@kestrel-agents/protocol": "packages/protocol",
    "@kestrel/mcp-security": "packages/mcp-security",
    "@lumi/kestrel-environment-auth": "packages/environment-auth",
  };

  assert.deepEqual(
    Object.entries(manifest.dependencies)
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name)
      .sort(),
    Object.keys(packageDirectories).sort(),
  );
  for (const [packageName, packageDirectory] of Object.entries(
    packageDirectories,
  )) {
    assert.match(
      dockerfile,
      new RegExp(
        `COPY ${packageDirectory.replace("/", "\\/")}\\/package\\.json ${packageDirectory.replace("/", "\\/")}\\/package\\.json`,
        "u",
      ),
    );
    assert.match(
      dockerfile,
      new RegExp(
        `COPY ${packageDirectory.replace("/", "\\/")} ${packageDirectory.replace("/", "\\/")}`,
        "u",
      ),
    );
    assert.match(manifest.scripts.build, new RegExp(packageName, "u"));
  }
  const contractRevision = server.match(
    /const ENVIRONMENT_GATEWAY_CONTRACT_REVISION = (\d+);/u,
  )?.[1];
  assert.ok(contractRevision);
  assert.match(
    smoke,
    new RegExp(`health\\.runtimeContractRevision !== ${contractRevision}`, "u"),
  );
  assert.match(smoke, /--env FLY_MACHINE_ID=gateway-smoke-machine/u);
});

test("Fly image contexts exclude host-staged Vercel native bindings", async () => {
  const dockerignores = await Promise.all(
    [
      ".dockerignore",
      "deploy/fly/kestrel-one-control-worker/Dockerfile.dockerignore",
      "deploy/fly/kestrel-one-turn-worker/Dockerfile.dockerignore",
      "deploy/fly/kestrel-one-runpod-worker/Dockerfile.dockerignore",
    ].map((file) => readFile(file, "utf8")),
  );

  for (const dockerignore of dockerignores) {
    assert.match(
      dockerignore,
      /^apps\/web\/\.kestrel-runtime$/mu,
      "a host-native Vercel binding must never enter a Linux image context",
    );
  }
});

test("local Fly deployment names one platform Machine and operator tag", () => {
  assert.deepEqual(
    parseFlyMachineDeploymentArgs([
      "--",
      "--role",
      "preview-edge",
      "--machine",
      "e2865",
      "--tag",
      tag,
    ]),
    { role: "preview-edge", machineId: "e2865", tag },
  );
  assert.deepEqual(flyMachineListArgs("example"), [
    "machine",
    "list",
    "--app",
    "example",
    "--json",
  ]);
  assert.deepEqual(
    flyMachineUpdateArgs({
      app: "example",
      image: `registry.fly.io/kestrel-preview-edge:${tag}`,
      machineId: "e2865",
      state: "started",
    }),
    [
      "machine",
      "update",
      "e2865",
      "--app",
      "example",
      "--image",
      `registry.fly.io/kestrel-preview-edge:${tag}`,
      "--yes",
    ],
  );
  assert.deepEqual(
    flyMachineUpdateArgs({
      app: "example",
      image: `registry.fly.io/kestrel-preview-edge:${tag}`,
      machineId: "e2865",
      state: "stopped",
    }),
    [
      "machine",
      "update",
      "e2865",
      "--app",
      "example",
      "--image",
      `registry.fly.io/kestrel-preview-edge:${tag}`,
      "--yes",
      "--skip-start",
    ],
  );
  assert.deepEqual(
    flyMachineStateArgs({
      action: "start",
      app: "example",
      machineId: "e2865",
    }),
    ["machine", "start", "e2865", "--app", "example"],
  );
  assert.deepEqual(
    flyMachineStateArgs({
      action: "stop",
      app: "example",
      machineId: "e2865",
    }),
    ["machine", "stop", "e2865", "--app", "example"],
  );
  assert.deepEqual(
    flyMachineWaitArgs({
      app: "example",
      machineId: "e2865",
      state: "started",
    }),
    [
      "machine",
      "wait",
      "e2865",
      "--app",
      "example",
      "--state",
      "started",
      "--wait-timeout",
      "2m",
    ],
  );
});

test("local Fly deployment output excludes Machine configuration and credentials", () => {
  const summary = summarizeFlyMachineForOutput({
    id: "worker1",
    state: "started",
    region: "iad",
    image_ref: {
      repository: "registry.fly.io/kestrel-one-control-worker",
      tag,
    },
    config: {
      env: {
        SECRET_TOKEN: "must-not-appear",
      },
      metadata: {
        private: "must-not-appear",
      },
    },
  });

  assert.deepEqual(summary, {
    id: "worker1",
    state: "started",
    region: "iad",
    image: {
      repository: "registry.fly.io/kestrel-one-control-worker",
      tag,
    },
  });
  assert.ok(!JSON.stringify(summary).includes("must-not-appear"));
});

test("local Fly deployment selects the exact Machine from provider lists", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let listCount = 0;
  const result = await deployProductionFlyMachine(
    ["--role", "preview-edge", "--machine", "e2865", "--tag", tag],
    (command, args) => {
      calls.push({ command, args });
      if (args[0] === "auth")
        return { status: 0, stdout: "operator@example.com\n" };
      if (args[0] === "machine" && args[1] === "list") {
        listCount += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            { id: "sibling", state: "started" },
            {
              id: "e2865",
              state: "started",
              image_ref: { tag: listCount === 1 ? "old" : tag },
              config: { services: previewEdgeServices },
            },
          ]),
        };
      }
      if (args[0] === "machine" && args[1] === "update") {
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
    async () => {},
  );

  assert.equal(result.before.id, "e2865");
  assert.equal(result.after.id, "e2865");
  assert.equal(calls.filter(({ args }) => args[1] === "list").length, 2);
  assert.equal(calls.filter(({ args }) => args[1] === "update").length, 1);
  assert.ok(calls.every(({ args }) => !args.includes("status")));
});

test("local Fly deployment refuses a transitional Machine before mutation", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  await assert.rejects(
    deployProductionFlyMachine(
      ["--role", "control-worker", "--machine", "worker1", "--tag", tag],
      (command, args) => {
        calls.push({ command, args });
        if (args[0] === "auth") {
          return { status: 0, stdout: "operator@example.com\n" };
        }
        if (args[0] === "machine" && args[1] === "list") {
          return {
            status: 0,
            stdout: JSON.stringify([{ id: "worker1", state: "replacing" }]),
          };
        }
        return { status: 0, stdout: "" };
      },
      async () => {},
    ),
    /must be stably started or stopped before an image update/u,
  );
  assert.equal(calls.filter(({ args }) => args[1] === "update").length, 0);
});

test("local Fly deployment restores a started Machine after an image update stops it", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let listCount = 0;
  let waitedForStarted = false;
  const result = await deployProductionFlyMachine(
    ["--role", "control-worker", "--machine", "worker1", "--tag", tag],
    (command, args) => {
      calls.push({ command, args });
      if (args[0] === "auth") {
        return { status: 0, stdout: "operator@example.com\n" };
      }
      if (args[0] === "machine" && args[1] === "list") {
        listCount += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "worker1",
              state:
                listCount === 1 || waitedForStarted ? "started" : "stopped",
              image_ref: { tag: listCount === 1 ? "old" : tag },
            },
          ]),
        };
      }
      if (
        args[0] === "machine" &&
        (args[1] === "update" || args[1] === "start")
      ) {
        return { status: 0, stdout: "" };
      }
      if (args[0] === "machine" && args[1] === "wait") {
        waitedForStarted = true;
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
    async () => {},
  );

  assert.equal(result.before.state, "started");
  assert.equal(result.after.state, "started");
  assert.equal(calls.filter(({ args }) => args[1] === "start").length, 1);
  assert.equal(calls.filter(({ args }) => args[1] === "wait").length, 1);
  assert.equal(calls.filter(({ args }) => args[1] === "list").length, 3);
});

test("local Fly deployment keeps an ordinary stopped Machine stopped during update", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let listCount = 0;
  const result = await deployProductionFlyMachine(
    ["--role", "turn-worker", "--machine", "standby1", "--tag", tag],
    (command, args) => {
      calls.push({ command, args });
      if (args[0] === "auth") {
        return { status: 0, stdout: "operator@example.com\n" };
      }
      if (args[0] === "machine" && args[1] === "list") {
        listCount += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "standby1",
              state: "stopped",
              image_ref: { tag: listCount === 1 ? "old" : tag },
            },
          ]),
        };
      }
      if (args[0] === "machine" && args[1] === "update") {
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
    async () => {},
  );

  assert.equal(result.before.state, "stopped");
  assert.equal(result.after.state, "stopped");
  const update = calls.find(({ args }) => args[1] === "update");
  assert.ok(update?.args.includes("--skip-start"));
  assert.equal(calls.filter(({ args }) => args[1] === "start").length, 0);
  assert.equal(calls.filter(({ args }) => args[1] === "stop").length, 0);
  assert.equal(calls.filter(({ args }) => args[1] === "wait").length, 0);
  assert.equal(calls.filter(({ args }) => args[1] === "list").length, 2);
});

test("local Fly deployment restores a stopped Machine if an image update starts it", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let listCount = 0;
  let waitedForStopped = false;
  const result = await deployProductionFlyMachine(
    ["--role", "turn-worker", "--machine", "standby1", "--tag", tag],
    (command, args) => {
      calls.push({ command, args });
      if (args[0] === "auth") {
        return { status: 0, stdout: "operator@example.com\n" };
      }
      if (args[0] === "machine" && args[1] === "list") {
        listCount += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "standby1",
              state:
                listCount === 1 || waitedForStopped ? "stopped" : "started",
              image_ref: { tag: listCount === 1 ? "old" : tag },
            },
          ]),
        };
      }
      if (
        args[0] === "machine" &&
        (args[1] === "update" || args[1] === "stop")
      ) {
        return { status: 0, stdout: "" };
      }
      if (args[0] === "machine" && args[1] === "wait") {
        waitedForStopped = true;
        return { status: 0, stdout: "" };
      }
      return { status: 1, stdout: "" };
    },
    async () => {},
  );

  assert.equal(result.before.state, "stopped");
  assert.equal(result.after.state, "stopped");
  const update = calls.find(({ args }) => args[1] === "update");
  assert.ok(update?.args.includes("--skip-start"));
  assert.equal(calls.filter(({ args }) => args[1] === "stop").length, 1);
  assert.equal(calls.filter(({ args }) => args[1] === "wait").length, 1);
  assert.equal(calls.filter(({ args }) => args[1] === "list").length, 3);
});

test("Preview Edge image deployment refuses missing or invalid ingress before mutation", async () => {
  const invalidServices = [
    undefined,
    [
      {
        protocol: "tcp",
        internal_port: 8080,
        ports: [{ port: 80, handlers: ["http"], force_https: true }],
      },
    ],
    [
      {
        protocol: "tcp",
        internal_port: 8081,
        ports: [
          { port: 80, handlers: ["http"], force_https: false },
          { port: 443, handlers: ["tls", "http"] },
        ],
      },
    ],
  ];

  for (const services of invalidServices) {
    let updates = 0;
    await assert.rejects(
      deployProductionFlyMachine(
        ["--role", "preview-edge", "--machine", "e2865", "--tag", tag],
        (_command, args) => {
          if (args[0] === "auth")
            return { status: 0, stdout: "operator@example.com\n" };
          if (args[0] === "machine" && args[1] === "list") {
            return {
              status: 0,
              stdout: JSON.stringify([
                { id: "e2865", state: "started", config: { services } },
              ]),
            };
          }
          if (args[0] === "machine" && args[1] === "update") updates += 1;
          return { status: 0, stdout: "" };
        },
        async () => {},
      ),
      /Preview Edge Machine e2865 is missing its public ingress contract before image update/u,
    );
    assert.equal(updates, 0);
  }
});

test("Preview Edge image deployment rejects ingress stripped by the provider update", async () => {
  let lists = 0;
  let updates = 0;
  await assert.rejects(
    deployProductionFlyMachine(
      ["--role", "preview-edge", "--machine", "e2865", "--tag", tag],
      (_command, args) => {
        if (args[0] === "auth")
          return { status: 0, stdout: "operator@example.com\n" };
        if (args[0] === "machine" && args[1] === "list") {
          lists += 1;
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                id: "e2865",
                state: "started",
                config: {
                  services: lists === 1 ? previewEdgeServices : undefined,
                },
              },
            ]),
          };
        }
        if (args[0] === "machine" && args[1] === "update") {
          updates += 1;
          return { status: 0, stdout: "" };
        }
        return { status: 1, stdout: "" };
      },
      async () => {},
    ),
    /Preview Edge Machine e2865 is missing its public ingress contract after image update/u,
  );
  assert.equal(updates, 1);
});

test("service-less worker image deployment remains supported", async () => {
  let lists = 0;
  const result = await deployProductionFlyMachine(
    ["--role", "control-worker", "--machine", "worker1", "--tag", tag],
    (_command, args) => {
      if (args[0] === "auth")
        return { status: 0, stdout: "operator@example.com\n" };
      if (args[0] === "machine" && args[1] === "list") {
        lists += 1;
        return {
          status: 0,
          stdout: JSON.stringify([
            {
              id: "worker1",
              state: "started",
              image_ref: { tag: lists === 1 ? "old" : tag },
            },
          ]),
        };
      }
      if (args[0] === "machine" && args[1] === "update")
        return { status: 0, stdout: "" };
      return { status: 1, stdout: "" };
    },
    async () => {},
  );

  assert.equal(result.role, "control-worker");
  assert.equal(lists, 2);
});

test("tenant runtime catalog roles publish from exact public GHCR repositories", async () => {
  const releaseCatalog = flyImageCatalogSchema.parse(
    JSON.parse(
      await readFile(
        path.join(process.cwd(), "deploy/fly/image-catalog.json"),
        "utf8",
      ),
    ),
  );
  assert.deepEqual(
    releaseCatalog.images
      .filter((entry) => entry.rollout === "environment")
      .map(({ role, publisher, repository }) => ({
        role,
        publisher,
        repository,
      })),
    [
      {
        role: "workspace-runtime",
        publisher: "ghcr",
        repository: "ghcr.io/lumicorp/kestrel-workspace-runtime",
      },
      {
        role: "environment-router",
        publisher: "ghcr",
        repository: "ghcr.io/lumicorp/kestrel-environment-router",
      },
    ],
  );
});

test("every production image role has a live-proof rollout overlay", async () => {
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(
      await readFile(
        path.join(process.cwd(), "deploy/fly/image-catalog.json"),
        "utf8",
      ),
    ),
  );
  const rolloutByRole: Record<string, string> = {
    "workspace-runtime": "deploy/fly/environment-runtime/ROLLOUT.md",
    "environment-router": "deploy/fly/environment-runtime/ROLLOUT.md",
    "preview-edge": "apps/preview-edge/ROLLOUT.md",
    "turn-worker": "deploy/fly/kestrel-one-turn-worker/ROLLOUT.md",
    "control-worker": "deploy/fly/kestrel-one-control-worker/ROLLOUT.md",
    "runpod-worker": "deploy/fly/kestrel-one-runpod-worker/ROLLOUT.md",
    "browser-worker": "deploy/fly/kestrel-one-browser-worker/ROLLOUT.md",
  };
  const rolloutEntries = await Promise.all(
    Object.entries(rolloutByRole).map(
      async ([role, rolloutPath]) =>
        [
          role,
          await readFile(path.join(process.cwd(), rolloutPath), "utf8"),
        ] as const,
    ),
  );
  const rollouts = new Map(rolloutEntries);
  const [canonical, publicDocs, turnReadme, controlReadme, runpodReadme] =
    await Promise.all([
      readFile(
        path.join(process.cwd(), "docs/production-delivery-channels.md"),
        "utf8",
      ),
      readFile(
        path.join(
          process.cwd(),
          "apps/docs/content/operate/production-delivery.mdx",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          process.cwd(),
          "deploy/fly/kestrel-one-turn-worker/README.md",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          process.cwd(),
          "deploy/fly/kestrel-one-control-worker/README.md",
        ),
        "utf8",
      ),
      readFile(
        path.join(
          process.cwd(),
          "deploy/fly/kestrel-one-runpod-worker/README.md",
        ),
        "utf8",
      ),
    ]);

  assert.deepEqual(
    Object.keys(rolloutByRole).sort(),
    catalog.images.map(({ role }) => role).sort(),
  );
  for (const image of catalog.images) {
    const rollout = rollouts.get(image.role);
    assert.ok(rollout, `${image.role} is missing a rollout overlay`);
    assert.match(rollout, /production:image:publish/u);
    assert.match(rollout, /main` to `production/u);
    assert.match(rollout, /image smoke/iu);
    assert.match(rollout, /## Rollback/u);
    assert.match(
      canonical,
      new RegExp(rolloutByRole[image.role]!.replaceAll("/", "\\/"), "u"),
    );
  }

  for (const image of catalog.images.filter(
    ({ rollout }) => rollout === "global-app",
  )) {
    const rollout = rollouts.get(image.role)!;
    assert.match(rollout, /production:fly:machine/u);
    assert.match(rollout, /## 4\. Update started Machines first/u);
    assert.match(rollout, /## 6\. Update stopped Machines/u);
    assert.match(rollout, /one\s+exact\s+Machine/iu);
    assert.match(rollout, /work|preview|Knowledge|turn/iu);
  }

  const runtimeRollout = rollouts.get("workspace-runtime")!;
  assert.equal(runtimeRollout, rollouts.get("environment-router"));
  assert.match(runtimeRollout, /same tag/u);
  assert.match(runtimeRollout, /environment\.update\.ready/u);
  assert.match(runtimeRollout, /canary:environment:workspace/u);
  assert.match(runtimeRollout, /canary:environment:preview/u);
  assert.match(runtimeRollout, /production:runtime:activate/u);
  assert.match(runtimeRollout, /no batch rollout/iu);

  for (const readme of [turnReadme, controlReadme, runpodReadme]) {
    assert.match(readme, /\.\/ROLLOUT\.md/u);
    assert.match(readme, /Readiness is provider-native/u);
    assert.match(readme, /image smoke/iu);
  }
  assert.match(publicDocs, /Update and verify started Machines before/u);
  assert.match(publicDocs, /live\s+work-delivery proof/u);
  assert.match(publicDocs, /provider-spend/u);
});

test("workspace-runtime image builds and carries the shared memory package", async () => {
  const dockerfile = await readFile(
    path.join(process.cwd(), "apps/workspace-runtime/Dockerfile"),
    "utf8",
  );
  const releaseCatalog = JSON.parse(
    await readFile(
      path.join(process.cwd(), "deploy/fly/image-catalog.json"),
      "utf8",
    ),
  ) as { images: Array<{ role: string }> };
  const workspaceRuntime = releaseCatalog.images.find(
    (entry) => entry.role === "workspace-runtime",
  );

  assert.ok(workspaceRuntime, "workspace-runtime image must be registered");
  const memoryManifestCopy = dockerfile.indexOf(
    "COPY packages/memory/package.json packages/memory/package.json",
  );
  const dependencyInstall = dockerfile.indexOf(
    "RUN pnpm install --frozen-lockfile",
  );
  assert.ok(
    memoryManifestCopy >= 0 && memoryManifestCopy < dependencyInstall,
    "the memory manifest must be present before pnpm install",
  );
  const memorySourceCopy = dockerfile.indexOf(
    "COPY packages/memory packages/memory",
  );
  const memoryBuild = dockerfile.indexOf(
    "pnpm --filter @kestrel-agents/memory build",
  );
  assert.ok(
    memorySourceCopy >= 0 && memorySourceCopy < memoryBuild,
    "the memory sources must be present in the build stage",
  );
  assert.ok(
    memoryBuild >= 0 && memoryBuild < dockerfile.indexOf("pnpm run clean"),
    "the memory package must be built before the root runtime",
  );
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/packages\/memory \.\/packages\/memory/u,
    "the memory package must be present behind the production workspace symlink",
  );
});

test("workspace-runtime image carries the Conversation package used by the CLI", async () => {
  const dockerfile = await readFile(
    path.join(process.cwd(), "apps/workspace-runtime/Dockerfile"),
    "utf8",
  );
  const conversationManifestCopy = dockerfile.indexOf(
    "COPY packages/conversation/package.json packages/conversation/package.json",
  );
  const dependencyInstall = dockerfile.indexOf(
    "RUN pnpm install --frozen-lockfile",
  );
  assert.ok(
    conversationManifestCopy >= 0 &&
      conversationManifestCopy < dependencyInstall,
    "the Conversation manifest must be present before pnpm install",
  );
  const conversationSourceCopy = dockerfile.indexOf(
    "COPY packages/conversation packages/conversation",
  );
  const conversationBuild = dockerfile.indexOf(
    "pnpm --filter @kestrel-agents/conversation build",
  );
  assert.ok(
    conversationSourceCopy >= 0 && conversationSourceCopy < conversationBuild,
    "the Conversation sources must be present in the build stage",
  );
  assert.ok(
    conversationBuild >= 0 &&
      conversationBuild < dockerfile.indexOf("pnpm run clean"),
    "the Conversation package must be built before the root runtime",
  );
  assert.match(
    dockerfile,
    /COPY --from=build \/app\/packages\/conversation \.\/packages\/conversation/u,
    "the Conversation package must be present behind the production workspace symlink",
  );
});

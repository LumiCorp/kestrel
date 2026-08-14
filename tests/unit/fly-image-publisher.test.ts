import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  FLY_REGISTRY_PULL_ATTEMPTS,
  FLY_REGISTRY_PULL_RETRY_DELAY_MS,
  isFlyRegistryManifestUnavailable,
  publishFlyImages,
  pullPublishedImage,
  verifyAnonymousGhcrDigestPull,
  type FlyImagePublisherDependencies,
} from "../../scripts/fly-image-publisher.js";
import {
  flyImageReleaseCandidatePublicationResponseSchema,
  flyImageReleaseManifestV3Schema,
} from "../../apps/web/lib/releases/contracts.js";
import { RELEASE_CONTROLLER_CONTRACT_REVISION } from "../../apps/web/lib/releases/controller-contract.js";
import {
  captureStreamingCommand,
  runStreamingCommand,
  STREAMING_COMMAND_STDERR_TAIL_BYTES,
  StreamingCommandError,
} from "../../scripts/lib/streaming-command.js";
import { ReleaseArtifactAggregateError } from "../../scripts/fly-image-publisher.js";

const revision = "a".repeat(40);
const releaseId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const roles = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "runpod-worker",
] as const;

test("publisher exercises every image and survives Fly registry propagation", async () => {
  const harness = publisherHarness({ reusePublishedImages: false });
  const result = await publishFlyImages(harness.dependencies);

  assert.equal(result.published, true);
  assert.deepEqual(
    result.components.map((component) => component.role),
    roles,
  );
  assert.equal(harness.flyBuilds.length, 3);
  assert.equal(harness.ghcrBuilds.length, 2);
  assert.equal(harness.cosignCommands.length, 4);
  assert.equal(harness.smokes.length, roles.length);
  assert.equal(harness.maxActiveFlyBuilds, 3);
  assert.equal(harness.concurrentBuildsSharedAnApp, false);
  assert.deepEqual(harness.controllerBuildInputs, [
    { revision, attemptId, forceAll: true },
  ]);
  assert.deepEqual(
    harness.waits,
    roles.map(() => FLY_REGISTRY_PULL_RETRY_DELAY_MS),
  );
  assert.equal(harness.oidcRequests, 5);
  assert.equal(harness.preflightAuthorization, "Bearer oidc-token-1");
  assert.equal(harness.publicationAuthorization, "Bearer oidc-token-5");
  assert.deepEqual(
    harness.publishedManifest?.components.map(
      (component: { role: string }) => component.role,
    ),
    roles,
  );
  assert.equal(
    harness.publishedManifest?.controllerContractRevision,
    RELEASE_CONTROLLER_CONTRACT_REVISION,
  );
  assert.deepEqual(result.release, { id: releaseId, status: "candidate" });
  assert.match(
    harness.output.join(""),
    new RegExp(`Published Fly image release candidate ${releaseId}`, "u"),
  );
});

test("publisher reuses revision tags and still smokes every image", async () => {
  const harness = publisherHarness({ reusePublishedImages: true });
  const result = await publishFlyImages(harness.dependencies);

  assert.equal(result.published, true);
  assert.equal(harness.flyBuilds.length, 0);
  assert.equal(harness.smokes.length, roles.length);
  assert.equal(harness.waits.length, 0);
  assert.deepEqual(harness.controllerBuildInputs, [
    { revision, attemptId, forceAll: false },
  ]);
  assert.equal(
    harness.output.filter((message) =>
      message.startsWith("Reusing published image"),
    ).length,
    roles.length,
  );
});

test("publisher reports the candidate API error code", async () => {
  const harness = publisherHarness({
    reusePublishedImages: true,
    publicationFailureCode: "RELEASE_INCOMPLETE",
  });
  await assert.rejects(
    publishFlyImages(harness.dependencies),
    /409: RELEASE_INCOMPLETE/u,
  );
});

test("publisher waits for every artifact and reports all failures together", async () => {
  const harness = publisherHarness({
    reusePublishedImages: false,
    failingSmokeRoles: ["environment-router", "turn-worker"],
    controllerFailure: true,
  });
  await assert.rejects(
    publishFlyImages(harness.dependencies),
    (error: unknown) => {
      assert.ok(error instanceof ReleaseArtifactAggregateError);
      assert.deepEqual(error.failures.map((failure) => failure.role).sort(), [
        "environment-router",
        "release-controller",
        "turn-worker",
      ]);
      assert.match(
        error.message,
        /release-controller: controller smoke failed/u,
      );
      assert.match(
        error.message,
        /environment-router: environment-router smoke failed/u,
      );
      assert.match(error.message, /turn-worker: turn-worker smoke failed/u);
      return true;
    },
  );
  assert.equal(harness.smokes.length, roles.length);
  assert.equal(harness.attemptMutations.at(-1)?.action, "fail");
  assert.deepEqual(
    (harness.attemptMutations.at(-1)?.evidence as { failures?: unknown })
      .failures,
    [
      { role: "release-controller", message: "controller smoke failed" },
      {
        role: "environment-router",
        message: "environment-router smoke failed",
      },
      { role: "turn-worker", message: "turn-worker smoke failed" },
    ],
  );
});

test("publication preflight fails before any managed image command", async () => {
  const harness = publisherHarness({
    reusePublishedImages: false,
    preflightFailureCode: "RELEASE_MIGRATION_BLOCKED",
  });
  await assert.rejects(
    publishFlyImages(harness.dependencies),
    /409: RELEASE_MIGRATION_BLOCKED/u,
  );
  assert.equal(harness.flyBuilds.length, 0);
  assert.equal(harness.smokes.length, 0);
  assert.equal(harness.oidcRequests, 1);
  assert.equal(harness.publicationAuthorization, null);
});

test("publisher rejects malformed successful publication responses", async () => {
  for (const publicationResponse of [
    {},
    { release: { status: "candidate" } },
    { release: { id: "not-a-uuid", status: "candidate" } },
    { release: { id: releaseId, status: "completed" } },
  ]) {
    const harness = publisherHarness({
      reusePublishedImages: true,
      publicationResponse,
    });
    await assert.rejects(publishFlyImages(harness.dependencies));
  }
  assert.deepEqual(
    flyImageReleaseCandidatePublicationResponseSchema.parse({
      release: { id: releaseId, status: "candidate" },
    }),
    { release: { id: releaseId, status: "candidate" } },
  );
});

test("streaming commands have no output ceiling and retain bounded error evidence", async () => {
  const stdout = new PassThrough();
  let stdoutBytes = 0;
  stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
  });
  await runStreamingCommand(
    process.execPath,
    ["-e", 'process.stdout.write("x".repeat(3 * 1024 * 1024))'],
    { cwd: process.cwd(), stdout },
  );
  assert.equal(stdoutBytes, 3 * 1024 * 1024);

  const captured = await captureStreamingCommand(
    process.execPath,
    ["-e", 'process.stdout.write("y".repeat(3 * 1024 * 1024))'],
    { cwd: process.cwd() },
  );
  assert.equal(Buffer.byteLength(captured), 3 * 1024 * 1024);

  const stderr = new PassThrough();
  stderr.resume();
  let failure: unknown;
  try {
    await runStreamingCommand(
      process.execPath,
      [
        "-e",
        'process.stderr.end("discard-me" + "z".repeat(70 * 1024) + "manifest unknown", () => process.exit(7))',
      ],
      { cwd: process.cwd(), stderr },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof StreamingCommandError);
  assert.equal(failure.exitCode, 7);
  assert.equal(failure.code, 7);
  assert.equal(failure.signal, null);
  assert.ok(
    Buffer.byteLength(failure.stderr) <= STREAMING_COMMAND_STDERR_TAIL_BYTES,
  );
  assert.doesNotMatch(failure.stderr, /discard-me/u);
  assert.match(failure.stderr, /manifest unknown/u);
  assert.equal(isFlyRegistryManifestUnavailable(failure), true);

  let signalFailure: unknown;
  try {
    await runStreamingCommand(
      process.execPath,
      ["-e", 'process.kill(process.pid, "SIGTERM")'],
      { cwd: process.cwd(), stderr },
    );
  } catch (error) {
    signalFailure = error;
  }
  assert.ok(signalFailure instanceof StreamingCommandError);
  assert.equal(signalFailure.exitCode, null);
  assert.equal(signalFailure.code, null);
  assert.equal(signalFailure.signal, "SIGTERM");
});

test("registry retry is bounded and does not hide other Docker failures", async () => {
  let attempts = 0;
  const waits: number[] = [];
  await assert.rejects(
    pullPublishedImage(
      {
        run: async () => {
          attempts += 1;
          throw commandError("unauthorized: authentication required");
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
      "registry.fly.io/app:tag",
    ),
    /command failed/u,
  );
  assert.equal(attempts, 1);
  assert.equal(waits.length, 0);

  attempts = 0;
  await assert.rejects(
    pullPublishedImage(
      {
        run: async () => {
          attempts += 1;
          throw commandError("manifest unknown");
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      },
      "registry.fly.io/app:tag",
    ),
    /command failed/u,
  );
  assert.equal(attempts, FLY_REGISTRY_PULL_ATTEMPTS);
  assert.equal(waits.length, FLY_REGISTRY_PULL_ATTEMPTS - 1);
});

test("anonymous GHCR verification completes the bearer challenge without credentials", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  await verifyAnonymousGhcrDigestPull(
    async (request, init) => {
      const url = String(request);
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({ url, authorization });
      if (url.startsWith("https://ghcr.io/token")) {
        return Response.json({ token: "anonymous-token" });
      }
      if (!authorization) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:lumicorp/kestrel-workspace-runtime:pull"',
          },
        });
      }
      return new Response(null, { status: 200 });
    },
    `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"a".repeat(64)}`,
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.authorization, null);
  assert.equal(requests[2]?.authorization, "Bearer anonymous-token");
});

function publisherHarness(input: {
  reusePublishedImages: boolean;
  preflightFailureCode?: string;
  publicationFailureCode?: string;
  publicationResponse?: unknown;
  failingSmokeRoles?: string[];
  controllerFailure?: boolean;
}) {
  const builtImages = new Set<string>();
  const postBuildPulls = new Map<string, number>();
  const flyBuilds: string[][] = [];
  const ghcrBuilds: string[][] = [];
  const cosignCommands: string[][] = [];
  const smokes: string[][] = [];
  const waits: number[] = [];
  const output: string[] = [];
  const attemptMutations: Array<Record<string, unknown>> = [];
  const controllerBuildInputs: Array<{
    revision: string;
    attemptId: string;
    forceAll: boolean;
  }> = [];
  let activeFlyBuilds = 0;
  let maxActiveFlyBuilds = 0;
  const activeFlyBuildApps = new Set<string>();
  let concurrentBuildsSharedAnApp = false;
  let oidcRequests = 0;
  let preflightAuthorization: string | null = null;
  let publicationAuthorization: string | null = null;
  let publishedManifest: {
    controllerContractRevision: number;
    components: Array<{ role: string }>;
  } | null = null;

  const dependencies: FlyImagePublisherDependencies = {
    root: process.cwd(),
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "123456789",
      KESTREL_RELEASE_FORCE_ALL: input.reusePublishedImages ? "false" : "true",
      KESTREL_RELEASE_PUBLISH_URL: "https://publisher.test/candidates",
      KESTREL_RELEASE_TRIGGER: "manual",
      KESTREL_RELEASE_VALIDATION_COMMANDS: '["pnpm validate"]',
    },
    fetchImpl: async (request, init) => {
      const url = new URL(
        request instanceof Request ? request.url : request.toString(),
      );
      if (url.hostname === "oidc.test") {
        oidcRequests += 1;
        return Response.json({ value: `oidc-token-${oidcRequests}` });
      }
      if (url.hostname === "ghcr.io") {
        return new Response(null, { status: 200 });
      }
      if (url.hostname !== "publisher.test") {
        throw new Error(`Unexpected fetch URL '${url.href}'.`);
      }
      const authorization = new Headers(init?.headers).get("authorization");
      if (init?.method === "PUT") {
        return Response.json({ attempt: { id: attemptId } }, { status: 201 });
      }
      if (init?.method === "PATCH") {
        attemptMutations.push(JSON.parse(String(init.body)));
        return Response.json({ attempt: { id: attemptId } });
      }
      if (init?.method === "POST") {
        publicationAuthorization = authorization;
        publishedManifest = flyImageReleaseManifestV3Schema.parse(
          JSON.parse(String(init.body)),
        );
        if (input.publicationFailureCode) {
          return Response.json(
            { error: { code: input.publicationFailureCode } },
            { status: 409 },
          );
        }
        return Response.json(
          input.publicationResponse ?? {
            release: { id: releaseId, status: "candidate" },
          },
          { status: 202 },
        );
      }
      preflightAuthorization = authorization;
      if (input.preflightFailureCode) {
        return Response.json(
          { error: { code: input.preflightFailureCode } },
          { status: 409 },
        );
      }
      return Response.json({
        requiresFullBundle: !input.reusePublishedImages,
        stableBundleRevision: input.reusePublishedImages ? revision : null,
      });
    },
    now: () => new Date("2026-08-04T12:00:00.000Z"),
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    capture: async (command, args) => {
      if (command === "git" && args.join(" ") === "rev-parse HEAD") {
        return revision;
      }
      if (command === "git" && args.join(" ") === "ls-files") {
        return "deploy/fly/image-catalog.json\npackage.json";
      }
      if (command === "git" && args[0] === "diff") {
        return "";
      }
      if (command === "docker" && args[0] === "image") {
        const taggedImage = args[2]!;
        const [repository, label] = taggedImage.split(":");
        const roleIndex = roles.findIndex((role) => label?.startsWith(role));
        assert.ok(roleIndex >= 0);
        return JSON.stringify([
          `${repository}@sha256:${String(roleIndex + 1).repeat(64)}`,
        ]);
      }
      throw new Error(`Unexpected capture: ${command} ${args.join(" ")}`);
    },
    run: async (command, args) => {
      if (command === "flyctl") {
        const app = args[args.indexOf("--app") + 1]!;
        activeFlyBuilds += 1;
        concurrentBuildsSharedAnApp ||= activeFlyBuildApps.has(app);
        activeFlyBuildApps.add(app);
        maxActiveFlyBuilds = Math.max(maxActiveFlyBuilds, activeFlyBuilds);
        await Promise.resolve();
        flyBuilds.push(args);
        const label = args[args.indexOf("--image-label") + 1]!;
        builtImages.add(`registry.fly.io/${app}:${label}`);
        activeFlyBuildApps.delete(app);
        activeFlyBuilds -= 1;
        return;
      }
      if (command === "docker" && args[0] === "buildx") {
        ghcrBuilds.push(args);
        builtImages.add(args[args.indexOf("--tag") + 1]!);
        return;
      }
      if (command === "cosign") {
        cosignCommands.push(args);
        return;
      }
      if (command === "bash") {
        smokes.push(args);
        const role = roles.find((candidate) => args[0]?.includes(candidate));
        if (role && input.failingSmokeRoles?.includes(role)) {
          throw new Error(`${role} smoke failed`);
        }
        return;
      }
      if (command === "docker" && args[0] === "pull") {
        const taggedImage = args[1]!;
        if (input.reusePublishedImages) return;
        if (!builtImages.has(taggedImage)) {
          throw commandError("manifest unknown");
        }
        const attempts = postBuildPulls.get(taggedImage) ?? 0;
        postBuildPulls.set(taggedImage, attempts + 1);
        if (attempts === 0) throw commandError("manifest unknown");
        return;
      }
      throw new Error(`Unexpected run: ${command} ${args.join(" ")}`);
    },
    buildController: async (controllerInput) => {
      controllerBuildInputs.push(controllerInput);
      if (input.controllerFailure) throw new Error("controller smoke failed");
      return {
        image: `registry.fly.io/kestrel-one-control-worker@sha256:${"6".repeat(64)}`,
        fingerprint: "7".repeat(64),
        smokeCommand: "control-worker-smoke",
        completedAt: "2026-08-04T12:00:00.000Z",
      };
    },
    write: (message) => output.push(message),
  };

  return {
    dependencies,
    flyBuilds,
    ghcrBuilds,
    cosignCommands,
    smokes,
    waits,
    output,
    attemptMutations,
    controllerBuildInputs,
    get oidcRequests() {
      return oidcRequests;
    },
    get preflightAuthorization() {
      return preflightAuthorization;
    },
    get publicationAuthorization() {
      return publicationAuthorization;
    },
    get publishedManifest() {
      return publishedManifest;
    },
    get maxActiveFlyBuilds() {
      return maxActiveFlyBuilds;
    },
    get concurrentBuildsSharedAnApp() {
      return concurrentBuildsSharedAnApp;
    },
  };
}

function commandError(stderr: string) {
  return Object.assign(new Error("command failed"), { stderr });
}

import assert from "node:assert/strict";
import test from "node:test";
import {
  FLY_REGISTRY_PULL_ATTEMPTS,
  FLY_REGISTRY_PULL_RETRY_DELAY_MS,
  publishFlyImages,
  pullPublishedImage,
  type FlyImagePublisherDependencies,
} from "../../scripts/fly-image-publisher.js";
import { platformImagePublicationSchema } from "../../apps/web/lib/runtime-deployments/contracts.js";

const revision = "a".repeat(40);
const roles = [
  "workspace-runtime",
  "environment-router",
  "preview-edge",
  "turn-worker",
  "runpod-worker",
  "control-worker",
] as const;

test("publisher exercises every image and survives Fly registry propagation", async () => {
  const harness = publisherHarness({ reusePublishedImages: false });
  const result = await publishFlyImages(harness.dependencies);

  assert.equal(result.published, true);
  assert.deepEqual(
    result.components.map((component) => component.role),
    roles,
  );
  assert.equal(harness.flyBuilds.length, roles.length);
  assert.equal(harness.flyDeploys.length, 4);
  assert.equal(harness.smokes.length, roles.length);
  assert.deepEqual(
    harness.waits,
    roles.map(() => FLY_REGISTRY_PULL_RETRY_DELAY_MS),
  );
  assert.equal(harness.oidcRequests, 2);
  assert.equal(harness.preflightAuthorization, "Bearer oidc-token-1");
  assert.equal(harness.publicationAuthorization, "Bearer oidc-token-2");
  assert.equal(harness.publishedManifest?.sourceRevision, revision);
  assert.match(
    harness.output.join(""),
    /Published platform generation 1; fanout status is ready/u,
  );
});

test("publisher reuses revision tags and still smokes every image", async () => {
  const harness = publisherHarness({ reusePublishedImages: true });
  const result = await publishFlyImages(harness.dependencies);

  assert.equal(result.published, true);
  assert.equal(harness.flyBuilds.length, 0);
  assert.equal(harness.flyDeploys.length, 4);
  assert.equal(harness.smokes.length, roles.length);
  assert.equal(harness.waits.length, 0);
  assert.equal(
    harness.output.filter((message) =>
      message.startsWith("Reusing published Fly image"),
    ).length,
    roles.length,
  );
});

test("publisher reports the platform API error code", async () => {
  const harness = publisherHarness({
    reusePublishedImages: true,
    publicationFailureCode: "RELEASE_INCOMPLETE",
  });
  await assert.rejects(
    publishFlyImages(harness.dependencies),
    /409: RELEASE_INCOMPLETE/u,
  );
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

function publisherHarness(input: {
  reusePublishedImages: boolean;
  publicationFailureCode?: string;
}) {
  const builtImages = new Set<string>();
  const postBuildPulls = new Map<string, number>();
  const flyBuilds: string[][] = [];
  const flyDeploys: string[][] = [];
  const smokes: string[][] = [];
  const waits: number[] = [];
  const output: string[] = [];
  let oidcRequests = 0;
  let preflightAuthorization: string | null = null;
  let publicationAuthorization: string | null = null;
  let publishedManifest: ReturnType<
    typeof platformImagePublicationSchema.parse
  > | null = null;

  const dependencies: FlyImagePublisherDependencies = {
    root: process.cwd(),
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      KESTREL_RELEASE_FORCE_ALL: "true",
      KESTREL_PLATFORM_IMAGE_URL: "https://publisher.test/platform-images",
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
      if (url.hostname !== "publisher.test") {
        throw new Error(`Unexpected fetch URL '${url.href}'.`);
      }
      const authorization = new Headers(init?.headers).get("authorization");
      if (init?.method === "POST") {
        publicationAuthorization = authorization;
        publishedManifest = platformImagePublicationSchema.parse(
          JSON.parse(String(init.body)),
        );
        if (input.publicationFailureCode) {
          return Response.json(
            { error: { code: input.publicationFailureCode } },
            { status: 409 },
          );
        }
        return Response.json(
          {
            platform: platformState({
              generation: 1,
              status: "ready",
              activeSourceRevision: revision,
            }),
          },
          { status: 202 },
        );
      }
      preflightAuthorization = authorization;
      return Response.json({
        platform: platformState(),
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
        if (!args.includes("--build-only")) {
          flyDeploys.push(args);
          return;
        }
        flyBuilds.push(args);
        const app = args[args.indexOf("--app") + 1]!;
        const label = args[args.indexOf("--image-label") + 1]!;
        builtImages.add(`registry.fly.io/${app}:${label}`);
        return;
      }
      if (command === "bash") {
        smokes.push(args);
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
    write: (message) => output.push(message),
  };

  return {
    dependencies,
    flyBuilds,
    flyDeploys,
    smokes,
    waits,
    output,
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
  };
}

function platformState(
  overrides: Partial<{
    generation: number;
    status: "ready" | "canary";
    activeSourceRevision: string | null;
  }> = {},
) {
  return {
    generation: overrides.generation ?? 0,
    status: overrides.status ?? "ready",
    activeSourceRevision: overrides.activeSourceRevision ?? null,
    desiredRouterImage: `registry.fly.io/kestrel-one-runner@sha256:${"7".repeat(64)}`,
    activeRouterImage: `registry.fly.io/kestrel-one-runner@sha256:${"7".repeat(64)}`,
    desiredRuntimeImage: `registry.fly.io/kestrel-one-runner@sha256:${"8".repeat(64)}`,
    activeRuntimeImage: `registry.fly.io/kestrel-one-runner@sha256:${"8".repeat(64)}`,
    lastFailureCode: null,
  };
}

function commandError(stderr: string) {
  return Object.assign(new Error("command failed"), { stderr });
}

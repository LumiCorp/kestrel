import assert from "node:assert/strict";
import test from "node:test";
import {
  FLY_REGISTRY_PULL_ATTEMPTS,
  FLY_REGISTRY_PULL_RETRY_DELAY_MS,
  publishFlyImages,
  pullPublishedImage,
  type FlyImagePublisherDependencies,
} from "../../scripts/fly-image-publisher.js";
import { flyImageReleaseManifestV2Schema } from "../../apps/web/lib/releases/contracts.js";

const revision = "a".repeat(40);
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
  assert.equal(harness.flyBuilds.length, roles.length);
  assert.equal(harness.smokes.length, roles.length);
  assert.equal(harness.maxActiveFlyBuilds, 4);
  assert.equal(harness.concurrentBuildsSharedAnApp, false);
  assert.deepEqual(
    harness.waits,
    roles.map(() => FLY_REGISTRY_PULL_RETRY_DELAY_MS),
  );
  assert.equal(harness.oidcRequests, 2);
  assert.equal(harness.preflightAuthorization, "Bearer oidc-token-1");
  assert.equal(harness.publicationAuthorization, "Bearer oidc-token-2");
  assert.deepEqual(
    harness.publishedManifest?.components.map(
      (component: { role: string }) => component.role,
    ),
    roles,
  );
  assert.match(
    harness.output.join(""),
    /Published Fly image release candidate release-test/u,
  );
});

test("publisher reuses revision tags and still smokes every image", async () => {
  const harness = publisherHarness({ reusePublishedImages: true });
  const result = await publishFlyImages(harness.dependencies);

  assert.equal(result.published, true);
  assert.equal(harness.flyBuilds.length, 0);
  assert.equal(harness.smokes.length, roles.length);
  assert.equal(harness.waits.length, 0);
  assert.equal(
    harness.output.filter((message) =>
      message.startsWith("Reusing published Fly image"),
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
  const smokes: string[][] = [];
  const waits: number[] = [];
  const output: string[] = [];
  let activeFlyBuilds = 0;
  let maxActiveFlyBuilds = 0;
  const activeFlyBuildApps = new Set<string>();
  let concurrentBuildsSharedAnApp = false;
  let oidcRequests = 0;
  let preflightAuthorization: string | null = null;
  let publicationAuthorization: string | null = null;
  let publishedManifest: {
    components: Array<{ role: string }>;
  } | null = null;

  const dependencies: FlyImagePublisherDependencies = {
    root: process.cwd(),
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      KESTREL_RELEASE_FORCE_ALL: "true",
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
      if (url.hostname !== "publisher.test") {
        throw new Error(`Unexpected fetch URL '${url.href}'.`);
      }
      const authorization = new Headers(init?.headers).get("authorization");
      if (init?.method === "POST") {
        publicationAuthorization = authorization;
        publishedManifest = flyImageReleaseManifestV2Schema.parse(
          JSON.parse(String(init.body)),
        );
        if (input.publicationFailureCode) {
          return Response.json(
            { error: { code: input.publicationFailureCode } },
            { status: 409 },
          );
        }
        return Response.json(
          { release: { id: "release-test", status: "candidate" } },
          { status: 202 },
        );
      }
      preflightAuthorization = authorization;
      return Response.json({
        requiresFullBundle: true,
        stableBundleRevision: null,
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

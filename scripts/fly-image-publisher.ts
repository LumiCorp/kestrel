import { readFile } from "node:fs/promises";
import {
  ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS,
  ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
} from "@lumi/kestrel-environment-auth";
import { z } from "zod";
import {
  fingerprintImageInputs,
  flyImageCatalogSchema,
  flyImagePublicationStateSchema,
  flyMigrationChanged,
  impactedFlyImages,
  selectFlyImageDiffBase,
} from "./fly-image-release-contract.js";

export const FLY_REGISTRY_PULL_ATTEMPTS = 13;
export const FLY_REGISTRY_PULL_RETRY_DELAY_MS = 5_000;

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type FlyImagePublisherDependencies = {
  root: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchImplementation;
  now: () => Date;
  wait: (milliseconds: number) => Promise<void>;
  capture: (command: string, args: string[]) => Promise<string>;
  run: (
    command: string,
    args: string[],
    env?: NodeJS.ProcessEnv,
  ) => Promise<void>;
  write: (message: string) => void;
};

export async function publishFlyImages(
  dependencies: FlyImagePublisherDependencies,
) {
  const { env, root } = dependencies;
  const trigger = z
    .enum(["main", "scheduled", "manual"])
    .parse(env.KESTREL_RELEASE_TRIGGER ?? "manual");
  const revision = await git(dependencies, ["rev-parse", "HEAD"]);
  const requestedForceAll =
    trigger === "scheduled" || env.KESTREL_RELEASE_FORCE_ALL === "true";
  const publishUrl = requireEnvironment(env, "KESTREL_RELEASE_PUBLISH_URL");
  const preflightToken = await requestGithubOidcToken(dependencies);
  const publicationState = await getReleasePublicationState(
    dependencies,
    publishUrl,
    preflightToken,
    revision,
  );
  const forceAll = requestedForceAll || publicationState.requiresFullBundle;
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(await readFile(`${root}/deploy/fly/image-catalog.json`, "utf8")),
  );
  const diffBase = selectFlyImageDiffBase(publicationState);
  const changedPaths = diffBase
    ? await listChangedPaths(dependencies, diffBase, revision)
    : [];
  const impacted = impactedFlyImages({ catalog, changedPaths, forceAll });

  if (impacted.length === 0) {
    dependencies.write("No declared Fly image inputs changed.\n");
    return { published: false as const, components: [] };
  }

  const trackedPaths = (await git(dependencies, ["ls-files"]))
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean);
  const appBuildQueues = new Map<string, Promise<void>>();
  const components = await Promise.all(
    impacted.map(async (image) => {
      const label = `${image.role}-${revision.slice(0, 12)}`;
      const taggedImage = `${image.repository}:${label}`;
      const existingImage = await tryPullExistingImage(
        dependencies,
        taggedImage,
      );
      if (existingImage) {
        dependencies.write(`Reusing published image ${taggedImage}.\n`);
      } else if (image.publisher === "ghcr") {
        await dependencies.run("docker", [
          "buildx",
          "build",
          "--platform",
          "linux/amd64",
          "--file",
          image.dockerfile,
          "--tag",
          taggedImage,
          "--build-arg",
          `KESTREL_GIT_SHA=${revision}`,
          "--push",
          ".",
        ]);
        await pullPublishedImage(dependencies, taggedImage);
      } else {
        await runFlyImageBuild(dependencies, appBuildQueues, image.app, [
          "deploy",
          ".",
          "--app",
          image.app,
          "--config",
          image.config,
          "--dockerfile",
          image.dockerfile,
          "--build-only",
          "--push",
          "--remote-only",
          "--image-label",
          label,
          "--build-arg",
          `KESTREL_GIT_SHA=${revision}`,
        ]);
        await pullPublishedImage(dependencies, taggedImage);
      }
      const digest = await resolveLocalImageDigest(
        dependencies,
        taggedImage,
        image.repository,
      );
      const immutableImage = `${image.repository}@${digest}`;
      await dependencies.run("bash", [image.smoke, immutableImage], {
        ...env,
        EXPECTED_GIT_SHA: revision,
      });
      if (image.publisher === "ghcr") {
        await signAndVerifyPublicImage(dependencies, immutableImage);
      }
      return {
        role: image.role,
        image: immutableImage,
        sourceRevision: revision,
        inputFingerprint: await fingerprintImageInputs({
          image,
          trackedPaths,
          root,
        }),
        smoke: {
          status: "passed" as const,
          command: `${image.smoke} ${immutableImage}`,
          completedAt: dependencies.now().toISOString(),
        },
        ...(image.role === "environment-router"
          ? {
              environmentGateway: {
                acceptedVersions: [
                  ...ENVIRONMENT_GATEWAY_CONFIG_ACCEPTED_VERSIONS,
                ],
              },
            }
          : {}),
      };
    }),
  );

  const validationCommands = parseValidationCommands(env);
  const manifest = {
    version: 2 as const,
    controllerContractRevision: 1,
    bundleRevision: revision,
    trigger,
    migrationChanged: flyMigrationChanged(changedPaths),
    environmentGateway: {
      producedVersion: ENVIRONMENT_GATEWAY_CONFIG_PRODUCED_VERSION,
    },
    validation: {
      status: "passed" as const,
      commands: validationCommands,
      completedAt: dependencies.now().toISOString(),
    },
    components,
  };
  // GitHub Actions OIDC tokens are deliberately short-lived. Image builds and
  // smoke tests can take much longer than one token lifetime, so publication
  // must use a token minted after all image work has completed.
  const publicationToken = await requestGithubOidcToken(dependencies);
  const response = await dependencies.fetchImpl(publishUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${publicationToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(manifest),
  });
  if (!response.ok) {
    throw new Error(
      `Release candidate publication failed (${response.status}${await responseErrorSuffix(response)}).`,
    );
  }
  const result = (await response.json()) as { release?: { id?: unknown } };
  dependencies.write(
    `Published Fly image release candidate ${String(result.release?.id ?? "unknown")}.\n`,
  );
  return { published: true as const, components, manifest };
}

async function runFlyImageBuild(
  dependencies: Pick<FlyImagePublisherDependencies, "run">,
  queues: Map<string, Promise<void>>,
  app: string,
  args: string[],
) {
  const previous = queues.get(app) ?? Promise.resolve();
  let releaseLane: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    releaseLane = resolve;
  });
  const queued = previous.then(() => current);
  queues.set(app, queued);
  await previous;
  try {
    await dependencies.run("flyctl", args);
  } finally {
    releaseLane();
    if (queues.get(app) === queued) queues.delete(app);
  }
}

export async function tryPullExistingImage(
  dependencies: Pick<FlyImagePublisherDependencies, "run">,
  taggedImage: string,
) {
  try {
    await dependencies.run("docker", ["pull", taggedImage]);
    return true;
  } catch (error) {
    if (isFlyRegistryManifestUnavailable(error)) return false;
    throw error;
  }
}

export async function pullPublishedImage(
  dependencies: Pick<FlyImagePublisherDependencies, "run" | "wait">,
  taggedImage: string,
) {
  for (let attempt = 1; attempt <= FLY_REGISTRY_PULL_ATTEMPTS; attempt += 1) {
    try {
      await dependencies.run("docker", ["pull", taggedImage]);
      return;
    } catch (error) {
      if (
        !isFlyRegistryManifestUnavailable(error) ||
        attempt === FLY_REGISTRY_PULL_ATTEMPTS
      ) {
        throw error;
      }
      await dependencies.wait(FLY_REGISTRY_PULL_RETRY_DELAY_MS);
    }
  }
}

export function isFlyRegistryManifestUnavailable(error: unknown) {
  if (!(error && typeof error === "object")) return false;
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && stderr.includes("manifest unknown");
}

async function signAndVerifyPublicImage(
  dependencies: FlyImagePublisherDependencies,
  immutableImage: string,
) {
  const identity =
    dependencies.env.KESTREL_COSIGN_CERTIFICATE_IDENTITY?.trim() ||
    "https://github.com/LumiCorp/kestrel/.github/workflows/fly-image-release.yml@refs/heads/main";
  await dependencies.run("cosign", ["sign", "--yes", immutableImage]);
  await dependencies.run("cosign", [
    "verify",
    "--certificate-identity",
    identity,
    "--certificate-oidc-issuer",
    "https://token.actions.githubusercontent.com",
    immutableImage,
  ]);
  await verifyAnonymousGhcrDigestPull(dependencies.fetchImpl, immutableImage);
}

export async function verifyAnonymousGhcrDigestPull(
  fetchImpl: FetchImplementation,
  immutableImage: string,
) {
  const match = immutableImage.match(
    /^ghcr\.io\/([^@]+)@(sha256:[a-f0-9]{64})$/u,
  );
  if (!match) throw new Error("Anonymous verification requires a GHCR digest.");
  const [, repository, digest] = match;
  const manifestUrl = `https://ghcr.io/v2/${repository}/manifests/${digest}`;
  const headers = {
    accept:
      "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json",
  };
  let response = await fetchImpl(manifestUrl, { method: "HEAD", headers });
  if (response.status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    const realm = challenge.match(/realm="([^"]+)"/u)?.[1];
    const service = challenge.match(/service="([^"]+)"/u)?.[1];
    const scope = challenge.match(/scope="([^"]+)"/u)?.[1];
    if (!(realm && service && scope)) {
      throw new Error("GHCR did not provide an anonymous pull challenge.");
    }
    const tokenUrl = new URL(realm);
    tokenUrl.searchParams.set("service", service);
    tokenUrl.searchParams.set("scope", scope);
    const tokenResponse = await fetchImpl(tokenUrl);
    if (!tokenResponse.ok) {
      throw new Error(
        `GHCR anonymous token request failed (${tokenResponse.status}).`,
      );
    }
    const token = z
      .object({ token: z.string().min(1) })
      .parse(await tokenResponse.json()).token;
    response = await fetchImpl(manifestUrl, {
      method: "HEAD",
      headers: { ...headers, authorization: `Bearer ${token}` },
    });
  }
  if (!response.ok) {
    throw new Error(
      `GHCR image is not anonymously pullable by digest (${response.status}).`,
    );
  }
}

async function listChangedPaths(
  dependencies: FlyImagePublisherDependencies,
  base: string,
  head: string,
) {
  return (await git(dependencies, ["diff", "--name-only", base, head]))
    .split("\n")
    .filter(Boolean);
}

async function requestGithubOidcToken(
  dependencies: FlyImagePublisherDependencies,
) {
  const requestUrl = new URL(
    requireEnvironment(dependencies.env, "ACTIONS_ID_TOKEN_REQUEST_URL"),
  );
  requestUrl.searchParams.set("audience", "kestrel-one-release-publisher");
  const response = await dependencies.fetchImpl(requestUrl, {
    headers: {
      authorization: `Bearer ${requireEnvironment(dependencies.env, "ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub Actions OIDC token request failed (${response.status}${await responseErrorSuffix(response)}).`,
    );
  }
  const payload = z
    .object({ value: z.string().min(1) })
    .parse(await response.json());
  return payload.value;
}

async function getReleasePublicationState(
  dependencies: FlyImagePublisherDependencies,
  publishUrl: string,
  oidcToken: string,
  revision: string,
) {
  const url = new URL(publishUrl);
  url.searchParams.set("revision", revision);
  const response = await dependencies.fetchImpl(url, {
    headers: { authorization: `Bearer ${oidcToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Release publication preflight failed (${response.status}${await responseErrorSuffix(response)}).`,
    );
  }
  return flyImagePublicationStateSchema.parse(await response.json());
}

async function resolveLocalImageDigest(
  dependencies: FlyImagePublisherDependencies,
  taggedImage: string,
  repository: string,
) {
  const repoDigests = z
    .array(z.string())
    .parse(
      JSON.parse(
        await dependencies.capture("docker", [
          "image",
          "inspect",
          taggedImage,
          "--format",
          "{{json .RepoDigests}}",
        ]),
      ),
    );
  const expectedPrefix = `${repository}@`;
  const matches = repoDigests
    .filter((value) => value.startsWith(expectedPrefix))
    .map((value) => value.slice(expectedPrefix.length));
  if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(matches[0]!)) {
    throw new Error(
      "The pushed image tag did not resolve to one immutable digest.",
    );
  }
  return matches[0]!;
}

function parseValidationCommands(env: NodeJS.ProcessEnv) {
  const raw = env.KESTREL_RELEASE_VALIDATION_COMMANDS;
  if (!raw) return ["pnpm validate"];
  return z.array(z.string().trim().min(1)).parse(JSON.parse(raw));
}

function requireEnvironment(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function git(
  dependencies: FlyImagePublisherDependencies,
  args: string[],
) {
  return dependencies.capture("git", args);
}

async function responseErrorSuffix(response: Response) {
  try {
    const payload = z
      .object({ error: z.object({ code: z.string().trim().min(1) }) })
      .parse(await response.json());
    return `: ${payload.error.code}`;
  } catch {
    return "";
  }
}

import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  fingerprintImageInputs,
  flyImageCatalogSchema,
  impactedFlyImages,
} from "./fly-image-release-contract.js";
import { runtimeRolloutContractSchema } from "../apps/web/lib/runtime-deployments/contracts.js";

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
  const publishUrl =
    env.KESTREL_PLATFORM_IMAGE_URL?.trim() ||
    requireEnvironment(env, "KESTREL_RELEASE_PUBLISH_URL");
  const preflightToken = await requestGithubOidcToken(dependencies);
  const publicationState = await getPlatformPublicationState(
    dependencies,
    publishUrl,
    preflightToken,
    revision,
  );
  const forceAll = requestedForceAll;
  const catalog = flyImageCatalogSchema.parse(
    JSON.parse(await readFile(`${root}/deploy/fly/image-catalog.json`, "utf8")),
  );
  const diffBase =
    env.KESTREL_RELEASE_DIFF_BASE?.trim() ||
    publicationState.platform.activeSourceRevision ||
    undefined;
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
  const components = [];
  for (const image of impacted) {
    const label = `${image.role}-${revision.slice(0, 12)}`;
    const taggedImage = `registry.fly.io/${image.app}:${label}`;
    const existingImage = await tryPullExistingImage(dependencies, taggedImage);
    if (existingImage) {
      dependencies.write(`Reusing published Fly image ${taggedImage}.\n`);
    } else {
      await dependencies.run("flyctl", [
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
      image.app,
    );
    const immutableImage = `registry.fly.io/${image.app}@${digest}`;
    await dependencies.run("bash", [image.smoke, immutableImage], {
      ...env,
      EXPECTED_GIT_SHA: revision,
    });
    components.push({
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
    });
  }
  const globalComponents = components.filter((component) => {
    const catalogEntry = catalog.images.find(
      (candidate) => candidate.role === component.role,
    );
    return catalogEntry?.rollout === "global-app";
  });
  for (const component of globalComponents) {
    const image = catalog.images.find(
      (candidate) => candidate.role === component.role,
    );
    if (!image) throw new Error(`Catalog entry ${component.role} disappeared.`);
    await dependencies.run("flyctl", [
      "deploy",
      ".",
      "--app",
      image.app,
      "--config",
      image.config,
      "--image",
      component.image,
      "--strategy",
      "rolling",
      "--wait-timeout",
      "300",
    ]);
    dependencies.write(
      `Deployed ${component.role} at ${component.sourceRevision}.\n`,
    );
  }

  const environmentComponents = components.filter((component) =>
    ["environment-router", "workspace-runtime"].includes(component.role),
  );
  if (environmentComponents.length === 0) {
    return { published: false as const, components, globalComponents };
  }
  const rollout = runtimeRolloutContractSchema.parse(
    JSON.parse(await readFile(`${root}/deploy/fly/runtime-rollout.json`, "utf8")),
  );
  const maintenanceDispatch =
    rollout.mode === "maintenance" && env.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (rollout.mode === "maintenance" && !maintenanceDispatch) {
    dependencies.write(
      "Built and smoked maintenance images; exact-SHA workflow dispatch is required for activation.\n",
    );
    return {
      published: false as const,
      maintenancePending: true as const,
      components,
      globalComponents,
    };
  }
  const router = environmentComponents.find(
    (component) => component.role === "environment-router",
  );
  const runtime = environmentComponents.find(
    (component) => component.role === "workspace-runtime",
  );
  const routerImage =
    router?.image ??
    publicationState.platform.desiredRouterImage ??
    publicationState.platform.activeRouterImage;
  const runtimeImage =
    runtime?.image ??
    publicationState.platform.desiredRuntimeImage ??
    publicationState.platform.activeRuntimeImage;
  if (!(routerImage && runtimeImage)) {
    throw new Error(
      "Platform image publication requires both immutable router and Workspace Runtime images.",
    );
  }
  const publication = {
    sourceRevision: revision,
    routerImage,
    runtimeImage,
    rollout,
    smoke: {
      ...(router ? { router: router.smoke } : {}),
      ...(runtime ? { runtime: runtime.smoke } : {}),
    },
    activateMaintenance: maintenanceDispatch,
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
    body: JSON.stringify(publication),
  });
  if (!response.ok) {
    throw new Error(
      `Platform image publication failed (${response.status}${await responseErrorSuffix(response)}).`,
    );
  }
  let result = platformPublicationStateSchema.parse(await response.json());
  for (let attempt = 0; ["canary", "maintenance"].includes(result.platform.status); attempt += 1) {
    if (attempt >= 120) {
      throw new Error("Platform canary did not finish within 20 minutes.");
    }
    await dependencies.wait(10_000);
    const pollToken = await requestGithubOidcToken(dependencies);
    result = await getPlatformPublicationState(
      dependencies,
      publishUrl,
      pollToken,
      revision,
    );
  }
  if (["blocked", "rejected"].includes(result.platform.status)) {
    throw new Error(
      `Platform canary ended ${result.platform.status}: ${result.platform.lastFailureCode ?? "unknown"}.`,
    );
  }
  dependencies.write(
    `Published platform generation ${result.platform.generation}; fanout status is ${result.platform.status}.\n`,
  );
  return { published: true as const, components, publication, result };
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

const platformPublicationStateSchema = z.object({
  platform: z.object({
    generation: z.number().int().nonnegative(),
    status: z.enum([
      "ready",
      "canary",
      "fanout",
      "degraded",
      "blocked",
      "rejected",
      "maintenance_pending",
      "maintenance",
    ]),
    activeSourceRevision: z.string().nullable(),
    desiredRouterImage: z.string().nullable(),
    activeRouterImage: z.string().nullable(),
    desiredRuntimeImage: z.string().nullable(),
    activeRuntimeImage: z.string().nullable(),
    lastFailureCode: z.string().nullable(),
  }).passthrough(),
}).passthrough();

async function getPlatformPublicationState(
  dependencies: FlyImagePublisherDependencies,
  publishUrl: string,
  oidcToken: string,
  revision: string,
) {
  const url = new URL(publishUrl);
  url.searchParams.set("sourceRevision", revision);
  const response = await dependencies.fetchImpl(url, {
    headers: { authorization: `Bearer ${oidcToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Platform publication preflight failed (${response.status}${await responseErrorSuffix(response)}).`,
    );
  }
  return platformPublicationStateSchema.parse(await response.json());
}

async function resolveLocalImageDigest(
  dependencies: FlyImagePublisherDependencies,
  taggedImage: string,
  app: string,
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
  const expectedPrefix = `registry.fly.io/${app}@`;
  const matches = repoDigests
    .filter((value) => value.startsWith(expectedPrefix))
    .map((value) => value.slice(expectedPrefix.length));
  if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(matches[0]!)) {
    throw new Error(
      "The pushed Fly image tag did not resolve to one immutable digest.",
    );
  }
  return matches[0]!;
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

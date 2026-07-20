import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const appManifestUrl = new URL("../../package.json", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const gitCommitPattern = /^[0-9a-f]{40}$/iu;

export type KestrelBuildIdentity = {
  revision: string;
  source: "development" | "git" | "legacy" | "vercel";
  version: string;
};

export type ResolveKestrelBuildIdentityInput = {
  env: Record<string, string | undefined>;
  manifestVersion: string;
  readGitRevision: () => string | undefined | void;
};

function optionalValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseGitRevision(value: string, source: string) {
  const revision = value.trim();
  if (!gitCommitPattern.test(revision)) {
    throw new Error(`${source} must be a full 40-character Git commit SHA.`);
  }
  return revision.toLowerCase();
}

export function resolveKestrelBuildIdentity(
  input: ResolveKestrelBuildIdentityInput
): KestrelBuildIdentity {
  const version = input.manifestVersion.trim();
  if (!version) {
    throw new Error("apps/web/package.json must declare a non-empty version.");
  }

  const legacyVersion = optionalValue(input.env.KESTREL_APP_VERSION);
  if (legacyVersion && legacyVersion !== version) {
    throw new Error(
      `KESTREL_APP_VERSION must match apps/web/package.json (${version}); received ${legacyVersion}.`
    );
  }

  const vercelRevision = optionalValue(input.env.VERCEL_GIT_COMMIT_SHA);
  if (vercelRevision) {
    return {
      revision: parseGitRevision(vercelRevision, "VERCEL_GIT_COMMIT_SHA"),
      source: "vercel",
      version,
    };
  }

  const gitRevisionCandidate = input.readGitRevision();
  const gitRevision =
    typeof gitRevisionCandidate === "string"
      ? optionalValue(gitRevisionCandidate)
      : undefined;
  if (gitRevision) {
    return {
      revision: parseGitRevision(gitRevision, "git rev-parse HEAD"),
      source: "git",
      version,
    };
  }

  const legacyRevision = optionalValue(input.env.KESTREL_BUILD_REVISION);
  if (legacyRevision) {
    return {
      revision: parseGitRevision(
        legacyRevision,
        "KESTREL_BUILD_REVISION"
      ),
      source: "legacy",
      version,
    };
  }

  if (input.env.VERCEL_ENV?.trim() === "production") {
    throw new Error(
      "Kestrel One production builds require a full Git revision from VERCEL_GIT_COMMIT_SHA, git rev-parse HEAD, or KESTREL_BUILD_REVISION."
    );
  }

  return { revision: "development", source: "development", version };
}

function readAppManifestVersion() {
  const manifest = JSON.parse(readFileSync(appManifestUrl, "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") {
    throw new Error("apps/web/package.json must declare a string version.");
  }
  return manifest.version;
}

function readRepositoryRevision() {
  try {
    return execFileSync(
      "git",
      ["rev-parse", "--verify", "HEAD^{commit}"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
  } catch {
    return;
  }
}

export function loadKestrelBuildIdentity(
  env: Record<string, string | undefined> = process.env
) {
  return resolveKestrelBuildIdentity({
    env,
    manifestVersion: readAppManifestVersion(),
    readGitRevision: readRepositoryRevision,
  });
}

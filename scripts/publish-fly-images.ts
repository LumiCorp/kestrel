import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  fingerprintImageInputs,
  flyImageCatalogSchema,
  flyImagePublicationStateSchema,
  flyMigrationChanged,
  impactedFlyImages,
  selectFlyImageDiffBase,
} from "./fly-image-release-contract";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const trigger = z
  .enum(["main", "scheduled", "manual"])
  .parse(process.env.KESTREL_RELEASE_TRIGGER ?? "manual");
const revision = await git(["rev-parse", "HEAD"]);
const requestedForceAll =
  trigger === "scheduled" || process.env.KESTREL_RELEASE_FORCE_ALL === "true";
const publishUrl = requireEnvironment("KESTREL_RELEASE_PUBLISH_URL");
const oidcToken = await requestGithubOidcToken();
const publicationState = await getReleasePublicationState(
  publishUrl,
  oidcToken,
  revision,
);
const forceAll =
  requestedForceAll || publicationState.requiresFullBundle;
const catalog = flyImageCatalogSchema.parse(
  JSON.parse(await readFile(`${root}/deploy/fly/image-catalog.json`, "utf8")),
);
const diffBase = selectFlyImageDiffBase(publicationState);
const changedPaths = diffBase
  ? await listChangedPaths(diffBase, revision)
  : [];
const impacted = impactedFlyImages({ catalog, changedPaths, forceAll });

if (impacted.length === 0) {
  process.stdout.write("No declared Fly image inputs changed.\n");
  process.exit(0);
}

const trackedPaths = (await git(["ls-files"]))
  .split("\n")
  .map((path) => path.trim())
  .filter(Boolean);
const components = [];
for (const image of impacted) {
  const label = `${image.role}-${revision.slice(0, 12)}`;
  await run("fly", [
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
  const taggedImage = `registry.fly.io/${image.app}:${label}`;
  await run("docker", ["pull", taggedImage]);
  const digest = await resolveLocalImageDigest(taggedImage, image.app);
  const immutableImage = `registry.fly.io/${image.app}@${digest}`;
  await run("bash", [image.smoke, immutableImage], {
    ...process.env,
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
      completedAt: new Date().toISOString(),
    },
  });
}

const validationCommands = parseValidationCommands();
const manifest = {
  version: 1,
  bundleRevision: revision,
  trigger,
  migrationChanged: flyMigrationChanged(changedPaths),
  validation: {
    status: "passed",
    commands: validationCommands,
    completedAt: new Date().toISOString(),
  },
  components,
};
const response = await fetch(publishUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${oidcToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(manifest),
});
if (!response.ok) {
  throw new Error(`Release candidate publication failed (${response.status}).`);
}
const result = (await response.json()) as { release?: { id?: unknown } };
process.stdout.write(
  `Published Fly image release candidate ${String(result.release?.id ?? "unknown")}.\n`,
);

async function listChangedPaths(base: string, head: string) {
  return (await git(["diff", "--name-only", base, head]))
    .split("\n")
    .filter(Boolean);
}

async function requestGithubOidcToken() {
  const requestUrl = new URL(
    requireEnvironment("ACTIONS_ID_TOKEN_REQUEST_URL"),
  );
  requestUrl.searchParams.set("audience", "kestrel-one-release-publisher");
  const response = await fetch(requestUrl, {
    headers: {
      authorization: `Bearer ${requireEnvironment("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`,
    },
  });
  if (!response.ok)
    throw new Error("GitHub Actions OIDC token request failed.");
  const payload = z
    .object({ value: z.string().min(1) })
    .parse(await response.json());
  return payload.value;
}

async function getReleasePublicationState(
  publishUrl: string,
  oidcToken: string,
  revision: string,
) {
  const url = new URL(publishUrl);
  url.searchParams.set("revision", revision);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${oidcToken}` },
  });
  if (!response.ok) {
    throw new Error(
      `Release publication preflight failed (${response.status}).`,
    );
  }
  return flyImagePublicationStateSchema.parse(await response.json());
}

async function resolveLocalImageDigest(taggedImage: string, app: string) {
  const repoDigests = z.array(z.string()).parse(
    JSON.parse(
      await capture("docker", [
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

function parseValidationCommands() {
  const raw = process.env.KESTREL_RELEASE_VALIDATION_COMMANDS;
  if (!raw) return ["pnpm validate"];
  return z.array(z.string().trim().min(1)).parse(JSON.parse(raw));
}

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function git(args: string[]) {
  return capture("git", args);
}

async function capture(command: string, args: string[]) {
  const result = await execFileAsync(command, args, {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(command, args, { cwd: root, env }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  });
}

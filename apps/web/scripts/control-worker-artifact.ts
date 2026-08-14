import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { captureStreamingCommand } from "./streaming-command";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const dockerfilePath = "deploy/fly/kestrel-one-control-worker/Dockerfile";

export const CONTROL_WORKER_FINGERPRINT_PATHS = [
  dockerfilePath,
  "deploy/fly/kestrel-one-control-worker/fly.toml",
  "deploy/fly/kestrel-one-control-worker/smoke.sh",
  "apps/web/package.json",
  "apps/web/scripts/control-worker-artifact.ts",
  "apps/web/scripts/control-worker-machine.ts",
  "apps/web/scripts/deploy-control-worker-candidate.ts",
  "apps/web/scripts/publish-control-worker-candidate.ts",
  "apps/web/scripts/release-control-worker.ts",
  "scripts/lib/streaming-command.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "packages/*/package.json",
  "apps/web/drizzle",
  "apps/web/lib/db/contract-migrations",
  "apps/web/lib/db/migrations",
] as const;

export type ControlWorkerArtifact = {
  contextDirectory: string;
  dockerfile: string;
  fingerprint: string;
  runtimeInputs: string[];
  workerBundle: string;
  readinessBundle: string;
  dispose: () => Promise<void>;
};

type ArtifactDependencies = {
  capture: (command: string, args: string[]) => Promise<string>;
};

export async function buildControlWorkerArtifact(
  input: {
    root?: string;
    dependencies?: ArtifactDependencies;
  } = {},
): Promise<ControlWorkerArtifact> {
  const root = input.root ?? repositoryRoot;
  const dependencies = input.dependencies ?? { capture };
  const contextDirectory = await mkdtemp(
    join(tmpdir(), "kestrel-control-worker-artifact-"),
  );
  const workerBundle = join(contextDirectory, "control-worker.cjs");
  const readinessBundle = join(
    contextDirectory,
    "verify-control-worker-readiness.cjs",
  );
  const stagedDockerfile = join(contextDirectory, "Dockerfile");

  try {
    const [worker, readiness] = await Promise.all([
      bundle({
        root,
        entrypoint: "apps/web/scripts/control-worker.ts",
        outfile: workerBundle,
      }),
      bundle({
        root,
        entrypoint: "apps/web/scripts/verify-control-worker-readiness.ts",
        outfile: readinessBundle,
      }),
    ]);
    await copyFile(resolve(root, dockerfilePath), stagedDockerfile);
    const fingerprint = await fingerprintControlWorkerArtifact({
      root,
      dependencies,
      bundles: [workerBundle, readinessBundle],
    });
    const runtimeInputs = [
      ...new Set([
        ...Object.keys(worker.inputs),
        ...Object.keys(readiness.inputs),
      ]),
    ].sort();
    return {
      contextDirectory,
      dockerfile: stagedDockerfile,
      fingerprint,
      runtimeInputs,
      workerBundle,
      readinessBundle,
      dispose: () => rm(contextDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(contextDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function bundle(input: {
  root: string;
  entrypoint: string;
  outfile: string;
}): Promise<Metafile> {
  const result = await build({
    absWorkingDir: input.root,
    bundle: true,
    entryPoints: [input.entrypoint],
    format: "cjs",
    logLevel: "silent",
    metafile: true,
    outfile: input.outfile,
    platform: "node",
    target: "node22",
    tsconfig: "apps/web/tsconfig.json",
  });
  if (!result.metafile) {
    throw new Error(
      "The control worker bundle did not produce dependency metadata.",
    );
  }
  return result.metafile;
}

export async function fingerprintControlWorkerArtifact(input: {
  root: string;
  dependencies: ArtifactDependencies;
  bundles: string[];
}) {
  const paths = (
    await input.dependencies.capture("git", [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...CONTROL_WORKER_FINGERPRINT_PATHS,
    ])
  )
    .split("\n")
    .map((path) => path.trim())
    .filter(Boolean)
    .sort();
  if (paths.length === 0) {
    throw new Error("Control worker fingerprint inputs matched no files.");
  }
  const hash = createHash("sha256");
  for (const bundlePath of input.bundles) {
    hash.update(
      bundlePath.endsWith("control-worker.cjs") ? "worker" : "readiness",
    );
    hash.update("\0");
    hash.update(await readFile(bundlePath));
    hash.update("\0");
  }
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(resolve(input.root, path)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function capture(command: string, args: string[]) {
  return (
    await captureStreamingCommand(command, args, { cwd: repositoryRoot })
  ).trimEnd();
}

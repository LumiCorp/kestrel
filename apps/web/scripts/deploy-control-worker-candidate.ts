import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureStreamingCommand,
  runStreamingCommand,
} from "./streaming-command";
import {
  buildControlWorkerArtifact,
  type ControlWorkerArtifact,
} from "./control-worker-artifact";
import {
  canSkipControlWorkerMachineDeploy,
  CONTROL_WORKER_STARTUP_COMMAND,
  findControlWorkerMachine,
  isControlWorkerMachinePostcondition,
  isIncompleteControlWorkerMachineError,
  readControlWorkerInventory,
  selectControlWorkerMachineUpdatePlan,
} from "./control-worker-machine";

const defaultApp = "kestrel-one-control-worker";
const pullAttempts = 13;
const pullRetryDelayMs = 5_000;
const readinessAttempts = 45;
const readinessRetryDelayMs = 2_000;
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const smokeScript = resolve(
  repositoryRoot,
  "deploy/fly/kestrel-one-control-worker/smoke.sh",
);
const flyConfig = resolve(
  repositoryRoot,
  "deploy/fly/kestrel-one-control-worker/fly.toml",
);

export type ControlWorkerDeployDependencies = {
  buildArtifact: () => Promise<ControlWorkerArtifact>;
  capture: (command: string, args: string[]) => Promise<string>;
  readInventory: (app: string, accessToken: string) => Promise<unknown>;
  run: (
    command: string,
    args: string[],
    environment?: NodeJS.ProcessEnv,
  ) => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
  write: (message: string) => void;
};

export function canSkipControlWorkerDeploy(input: {
  inventory: unknown;
  expectedFingerprint: string;
}) {
  return canSkipControlWorkerMachineDeploy(input);
}

export async function deployControlWorkerCandidate(input: {
  revision: string;
  appName?: string;
  accessToken: string;
  dependencies: ControlWorkerDeployDependencies;
}) {
  const appName = input.appName ?? defaultApp;
  const artifact = await input.dependencies.buildArtifact();
  try {
    const inventory = await input.dependencies.readInventory(
      appName,
      input.accessToken,
    );
    if (
      canSkipControlWorkerDeploy({
        inventory,
        expectedFingerprint: artifact.fingerprint,
      })
    ) {
      try {
        await verifyControllerReadiness(input.dependencies, appName);
        input.dependencies.write(
          `Release controller already healthy for fingerprint ${artifact.fingerprint}.\n`,
        );
        return {
          action: "skipped" as const,
          fingerprint: artifact.fingerprint,
        };
      } catch (error) {
        input.dependencies.write(
          `Release controller fingerprint matched but readiness failed; rebuilding (${error instanceof Error ? error.message : "unknown error"}).\n`,
        );
      }
    }

    const published = await publishControlWorkerImage({
      appName,
      artifact,
      dependencies: input.dependencies,
      revision: input.revision,
    });
    await updateControlWorkerMachines({
      appName,
      accessToken: input.accessToken,
      dependencies: input.dependencies,
      taggedImage: published.taggedImage,
      authoritativeImage: published.immutableImage,
      fingerprint: artifact.fingerprint,
      revision: input.revision,
    });
    await verifyControllerReadiness(input.dependencies, appName);
    input.dependencies.write(
      `Release controller deployed ${published.immutableImage} (${artifact.fingerprint}).\n`,
    );
    return {
      action: "deployed" as const,
      image: published.immutableImage,
      fingerprint: artifact.fingerprint,
    };
  } finally {
    await artifact.dispose();
  }
}

export async function deployStoredControlWorkerCandidate(input: {
  revision: string;
  image: string;
  fingerprint: string;
  appName?: string;
  accessToken: string;
  dependencies: Pick<
    ControlWorkerDeployDependencies,
    "readInventory" | "run" | "wait" | "write"
  >;
}) {
  const appName = input.appName ?? defaultApp;
  if (
    !input.image.match(
      /^registry\.fly\.io\/kestrel-one-control-worker@sha256:[a-f0-9]{64}$/u,
    )
  ) {
    throw new Error("Preparation requires an immutable control-worker image.");
  }
  await updateControlWorkerMachines({
    appName,
    accessToken: input.accessToken,
    dependencies: input.dependencies,
    taggedImage: input.image,
    authoritativeImage: input.image,
    fingerprint: input.fingerprint.replace(/^sha256:/u, ""),
    revision: input.revision,
  });
  await verifyControllerReadiness(input.dependencies, appName);
  input.dependencies.write(
    `Release controller prepared from ${input.image} (${input.fingerprint}).\n`,
  );
}

export async function publishControlWorkerImage(input: {
  appName: string;
  artifact: ControlWorkerArtifact;
  dependencies: Pick<
    ControlWorkerDeployDependencies,
    "capture" | "run" | "wait"
  >;
  revision: string;
  labelSuffix?: string;
  flyCommand?: string;
}) {
  const label = [
    "control-worker",
    input.revision.slice(0, 12),
    input.artifact.fingerprint.slice(0, 12),
    input.labelSuffix,
  ]
    .filter(Boolean)
    .join("-");
  const taggedImage = `registry.fly.io/${input.appName}:${label}`;
  await input.dependencies.run(input.flyCommand ?? "flyctl", [
    "deploy",
    input.artifact.contextDirectory,
    "--app",
    input.appName,
    "--config",
    flyConfig,
    "--dockerfile",
    input.artifact.dockerfile,
    "--remote-only",
    "--build-only",
    "--push",
    "--image-label",
    label,
    "--build-arg",
    `KESTREL_GIT_SHA=${input.revision}`,
    "--build-arg",
    `KESTREL_CONTROL_WORKER_FINGERPRINT=${input.artifact.fingerprint}`,
  ]);
  await pullPublishedImage(input.dependencies, taggedImage);
  const digest = await resolveLocalImageDigest(
    input.dependencies,
    taggedImage,
    input.appName,
  );
  const immutableImage = `registry.fly.io/${input.appName}@${digest}`;
  await input.dependencies.run("bash", [smokeScript, immutableImage], {
    ...process.env,
    EXPECTED_CONTROL_WORKER_FINGERPRINT: input.artifact.fingerprint,
    EXPECTED_GIT_SHA: input.revision,
  });
  return { digest, immutableImage, label, taggedImage };
}

async function updateControlWorkerMachines(input: {
  appName: string;
  accessToken: string;
  dependencies: Pick<
    ControlWorkerDeployDependencies,
    "readInventory" | "run" | "wait"
  >;
  taggedImage: string;
  authoritativeImage: string;
  fingerprint: string;
  revision: string;
}) {
  const inventory = await input.dependencies.readInventory(
    input.appName,
    input.accessToken,
  );
  const plan = selectControlWorkerMachineUpdatePlan({ inventory });
  for (const update of plan.updates) {
    const args = [
      "machine",
      "update",
      update.machineId,
      "--app",
      input.appName,
      "--image",
      input.taggedImage,
      "--env",
      `KESTREL_RELEASE_IMAGE=${input.authoritativeImage}`,
      "--command",
      CONTROL_WORKER_STARTUP_COMMAND,
      "--wait-timeout",
      "120",
      "--yes",
    ];
    if (update.skipStart) args.push("--skip-start");
    await input.dependencies.run("flyctl", args);
    await waitForMachinePostcondition({
      appName: input.appName,
      accessToken: input.accessToken,
      dependencies: input.dependencies,
      machineId: update.machineId,
      expectedState: update.expectedState,
      expectedFingerprint: input.fingerprint,
      expectedRevision: input.revision,
    });
  }
}

async function waitForMachinePostcondition(input: {
  appName: string;
  accessToken: string;
  dependencies: Pick<ControlWorkerDeployDependencies, "readInventory" | "wait">;
  machineId: string;
  expectedState: "started" | "stopped";
  expectedFingerprint: string;
  expectedRevision: string;
  expectedEnvironment?: Record<string, string>;
}) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const machine = findControlWorkerMachine({
        inventory: await input.dependencies.readInventory(
          input.appName,
          input.accessToken,
        ),
        machineId: input.machineId,
      });
      if (isControlWorkerMachinePostcondition({ machine, ...input })) {
        return;
      }
    } catch (error) {
      if (!isIncompleteControlWorkerMachineError(error)) throw error;
    }
    await input.dependencies.wait(2_000);
  }
  throw new Error(
    `Control worker Machine ${input.machineId} did not reach ${input.expectedState} on revision ${input.expectedRevision} with fingerprint ${input.expectedFingerprint}.`,
  );
}

async function verifyControllerReadiness(
  dependencies: Pick<ControlWorkerDeployDependencies, "run" | "wait">,
  appName: string,
) {
  for (let attempt = 1; attempt <= readinessAttempts; attempt += 1) {
    try {
      await dependencies.run("flyctl", [
        "ssh",
        "console",
        "--app",
        appName,
        "--command",
        "node /app/verify-control-worker-readiness.cjs --contract-only",
      ]);
      return;
    } catch (error) {
      if (attempt === readinessAttempts) throw error;
      await dependencies.wait(readinessRetryDelayMs);
    }
  }
}

async function pullPublishedImage(
  dependencies: Pick<ControlWorkerDeployDependencies, "run" | "wait">,
  taggedImage: string,
) {
  for (let attempt = 1; attempt <= pullAttempts; attempt += 1) {
    try {
      await dependencies.run("docker", ["pull", taggedImage]);
      return;
    } catch (error) {
      if (
        !isFlyRegistryManifestUnavailable(error) ||
        attempt === pullAttempts
      ) {
        throw error;
      }
      await dependencies.wait(pullRetryDelayMs);
    }
  }
}

function isFlyRegistryManifestUnavailable(error: unknown) {
  if (!(error && typeof error === "object")) return false;
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === "string" && stderr.includes("manifest unknown");
}

async function resolveLocalImageDigest(
  dependencies: Pick<ControlWorkerDeployDependencies, "capture">,
  taggedImage: string,
  appName: string,
) {
  const repoDigests = JSON.parse(
    await dependencies.capture("docker", [
      "image",
      "inspect",
      taggedImage,
      "--format",
      "{{json .RepoDigests}}",
    ]),
  ) as string[];
  const expectedPrefix = `registry.fly.io/${appName}@`;
  const matches = repoDigests
    .filter((value) => value.startsWith(expectedPrefix))
    .map((value) => value.slice(expectedPrefix.length));
  if (matches.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(matches[0]!)) {
    throw new Error(
      "The pushed control worker image tag did not resolve to one immutable digest.",
    );
  }
  return matches[0]!;
}

async function capture(command: string, args: string[]) {
  return (
    await captureStreamingCommand(command, args, { cwd: process.cwd() })
  ).trimEnd();
}

async function run(
  command: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
) {
  await runStreamingCommand(command, args, {
    cwd: process.cwd(),
    env: environment ?? process.env,
  });
}

async function main() {
  const revision = process.argv[2]?.trim();
  if (!revision?.match(/^[a-f0-9]{40}$/u)) {
    throw new Error("Expected a full production Git revision argument.");
  }
  const accessToken = process.env.FLY_API_TOKEN?.trim();
  if (!accessToken) throw new Error("FLY_API_TOKEN is required.");
  await deployControlWorkerCandidate({
    revision,
    accessToken,
    dependencies: {
      buildArtifact: () => buildControlWorkerArtifact(),
      capture,
      readInventory: readControlWorkerInventory,
      run,
      wait: (milliseconds) =>
        new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)),
      write: (message) => process.stdout.write(message),
    },
  });
}

if (process.argv[1]?.endsWith("deploy-control-worker-candidate.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Control worker deploy failed."}\n`,
    );
    process.exitCode = 1;
  });
}

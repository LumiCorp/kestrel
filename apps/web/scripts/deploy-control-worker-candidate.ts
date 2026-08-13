import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildControlWorkerArtifact,
  type ControlWorkerArtifact,
} from "./control-worker-artifact";
import {
  canSkipControlWorkerMachineDeploy,
  findControlWorkerMachine,
  readControlWorkerInventory,
  selectControlWorkerMachineUpdatePlan,
} from "./control-worker-machine";

const execFileAsync = promisify(execFile);
const defaultApp = "kestrel-one-control-worker";
const pullAttempts = 13;
const pullRetryDelayMs = 5_000;
const readinessAttempts = 45;
const readinessRetryDelayMs = 2_000;
const smokeScript = "deploy/fly/kestrel-one-control-worker/smoke.sh";
const flyConfig = "deploy/fly/kestrel-one-control-worker/fly.toml";

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
        return { action: "skipped" as const, fingerprint: artifact.fingerprint };
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
      imageDigest: published.digest,
      taggedImage: published.taggedImage,
      fingerprint: artifact.fingerprint,
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

export async function publishControlWorkerImage(input: {
  appName: string;
  artifact: ControlWorkerArtifact;
  dependencies: Pick<
    ControlWorkerDeployDependencies,
    "capture" | "run" | "wait"
  >;
  revision: string;
  flyCommand?: string;
}) {
  const label = `control-worker-${input.revision.slice(0, 12)}-${input.artifact.fingerprint.slice(0, 12)}`;
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
  dependencies: ControlWorkerDeployDependencies;
  imageDigest: string;
  taggedImage: string;
  fingerprint: string;
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
      expectedDigest: input.imageDigest,
      expectedFingerprint: input.fingerprint,
    });
  }
}

async function waitForMachinePostcondition(input: {
  appName: string;
  accessToken: string;
  dependencies: Pick<ControlWorkerDeployDependencies, "readInventory" | "wait">;
  machineId: string;
  expectedState: "started" | "stopped";
  expectedDigest: string;
  expectedFingerprint: string;
}) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const machine = findControlWorkerMachine({
      inventory: await input.dependencies.readInventory(
        input.appName,
        input.accessToken,
      ),
      machineId: input.machineId,
    });
    if (
      machine.state === input.expectedState &&
      machine.digest === input.expectedDigest &&
      machine.fingerprint === input.expectedFingerprint
    ) {
      return;
    }
    await input.dependencies.wait(2_000);
  }
  throw new Error(
    `Control worker Machine ${input.machineId} did not reach ${input.expectedState} on digest ${input.expectedDigest}.`,
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
      if (!isFlyRegistryManifestUnavailable(error) || attempt === pullAttempts) {
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
  const result = await execFileAsync(command, args, {
    cwd: process.cwd(),
    maxBuffer: 20 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}

async function run(
  command: string,
  args: string[],
  environment?: NodeJS.ProcessEnv,
) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: process.cwd(), env: environment ?? process.env },
      (error, _stdout, stderr) => {
        if (error) {
          Object.assign(error, { stderr });
          reject(error);
        } else {
          resolve();
        }
      },
    );
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
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

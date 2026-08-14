import {
  captureStreamingCommand,
  runStreamingCommand,
} from "./streaming-command";
import {
  buildControlWorkerArtifact,
  type ControlWorkerArtifact,
} from "./control-worker-artifact";
import { publishControlWorkerImage } from "./deploy-control-worker-candidate";

const defaultApp = "kestrel-one-control-worker";

export type ControlWorkerCandidatePublisherDependencies = {
  buildArtifact: () => Promise<ControlWorkerArtifact>;
  publishImage: typeof publishControlWorkerImage;
  write: (message: string) => void;
};

export async function publishControlWorkerCandidate(input: {
  revision: string;
  appName?: string;
  dependencies: ControlWorkerCandidatePublisherDependencies;
}) {
  const appName = input.appName ?? defaultApp;
  const artifact = await input.dependencies.buildArtifact();
  try {
    const published = await input.dependencies.publishImage({
      appName,
      artifact,
      dependencies: { capture, run, wait },
      revision: input.revision,
    });
    input.dependencies.write(
      `Published and smoked release controller candidate ${published.immutableImage} (${artifact.fingerprint}).\n`,
    );
    return { ...published, fingerprint: artifact.fingerprint };
  } finally {
    await artifact.dispose();
  }
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

function wait(milliseconds: number) {
  return new Promise<void>((resolveWait) =>
    setTimeout(resolveWait, milliseconds),
  );
}

async function main() {
  const revision = process.argv[2]?.trim();
  if (!revision?.match(/^[a-f0-9]{40}$/u)) {
    throw new Error("Expected a full production Git revision argument.");
  }
  await publishControlWorkerCandidate({
    revision,
    dependencies: {
      buildArtifact: () => buildControlWorkerArtifact(),
      publishImage: publishControlWorkerImage,
      write: (message) => process.stdout.write(message),
    },
  });
}

if (process.argv[1]?.endsWith("publish-control-worker-candidate.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Control worker candidate publication failed."}\n`,
    );
    process.exitCode = 1;
  });
}

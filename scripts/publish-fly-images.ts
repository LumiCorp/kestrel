import { publishFlyImages } from "./fly-image-publisher.js";
import {
  captureStreamingCommand,
  runStreamingCommand,
} from "./lib/streaming-command.js";
import { buildControlWorkerArtifact } from "../apps/web/scripts/control-worker-artifact.js";
import { publishControlWorkerImage } from "../apps/web/scripts/deploy-control-worker-candidate.js";

const root = process.cwd();

await publishFlyImages({
  root,
  env: process.env,
  fetchImpl: fetch,
  now: () => new Date(),
  wait: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  capture,
  run,
  buildController,
  write: (message) => process.stdout.write(message),
});

async function buildController(input: {
  revision: string;
  attemptId: string;
  forceAll: boolean;
}) {
  const artifact = await buildControlWorkerArtifact({ root });
  try {
    const published = await publishControlWorkerImage({
      appName: "kestrel-one-control-worker",
      artifact,
      revision: input.revision,
      labelSuffix: input.forceAll ? input.attemptId.slice(0, 8) : undefined,
      dependencies: {
        capture,
        run,
        wait: (milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds)),
      },
    });
    return {
      image: published.immutableImage,
      fingerprint: artifact.fingerprint,
      smokeCommand: `deploy/fly/kestrel-one-control-worker/smoke.sh ${published.immutableImage}`,
      completedAt: new Date().toISOString(),
    };
  } finally {
    await artifact.dispose();
  }
}

async function capture(command: string, args: string[]) {
  return (await captureStreamingCommand(command, args, { cwd: root })).trim();
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  await runStreamingCommand(command, args, { cwd: root, env });
}

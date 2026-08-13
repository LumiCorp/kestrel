import { publishFlyImages } from "./fly-image-publisher.js";
import {
  captureStreamingCommand,
  runStreamingCommand,
} from "./lib/streaming-command.js";

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
  write: (message) => process.stdout.write(message),
});

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

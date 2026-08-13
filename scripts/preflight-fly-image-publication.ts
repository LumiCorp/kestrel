import { preflightFlyImagePublication } from "./fly-image-publisher.js";
import { captureStreamingCommand } from "./lib/streaming-command.js";

const root = process.cwd();

const result = await preflightFlyImagePublication({
  env: process.env,
  fetchImpl: fetch,
  capture: async (command, args) =>
    (await captureStreamingCommand(command, args, { cwd: root })).trim(),
});

process.stdout.write(
  `Release publication preflight passed for ${result.revision}.\n`,
);

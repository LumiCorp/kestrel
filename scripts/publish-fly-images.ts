import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishFlyImages } from "./fly-image-publisher.js";

const execFileAsync = promisify(execFile);
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
    const child = execFile(
      command,
      args,
      { cwd: root, env },
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

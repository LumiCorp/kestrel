import { spawnSync } from "node:child_process";

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed.`);
  }
}

function main() {
  run("pnpm", ["sync:turn-worker-keyring"]);
  run("fly", [
    "deploy",
    "--config",
    "../../deploy/fly/kestrel-one-turn-worker/fly.toml",
    "--app",
    process.env.KESTREL_TURN_WORKER_APP?.trim() || "kestrel-one-turn-worker",
  ]);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Turn worker release failed."}\n`,
  );
  process.exitCode = 1;
}

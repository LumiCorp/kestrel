import { spawn } from "node:child_process";
import path from "node:path";

export async function runRuntimeCli(input: {
  args: string[];
  env: NodeJS.ProcessEnv;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const commandArgs = [
    "--import",
    "tsx",
    path.resolve(process.cwd(), "cli/runtime.ts"),
    ...input.args,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, commandArgs, {
      cwd: process.cwd(),
      env: {
        ...input.env,
        // The repository-wide unit gate runs with the in-process Core shortcut.
        // Runtime CLI subprocesses must still exercise the real authenticated Core client.
        KESTREL_LOCAL_CORE_DIRECT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

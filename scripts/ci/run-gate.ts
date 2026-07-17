import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";

const invocation = process.argv.slice(2);
if (invocation[0] === "--") invocation.shift();
const separator = invocation.indexOf("--");
const gate = invocation[0];
if (!(gate && separator === 1 && invocation[separator + 1])) {
  throw new Error("Usage: run-gate.ts <gate> -- <command> [args...]");
}

const command = invocation[separator + 1] as string;
const args = invocation.slice(separator + 2);
const startedAt = Date.now();
let output = "";

const child = spawn(command, args, {
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});
child.stdout.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  process.stdout.write(text);
});
child.stderr.on("data", (chunk: Buffer) => {
  const text = chunk.toString();
  output += text;
  process.stderr.write(text);
});

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});
const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

const testEvidence = [
  ...output.matchAll(/^# (?:tests|pass|fail|skipped) \d+$/gmu),
  ...output.matchAll(/^\s*\d+ (?:passed|failed|skipped)(?: \([^\n]+\))?$/gmu),
]
  .map((match) => match[0].trim())
  .slice(-5)
  .join("; ");
const migrationEvidence =
  output.match(/migrations=[^\s]+(?:\s+suites=\d+)?(?:\s+skips=\d+)?/u)?.[0] ??
  "n/a";
const artifactName = process.env.CI_ARTIFACT_NAME?.trim();
const artifactLink = artifactName
  ? `[${artifactName}](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})`
  : "n/a";
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  await appendFile(
    summaryPath,
    [
      `## ${gate}`,
      "",
      "| Result | Duration | Test evidence | Migration evidence | Failure artifacts |",
      "| --- | ---: | --- | --- | --- |",
      `| ${exitCode === 0 ? "passed" : "failed"} | ${durationSeconds}s | ${testEvidence || "not reported"} | ${migrationEvidence} | ${artifactLink} |`,
      "",
    ].join("\n"),
    "utf8"
  );
}

process.exitCode = exitCode;

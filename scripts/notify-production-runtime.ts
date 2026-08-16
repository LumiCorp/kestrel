import { notifyKestrel } from "./build-production-image.js";

const runNumber = process.env.GITHUB_RUN_NUMBER?.trim();
const runAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim();
const runId = process.env.GITHUB_RUN_ID?.trim();
const sourceRevision = process.env.GITHUB_SHA?.trim();
if (
  !(
    runNumber &&
    runAttempt &&
    runId &&
    sourceRevision &&
    /^[1-9][0-9]*$/u.test(runNumber) &&
    /^[1-9][0-9]*$/u.test(runAttempt) &&
    /^[1-9][0-9]*$/u.test(runId) &&
    /^[0-9a-f]{40}$/u.test(sourceRevision)
  )
) {
  throw new Error("GitHub run identity is invalid.");
}
const buildId = `production-${runNumber}-${runAttempt}`;
await notifyKestrel({
  kind: "environment-runtime",
  workspaceImage: `ghcr.io/lumicorp/kestrel-workspace-runtime:${buildId}`,
  routerImage: `ghcr.io/lumicorp/kestrel-environment-router:${buildId}`,
  sourceRevision,
  githubRunId: runId,
  githubRunAttempt: Number(runAttempt),
});
process.stdout.write(`Environment runtime publication ${buildId} recorded.\n`);

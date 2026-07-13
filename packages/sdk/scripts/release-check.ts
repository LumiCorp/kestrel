import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, "..");
const protocolPackageDir = path.resolve(packageDir, "..", "protocol");
const repoRoot = path.resolve(packageDir, "..", "..");
const packageJsonPath = path.join(packageDir, "package.json");

const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
assertNonEmptyString(manifest.license, "packages/sdk/package.json must declare license.");
assert.ok(
  typeof manifest.repository === "object" && manifest.repository !== null,
  "packages/sdk/package.json must declare repository metadata.",
);
assertNonEmptyString(manifest.homepage, "packages/sdk/package.json must declare homepage.");
assert.ok(
  typeof manifest.bugs === "object" && manifest.bugs !== null,
  "packages/sdk/package.json must declare bugs metadata.",
);
assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, "packages/sdk/package.json must declare keywords.");

const packDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-pack-"));
const extractDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-extract-"));
const fixtureDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-fixture-"));
const storeDir = mkdtempSync(path.join(os.tmpdir(), "kestrel-sdk-store-"));

try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: protocolPackageDir,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], {
    cwd: packageDir,
    stdio: "pipe",
  });

  const tarballName = readdirSync(packDir).find((entry) => entry.startsWith("kestrel-agents-sdk-") && entry.endsWith(".tgz"));
  assert.ok(tarballName, "pnpm pack did not produce an SDK tarball.");
  const protocolTarballName = readdirSync(packDir).find((entry) => entry.startsWith("kestrel-agents-protocol-") && entry.endsWith(".tgz"));
  assert.ok(protocolTarballName, "pnpm pack did not produce a protocol tarball for SDK dependency checks.");

  const tarballPath = path.join(packDir, tarballName);
  const protocolTarballPath = path.join(packDir, protocolTarballName);
  const tarEntries = execFileSync("tar", ["-tf", tarballPath], {
    cwd: packageDir,
    encoding: "utf8",
  }).split("\n").filter((entry) => entry.length > 0);

  assert.ok(tarEntries.includes("package/README.md"), "packed SDK tarball is missing README.md.");
  assert.ok(tarEntries.includes("package/LICENSE"), "packed SDK tarball is missing LICENSE.");
  assert.ok(tarEntries.includes("package/package.json"), "packed SDK tarball is missing package.json.");
  assert.ok(tarEntries.includes("package/dist/index.js"), "packed SDK tarball is missing dist/index.js.");
  assert.ok(tarEntries.includes("package/dist/index.d.ts"), "packed SDK tarball is missing dist/index.d.ts.");
  assert.ok(tarEntries.includes("package/dist/runner.js"), "packed SDK tarball is missing dist/runner.js.");
  assert.ok(tarEntries.includes("package/dist/runner.d.ts"), "packed SDK tarball is missing dist/runner.d.ts.");
  assert.ok(
    tarEntries.includes("package/dist/internal/LocalRunnerTransport.js"),
    "packed SDK tarball is missing the Local Core transport.",
  );
  assert.ok(
    tarEntries.every((entry) => entry.includes("NativeRunnerClient") === false),
    "packed SDK tarball still includes removed NativeRunnerClient artifacts.",
  );

  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    cwd: packageDir,
    stdio: "pipe",
  });

  const packedManifest = JSON.parse(readFileSync(path.join(extractDir, "package", "package.json"), "utf8")) as Record<string, unknown>;
  assertNonEmptyString(packedManifest.license, "packed SDK manifest is missing license.");
  assertNonEmptyString(packedManifest.homepage, "packed SDK manifest is missing homepage.");
  assert.ok(
    typeof packedManifest.bugs === "object" && packedManifest.bugs !== null,
    "packed SDK manifest is missing bugs metadata.",
  );
  const packedDependencies = packedManifest.dependencies as Record<string, unknown> | undefined;
  assert.equal(
    packedDependencies?.["@kestrel-agents/protocol"],
    manifest.version,
    "packed SDK manifest must depend on the exact matching protocol version.",
  );

  writeFileSync(path.join(fixtureDir, "package.json"), JSON.stringify({
    name: "kestrel-sdk-release-check",
    private: true,
    type: "module",
    packageManager: "pnpm@9.12.2",
    pnpm: {
      overrides: {
        "@kestrel-agents/protocol": protocolTarballPath,
      },
    },
  }, null, 2));
  writePnpmWorkspaceSettings(fixtureDir, {
    "@kestrel-agents/protocol": protocolTarballPath,
  });
  execFileSync("pnpm", ["add", "--workspace-root", protocolTarballPath, tarballPath], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      npm_config_store_dir: storeDir,
    },
    stdio: "pipe",
  });

  writeFileSync(path.join(fixtureDir, "contract-check.ts"), `
import type {
  JobRunCommandPayload,
  KestrelClient,
  McpStatusCommandPayload,
  ProjectActionCommandPayload,
  RunStartCommandPayload,
  RunnerAutoCompaction,
  RunnerJobRunResultV1,
  RunnerProfile,
  RunnerResponseByCommandType,
  WorkspaceCheckpointEventPayload,
} from "@kestrel-agents/sdk/runner";

const profile: RunnerProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};
const validRun: RunStartCommandPayload = {
  profileId: "reference",
  turn: {
    sessionId: "session-1",
    message: "run",
    eventType: "user.message",
    autoCompaction: { enabled: true, state: "armed", suppressOnce: false },
  },
};
const validNestedJob: JobRunCommandPayload = {
  input: {
    version: "job_input_v1",
    profileId: "reference",
    turn: { sessionId: "session-1", message: "run" },
  },
};
const validMcp: McpStatusCommandPayload = { profileId: "reference" };
const validAction: ProjectActionCommandPayload = {
  type: "branch.create",
  sessionId: "session-1",
  branchName: "feature/contracts",
};
void [validRun, validNestedJob, validMcp, validAction];

function assertWorkspacePayloadTypes(payload: WorkspaceCheckpointEventPayload): void {
  const checkpointId: string | undefined = payload.checkpoint?.checkpoint.checkpointId;
  const diffFiles: Array<Record<string, unknown>> | undefined = payload.diff?.files;
  const promotionStatus: string | undefined = payload.promotion?.status;
  void [checkpointId, diffFiles, promotionStatus];
}
function assertWorkspaceResponseTypes(
  response: RunnerResponseByCommandType["workspace.checkpoint.diff"],
): void {
  const diffId: string | undefined = response.payload.diff?.diffId;
  const files: Array<Record<string, unknown>> | undefined = response.payload.diff?.files;
  void [diffId, files];
}
void [assertWorkspacePayloadTypes, assertWorkspaceResponseTypes];
type UndoWorkspacePromotionResult = Awaited<
  ReturnType<KestrelClient["undoLatestWorkspacePromotion"]>
>;
function assertUndoWorkspacePromotionType(result: UndoWorkspacePromotionResult): void {
  const restoreStatus: string | undefined = result.restore?.status;
  void restoreStatus;
}
void assertUndoWorkspacePromotionType;

// @ts-expect-error run.start requires profile or profileId
const invalidRun: RunStartCommandPayload = {
  turn: { sessionId: "session-1", message: "run", eventType: "user.message" },
};
// @ts-expect-error job.run requires an outer or nested profile reference
const invalidJob: JobRunCommandPayload = {
  input: {
    version: "job_input_v1",
    turn: { sessionId: "session-1", message: "run" },
  },
};
// @ts-expect-error mcp.status requires profile or profileId
const invalidMcp: McpStatusCommandPayload = {};
// @ts-expect-error run.start profile and profileId are mutually exclusive
const ambiguousRun: RunStartCommandPayload = {
  profile,
  profileId: "reference",
  turn: { sessionId: "session-1", message: "run", eventType: "user.message" },
};
// @ts-expect-error mcp profile and profileId are mutually exclusive
const ambiguousMcp: McpStatusCommandPayload = { profile, profileId: "reference" };
// @ts-expect-error job.run cannot combine outer and nested profile references
const ambiguousJob: JobRunCommandPayload = {
  profileId: "reference",
  input: {
    version: "job_input_v1",
    profileId: "nested-reference",
    turn: { sessionId: "session-1", message: "run" },
  },
};
// @ts-expect-error autoCompaction.enabled must be boolean
const invalidAutoCompaction: RunnerAutoCompaction = { enabled: "yes" };
// @ts-expect-error autoCompaction.state must be a supported state
const invalidAutoCompactionState: RunnerAutoCompaction = { state: "arrmed" };
// @ts-expect-error branch.create requires branchName
const invalidAction: ProjectActionCommandPayload = {
  type: "branch.create",
  sessionId: "session-1",
};
// @ts-expect-error job terminals require the runtime result contract
const invalidJobResult: RunnerJobRunResultV1 = {
  version: "job_run_result_v1",
  sessionId: "session-1",
  threadId: "thread-1",
  runId: "run-1",
  status: "COMPLETED",
  replay: {
    version: "job_replay_pointer_v1",
    sessionId: "session-1",
    threadId: "thread-1",
    runId: "run-1",
    replayQuery: { sessionId: "session-1", threadId: "thread-1", runId: "run-1" },
    commands: { replay: "replay", doctor: "doctor", bundle: "bundle" },
  },
};
void [
  invalidRun,
  invalidJob,
  invalidMcp,
  ambiguousRun,
  ambiguousMcp,
  ambiguousJob,
  invalidAutoCompaction,
  invalidAutoCompactionState,
  invalidAction,
  invalidJobResult,
];
`);
  writeFileSync(path.join(fixtureDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      lib: ["ES2022", "DOM"],
    },
    include: ["contract-check.ts"],
  }, null, 2));
  execFileSync(path.join(repoRoot, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
    cwd: fixtureDir,
    stdio: "pipe",
  });

  const installedPackageDir = path.join(fixtureDir, "node_modules", "@kestrel-agents", "sdk");
  const entryModule = await import(pathToFileURL(path.join(installedPackageDir, "dist", "index.js")).href);
  const runnerModule = await import(pathToFileURL(path.join(installedPackageDir, "dist", "runner.js")).href);
  assert.equal(typeof entryModule.createAgent, "function", "packed SDK root does not export createAgent.");
  assert.equal(typeof runnerModule.KestrelClient, "function", "packed SDK runner subpath does not export KestrelClient.");
  void entryModule.createAgent({ id: "release-check", profileId: "reference", baseUrl: "http://127.0.0.1:1" });
  const remoteClient = new runnerModule.KestrelClient({
    target: { kind: "remote", baseUrl: "http://127.0.0.1:1" },
  });
  const localClient = new runnerModule.KestrelClient({
    target: {
      kind: "local",
      socketPath: path.join(fixtureDir, "core.sock"),
      authToken: "release-check-token",
    },
  });
  await Promise.all([remoteClient.close(), localClient.close()]);

  console.log("sdk release-check passed");
} finally {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(storeDir, { recursive: true, force: true });
}

function assertNonEmptyString(value: unknown, message: string): void {
  assert.ok(typeof value === "string" && value.trim().length > 0, message);
}

function writePnpmWorkspaceSettings(
  fixtureDir: string,
  overrides: Record<string, string>,
): void {
  const fileOverrides = Object.fromEntries(
    Object.entries(overrides).map(([name, tarballPath]) => [name, `file:${tarballPath}`]),
  );
  writeFileSync(
    path.join(fixtureDir, "pnpm-workspace.yaml"),
    `${JSON.stringify({ packages: ["."], overrides: fileOverrides }, null, 2)}\n`,
  );
}

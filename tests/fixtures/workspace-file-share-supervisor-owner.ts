import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";

import { DevShellSupervisor } from "../../src/devshell/DevShellSupervisor.js";
import { InMemoryDevShellStore } from "../../src/devshell/InMemoryDevShellStore.js";

const [workspaceRoot, stateDir, stagePath, payloadPath, serverPath, recordPath] =
  process.argv.slice(2);
if (
  workspaceRoot === undefined ||
  stateDir === undefined ||
  stagePath === undefined ||
  payloadPath === undefined ||
  serverPath === undefined ||
  recordPath === undefined
) {
  throw new Error("Missing workspace file-share owner fixture arguments.");
}

const store = new InMemoryDevShellStore();
const supervisor = new DevShellSupervisor(store, stateDir);
await supervisor.initialize();
const config = Buffer.from(
  JSON.stringify({
    stagePath,
    payloadPath,
    downloadName: "restart-proof.txt",
    mediaType: "text/plain",
    expectedSizeBytes: (await lstat(payloadPath)).size,
    expectedSha256: createHash("sha256").update(await readFile(payloadPath)).digest("hex"),
    stageDevice: String((await lstat(stagePath)).dev),
    stageInode: String((await lstat(stagePath)).ino),
  }),
  "utf8",
).toString("base64url");
let started = await supervisor.startProcess({
  workspaceRoot,
  cwd: workspaceRoot,
  command: `node ${shellQuote(serverPath)} ${shellQuote(config)}`,
  requiredTools: ["node"],
  envMode: "allowlist",
  sourceWriteAuthority: "source_readonly",
  yieldTimeMs: 1_500,
  maxOutputBytes: 16_384,
});
let port = readReadyPort(started.text);
if (port === undefined && started.status === "RUNNING" && started.processId !== undefined) {
  started = await supervisor.readProcess({
    processId: started.processId,
    cursor: started.nextCursor,
    waitMs: 5_000,
    maxBytes: 16_384,
  });
  port = readReadyPort(started.text);
}
if (started.processId === undefined || port === undefined) {
  throw new Error(`File-share server did not become ready: ${JSON.stringify(started)}`);
}
await supervisor.retainProcess({
  processId: started.processId,
  leaseId: "workspace-preview:restart-proof",
  kind: "workspace_preview",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});
const record = await store.getProcess(started.processId);
if (record === null) {
  throw new Error("File-share process record was not persisted.");
}
await writeFile(recordPath, JSON.stringify(record), "utf8");
const running = (
  supervisor as unknown as {
    processes: Map<string, { child: { pid?: number | undefined } }>;
  }
).processes.get(started.processId);
if (running?.child.pid === undefined) {
  throw new Error("File-share process group was unavailable.");
}
process.stdout.write(
  `OWNER_READY ${JSON.stringify({
    processId: started.processId,
    port,
    processGroupId: running.child.pid,
  })}\n`,
);
setInterval(() => undefined, 60_000);

function readReadyPort(output: string): number | undefined {
  for (const line of output.split("\n")) {
    if (!line.startsWith("KESTREL_FILE_SHARE_READY ")) continue;
    const parsed = JSON.parse(line.slice("KESTREL_FILE_SHARE_READY ".length)) as {
      port?: unknown;
    };
    if (typeof parsed.port === "number" && Number.isInteger(parsed.port) && parsed.port > 0) {
      return parsed.port;
    }
  }
  return undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

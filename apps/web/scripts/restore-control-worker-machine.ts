import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { restoreControlWorkerMachine } from "./control-worker-machine";

const app = "kestrel-one-control-worker";

async function main() {
  const expectedRevision = process.argv[2]?.trim();
  if (!expectedRevision) {
    throw new Error("Expected control worker revision is required.");
  }
  const machineId = await restoreControlWorkerMachine({
    app,
    expectedRevision,
  });
  process.stdout.write(`Control worker Machine ${machineId} is running.\n`);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Control worker Machine restoration failed."}\n`,
    );
    process.exitCode = 1;
  });
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contractTest } from "../helpers/contract-test.js";


const repoRoot = path.resolve(import.meta.dirname, "../..");
const sourceDeclarationPath = path.join(repoRoot, "src", "desktopShell", "contracts.d.ts");

contractTest("runtime.hermetic", "desktop shell source declarations include stopping runs and pending actions", async () => {
  const sourceDeclaration = await readFile(sourceDeclarationPath, "utf8");

  assert.match(sourceDeclaration, /DesktopManagedProjectRunStatus = "running" \| "stopping" \| "completed" \| "failed" \| "stopped"/);
  assert.match(sourceDeclaration, /pendingAction\?: "stop" \| "restart" \| undefined;/);
  assert.match(sourceDeclaration, /modifiedAt\?: string \| undefined;/);
  assert.match(sourceDeclaration, /sizeBytes\?: number \| undefined;/);
  assert.match(sourceDeclaration, /export interface DesktopReadinessItem/);
  assert.match(sourceDeclaration, /readiness\?: DesktopReadinessView \| undefined;/);
});

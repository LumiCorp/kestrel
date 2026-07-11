import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const sourceDeclarationPath = path.join(repoRoot, "src", "desktopShell", "contracts.d.ts");
const desktopResourceDeclarationPath = path.join(
  repoRoot,
  "apps",
  "desktop",
  "resources",
  "kestrel-repo",
  "src",
  "desktopShell",
  "contracts.d.ts",
);

test("desktop shell source declarations include stopping runs and pending actions", async () => {
  const sourceDeclaration = await readFile(sourceDeclarationPath, "utf8");

  assert.match(sourceDeclaration, /DesktopManagedProjectRunStatus = "running" \| "stopping" \| "completed" \| "failed" \| "stopped"/);
  assert.match(sourceDeclaration, /pendingAction\?: "stop" \| "restart" \| undefined;/);
  assert.match(sourceDeclaration, /modifiedAt\?: string \| undefined;/);
  assert.match(sourceDeclaration, /sizeBytes\?: number \| undefined;/);
  assert.match(sourceDeclaration, /export interface DesktopReadinessItem/);
  assert.match(sourceDeclaration, /readiness\?: DesktopReadinessView \| undefined;/);
});

test("prepared desktop resource declarations stay in sync with the source contract", async (t) => {
  try {
    await access(desktopResourceDeclarationPath, constants.F_OK);
  } catch {
    t.skip("desktop resources are not prepared in this checkout");
    return;
  }

  const [sourceDeclaration, desktopResourceDeclaration] = await Promise.all([
    readFile(sourceDeclarationPath, "utf8"),
    readFile(desktopResourceDeclarationPath, "utf8"),
  ]);

  assert.equal(desktopResourceDeclaration, sourceDeclaration);
});

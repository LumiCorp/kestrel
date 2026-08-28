import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rendererDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../renderer/src",
);

test("Project settings show selected, connected, and unavailable personal App states", async () => {
  const [projectWorkspace, desktopApp] = await Promise.all([
    readFile(path.join(rendererDirectory, "ProjectWorkspace.tsx"), "utf8"),
    readFile(path.join(rendererDirectory, "DesktopApp.tsx"), "utf8"),
  ]);

  assert.match(projectWorkspace, /<h2>Personal Apps<\/h2>/u);
  assert.match(projectWorkspace, /Selected and connected/u);
  assert.match(projectWorkspace, /Selected but currently unavailable/u);
  assert.match(projectWorkspace, /Connected but not selected/u);
  assert.match(desktopApp, /onPersonalAppIdsChange=\{updateProjectPersonalAppIds\}/u);
});

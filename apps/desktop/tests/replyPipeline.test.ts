import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopAppPath = path.join(testDir, "..", "renderer", "src", "DesktopApp.tsx");
const mainPath = path.join(testDir, "..", "src", "main.ts");

test("Desktop replies request accepted completion in the selected interaction mode", async () => {
  const source = await readFile(desktopAppPath, "utf8");

  assert.match(source, /completionMode:\s*"accepted"/u);
  assert.match(source, /interactionMode:\s*activeThread\.mode/u);
  assert.match(source, /activeThread\.mode === "build" \? \{ actSubmode: "safe" \}/u);
  assert.match(source, /setDraft\(\(current\) => current\.trim\(\)\.length > 0 \? current : message\)/u);
});

test("Desktop forwards runner events from one centralized transport observer", async () => {
  const source = await readFile(mainPath, "utf8");

  assert.match(source, /runnerTransport\.observe\(\{/u);
  assert.match(source, /mainWindow\.webContents\.send\("desktop:runner-event", event\)/u);
  assert.match(source, /onEvent\(\) \{\}/u);
  assert.doesNotMatch(source, /event\.sender\.send\("desktop:runner-event"/u);
});

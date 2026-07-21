import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const desktopAppPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../renderer/src/DesktopApp.tsx",
);

test("Desktop Diff binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const diffBranch = source.slice(
    source.indexOf("<DiffWorkspace"),
    source.indexOf("<TerminalWorkspace"),
  );

  assert.match(diffBranch, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.match(diffBranch, /projectPath=\{activeThread\.projectPath\}/u);
  assert.doesNotMatch(diffBranch, /threadId=\{activeThread\.sessionId\}/u);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../tests/helpers/contract-test.js";

const desktopAppPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../renderer/src/DesktopApp.tsx",
);

contractTest("desktop.hermetic", "Desktop Diff binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const diffBranch = source.slice(
    source.indexOf("<DiffWorkspace"),
    source.indexOf("<TerminalWorkspace"),
  );

  assert.match(diffBranch, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.match(diffBranch, /projectPath=\{activeThread\.projectPath\}/u);
  assert.doesNotMatch(diffBranch, /threadId=\{activeThread\.sessionId\}/u);
});

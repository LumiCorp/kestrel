import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
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

test("Desktop Terminal binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const terminalStart = source.indexOf("<TerminalWorkspace");
  const terminalOpeningElement = source.slice(
    terminalStart,
    source.indexOf("/>", terminalStart) + 2,
  );

  assert.match(terminalOpeningElement, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.doesNotMatch(terminalOpeningElement, /threadId=\{activeThread\.sessionId\}/u);
});

test("Desktop Review binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const reviewBranch = source.slice(
    source.indexOf("<ReviewWorkspace"),
    source.indexOf("<ValidationWorkspace"),
  );

  assert.match(reviewBranch, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.doesNotMatch(reviewBranch, /threadId=\{activeThread\.sessionId\}/u);
});

test("Desktop Validation binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const validationStart = source.indexOf("<ValidationWorkspace");
  const validationOpeningElement = source.slice(
    validationStart,
    source.indexOf("/>", validationStart) + 2,
  );

  assert.match(validationOpeningElement, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.doesNotMatch(validationOpeningElement, /threadId=\{activeThread\.sessionId\}/u);
});

test("Desktop Git binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const gitStart = source.indexOf("<GitWorkspace");
  const gitOpeningElement = source.slice(
    gitStart,
    source.indexOf("/>", gitStart) + 2,
  );

  assert.match(gitOpeningElement, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.doesNotMatch(gitOpeningElement, /threadId=\{activeThread\.sessionId\}/u);
});

test("Desktop Projects binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const projectStart = source.indexOf("<ProjectWorkspace");
  const projectOpeningElement = source.slice(
    projectStart,
    source.indexOf("/>", projectStart) + 2,
  );

  assert.match(projectOpeningElement, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.doesNotMatch(projectOpeningElement, /threadId=\{activeThread\.sessionId\}/u);
});

test("Desktop Preview binds restored conversations to the canonical Local Core thread", async () => {
  const source = await readFile(desktopAppPath, "utf8");
  const previewStart = source.indexOf("<PreviewWorkspace");
  const previewOpeningElement = source.slice(
    previewStart,
    source.indexOf("/>", previewStart) + 2,
  );

  assert.match(previewOpeningElement, /threadId=\{localCoreThreadId\(activeThread\.sessionId\)\}/u);
  assert.doesNotMatch(previewOpeningElement, /threadId=\{activeThread\.sessionId\}/u);
});

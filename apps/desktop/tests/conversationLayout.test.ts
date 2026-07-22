import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../tests/helpers/contract-test.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.join(testDir, "..", "renderer", "src", "styles.css");
const appPath = path.join(testDir, "..", "renderer", "src", "DesktopApp.tsx");
const explorerPath = path.join(testDir, "..", "renderer", "src", "ConversationExplorer.tsx");
const contextSidebarPath = path.join(testDir, "..", "renderer", "src", "ContextSidebar.tsx");

contractTest("desktop.hermetic", "thread messages and composer share the conversation width", async () => {
  const source = await readFile(stylesPath, "utf8");

  assert.match(source, /--conversation-content-width:\s*880px;/u);
  assert.match(source, /\.transcript\s*\{[^}]*padding:\s*28px var\(--conversation-gutter\) 18px;/su);
  assert.match(source, /\.message\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);/su);
  assert.match(
    source,
    /\.message-user\s*\{[^}]*margin-right:\s*max\(0px,\s*calc\(\(100% - var\(--conversation-content-width\)\) \/ 2\)\);/su,
  );
  assert.match(source, /\.activity-line\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),/su);
  assert.match(source, /\.composer\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),/su);
});

contractTest("desktop.hermetic", "context sidebar occupies its width without an empty resizer column", async () => {
  const [styles, sidebar] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(contextSidebarPath, "utf8"),
  ]);

  assert.match(
    styles,
    /\.workspace\.with-inspector\s*\{[^}]*grid-template-columns:\s*var\(--rail-width\) minmax\(0,\s*1fr\) var\(\s*--inspector-width\s*\);/su,
  );
  assert.doesNotMatch(
    styles,
    /\.workspace\.with-inspector\s*\{[^}]*grid-template-columns:[^;}]*5px/su,
  );
  assert.match(sidebar, /className="sidebar-resize-handle"/u);
});

contractTest("desktop.hermetic", "background attachment hydration waits for healthy Core and stays non-blocking", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /runtimeHealth\?\.state !== "healthy"/u);
  assert.match(app, /listAttachments\(localCoreThreadId\(activeThread\.sessionId\)\)/u);
  assert.match(app, /Background attachment hydration is optional\./u);
  assert.doesNotMatch(
    app,
    /listAttachments\(localCoreThreadId\(activeThread\.sessionId\)\)[\s\S]{0,500}\.catch\(\(cause\) => setError/u,
  );
});

contractTest("desktop.hermetic", "startup hydrates inactive thread authority sequentially", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /for \(const thread of rendererState\.threads\)/u);
  assert.match(app, /thread\.id === rendererState\.activeThreadId/u);
  assert.match(app, /await refreshThreadAuthority\(thread\)/u);
  assert.doesNotMatch(
    app,
    /Promise\.all\(rendererState\.threads\.map\([^)]*refreshThreadAuthority/su,
  );
});

contractTest("desktop.hermetic", "composer controls are grouped by context and action", async () => {
  const [styles, app] = await Promise.all([
    readFile(stylesPath, "utf8"),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /\.composer-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/su);
  assert.match(styles, /\.composer-actions-left\s*\{[^}]*justify-self:\s*start;/su);
  assert.match(styles, /\.composer-actions-right\s*\{[^}]*justify-self:\s*end;/su);
  assert.match(app, /className="composer-actions-left"[\s\S]*className="composer-actions-right"/u);
});

contractTest("desktop.hermetic", "active runs suppress stale stalled-attention cards", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /item\.kind !== "stalled_thread_attention" \|\| activeRun === undefined/u);
  assert.match(app, /operatorActionCardItems\.map\(\(item\) => \(/u);
});

contractTest("desktop.hermetic", "user-input requests are composer-owned and do not render action cards", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /inboxItems:\s*operatorInboxItems/u);
  assert.match(
    app,
    /const operatorActionCardItems = operatorInboxItems\.filter\(\s*\(item\) => item\.kind !== "user_input_request",?\s*\);/su,
  );
  assert.match(app, /operatorActionCardItems\.map\(\(item\) => \(/u);
});

contractTest("desktop.hermetic", "conversation rail is grouped and keeps row selection separate from actions", async () => {
  const [app, explorer] = await Promise.all([readFile(appPath, "utf8"), readFile(explorerPath, "utf8")]);
  assert.match(app, /<ConversationExplorer/u);
  assert.match(explorer, /groupRendererThreads\(/u);
  assert.match(explorer, /className="explorer-thread-select"/u);
  assert.match(explorer, /className="explorer-thread-menu-button"/u);
  assert.match(explorer, /Archived \(\$\{archivedCount\}\)/u);
  assert.match(explorer, /aria-label="Search conversations"/u);
});

contractTest("desktop.hermetic", "conversation menus and rename dialog expose keyboard and focus behavior", async () => {
  const explorer = await readFile(explorerPath, "utf8");
  assert.match(explorer, /aria-haspopup="menu"/u);
  assert.match(explorer, /event\.key === "Escape"/u);
  assert.match(explorer, /keepFocusInsideDialog/u);
  assert.match(explorer, /renameInputRef\.current\?\.focus\(\)/u);
  assert.match(explorer, /role="dialog" aria-modal="true"/u);
  assert.match(explorer, /onSubmit=/u);
});

contractTest("desktop.hermetic", "archived conversations are read-only and thread-scoped surfaces are disabled", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /const archivedThreadSelected = activeThread\.archivedAt !== undefined/u);
  assert.match(app, /<section className="archived-conversation-banner"/u);
  assert.match(app, /This transcript is read-only\./u);
  assert.match(app, /disabled=\{archivedThreadSelected\}/u);
  assert.match(app, /if \(activeThread\?\.archivedAt !== undefined\) setSurface\("chat"\)/u);
});

contractTest("desktop.hermetic", "conversation header shows stable project context and established threads use a read-only binding", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /className="titlebar-thread-context"[\s\S]*\{conversationProjectLabel\}/u);
  assert.match(app, /projectLocked=\{projectLocked\}/u);
  assert.match(app, /projectPath=\{threadProjectPath\}/u);
  assert.doesNotMatch(app, /activeProjectPath/u);
});

contractTest("desktop.hermetic", "archive blocking covers runs, waits, and actionable operator requests", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /getRendererThreadArchiveBlockReason\(thread/u);
  assert.match(app, /await refreshThreadAuthority\(thread\)/u);
  assert.match(app, /authority\.view\.inboxItems\.some\(\(item\) => item\.actionable !== false\)/u);
  assert.match(app, /authority\.view\.activeRun\?\.status === "WAITING"/u);
});

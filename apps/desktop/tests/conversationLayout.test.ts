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
const timelinePath = path.join(testDir, "..", "renderer", "src", "ConversationTimeline.tsx");
const mainPath = path.join(testDir, "..", "src", "main.ts");

async function readDesktopStyles(filePath = stylesPath, seen = new Set<string>()): Promise<string> {
  if (seen.has(filePath)) {
    return "";
  }
  seen.add(filePath);
  const source = await readFile(filePath, "utf8");
  const imports = [...source.matchAll(/@import\s+"([^"]+)";/gu)];
  const imported = await Promise.all(
    imports.map((match) => readDesktopStyles(path.resolve(path.dirname(filePath), match[1] ?? ""), seen)),
  );
  return [...imported, source].join("\n");
}

contractTest("desktop.hermetic", "conversation timeline and composer share the conversation width", async () => {
  const source = await readDesktopStyles();

  assert.match(source, /--conversation-content-width:\s*640px;/u);
  assert.match(source, /\.conversation-timeline\s*\{[^}]*padding:\s*var\(--space-5\) var\(--conversation-gutter\) var\(--space-3\);/su);
  assert.match(source, /\.conversation-timeline-list\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);/su);
  assert.match(source, /\.conversation-timeline-list::before\s*\{[^}]*width:\s*1px;/su);
  assert.doesNotMatch(source, /\.activity-line\s*\{/u);
  assert.match(source, /\.composer\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),/su);
});

contractTest("desktop.hermetic", "conversation work is a semantic timeline with collapsed operational detail", async () => {
  const [app, timeline] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(timelinePath, "utf8"),
  ]);

  assert.match(app, /<ConversationTimeline/u);
  assert.doesNotMatch(app, /className="activity-shell"/u);
  assert.match(timeline, /className=\{`conversation-timeline-list/u);
  assert.match(timeline, /<details className="timeline-details">/u);
  assert.match(timeline, /entry\.item\.kind !== "assistant"/u);
  assert.match(timeline, /aria-live="polite"/u);
});

contractTest("desktop.hermetic", "context sidebar joins the full-width work canvas without an empty resizer column", async () => {
  const [styles, sidebar] = await Promise.all([
    readDesktopStyles(),
    readFile(contextSidebarPath, "utf8"),
  ]);

  assert.match(
    styles,
    /\.workspace\.with-inspector\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) var\(--inspector-width\);/su,
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
    readDesktopStyles(),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /\.composer-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/su);
  assert.match(styles, /\.composer-actions-left\s*\{[^}]*justify-self:\s*start;/su);
  assert.match(styles, /\.composer-actions-right\s*\{[^}]*justify-self:\s*end;/su);
  assert.match(app, /className="composer-actions-left"[\s\S]*className="composer-actions-right"/u);
});

contractTest("desktop.hermetic", "composer keeps mode and model semantics without redundant visible chrome", async () => {
  const [styles, app] = await Promise.all([
    readDesktopStyles(),
    readFile(appPath, "utf8"),
  ]);

  assert.match(app, /aria-label="Conversation model"/u);
  assert.doesNotMatch(app, />Model<\/span>/u);
  assert.doesNotMatch(app, /Safe build/u);
  assert.doesNotMatch(app, /composer-mode-label/u);
  assert.match(styles, /\.composer-model-selector\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*170px\);/su);
  assert.doesNotMatch(styles, /\.composer-mode-label/u);
});

contractTest("desktop.hermetic", "composer uses compact idle geometry and expands through presentation state", async () => {
  const [styles, app] = await Promise.all([
    readDesktopStyles(),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /--composer-height:\s*40px;/u);
  assert.match(styles, /\.composer\s*\{[^}]*min-height:\s*var\(--composer-height\);/su);
  assert.match(styles, /\.composer\s*\{[^}]*margin:\s*0 auto var\(--space-6\);/su);
  assert.match(styles, /\.composer:focus-within,\s*\.composer\.composer-expanded\s*\{/su);
  assert.match(app, /const \[composerFocused, setComposerFocused\] = useState\(false\);/u);
  assert.match(app, /className=\{`composer \$\{composerFocused \|\| activeThread\.draft\.trim\(\)\.length > 0/u);
});

contractTest("desktop.hermetic", "active runs suppress stale stalled-attention cards", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /item\.kind !== "stalled_thread_attention" \|\| activeRun === undefined/u);
  assert.match(app, /operatorActionCardItems\.map\(\(item\) => \(/u);
});

contractTest("desktop.hermetic", "user-input requests are timeline-visible and composer-owned", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /inboxItems:\s*operatorInboxItems/u);
  assert.match(
    app,
    /const operatorActionCardItems = operatorInboxItems\.filter\(\s*\(item\) => item\.kind !== "user_input_request",?\s*\);/su,
  );
  assert.match(app, /operatorActionCardItems\.map\(\(item\) => \(/u);
  assert.match(app, /Kestrel needs your input/u);
  assert.match(app, /composerPolicy\.mode === "reply_to_request"/u);
});

contractTest("desktop.hermetic", "find work drawer groups conversations and keeps row selection separate from actions", async () => {
  const [app, explorer] = await Promise.all([readFile(appPath, "utf8"), readFile(explorerPath, "utf8")]);
  assert.match(app, /conversation-rail work-navigator/u);
  assert.match(app, /Find work \(Command-K\)/u);
  assert.match(app, /setWorkNavigatorOpen\(false\)/u);
  assert.match(app, /<ConversationExplorer/u);
  assert.match(app, /role="dialog"/u);
  assert.match(app, /aria-modal=\{workNavigatorOpen \? true : undefined\}/u);
  assert.match(app, /workNavigatorSearchRef\.current\?\.focus\(\)/u);
  assert.match(app, /trigger\?\.isConnected/u);
  assert.match(app, /workNavigatorFallbackRef\.current\?\.focus\(\)/u);
  assert.doesNotMatch(app, /closeWorkNavigator\(false\)/u);
  assert.match(app, /keepFocusInsideDialog\(event\.nativeEvent, workNavigatorRef\.current\)/u);
  assert.match(explorer, /groupRendererThreads\(/u);
  assert.match(explorer, /className="explorer-thread-select"/u);
  assert.match(explorer, /className="explorer-thread-menu-button"/u);
  assert.match(explorer, /Archived \(\$\{archivedCount\}\)/u);
  assert.match(explorer, /aria-label="Search conversations"/u);
});

contractTest("desktop.hermetic", "find work keeps low-value inspection pages out of the everyday navigation", async () => {
  const app = await readFile(appPath, "utf8");

  assert.doesNotMatch(app, /openWorkSurface\("diff"\)/u);
  assert.doesNotMatch(app, /openWorkSurface\("review"\)/u);
  assert.doesNotMatch(app, /openWorkSurface\("validation"\)/u);
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
  assert.match(app, /className="timeline-entry timeline-entry-archived"/u);
  assert.match(app, /className="timeline-entry-content archived-conversation-banner"/u);
  assert.match(app, /This transcript is read-only\./u);
  assert.match(app, /disabled=\{archivedThreadSelected\}/u);
  assert.match(app, /if \(activeThread\?\.archivedAt !== undefined\) setSurface\("chat"\)/u);
});

contractTest("desktop.hermetic", "conversation header keeps project context in the project switcher without sidebar reassignment", async () => {
  const [app, sidebar] = await Promise.all([readFile(appPath, "utf8"), readFile(contextSidebarPath, "utf8")]);
  assert.match(app, /className="project-switcher"[\s\S]*\{conversationProjectLabel\}/u);
  assert.doesNotMatch(app, /<small>\{conversationProjectLabel\}<\/small>/u);
  assert.doesNotMatch(app, /onProjectChange=/u);
  assert.doesNotMatch(sidebar, /Conversation project/u);
  assert.doesNotMatch(app, /activeProjectPath/u);
});

contractTest("desktop.hermetic", "composer selects configured models while Apps remain globally settings-owned", async () => {
  const [app, state, settings, sidebar, main] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "state.ts"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "SettingsWorkspace.tsx"), "utf8"),
    readFile(contextSidebarPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);

  assert.match(app, /aria-label="Conversation model"/u);
  assert.match(app, /settings\.defaultEnabledAppIds/u);
  assert.match(state, /toDesktopExecutionSelection\([\s\S]*enabledAppIds: readonly string\[\]/u);
  assert.match(state, /const enabled = new Set\(enabledAppIds\);/u);
  assert.doesNotMatch(state, /const enabled = new Set\(thread\.enabledAppIds\);/u);
  assert.match(settings, /<strong>Enabled Apps<\/strong>/u);
  assert.doesNotMatch(sidebar, /aria-label="Model configuration"/u);
  assert.doesNotMatch(sidebar, /<span>Apps<\/span>/u);
  assert.match(main, /getEffectiveDesktopEnabledAppIds\(desktopSettings\)\.flatMap/u);
  assert.match(main, /selection: globalExecutionSelection/u);
});

contractTest("desktop.hermetic", "details persist while Find Work remains a calm, temporary drawer", async () => {
  const [app, styles] = await Promise.all([readFile(appPath, "utf8"), readDesktopStyles()]);

  assert.match(app, /readDesktopSidebarState\(INSPECTOR_STATE_KEY, false\)/u);
  assert.match(app, /const detailsLabel = `\$\{inspectorOpen \? "Close" : "Open"\} details/u);
  assert.match(app, /aria-label=\{detailsLabel\}/u);
  assert.match(app, /runtimeHealthLabel\(healthState\)/u);
  assert.match(styles, /\.details-button\.needs-attention/u);
  assert.match(app, /className=\{`conversation-rail work-navigator/u);
  assert.match(app, /aria-modal=\{workNavigatorOpen \? true : undefined\}/u);
  assert.doesNotMatch(styles, /\.workspace\.with-conversation-rail\s*\{/u);
  assert.match(app, /storedWidth === null \? 288 : clampInspectorWidth\(Number\(storedWidth\)\)/u);
});

contractTest("desktop.hermetic", "top-level workspace headers avoid decorative category kickers", async () => {
  const [settings, apps, mission, projects, diagnostics] = await Promise.all([
    readFile(path.join(testDir, "..", "renderer", "src", "SettingsWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "McpWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "MissionControlWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "ProjectWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "DiagnosticsWorkspace.tsx"), "utf8"),
  ]);

  assert.doesNotMatch(settings, /Desktop authority/u);
  assert.doesNotMatch(apps, /<span className="surface-kicker">Capabilities<\/span>/u);
  assert.doesNotMatch(mission, /Session operations/u);
  assert.doesNotMatch(projects, /\{props\.workspace\?\.kind === "managed" \? "Managed worktree" : "Project"\}/u);
  assert.doesNotMatch(diagnostics, /<span className="surface-kicker">Local Core<\/span>/u);
});

contractTest("desktop.hermetic", "archive blocking covers runs, waits, and actionable operator requests", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /getRendererThreadArchiveBlockReason\(thread/u);
  assert.match(app, /await refreshThreadAuthority\(thread\)/u);
  assert.match(app, /authority\.view\.inboxItems\.some\(\(item\) => item\.actionable !== false\)/u);
  assert.match(app, /authority\.view\.activeRun\?\.status === "WAITING"/u);
});

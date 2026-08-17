import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.join(testDir, "..", "renderer", "src", "styles.css");
const appPath = path.join(testDir, "..", "renderer", "src", "DesktopApp.tsx");
const explorerPath = path.join(testDir, "..", "renderer", "src", "ConversationExplorer.tsx");
const contextSidebarPath = path.join(testDir, "..", "renderer", "src", "ContextSidebar.tsx");
const timelinePath = path.join(testDir, "..", "renderer", "src", "ConversationTimeline.tsx");
const browserPreviewPath = path.join(testDir, "..", "renderer", "src", "browserPreview.ts");
const rendererEntryPath = path.join(testDir, "..", "renderer", "src", "main.tsx");
const rendererBoundaryPath = path.join(testDir, "..", "renderer", "src", "RendererErrorBoundary.tsx");
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

test("conversation timeline and composer share the conversation width", async () => {
  const source = await readDesktopStyles();

  assert.match(source, /--conversation-content-width:\s*640px;/u);
  assert.match(source, /\.conversation-timeline\s*\{[^}]*padding:\s*var\(--space-5\) var\(--conversation-gutter\) var\(--space-3\);/su);
  assert.match(source, /\.conversation-timeline-list\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),\s*100%\);/su);
  assert.match(source, /\.conversation-timeline-list::before\s*\{[^}]*width:\s*1px;/su);
  assert.doesNotMatch(source, /\.activity-line\s*\{/u);
  assert.match(source, /\.composer\s*\{[^}]*width:\s*min\(var\(--conversation-content-width\),/su);
  assert.match(source, /\.conversation-timeline-list\s*\{[^}]*max-width:\s*none;/su);
});

test("conversation scrolling and motion use one visible, reduced-motion-safe system", async () => {
  const source = await readDesktopStyles();

  assert.match(
    source,
    /\.conversation-timeline\s*\{[^}]*overscroll-behavior-y:\s*contain;[^}]*scrollbar-gutter:\s*stable;/su,
  );
  assert.match(
    source,
    /\.timeline-details\s*>\s*ol,[\s\S]*?\.composer textarea\s*\{[^}]*scrollbar-gutter:\s*stable;/su,
  );
  assert.match(source, /::-webkit-scrollbar-thumb\s*\{[^}]*background-clip:\s*padding-box;/su);
  assert.match(source, /@keyframes conversation-disclosure-in/u);
  assert.match(
    source,
    /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.timeline-details\.is-open\s*>\s*ol,[\s\S]*?animation:\s*none;/su,
  );
});

test("external-link confirmation keeps actions visible for long destinations", async () => {
  const source = await readDesktopStyles();

  assert.match(
    source,
    /\.external-link-dialog\s*\{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto auto;[^}]*max-height:\s*calc\(100vh - 48px\);[^}]*overflow:\s*hidden;/su,
  );
  assert.match(
    source,
    /\.external-link-destination\s*\{[^}]*overflow:\s*auto;[^}]*overscroll-behavior:\s*contain;/su,
  );
  assert.match(
    source,
    /\.external-link-destination code\s*\{[^}]*overflow-wrap:\s*anywhere;/su,
  );
});

test("conversation work is a semantic timeline with collapsed operational detail", async () => {
  const [app, timeline] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(timelinePath, "utf8"),
  ]);

  assert.match(app, /<ConversationTimeline/u);
  assert.doesNotMatch(app, /className="activity-shell"/u);
  assert.match(timeline, /className=\{`conversation-timeline-list/u);
  assert.ok(timeline.includes('className={`timeline-details ${open ? "is-open" : ""}`}'));
  assert.ok(timeline.includes("const [open, setOpen] = useState(false)"));
  assert.ok(timeline.includes("aria-expanded={open}"));
  assert.ok(timeline.includes("{open ? ("));
  assert.match(timeline, /item\.kind !== "agent_progress"/u);
  assert.match(timeline, /className="timeline-progress"/u);
  assert.match(timeline, /Agent progress/u);
  assert.match(timeline, /aria-live="polite"/u);
});

test("expanded operational details keep their disclosure control visible while scrolling", async () => {
  const styles = await readDesktopStyles();

  assert.match(
    styles,
    /\.timeline-details\.is-open > \.timeline-details-toggle\s*\{[^}]*position:\s*sticky;[^}]*top:\s*var\(--space-1\);[^}]*z-index:\s*2;/su,
  );
  assert.match(
    styles,
    /\.timeline-details\.is-open > \.timeline-details-toggle\s*\{[^}]*background:\s*var\(--bg-pane\);/su,
  );
});

test("context sidebar joins the full-width work canvas without an empty resizer column", async () => {
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

test("background attachment hydration waits for healthy Core and stays non-blocking", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /runtimeHealth\?\.state !== "healthy"/u);
  assert.match(app, /listAttachments\(localCoreThreadId\(activeThread\.sessionId\)\)/u);
  assert.match(app, /Background attachment hydration is optional\./u);
  assert.doesNotMatch(
    app,
    /listAttachments\(localCoreThreadId\(activeThread\.sessionId\)\)[\s\S]{0,500}\.catch\(\(cause\) => setError/u,
  );
});

test("startup hydrates inactive thread authority sequentially", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /for \(const thread of rendererState\.threads\)/u);
  assert.match(app, /thread\.id === rendererState\.activeThreadId/u);
  assert.match(app, /await refreshThreadAuthority\(thread\)/u);
  assert.doesNotMatch(
    app,
    /Promise\.all\(rendererState\.threads\.map\([^)]*refreshThreadAuthority/su,
  );
});

test("composer controls are grouped by context and action", async () => {
  const [styles, app] = await Promise.all([
    readDesktopStyles(),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /\.composer-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) auto;/su);
  assert.match(styles, /\.composer-actions-left\s*\{[^}]*justify-self:\s*start;/su);
  assert.match(styles, /\.composer-actions-right\s*\{[^}]*justify-self:\s*end;/su);
  assert.match(app, /className="composer-actions-left"[\s\S]*className="composer-actions-right"/u);
});

test("composer keeps mode and model semantics without redundant visible chrome", async () => {
  const [styles, app] = await Promise.all([
    readDesktopStyles(),
    readFile(appPath, "utf8"),
  ]);

  assert.match(app, /aria-label="Conversation model"/u);
  assert.match(app, /className="composer-model-chevron"/u);
  assert.doesNotMatch(app, />Model<\/span>/u);
  assert.doesNotMatch(app, /Safe build/u);
  assert.doesNotMatch(app, /composer-mode-label/u);
  assert.match(styles, /\.composer-model-selector\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*170px\);/su);
  assert.doesNotMatch(styles, /\.composer-mode-label/u);
});

test("composer uses compact idle geometry and expands through presentation state", async () => {
  const [styles, app] = await Promise.all([
    readDesktopStyles(),
    readFile(appPath, "utf8"),
  ]);

  assert.match(styles, /--composer-height:\s*40px;/u);
  assert.match(styles, /\.composer\s*\{[^}]*min-height:\s*var\(--composer-height\);/su);
  assert.match(styles, /\.composer\s*\{[^}]*margin:\s*0 auto var\(--space-6\);/su);
  assert.match(styles, /\.composer:focus-within,\s*\.composer\.composer-expanded\s*\{/su);
  assert.match(
    styles,
    /\.composer:focus-within,\s*\.composer\.composer-expanded\s*\{[^}]*gap:\s*var\(--space-2\);[^}]*padding:\s*var\(--space-2\);/su,
  );
  assert.match(app, /const \[composerFocused, setComposerFocused\] = useState\(false\);/u);
  assert.match(app, /className=\{`composer \$\{composerFocused \|\| activeThread\.draft\.trim\(\)\.length > 0/u);
});

test("composer keeps one outer border and borderless internal controls", async () => {
  const styles = await readDesktopStyles();
  const expandedActions = /\.composer:focus-within \.composer-actions,\s*\.composer\.composer-expanded \.composer-actions\s*\{([^}]*)\}/su.exec(styles)?.[1];

  assert.match(styles, /\.composer\s*\{[^}]*border:\s*var\(--border-width\) solid var\(--border-subtle\);/su);
  assert.match(
    styles,
    /\.composer:focus-within,\s*\.composer\.composer-expanded\s*\{[^}]*border-color:\s*var\(--border-strong\);/su,
  );
  assert.match(styles, /\.composer-actions\s*\{[^}]*border:\s*0;/su);
  assert.match(styles, /\.composer-model-selector select\s*\{[^}]*border:\s*0;/su);
  assert.match(styles, /\.attachment-chip\s*\{[^}]*border:\s*0;/su);
  assert.match(styles, /\.composer textarea:focus-visible\s*\{[^}]*outline:\s*0;/su);
  assert.match(
    styles,
    /\.composer \.icon-button,[\s\S]*?\.composer \.attachment-chip button\s*\{[^}]*border:\s*0;/su,
  );
  assert.ok(expandedActions !== undefined);
  assert.doesNotMatch(expandedActions, /border-top:/u);
});

test("browser preview keeps new bridge members from crashing workspace navigation", async () => {
  const preview = await readFile(browserPreviewPath, "utf8");

  assert.match(preview, /onCommand\(\)\s*\{\s*return \(\) => \{\};\s*\}/su);
  assert.match(preview, /async getPendingUninstallResult\(\)\s*\{\s*return undefined;\s*\}/su);
  assert.match(preview, /async getKestrelOneAccount\(\)\s*\{/u);
  assert.match(preview, /async getKestrelOneEnvironments\(\)\s*\{/u);
  assert.match(preview, /async syncWorkspaceSkills\(\)\s*\{\s*return \[\];\s*\}/su);
  assert.match(preview, /bridge = new Proxy\(implementedBridge,/u);
  assert.match(preview, /is unavailable in the browser preview/u);
});

test("renderer failures show a recoverable surface instead of a blank window", async () => {
  const [entry, boundary] = await Promise.all([
    readFile(rendererEntryPath, "utf8"),
    readFile(rendererBoundaryPath, "utf8"),
  ]);

  assert.match(entry, /<RendererErrorBoundary>/u);
  assert.match(boundary, /getDerivedStateFromError/u);
  assert.match(boundary, /role="alert"/u);
  assert.match(boundary, /Reload Kestrel/u);
  assert.match(boundary, /window\.location\.reload\(\)/u);
});

test("active runs suppress stale stalled-attention cards", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /item\.kind !== "stalled_thread_attention" \|\| activeRun === undefined/u);
  assert.match(app, /operatorActionCardItems\.map\(\(item\) => \(/u);
});

test("user-input requests are composer-owned without a duplicate timeline card", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /inboxItems:\s*operatorInboxItems/u);
  assert.match(
    app,
    /const operatorActionCardItems = operatorInboxItems\.filter\(\s*\(item\) => item\.kind !== "user_input_request",?\s*\);/su,
  );
  assert.match(app, /operatorActionCardItems\.map\(\(item\) => \(/u);
  assert.match(app, /composerPolicy\.mode === "reply_to_request"/u);
  assert.match(app, /composerPolicy\.mode === "select_evaluation_option"/u);
  assert.match(app, /recoveryOptionId:\s*optionId/u);
  assert.doesNotMatch(app, /Selected recovery option:/u);
  assert.match(app, /submitConversationMessage/u);
  assert.match(app, /Waiting for your decision/u);
  assert.match(app, /Waiting for your input/u);
  assert.match(app, /Queued behind current work/u);
  assert.doesNotMatch(app, /triggeringFailureCode/u);
  assert.match(app, /<EvaluationTechnicalDisclosure value=\{composerPolicy\.evaluationTechnicalDisclosure\}/u);
  assert.doesNotMatch(
    app,
    /<span>\{composerPolicy\.reviewKind === "evaluation"[\s\S]*?composerPolicy\.triggeringFailureSummary\s*\?\?/u,
  );
  assert.doesNotMatch(app, /timeline-entry-user-request/u);
  assert.doesNotMatch(app, /Kestrel needs your input/u);
});

test("unavailable-project conversations are read-only across work surfaces", async () => {
  const app = await readFile(appPath, "utf8");

  assert.match(app, /isDesktopThreadProjectUnavailable\(activeThread, settings\.projects\)/u);
  assert.match(app, /const threadReadOnlySelected = archivedThreadSelected \|\| unavailableProjectThreadSelected;/u);
  assert.match(app, /disabled=\{threadReadOnlySelected\}/u);
  assert.match(app, /\{threadReadOnlySelected \? null : \(/u);
  assert.match(app, /This conversation is read-only because its project is no longer registered\./u);
});

test("find work drawer groups conversations and keeps row selection separate from actions", async () => {
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
  assert.match(app, /closeWorkNavigator\(false\)/u);
  assert.match(app, /createConversationForProject\(projectPath: string \| null\)/u);
  assert.match(app, /newConversationRequestId=\{newConversationRequestId\}/u);
  assert.match(app, /keepFocusInsideDialog\(event\.nativeEvent, workNavigatorRef\.current\)/u);
  assert.match(explorer, /projectDesktopWorkNavigator\(/u);
  assert.match(explorer, /className="explorer-project-select"/u);
  assert.match(explorer, /aria-label=\{`New conversation in/u);
  assert.match(explorer, /className="explorer-thread-select"/u);
  assert.match(explorer, /className="explorer-thread-menu-button"/u);
  assert.match(explorer, /Archived \(\$\{archivedCount\}\)/u);
  assert.match(explorer, /aria-label="Search conversations"/u);
});

test("conversation search uses one focus border on its outer shell", async () => {
  const styles = await readDesktopStyles();

  assert.match(
    styles,
    /\.explorer-search:focus-within\s*\{[^}]*border-color:\s*var\(--focus-ring\);/su,
  );
  assert.match(
    styles,
    /\.explorer-search input:focus-visible\s*\{[^}]*outline:\s*0;/su,
  );
});

test("settings keep compact checks and wrap navigation at narrow widths", async () => {
  const app = await readFile(path.join(testDir, "..", "renderer", "src", "SettingsWorkspace.tsx"), "utf8");
  const styles = await readDesktopStyles();

  assert.match(
    app,
    /className="settings-check"[\s\S]*?uninstallDisconnectKestrelOne/su,
  );
  assert.match(
    app,
    /className="settings-check"[\s\S]*?uninstallDiscardWorktrees/su,
  );
  assert.match(
    styles,
    /\.settings-card > \.settings-form\s*\{[^}]*border:\s*0;/su,
  );
  assert.match(
    styles,
    /\.surface-header,[\s\S]*?\.settings-surface > \.surface-header\s*\{[^}]*height:\s*var\(--surface-header-height\);/su,
  );
  assert.match(
    styles,
    /\.settings-category-nav\s*\{[^}]*top:\s*var\(--surface-header-height\);/su,
  );
  assert.match(
    styles,
    /\.settings-surface \.capability-card\s*\{[^}]*min-height:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/su,
  );
  assert.match(
    styles,
    /input\[type="checkbox"\],[\s\S]*?input\[type="radio"\]\s*\{[^}]*appearance:\s*auto;[^}]*accent-color:\s*var\(--status-ready\);/su,
  );
  assert.match(
    styles,
    /@media \(max-width:\s*760px\)\s*\{[\s\S]*?\.settings-category-nav\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow-x:\s*visible;/su,
  );
});

test("settings navigation mounts one bounded category page at a time", async () => {
  const app = await readFile(path.join(testDir, "..", "renderer", "src", "SettingsWorkspace.tsx"), "utf8");
  const styles = await readDesktopStyles();

  assert.match(app, /type SettingsPage = "general" \| Exclude<DesktopCapabilityCategory, "tools_services">;/u);
  assert.doesNotMatch(app, /tools_services: "Tools & services"/u);
  assert.match(app, /const \[activePage, setActivePage\] = useState<SettingsPage>/u);
  assert.match(app, /aria-current=\{activePage === page \? "page" : undefined\}/u);
  assert.match(app, /activePage === "general" && attentionCapabilities\.length > 0/u);
  assert.match(app, /activePage === "workspace_data" \? \(/u);
  assert.match(app, /activePage === "connections" \? \(/u);
  assert.match(app, /const category = activePage;/u);
  assert.match(app, /activePage === "models" \? \(/u);
  assert.match(app, /activePage === "general" \? \(/u);
  assert.match(
    styles,
    /\.settings-category-nav a\.active,[\s\S]*?a\[aria-current="page"\]\s*\{[^}]*background:\s*var\(--bg-active\);/su,
  );
});

test("standard workspace headers and project grids share shell geometry", async () => {
  const styles = await readDesktopStyles();

  assert.match(styles, /--surface-header-height:\s*44px;/u);
  assert.match(
    styles,
    /\.project-grid\s*\{[^}]*min-height:\s*calc\(100% - var\(--surface-header-height\)\);/su,
  );
  assert.match(
    styles,
    /@media \(min-width:\s*820px\)\s*\{[\s\S]*?\.project-grid\s*\{[^}]*grid-template-columns:\s*minmax\(360px,\s*1\.25fr\) minmax\(300px,\s*0\.9fr\);/su,
  );
});

test("find work keeps low-value inspection pages out of the everyday navigation", async () => {
  const app = await readFile(appPath, "utf8");

  assert.doesNotMatch(app, /openWorkSurface\("diff"\)/u);
  assert.doesNotMatch(app, /openWorkSurface\("review"\)/u);
  assert.doesNotMatch(app, /openWorkSurface\("validation"\)/u);
});

test("conversation menus and rename dialog expose keyboard and focus behavior", async () => {
  const explorer = await readFile(explorerPath, "utf8");
  assert.match(explorer, /aria-haspopup="menu"/u);
  assert.match(explorer, /event\.key === "Escape"/u);
  assert.match(explorer, /keepFocusInsideDialog/u);
  assert.match(explorer, /renameInputRef\.current\?\.focus\(\)/u);
  assert.match(explorer, /role="dialog" aria-modal="true"/u);
  assert.match(explorer, /onSubmit=/u);
});

test("archived conversations are read-only and thread-scoped surfaces are disabled", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /const archivedThreadSelected = activeThread\?\.archivedAt !== undefined/u);
  assert.match(app, /className="timeline-entry timeline-entry-archived"/u);
  assert.match(app, /className="timeline-entry-content archived-conversation-banner"/u);
  assert.match(app, /This transcript is read-only\./u);
  assert.match(app, /disabled=\{threadReadOnlySelected\}/u);
  assert.match(app, /if \(threadReadOnlySelected\) setSurface\("chat"\)/u);
});

test("conversation header keeps project context in the project switcher without sidebar reassignment", async () => {
  const [app, sidebar] = await Promise.all([readFile(appPath, "utf8"), readFile(contextSidebarPath, "utf8")]);
  assert.match(app, /const titlebarProjectLabel = surface === "projects" \? selectedProjectLabel : conversationProjectLabel/u);
  assert.match(app, /className="project-switcher"[\s\S]*\{titlebarProjectLabel\}/u);
  assert.doesNotMatch(app, /<small>\{conversationProjectLabel\}<\/small>/u);
  assert.doesNotMatch(app, /onProjectChange=/u);
  assert.doesNotMatch(sidebar, /Conversation project/u);
  assert.doesNotMatch(app, /activeProjectPath/u);
});

test("selected project persistence waits for renderer bootstrap", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /const \[selectedProjectPersistenceReady, setSelectedProjectPersistenceReady\] = useState\(false\)/u);
  assert.match(app, /if \(!selectedProjectPersistenceReady\) return;[\s\S]*writeDesktopSelectedProjectPath\(selectedProjectPath\)/u);
  assert.match(app, /setSelectedProjectPersistenceReady\(true\)/u);
});

test("project Files expose conversation actions only to the owning project thread", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /const projectConversationMatchesActiveThread = selectedProject\?\.path === activeThread\.projectPath/u);
  assert.match(app, /openFiles=\{projectConversationMatchesActiveThread \? activeThread\.openFiles : \[\]\}/u);
  assert.match(app, /onAttachFile=\{projectConversationMatchesActiveThread \?/u);
  assert.match(app, /onOpenFile=\{projectConversationMatchesActiveThread \?/u);
});

test("composer owns conversation workflows while Apps own global availability", async () => {
  const [app, state, settings, sidebar, main] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "state.ts"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "SettingsWorkspace.tsx"), "utf8"),
    readFile(contextSidebarPath, "utf8"),
    readFile(mainPath, "utf8"),
  ]);

  assert.match(app, /aria-label="Conversation model"/u);
  assert.match(app, /<ConversationWorkflowControl/u);
  assert.match(state, /enabledWorkflowAppIds: string\[\]/u);
  assert.match(state, /const enabled = new Set\(thread\.enabledWorkflowAppIds\);/u);
  assert.doesNotMatch(settings, /<strong>Enabled Apps<\/strong>/u);
  assert.match(settings, /<legend>Appearance<\/legend>/u);
  assert.doesNotMatch(sidebar, /aria-label="Model configuration"/u);
  assert.doesNotMatch(sidebar, /<span>Apps<\/span>/u);
  assert.match(main, /resolveAuthoritativeDesktopExecutionSelection/u);
  assert.match(main, /selection: globalExecutionSelection/u);
});

test("details persist while Find Work remains a calm, temporary drawer", async () => {
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

test("top-level workspace headers avoid decorative category kickers", async () => {
  const [settings, apps, mission, projects, diagnostics] = await Promise.all([
    readFile(path.join(testDir, "..", "renderer", "src", "SettingsWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "McpWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "UnifiedMissionControlWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "ProjectWorkspace.tsx"), "utf8"),
    readFile(path.join(testDir, "..", "renderer", "src", "DiagnosticsWorkspace.tsx"), "utf8"),
  ]);

  assert.doesNotMatch(settings, /Desktop authority/u);
  assert.doesNotMatch(apps, /<span className="surface-kicker">Capabilities<\/span>/u);
  assert.doesNotMatch(mission, /Session operations|Legacy authority/u);
  assert.doesNotMatch(projects, /\{props\.workspace\?\.kind === "managed" \? "Managed worktree" : "Project"\}/u);
  assert.doesNotMatch(diagnostics, /<span className="surface-kicker">Local Core<\/span>/u);
});

test("archive blocking covers runs, waits, and actionable operator requests", async () => {
  const app = await readFile(appPath, "utf8");
  assert.match(app, /getRendererThreadArchiveBlockReason\(thread/u);
  assert.match(app, /await refreshThreadAuthority\(thread\)/u);
  assert.match(app, /authority\.view\.inboxItems\.some\(\(item\) => item\.actionable !== false\)/u);
  assert.match(app, /authority\.view\.activeRun\?\.status === "WAITING"/u);
});

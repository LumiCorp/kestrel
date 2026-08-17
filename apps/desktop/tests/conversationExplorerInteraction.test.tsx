import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ConversationExplorer } from "../renderer/src/ConversationExplorer.js";
import { ContextSidebar } from "../renderer/src/ContextSidebar.js";
import { keepFocusInsideDialog } from "../renderer/src/dialogFocus.js";
import { createRendererThread } from "../renderer/src/state.js";
import { KESTREL_STANDARD_APP_MANIFESTS } from "@kestrel-agents/protocol";
import { ConversationWorkflowControl } from "../renderer/src/ConversationWorkflowControl.js";
import type { DesktopMcpServerConfig } from "../src/contracts.js";

function installDom(): { root: Root; container: HTMLDivElement } {
  const browser = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    KeyboardEvent: browser.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  return { root: createRoot(container), container };
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(found, `Expected button '${label}'.`);
  return found;
}

test("conversation explorer hides the archive shortcut until an archived conversation exists", async () => {
  const { root, container } = installDom();
  const thread = { ...createRendererThread(), id: "thread-1", title: "Current conversation" };
  await act(async () => root.render(<ConversationExplorer
    threads={[thread]}
    activeThreadId={thread.id}
    projects={[]}
    onSelect={() => {}}
    onNewConversation={() => {}}
    onRename={() => {}}
    onArchive={async () => ({ status: "archived" })}
    onUndoArchive={() => {}}
    onRestore={() => {}}
  />));
  assert.doesNotMatch(container.textContent ?? "", /Archived \(0\)/u);
  await act(async () => root.unmount());
});

test("conversation explorer exposes its search field for Find Work focus", async () => {
  const { root, container } = installDom();
  const thread = { ...createRendererThread(), id: "thread-1", title: "Current conversation" };
  const searchInputRef = React.createRef<HTMLInputElement>();
  await act(async () => root.render(<ConversationExplorer
    threads={[thread]}
    activeThreadId={thread.id}
    projects={[]}
    searchInputRef={searchInputRef}
    onSelect={() => {}}
    onNewConversation={() => {}}
    onRename={() => {}}
    onArchive={async () => ({ status: "archived" })}
    onUndoArchive={() => {}}
    onRestore={() => {}}
  />));
  assert.equal(searchInputRef.current, container.querySelector('[aria-label="Search conversations"]'));
  searchInputRef.current?.focus();
  assert.equal(document.activeElement, searchInputRef.current);
  await act(async () => root.unmount());
});

test("conversation explorer exposes empty projects and requires an explicit project for global creation", async () => {
  const { root, container } = installDom();
  const thread = { ...createRendererThread({ projectPath: "/project/a" }), id: "thread-1", title: "Running work" };
  const created: Array<string | null> = [];
  const selectedProjects: string[] = [];
  await act(async () => root.render(<ConversationExplorer
    threads={[thread]}
    activeThreadId={thread.id}
    projects={[{ path: "/project/a", label: "Alpha" }, { path: "/project/b", label: "Empty project" }]}
    navigation={{ [thread.id]: { thread, status: "running", activity: "Running tests", updatedAt: thread.updatedAt } }}
    selectedProjectPath="/project/a"
    newConversationRequestId={0}
    onSelect={() => {}}
    onSelectProject={(projectPath) => selectedProjects.push(projectPath)}
    onNewConversation={(projectPath) => created.push(projectPath)}
    onAddProjectAndCreate={async () => {}}
    onRename={() => {}}
    onArchive={async () => ({ status: "archived" })}
    onUndoArchive={() => {}}
    onRestore={() => {}}
  />));

  assert.ok(container.querySelector('[title="/project/b"]'), "empty registered project must remain visible");
  assert.ok(container.querySelector('[aria-label="Collapse Alpha"]'));
  assert.ok(container.querySelector('[aria-label="New conversation in Alpha"]'));
  await act(async () => container.querySelector<HTMLButtonElement>('[title="/project/b"]')?.click());
  assert.deepEqual(selectedProjects, ["/project/b"]);

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="New conversation"]')?.click());
  const picker = container.querySelector('[aria-label="Choose a project for the new conversation"]');
  assert.ok(picker);
  assert.equal(document.activeElement?.textContent, "Alpha");
  await act(async () => button(picker as HTMLElement, "Empty project").click());
  assert.deepEqual(created, ["/project/b"]);
  await act(async () => root.unmount());
});

test("Find Work focus wraps within its dialog", () => {
  installDom();
  const drawer = document.createElement("aside");
  const first = document.createElement("button");
  const last = document.createElement("input");
  drawer.append(first, last);
  document.body.append(drawer);

  last.focus();
  const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  keepFocusInsideDialog(forward, drawer);
  assert.equal(document.activeElement, first);
  assert.equal(forward.defaultPrevented, true);

  const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  keepFocusInsideDialog(backward, drawer);
  assert.equal(document.activeElement, last);
  assert.equal(backward.defaultPrevented, true);
});

test("composer workflow control keeps unavailable workflows visible and selects ready workflows", async () => {
  const { root, container } = installDom();
  const changes: string[][] = [];
  const setup: string[] = [];
  const workflow = KESTREL_STANDARD_APP_MANIFESTS.find((app) => app.id === "workflow.software_delivery")!;
  const servers: DesktopMcpServerConfig[] = [...new Set(workflow.dependencies?.flatMap((dependency) => dependency.appIds) ?? [])]
    .map((appId) => {
      const manifest = KESTREL_STANDARD_APP_MANIFESTS.find((app) => app.id === appId)!;
      const required = workflow.dependencies?.flatMap((dependency) => dependency.requiredCapabilityPacks?.[appId] ?? []) ?? [];
      return {
        id: `standard.${appId}`, appId, name: manifest.name, transport: "http", url: "https://example.test/mcp",
        enabled: true, source: "desktop", sourceKind: "desktop-managed", toolCount: 1,
        capabilityPacks: required.length > 0 ? required : manifest.capabilityPacks.map((pack) => pack.key),
      };
    });
  await act(async () => root.render(<ConversationWorkflowControl selectedIds={[]} servers={[]} onChange={(ids) => changes.push(ids)} onSetup={(id) => setup.push(id)} />));
  await act(async () => button(container, "Workflows").click());
  const unavailable = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Software delivery"))!;
  assert.equal((unavailable.querySelector("input") as HTMLInputElement).disabled, true);
  await act(async () => (unavailable.parentElement?.querySelector("button") as HTMLButtonElement).click());
  assert.deepEqual(setup, ["workflow.software_delivery"]);
  await act(async () => root.render(<ConversationWorkflowControl selectedIds={[]} servers={servers} onChange={(ids) => changes.push(ids)} onSetup={(id) => setup.push(id)} />));
  const ready = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Software delivery"))!;
  const checkbox = ready.querySelector("input") as HTMLInputElement;
  assert.equal(checkbox.disabled, false);
  await act(async () => checkbox.click());
  assert.deepEqual(changes.at(-1), ["workflow.software_delivery"]);
  await act(async () => root.unmount());
});

test("conversation archive waits for authoritative preflight before offering Undo", async () => {
  const { root, container } = installDom();
  const thread = { ...createRendererThread(), id: "thread-1", title: "Review me" };
  let resolveArchive!: (result: { status: "archived" }) => void;
  const archiveResult = new Promise<{ status: "archived" }>((resolve) => { resolveArchive = resolve; });
  let archiveCalls = 0;
  await act(async () => root.render(<ConversationExplorer
    threads={[thread]}
    activeThreadId={thread.id}
    projects={[]}
    onSelect={() => {}}
    onNewConversation={() => {}}
    onRename={() => {}}
    onArchive={async () => { archiveCalls += 1; return await archiveResult; }}
    onUndoArchive={() => {}}
    onRestore={() => {}}
  />));
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[aria-label="Conversation actions for Review me"]')?.click();
  });
  await act(async () => { button(container, "Archive").click(); });
  assert.match(container.textContent ?? "", /Checking “Review me”…/u);
  assert.doesNotMatch(container.textContent ?? "", /Undo/u);
  assert.equal(archiveCalls, 1);
  await act(async () => { resolveArchive({ status: "archived" }); await archiveResult; });
  assert.match(container.textContent ?? "", /Archived “Review me”\./u);
  assert.match(container.textContent ?? "", /Undo/u);
  await act(async () => root.unmount());
});

test("conversation rename dialog owns focus and Escape returns it to the menu button", async () => {
  const { root, container } = installDom();
  const thread = { ...createRendererThread(), id: "thread-1", title: "Rename me" };
  await act(async () => root.render(<ConversationExplorer
    threads={[thread]}
    activeThreadId={thread.id}
    projects={[]}
    onSelect={() => {}}
    onNewConversation={() => {}}
    onRename={() => {}}
    onArchive={async () => ({ status: "archived" })}
    onUndoArchive={() => {}}
    onRestore={() => {}}
  />));
  const menuButton = container.querySelector<HTMLButtonElement>('[aria-label="Conversation actions for Rename me"]');
  assert.ok(menuButton);
  await act(async () => { menuButton.click(); });
  await act(async () => { button(container, "Rename").click(); });
  const input = container.querySelector<HTMLInputElement>('.rename-dialog input');
  assert.ok(input);
  assert.equal(document.activeElement, input);
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(document.activeElement, menuButton);
  await act(async () => root.unmount());
});

test("conversation context exposes active work and routes a capability exception to Settings", async () => {
  const { root, container } = installDom();
  let openedCapability: string | undefined;
  await act(async () => root.render(<ContextSidebar
    thread={createRendererThread({ projectPath: "/project" })}
    activeRun={true}
    activity="Waiting for approval"
    error="The configured provider needs attention."
    errorCapability="model.openai"
    inboxItems={[{
      itemId: "approval-1",
      kind: "approval_request",
      threadId: "thread-1",
      sessionId: "session-1",
      title: "Approve the file change",
      actionable: true,
      createdAt: new Date().toISOString(),
    }]}
    onOpenSettings={(capability) => { openedCapability = capability; }}
    onResizeStart={() => {}}
  />));

  assert.match(container.textContent ?? "", /Waiting for approval/u);
  assert.match(container.textContent ?? "", /Approve the file change/u);
  assert.doesNotMatch(container.textContent ?? "", /No run in progress/u);
  assert.equal(container.querySelector('[aria-label="Conversation project"]'), null);
  await act(async () => container.querySelector<HTMLButtonElement>(".context-exception button")?.click());
  assert.equal(openedCapability, "model.openai");
  await act(async () => root.unmount());
});

test("conversation context stays quiet when idle and healthy", async () => {
  const { root, container } = installDom();
  await act(async () => root.render(<ContextSidebar
    thread={{ ...createRendererThread({ projectPath: "/project" }), title: "Quiet conversation" }}
    activeRun={false}
    activity="Ready"
    inboxItems={[]}
    onOpenSettings={() => {}}
    onResizeStart={() => {}}
  />));

  assert.match(container.textContent ?? "", /Quiet conversation/u);
  assert.doesNotMatch(container.textContent ?? "", /No run in progress/u);
  assert.doesNotMatch(container.textContent ?? "", /Ready/u);
  assert.equal(container.querySelector(".context-exception"), null);
  await act(async () => root.unmount());
});

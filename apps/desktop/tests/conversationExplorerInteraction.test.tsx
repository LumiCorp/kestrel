import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ConversationExplorer } from "../renderer/src/ConversationExplorer.js";
import { ContextSidebar } from "../renderer/src/ContextSidebar.js";
import { createRendererThread } from "../renderer/src/state.js";
import type { DesktopRendererSettings } from "../src/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

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

contractTest("desktop.hermetic", "conversation archive waits for authoritative preflight before offering Undo", async () => {
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

contractTest("desktop.hermetic", "conversation rename dialog owns focus and Escape returns it to the menu button", async () => {
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

contractTest("desktop.hermetic", "conversation project selection locks during submission and becomes read-only after binding", async () => {
  const { root, container } = installDom();
  const thread = createRendererThread({
    modelConfigurationId: "model-default",
    modelConfigurationRevision: 1,
  });
  const settings = {
    projects: [{ path: "/project", label: "Project" }],
    apps: [],
    providerReadiness: [],
    modelConfigurations: [{
      id: "model-default",
      name: "Default",
      currentRevision: 1,
      revisions: [{ revision: 1, policy: { provider: "openai", model: "model" } }],
    }],
  } as unknown as DesktopRendererSettings;
  const renderSidebar = async (locked: boolean, projectLocked: boolean) => {
    await act(async () => root.render(<ContextSidebar
      surface="chat"
      thread={thread}
      settings={settings}
      locked={locked}
      projectPath="/project"
      projectLabel="Project"
      projectLocked={projectLocked}
      onModelConfigurationChange={() => {}}
      onAppToggle={() => {}}
      onProjectChange={() => {}}
      onNewConversationForProject={() => {}}
      onAddProject={() => {}}
      onRestartRuntime={() => {}}
      onResizeStart={() => {}}
    />));
  };

  await renderSidebar(false, false);
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Conversation project"]')?.disabled, false);
  await renderSidebar(true, false);
  assert.equal(container.querySelector<HTMLSelectElement>('[aria-label="Conversation project"]')?.disabled, true);
  await renderSidebar(true, true);
  assert.equal(container.querySelector('[aria-label="Conversation project"]'), null);
  assert.match(container.textContent ?? "", /New conversation in another project/u);
  await act(async () => root.unmount());
});

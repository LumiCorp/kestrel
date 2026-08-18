import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { ProjectWorkspace } from "../renderer/src/ProjectWorkspace.js";
import { createRendererThread } from "../renderer/src/state.js";

test("project overview summarizes work and routes thread and creation actions", async () => {
  const browser = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1; },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(browser, {
    kestrelDesktop: {
      listDirectory: async () => ({
        rootPath: "/project",
        directoryPath: "/project",
        entries: [{ path: "/project/README.md", name: "README.md", kind: "file" }],
      }),
      readProjectLauncher: async () => undefined,
      listProjectRuns: async () => [],
      watchProjectFiles: async () => undefined,
      unwatchProjectFiles: async () => undefined,
      syncWorkspaceSkills: async () => [],
      onProjectRuns: () => () => {},
      onProjectFilesChanged: () => () => {},
    },
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);
  const running = { ...createRendererThread({ projectPath: "/project" }), id: "running", title: "Run tests" };
  const waiting = { ...createRendererThread({ projectPath: "/project" }), id: "waiting", title: "Deploy" };
  const selected: string[] = [];
  let created = 0;
  let removed = 0;
  await act(async () => root.render(<ProjectWorkspace
    project={{ id: "project-1", path: "/project", label: "Kestrel" }}
    threads={[
      { thread: waiting, status: "waiting", activity: "Approve deployment", updatedAt: waiting.updatedAt },
      { thread: running, status: "running", activity: "Running tests", updatedAt: running.updatedAt },
    ]}
    openFiles={[]}
    onChat={() => { created += 1; }}
    onRemoveProject={() => { removed += 1; }}
    onSelectThread={(threadId) => selected.push(threadId)}
    onError={() => {}}
  />));

  assert.match(container.textContent ?? "", /Overview/u);
  assert.match(container.textContent ?? "", /Files/u);
  assert.match(container.textContent ?? "", /Running tests/u);
  assert.match(container.textContent ?? "", /Approve deployment/u);
  assert.match(container.textContent ?? "", /2Total/u);
  assert.equal(
    [...container.querySelectorAll("button")].filter((entry) => entry.textContent === "New conversation").length,
    1,
  );
  await act(async () => [...container.querySelectorAll("button")].find((entry) => entry.textContent?.startsWith("Deploy"))?.click());
  assert.deepEqual(selected, ["waiting"]);
  await act(async () => [...container.querySelectorAll("button")].find((entry) => entry.textContent === "New conversation")?.click());
  assert.equal(created, 1);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove project from Kestrel"]')?.click());
  assert.match(container.textContent ?? "", /does not delete the folder, repository, or local files/u);
  await act(async () => [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Remove project")?.click());
  assert.equal(removed, 1);
  await act(async () => [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Files")?.click());
  await act(async () => Promise.resolve());
  assert.match(container.textContent ?? "", /README\.md/u);
  assert.equal(container.querySelector('[aria-label="Attach README.md"]'), null, "cross-project Files must not expose conversation actions without an explicit owner");
  await act(async () => root.unmount());
});

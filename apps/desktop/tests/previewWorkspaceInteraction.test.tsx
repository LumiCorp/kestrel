import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { PreviewWorkspace } from "../renderer/src/PreviewWorkspace.js";
import type {
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
  DesktopProjectLauncherDescriptor,
} from "../src/contracts.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

function run(
  input: Partial<DesktopManagedProjectRun> = {},
): DesktopManagedProjectRun {
  return {
    runId: "run-1",
    projectPath: "/repo",
    manifestPath: "/repo/package.json",
    scriptName: "dev",
    packageManager: "pnpm",
    command: "pnpm run dev",
    status: "running",
    startedAt: "2026-07-23T12:00:00.000Z",
    updatedAt: "2026-07-23T12:00:01.000Z",
    primaryPreviewUrl: "http://localhost:3000/",
    previewUrls: [
      {
        url: "http://localhost:3000/",
        source: "stdout",
        firstSeenAt: "2026-07-23T12:00:01.000Z",
        lastSeenAt: "2026-07-23T12:00:01.000Z",
        line: "http://localhost:3000/",
        count: 1,
      },
    ],
    outputTail: [
      {
        source: "stdout",
        line: "http://localhost:3000/",
        observedAt: "2026-07-23T12:00:01.000Z",
      },
    ],
    stdoutTail: ["http://localhost:3000/"],
    stderrTail: [],
    ...input,
  };
}

function installPreviewDom(input: {
  runs?: DesktopManagedProjectRun[] | undefined;
  failFirstLoad?: boolean | undefined;
  restartWithoutUrl?: boolean | undefined;
  scripts?: DesktopProjectLauncherDescriptor["scripts"] | undefined;
}) {
  const browser = new Window({ url: "http://localhost/" });
  let currentRuns = input.runs ?? [];
  let runsListener:
    | ((runs: DesktopManagedProjectRun[]) => void)
    | undefined;
  let diagnosticListener:
    | ((diagnostic: DesktopPreviewDiagnostic) => void)
    | undefined;
  const calls = {
    starts: 0,
    startScripts: [] as string[],
    stops: [] as string[],
    restarts: [] as string[],
    loads: [] as string[],
    back: 0,
    forward: 0,
  };
  const launcher: DesktopProjectLauncherDescriptor = {
    projectPath: "/repo",
    manifestPath: "/repo/package.json",
    packageManager: "pnpm",
    packageManagerSelectionRequired: false,
    scripts: input.scripts ?? [{ name: "dev", command: "vite" }],
  };

  Object.assign(browser.HTMLElement.prototype, {
    loadURL(url: string) {
      calls.loads.push(url);
      if (input.failFirstLoad && calls.loads.length === 1) {
        return Promise.reject(
          new Error(
            "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
          ),
        );
      }
      return Promise.resolve();
    },
    reload() {},
    goBack() {
      calls.back += 1;
    },
    goForward() {
      calls.forward += 1;
    },
    canGoBack() {
      return true;
    },
    canGoForward() {
      return false;
    },
    getWebContentsId() {
      return 27;
    },
    capturePage() {
      return Promise.resolve({ toDataURL: () => "data:image/png;base64,test" });
    },
  });

  Object.assign(browser, {
    confirm: () => true,
    kestrelDesktop: {
      readProjectLauncher: async () => launcher,
      listProjectRuns: async () => currentRuns,
      onProjectRuns(listener: (runs: DesktopManagedProjectRun[]) => void) {
        runsListener = listener;
        return () => {
          runsListener = undefined;
        };
      },
      onPreviewDiagnostic(
        listener: (diagnostic: DesktopPreviewDiagnostic) => void,
      ) {
        diagnosticListener = listener;
        return () => {
          diagnosticListener = undefined;
        };
      },
      async startProjectRun(input: { scriptName: string }) {
        calls.starts += 1;
        calls.startScripts.push(input.scriptName);
        const started = run({
          runId: `run-${calls.starts}`,
          scriptName: input.scriptName,
        });
        currentRuns = [started, ...currentRuns];
        runsListener?.(currentRuns);
        return started;
      },
      async stopProjectRun(runId: string) {
        calls.stops.push(runId);
        currentRuns = currentRuns.map((entry) =>
          entry.runId === runId
            ? {
                ...entry,
                status: "stopped" as const,
                completedAt: "2026-07-23T12:00:05.000Z",
              }
            : entry,
        );
        runsListener?.(currentRuns);
        return currentRuns.find((entry) => entry.runId === runId);
      },
      async restartProjectRun(runId: string) {
        calls.restarts.push(runId);
        const restarted = input.restartWithoutUrl
          ? run({
              runId: `${runId}-restart`,
              primaryPreviewUrl: undefined,
              previewUrls: [],
              outputTail: [],
              stdoutTail: [],
            })
          : run({ runId: `${runId}-restart` });
        currentRuns = [
          restarted,
          ...currentRuns.map((entry) =>
            entry.runId === runId
              ? {
                  ...entry,
                  status: "stopped" as const,
                  completedAt: "2026-07-23T12:00:05.000Z",
                }
              : entry,
          ),
        ];
        runsListener?.(currentRuns);
        return restarted;
      },
      async openExternal() {},
    },
  });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    KeyboardEvent: browser.KeyboardEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = browser.document.createElement(
    "div",
  ) as unknown as HTMLDivElement;
  browser.document.body.append(container);
  return {
    root: createRoot(container),
    container,
    calls,
    emitDiagnostic(diagnostic: DesktopPreviewDiagnostic) {
      diagnosticListener?.(diagnostic);
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `Expected button '${label}'.`);
  return found;
}

async function renderPreview(
  root: Root,
): Promise<void> {
  await act(async () =>
    root.render(
      <PreviewWorkspace
        projectPath="/repo"
        threadId="thread-1"
        onAttachVisualFeedback={async () => {}}
        onError={() => {}}
      />,
    ),
  );
  await flush();
}

contractTest(
  "desktop.hermetic",
  "preview lifecycle uses one intelligent Start, Stop, and Restart control",
  async () => {
    const { root, container, calls } = installPreviewDom({ runs: [] });
    await renderPreview(root);

    await act(async () => {
      button(container, "Start dev").click();
    });
    await flush();
    assert.equal(calls.starts, 1);
    assert.ok(button(container, "Stop"));
    assert.equal(
      container.querySelector<HTMLSelectElement>(
        '[aria-label="Preview configuration"]',
      )?.disabled,
      true,
    );

    await act(async () => {
      button(container, "Stop").click();
    });
    await flush();
    assert.deepEqual(calls.stops, ["run-1"]);
    assert.ok(button(container, "Restart dev"));
    assert.equal(
      container.querySelector<HTMLSelectElement>(
        '[aria-label="Preview configuration"]',
      )?.disabled,
      false,
    );
    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.hermetic",
  "preview starts a newly selected script instead of restarting settled history",
  async () => {
    const { root, container, calls } = installPreviewDom({
      runs: [run({ status: "stopped" })],
      scripts: [
        { name: "dev", command: "vite" },
        { name: "docs", command: "vitepress dev" },
      ],
    });
    await renderPreview(root);
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Preview configuration"]',
    );
    assert.ok(select);

    await act(async () => {
      select.value = "docs";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.ok(button(container, "Start docs"));

    await act(async () => {
      button(container, "Start docs").click();
    });
    await flush();
    assert.deepEqual(calls.startScripts, ["docs"]);
    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.hermetic",
  "preview clears a prior run URL and retries an early load after dom-ready",
  async () => {
    const stopped = run({ status: "stopped" });
    const restartFixture = installPreviewDom({
      runs: [stopped],
      restartWithoutUrl: true,
    });
    await renderPreview(restartFixture.root);
    await act(async () => {
      button(restartFixture.container, "Restart dev").click();
    });
    await flush();
    assert.equal(
      restartFixture.container.querySelector<HTMLInputElement>(
        '[aria-label="Preview address"]',
      )?.value,
      "",
    );
    assert.deepEqual(restartFixture.calls.loads, []);
    await act(async () => restartFixture.root.unmount());

    const loadFixture = installPreviewDom({
      runs: [run()],
      failFirstLoad: true,
    });
    await renderPreview(loadFixture.root);
    assert.equal(loadFixture.calls.loads.length, 1);
    const webview = loadFixture.container.querySelector("webview");
    assert.ok(webview);
    await act(async () => {
      webview.dispatchEvent(new Event("dom-ready"));
      await Promise.resolve();
    });
    assert.deepEqual(loadFixture.calls.loads, [
      "http://localhost:3000/",
      "http://localhost:3000/",
    ]);
    await act(async () => loadFixture.root.unmount());
  },
);

contractTest(
  "desktop.hermetic",
  "preview overflow supports focus, arrow navigation, Escape, and running restart",
  async () => {
    const current = run();
    const { root, container, calls } = installPreviewDom({ runs: [current] });
    await renderPreview(root);

    const options = container.querySelector<HTMLButtonElement>(
      '[aria-label="Preview options"]',
    );
    assert.ok(options);
    await act(async () => options.click());
    const restart = button(container, "Restart dev");
    assert.equal(document.activeElement, restart);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    assert.equal(
      document.activeElement?.textContent?.trim(),
      "Grant agent interaction",
    );
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    assert.equal(container.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, options);

    await act(async () => options.click());
    await act(async () => {
      button(container, "Restart dev").click();
    });
    await flush();
    assert.deepEqual(calls.restarts, ["run-1"]);
    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.hermetic",
  "preview keeps manual Output choice and browser controls follow webview events",
  async () => {
    const current = run();
    const { root, container, calls, emitDiagnostic } = installPreviewDom({
      runs: [current],
    });
    await renderPreview(root);

    assert.deepEqual(calls.loads, ["http://localhost:3000/"]);
    const output = container.querySelector<HTMLButtonElement>(
      ".preview-output-summary",
    );
    assert.ok(output);
    assert.equal(output.getAttribute("aria-expanded"), "false");
    await act(async () => output.click());
    assert.equal(output.getAttribute("aria-expanded"), "true");

    const webview = container.querySelector("webview");
    assert.ok(webview);
    await act(async () => {
      webview.dispatchEvent(new Event("did-stop-loading"));
    });
    const back = container.querySelector<HTMLButtonElement>(
      '[aria-label="Go back"]',
    );
    assert.equal(back?.disabled, false);
    await act(async () => back?.click());
    assert.equal(calls.back, 1);

    await act(async () => {
      emitDiagnostic({
        webContentsId: 27,
        kind: "console",
        level: 3,
        message: "typed browser error",
        at: "2026-07-23T12:00:03.000Z",
      });
    });
    assert.equal(output.getAttribute("aria-expanded"), "true");
    assert.match(container.textContent ?? "", /1 browser issue/u);
    await act(async () => root.unmount());
  },
);

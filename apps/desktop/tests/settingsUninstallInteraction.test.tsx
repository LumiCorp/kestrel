import assert from "node:assert/strict";

import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { SettingsWorkspace } from "../renderer/src/SettingsWorkspace.js";
import type {
  DesktopUninstallApplyInput,
  KestrelUninstallApplyResultV1,
  KestrelUninstallPlanOptions,
  KestrelUninstallPlanV1,
  KestrelUninstallScope,
} from "../src/contracts.js";
import { toDesktopRendererSettings } from "../src/rendererSettings.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";

contractTest(
  "desktop.hermetic",
  "Desktop uninstall wizard enforces blockers and renders partial completion",
  async () => {
    const browser = new Window({
      url: "http://localhost/#settings-workspace_data",
    });
    Object.assign(browser, {
      kestrelDesktop: {
        getCapabilities: async () => ({
          capabilities: [],
          credentialStore: { available: true, backend: "macos_keychain" },
          refreshedAt: "2026-07-28T12:00:00.000Z",
        }),
        getKestrelOneEnvironments: async () => {
          throw new Error("not configured");
        },
        getKestrelOneAccount: async () => {
          throw new Error("not configured");
        },
        getPendingUninstallResult: async () => undefined,
        getModelCatalog: async () => ({ models: [] }),
        discoverMcpServers: async () => {
          throw new Error("not configured");
        },
      },
    });
    Object.assign(globalThis, {
      React,
      window: browser,
      document: browser.document,
      Node: browser.Node,
      HTMLElement: browser.HTMLElement,
      HTMLInputElement: browser.HTMLInputElement,
      HTMLSelectElement: browser.HTMLSelectElement,
      Event: browser.Event,
      InputEvent: browser.InputEvent,
      MouseEvent: browser.MouseEvent,
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
    const root = createRoot(container);
    const planned: Array<{
      scope: KestrelUninstallScope;
      options?: KestrelUninstallPlanOptions | undefined;
    }> = [];
    const applied: DesktopUninstallApplyInput[] = [];
    let planCount = 0;

    await act(async () => {
      root.render(
        <SettingsWorkspace
          settings={toDesktopRendererSettings(createDefaultDesktopSettings())}
          onSettings={async () =>
            toDesktopRendererSettings(createDefaultDesktopSettings())}
          onOpenMcp={() => {}}
          onAddProject={async () => {}}
          onCreateUninstallPlan={async (scope, options) => {
            planned.push({ scope, options });
            planCount += 1;
            return uninstallPlan({
              blockers: planCount === 1
                ? [{
                    code: "ACTIVE_WORK",
                    message: "An active execution must finish first.",
                  }]
                : [],
            });
          }}
          onApplyUninstallPlan={async (input) => {
            applied.push(input);
            return partialApplyResult();
          }}
          onRequestMicrophone={async () => {}}
          onError={() => {}}
        />,
      );
    });
    await flush();

    changeValue(
      browser,
      controlInLabel<HTMLSelectElement>(container, "Removal scope"),
      "complete",
    );
    click(
      controlInLabel<HTMLInputElement>(
        container,
        "Disconnect local Kestrel One enrollments",
      ),
    );
    await act(async () => button(container, "Create plan").click());
    await flush();

    assert.deepEqual(planned[0], {
      scope: "complete",
      options: {
        disconnectKestrelOne: true,
        exportWorktreesDirectory: "",
        discardWorktrees: false,
      },
    });
    assert.match(container.textContent, /ACTIVE_WORK/u);
    assert.equal(button(container, "Apply uninstall").disabled, true);

    click(
      controlInLabel<HTMLInputElement>(
        container,
        "Discard retained managed worktrees",
      ),
    );
    await act(async () => button(container, "Create plan").click());
    await flush();
    assert.deepEqual(planned[1], {
      scope: "complete",
      options: {
        disconnectKestrelOne: true,
        exportWorktreesDirectory: "",
        discardWorktrees: true,
      },
    });
    assert.equal(button(container, "Apply uninstall").disabled, false);
    await act(async () => button(container, "Apply uninstall").click());
    await flush();

    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.confirmPlanId, "desktop-plan-fixture");
    assert.equal(applied[0]?.deleteDataPhrase, undefined);
    assert.equal(applied[0]?.discardWorktreesPhrase, undefined);
    assert.match(container.textContent, /Apply result: partial/u);
    assert.match(container.textContent, /connection-1.*failed/u);
    assert.match(container.textContent, /desktop_helper: scheduled/u);
    assert.match(container.textContent, /DESKTOP_HELPER_PARTIAL/u);

    await act(async () => root.unmount());
  },
);

contractTest(
  "desktop.hermetic",
  "Settings navigation remains available when capability readiness fails",
  async () => {
    const browser = new Window({
      url: "http://localhost/#settings-general",
    });
    Object.assign(browser, {
      kestrelDesktop: {
        getCapabilities: async () => {
          throw new Error("Local Core is unavailable");
        },
        getKestrelOneEnvironments: async () => {
          throw new Error("not configured");
        },
        getKestrelOneAccount: async () => {
          throw new Error("not configured");
        },
        getPendingUninstallResult: async () => undefined,
        getModelCatalog: async () => ({ models: [] }),
      },
    });
    Object.assign(globalThis, {
      React,
      window: browser,
      document: browser.document,
      Node: browser.Node,
      HTMLElement: browser.HTMLElement,
      HTMLInputElement: browser.HTMLInputElement,
      HTMLSelectElement: browser.HTMLSelectElement,
      Event: browser.Event,
      InputEvent: browser.InputEvent,
      MouseEvent: browser.MouseEvent,
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
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SettingsWorkspace
          settings={toDesktopRendererSettings(createDefaultDesktopSettings())}
          onSettings={async () =>
            toDesktopRendererSettings(createDefaultDesktopSettings())}
          onOpenMcp={() => {}}
          onAddProject={async () => {}}
          onCreateUninstallPlan={async () => {
            throw new Error("not used");
          }}
          onApplyUninstallPlan={async () => {
            throw new Error("not used");
          }}
          onRequestMicrophone={async () => {}}
          onError={() => {}}
        />,
      );
    });
    await flush();

    const navigation = container.querySelector(
      'nav[aria-label="Settings categories"]',
    );
    assert.ok(navigation, "Expected Settings navigation after readiness failure.");
    const workspaceDataLink = [...navigation.querySelectorAll("a")].find(
      (candidate) => candidate.textContent?.trim() === "Workspace & data",
    );
    assert.ok(workspaceDataLink, "Expected Workspace & data navigation.");

    await act(async () => workspaceDataLink.click());
    assert.equal(browser.location.hash, "#settings-workspace_data");
    assert.match(container.textContent, /Data & Privacy/u);
    assert.ok(
      controlInLabel<HTMLSelectElement>(container, "Removal scope"),
      "Expected uninstall controls to remain reachable.",
    );

    await act(async () => root.unmount());
  },
);

function uninstallPlan(input: {
  blockers: KestrelUninstallPlanV1["blockers"];
}): KestrelUninstallPlanV1 {
  return {
    version: "kestrel_uninstall_plan_v1",
    planId: "desktop-plan-fixture",
    generatedAt: "2026-07-28T12:00:00.000Z",
    platform: "darwin",
    initiator: "desktop",
    scope: "complete",
    options: {
      disconnectKestrelOne: true,
      exportWorktreesDirectory: "",
      discardWorktrees: true,
    },
    targets: [{
      id: "desktop.bundle",
      kind: "desktop_bundle",
      path: "/Applications/Kestrel.app",
      verified: true,
      selected: true,
      removal: "trash",
      fingerprint: "fixture",
      evidence: ["fixture"],
    }],
    lifecycle: { state: "idle", blockers: [] },
    worktrees: {
      cleanDisposable: 0,
      retained: 1,
      blocked: 0,
      totalBytes: 42,
      entries: [{
        worktreeRoot: "/tmp/worktree",
        disposition: "retain_with_snapshot",
        dirty: true,
        aheadCommitCount: 0,
        storageBytes: 42,
        ignoredFileCount: 1,
        ignoredBytes: 10,
        reasons: ["dirty"],
      }],
    },
    kestrelOne: {
      disconnectSelected: true,
      environments: [{
        connectionId: "connection-1",
        baseUrl: "https://kestrel.one",
      }],
    },
    confirmations: input.blockers.length > 0
      ? [
          { kind: "plan_id", phrase: "desktop-plan-fixture" },
          { kind: "delete_data", phrase: "DELETE KESTREL DATA" },
          {
            kind: "discard_worktrees",
            phrase: "DISCARD 1 KESTREL WORKTREES",
          },
        ]
      : [{ kind: "plan_id", phrase: "desktop-plan-fixture" }],
    blockers: input.blockers,
  };
}

function partialApplyResult(): KestrelUninstallApplyResultV1 {
  return {
    version: "kestrel_uninstall_apply_result_v1",
    planId: "desktop-plan-fixture",
    appliedAt: "2026-07-28T12:01:00.000Z",
    status: "partial",
    removedTargets: [],
    skippedTargets: [],
    blockers: [{
      code: "DESKTOP_HELPER_PARTIAL",
      message: "Desktop helper completion requires review.",
    }],
    finalTargets: [],
    kestrelOneDisconnects: [{
      connectionId: "connection-1",
      baseUrl: "https://kestrel.one",
      status: "failed",
      errorCode: "offline",
      message: "Network unavailable.",
    }],
    deferredCompletions: [{
      executor: "desktop_helper",
      state: "scheduled",
      reportPath:
        "/private/var/tmp/com.kestrel.uninstall/desktop-plan-fixture/desktop-helper.json",
    }],
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

function controlInLabel<T extends HTMLInputElement | HTMLSelectElement>(
  container: HTMLElement,
  labelText: string,
): T {
  const label = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.includes(labelText),
  );
  assert.ok(label, `Expected label '${labelText}'.`);
  const control = label.querySelector("input, select");
  assert.ok(control, `Expected a control for '${labelText}'.`);
  return control as T;
}

function changeValue(
  browser: Window,
  control: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  act(() => {
    const prototype = control instanceof browser.HTMLSelectElement
      ? browser.HTMLSelectElement.prototype
      : browser.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter === undefined) {
      control.value = value;
    } else {
      setter.call(control, value);
    }
    if (control instanceof browser.HTMLInputElement) {
      control.dispatchEvent(new browser.InputEvent("input", {
        bubbles: true,
        data: value,
        inputType: "insertText",
      }));
    }
    control.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
}

function click(control: HTMLInputElement): void {
  act(() => control.click());
}

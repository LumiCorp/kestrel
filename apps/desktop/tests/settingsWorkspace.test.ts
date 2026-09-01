import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import type { DesktopCapability } from "../../../src/desktopShell/contracts.js";
import type {
  DesktopBrowserPersonalDomainProjectionV1,
  KestrelOneAccountStatus,
  KestrelUninstallPlanV1,
} from "../src/contracts.js";
import {
  DEFAULT_KESTREL_ONE_BASE_URL,
  SettingsWorkspace,
  desktopUninstallConfirmationsSatisfied,
  getDesktopCapabilityAttentionQueue,
} from "../renderer/src/SettingsWorkspace.js";
import { toDesktopRendererSettings } from "../src/rendererSettings.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";

const rendererDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../renderer/src",
);

test("Kestrel One sign-in targets the canonical hosted application", () => {
  assert.equal(DEFAULT_KESTREL_ONE_BASE_URL, "https://kestrelagents.dev");
});

function capability(id: DesktopCapability["id"], readiness: DesktopCapability["readiness"]): DesktopCapability {
  return {
    id,
    category: "local_capabilities",
    name: id,
    description: "Test capability.",
    toolNames: [],
    enabled: readiness !== "disabled",
    readiness,
    detail: "Test detail.",
    requirements: [],
    settings: [],
    verificationStrategy: "Test verification.",
    runtimeApplication: "Test application.",
    settingsSection: "settings/test",
  };
}

test("Settings surfaces only explicit readiness blockers in source order", () => {
  const queue = getDesktopCapabilityAttentionQueue([
    capability("local.filesystem", "ready"),
    capability("local.developer_shell", "unavailable"),
    capability("local.sandbox_code", "setup_required"),
    capability("data.database", "verification_failed"),
    capability("permission.microphone", "optional"),
  ]);

  assert.deepEqual(queue.map((entry) => entry.id), [
    "local.developer_shell",
    "local.sandbox_code",
    "data.database",
  ]);
});

test("Settings does not let an older readiness probe overwrite a later apply result", async () => {
  const source = await readFile(path.join(rendererDirectory, "SettingsWorkspace.tsx"), "utf8");

  assert.match(source, /const refreshVersionRef = useRef\(0\)/u);
  assert.match(source, /if \(refreshVersion !== refreshVersionRef\.current\) return;/u);
  assert.match(source, /function commitCapabilityView[\s\S]*refreshVersionRef\.current \+= 1;/u);
});

test("a delayed Browser revoke cannot repaint or retarget a newly selected Environment", async () => {
  const browser = new Window({
    url: "http://localhost/#settings-connections",
  });
  const environmentARevoke =
    deferred<DesktopBrowserPersonalDomainProjectionV1>();
  const revokeInputs: Array<{
    environmentId: string;
    canonicalDomain: string;
  }> = [];
  Object.assign(browser, {
    kestrelDesktop: {
      getCapabilities: async () => ({
        capabilities: [],
        credentialStore: { available: true, backend: "macos_keychain" },
        refreshedAt: "2026-08-29T12:00:00.000Z",
      }),
      getKestrelOneEnvironments: async () => ({
        enrollments: [],
        environments: [],
        globalCapacity: 1,
        activeRuns: 0,
        activity: [],
      }),
      getKestrelOneAccount: async () => browserAccount(),
      getPendingUninstallResult: async () => {},
      getModelCatalog: async () => ({ models: [] }),
      listBrowserPersonalDomains: async (input: { environmentId: string }) =>
        browserDomainProjection(
          input.environmentId,
          input.environmentId === "environment-a"
            ? "alpha.example"
            : "bravo.example",
        ),
      revokeBrowserPersonalDomain: async (input: {
        environmentId: string;
        canonicalDomain: string;
      }) => {
        revokeInputs.push(input);
        if (input.environmentId === "environment-a") {
          return environmentARevoke.promise;
        }
        return browserDomainProjection(
          input.environmentId,
          input.canonicalDomain,
          "revoked",
        );
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

  await act(async () => {
    root.render(
      React.createElement(SettingsWorkspace, {
        settings: toDesktopRendererSettings(createDefaultDesktopSettings()),
        onSettings: async () =>
          toDesktopRendererSettings(createDefaultDesktopSettings()),
        onOpenApps: () => {},
        onAddProject: async () => {},
        onCreateUninstallPlan: async () => {
          throw new Error("not used");
        },
        onApplyUninstallPlan: async () => {
          throw new Error("not used");
        },
        onRequestMicrophone: async () => {},
        onError: () => {},
      }),
    );
  });
  await flushRenderer();
  await flushRenderer();
  assert.match(container.textContent ?? "", /alpha\.example/u);

  act(() => revokeButton(container).click());
  const environment = browserEnvironmentSelect(container);
  changeRendererValue(browser, environment, "environment-b");
  await flushRenderer();
  assert.match(container.textContent ?? "", /bravo\.example/u);
  assert.doesNotMatch(container.textContent ?? "", /alpha\.example/u);

  await act(async () => {
    environmentARevoke.resolve(
      browserDomainProjection("environment-a", "alpha.example", "revoked"),
    );
  });
  await flushRenderer();
  assert.match(container.textContent ?? "", /bravo\.example/u);
  assert.doesNotMatch(container.textContent ?? "", /alpha\.example/u);

  act(() => revokeButton(container).click());
  await flushRenderer();
  assert.deepEqual(revokeInputs, [
    { environmentId: "environment-a", canonicalDomain: "alpha.example" },
    { environmentId: "environment-b", canonicalDomain: "bravo.example" },
  ]);
  assert.doesNotMatch(container.textContent ?? "", /Allowed · revision/u);

  await act(async () => root.unmount());
});

test("tool-service recovery routes to the Apps owner", async () => {
  const source = await readFile(path.join(rendererDirectory, "SettingsWorkspace.tsx"), "utf8");
  assert.match(source, /onOpenApps\(\{ kind: "capability", capabilityId: capability\.id \}\)/u);
});

test("Settings keeps healthy readiness quiet while retaining targeted recovery", async () => {
  const source = await readFile(path.join(rendererDirectory, "SettingsWorkspace.tsx"), "utf8");
  const styles = await readFile(path.join(rendererDirectory, "styles.css"), "utf8");

  assert.match(source, /attentionCapabilities\.length > 0 \? \(/u);
  assert.match(source, /Secure credential storage is unavailable on this system\./u);
  assert.match(
    source,
    /kestrelOneBusy \|\| view\?\.credentialStore\.available === false/u,
  );
  assert.match(
    source,
    /Secure credential storage is required before signing in\./u,
  );
  assert.match(source, /Last checked/u);
  assert.match(source, /runAction\(action\)/u);
  assert.doesNotMatch(source, /No setup blockers/u);
  assert.doesNotMatch(source, /Capability readiness summary/u);
  assert.doesNotMatch(source, /readinessSummary/u);
  assert.doesNotMatch(styles, /\.capability-summary/u);
  assert.doesNotMatch(styles, /\.capability-attention-clear/u);
});

test("Settings exposes guarded Desktop uninstall apply wizard controls", async () => {
  const source = await readFile(path.join(rendererDirectory, "SettingsWorkspace.tsx"), "utf8");

  assert.match(source, /Removal scope/u);
  assert.match(source, /Disconnect local Kestrel One enrollments/u);
  assert.match(source, /Worktree recovery export directory/u);
  assert.match(source, /Discard retained managed worktrees/u);
  assert.match(source, /DELETE KESTREL DATA/u);
  assert.match(source, /Apply uninstall/u);
  assert.match(source, /onApplyUninstallPlan/u);
  assert.match(source, /uninstallPlan\.blockers\.length > 0/u);
  assert.match(source, /Apply result:/u);
});

test("Desktop uninstall confirmations require exact destructive phrases", () => {
  const plan = {
    confirmations: [
      { kind: "plan_id", phrase: "plan-1" },
      { kind: "delete_data", phrase: "DELETE KESTREL DATA" },
      {
        kind: "discard_worktrees",
        phrase: "DISCARD 2 KESTREL WORKTREES",
      },
    ],
  } as KestrelUninstallPlanV1;

  assert.equal(
    desktopUninstallConfirmationsSatisfied(
      plan,
      "delete kestrel data",
      "DISCARD 2 KESTREL WORKTREES",
    ),
    false,
  );
  assert.equal(
    desktopUninstallConfirmationsSatisfied(
      plan,
      "DELETE KESTREL DATA",
      "DISCARD 2 KESTREL WORKTREES",
    ),
    true,
  );
  assert.equal(
    desktopUninstallConfirmationsSatisfied(
      undefined,
      "DELETE KESTREL DATA",
      "DISCARD 2 KESTREL WORKTREES",
    ),
    false,
  );
});

function browserAccount(): KestrelOneAccountStatus {
  return {
    status: "signed_in",
    baseUrl: "https://kestrelagents.dev",
    projection: {
      account: {
        id: "person-stable-id-1",
        name: "Browser Person",
        email: "browser-person@example.test",
      },
      organizations: [],
      projects: [
        {
          id: "project-a",
          organizationId: "organization-1",
          name: "Project A",
          environmentId: "environment-a",
          environmentProvider: "desktop",
          role: "member",
        },
        {
          id: "project-b",
          organizationId: "organization-1",
          name: "Project B",
          environmentId: "environment-b",
          environmentProvider: "desktop",
          role: "member",
        },
      ],
      threads: [],
    },
  };
}

function browserDomainProjection(
  environmentId: string,
  canonicalDomain: string,
  state: "active" | "revoked" = "active",
): DesktopBrowserPersonalDomainProjectionV1 {
  const authority = {
    version: "browser_public_domain_authority_v1" as const,
    scheme: "https" as const,
    canonicalDomain,
    includeSubdomains: true,
    port: 443,
  };
  return {
    accountId: "person-stable-id-1",
    environmentId,
    revision: state === "active" ? 1 : 2,
    authority: {
      version: "browser_personal_domain_authority_v1",
      userId: "person-stable-id-1",
      environmentId,
      revision: state === "active" ? "1" : "2",
      activeDomains: state === "active" ? [authority] : [],
    },
    domains: [
      {
        version: "desktop_browser_personal_domain_record_v1",
        authority,
        state,
        provenance: {
          version: "desktop_browser_personal_domain_provenance_v1",
          source: "browser.request_grant",
          approvalId: "approval-1",
          approvedAt: "2026-08-29T12:00:00.000Z",
        },
        createdAt: "2026-08-29T12:00:00.000Z",
        updatedAt: "2026-08-29T12:01:00.000Z",
        ...(state === "revoked"
          ? { revokedAt: "2026-08-29T12:01:00.000Z" }
          : {}),
      },
    ],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushRenderer(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function browserEnvironmentSelect(container: HTMLElement): HTMLSelectElement {
  const found = [...container.querySelectorAll("select")].find((candidate) =>
    [...candidate.options].some((option) => option.value === "environment-a"),
  );
  assert.ok(found, "Expected the personal Browser Environment selector.");
  return found;
}

function revokeButton(container: HTMLElement): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Revoke",
  );
  assert.ok(found, "Expected an active personal Browser domain revoke button.");
  return found;
}

function changeRendererValue(
  browser: Window,
  control: HTMLSelectElement,
  value: string,
): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      browser.HTMLSelectElement.prototype,
      "value",
    )?.set;
    if (setter === undefined) {
      control.value = value;
    } else {
      setter.call(control, value);
    }
    control.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
}

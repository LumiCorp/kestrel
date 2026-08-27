import assert from "node:assert/strict";
import test from "node:test";

import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { SettingsWorkspace } from "../renderer/src/SettingsWorkspace.js";
import type { KestrelOneReceivingConnection } from "../src/contracts.js";
import { toDesktopRendererSettings } from "../src/rendererSettings.js";
import { createDefaultDesktopSettings } from "../src/settingsStore.js";

test("Desktop members see read-only receiving status and stale tenant responses cannot repaint it", async () => {
  const browser = new Window({
    url: "http://localhost/#settings-connections",
  });
  const organizationA = deferred<KestrelOneReceivingConnection>();
  const organizationB = deferred<KestrelOneReceivingConnection>();
  const receivingReads: string[] = [];
  Object.assign(browser, {
    kestrelDesktop: {
      getCapabilities: async () => ({
        capabilities: [],
        credentialStore: { available: true, backend: "macos_keychain" },
        refreshedAt: "2026-08-27T12:00:00.000Z",
      }),
      getKestrelOneEnvironments: async () => ({
        enrollments: [],
        environments: [],
        globalCapacity: 1,
        activeRuns: 0,
        activity: [],
      }),
      getKestrelOneAccount: async () => signedInAccount(),
      getPendingUninstallResult: async () => undefined,
      getModelCatalog: async () => ({ models: [] }),
      getKestrelOneReceivingConnection: async (organizationId: string) => {
        receivingReads.push(organizationId);
        return organizationId === "organization-a"
          ? organizationA.promise
          : organizationB.promise;
      },
      signOutKestrelOneAccount: async () => ({ status: "signed_out" }),
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
        onOpenApps={() => {}}
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

  const organization = controlInLabel<HTMLSelectElement>(
    container,
    "Organization",
  );
  changeValue(browser, organization, "organization-a");
  await flush();
  assert.deepEqual(receivingReads, ["organization-a"]);
  assert.match(container.textContent ?? "", /Read-only receiving status/u);
  assert.doesNotMatch(container.textContent ?? "", /Resend Full access API key/u);

  changeValue(browser, organization, "organization-b");
  await flush();
  assert.deepEqual(receivingReads, ["organization-a", "organization-b"]);
  await act(async () => organizationB.resolve(receivingConnection("domain-b.example.test")));
  await flush();
  assert.match(container.textContent ?? "", /domain-b\.example\.test/u);

  await act(async () => organizationA.resolve(receivingConnection("domain-a.example.test")));
  await flush();
  assert.match(container.textContent ?? "", /domain-b\.example\.test/u);
  assert.doesNotMatch(container.textContent ?? "", /domain-a\.example\.test/u);

  await act(async () => button(container, "Sign out").click());
  await flush();
  assert.doesNotMatch(container.textContent ?? "", /domain-b\.example\.test/u);
  assert.match(container.textContent ?? "", /Sign in to Kestrel One/u);

  await act(async () => root.unmount());
});

function signedInAccount() {
  return {
    status: "signed_in" as const,
    baseUrl: "https://kestrelagents.dev",
    projection: {
      account: {
        id: "member-user",
        name: "Receiving Member",
        email: "member@example.test",
      },
      organizations: [
        {
          organizationId: "organization-a",
          organizationName: "Organization A",
          organizationSlug: "organization-a",
          organizationRole: "member",
        },
        {
          organizationId: "organization-b",
          organizationName: "Organization B",
          organizationSlug: "organization-b",
          organizationRole: "member",
        },
      ],
      projects: [],
      threads: [],
    },
  };
}

function receivingConnection(
  receivingDomain: string,
): KestrelOneReceivingConnection {
  return {
    provider: "resend",
    configured: true,
    credentialStatus: "full_access",
    credentialValidatedAt: "2026-08-27T12:00:00.000Z",
    receivingDomain,
    receivingDomainStatus: "verified",
    mxStatus: "verified",
    domainCheckedAt: "2026-08-27T12:00:00.000Z",
    webhookStatus: "not_staged",
    inboundEnabled: false,
    lastHealthCheckedAt: "2026-08-27T12:00:00.000Z",
    lastTestedAt: null,
    lastErrorCode: null,
    readiness: "ready_inactive",
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
    control.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
}

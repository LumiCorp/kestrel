import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { LaunchRoot } from "../renderer/src/LaunchRoot.js";
import type {
  DesktopOnboardingProviderInput,
  DesktopProviderModelCatalogRequest,
} from "../src/contracts.js";

test("local onboarding exposes and probes the configured endpoint without persisting it", async () => {
  const browser = new Window({ url: "http://localhost/?onboarding=1" });
  const catalogRequests: DesktopProviderModelCatalogRequest[] = [];
  let savedDrafts = 0;
  Object.assign(browser, {
    kestrelDesktop: {
      getLaunchState: async () => ({
        phase: "setup_required",
        message: "Finish setting up Kestrel.",
      }),
      onLaunchState: () => () => {},
      getOnboardingState: async () => ({
        version: 1,
        mode: "resume",
        step: "provider",
        provider: "ollama",
        model: "qwen3:8b",
        baseUrl: "http://127.0.0.1:2244",
        providerVerified: false,
        credentialConfigured: true,
        secureStorageAvailable: true,
        projects: [],
        canComplete: false,
      }),
      getModelCatalog: async (request: DesktopProviderModelCatalogRequest) => {
        catalogRequests.push(request);
        return {
          provider: request.provider,
          models: ["qwen3:8b"],
          source: "live",
        };
      },
      saveOnboardingDraft: async () => {
        savedDrafts += 1;
        throw new Error("draft persistence is not expected");
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
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<LaunchRoot />));
  await flush();

  const endpoint = container.querySelector<HTMLInputElement>("#onboarding-endpoint");
  assert.ok(endpoint);
  assert.equal(endpoint.value, "http://127.0.0.1:2244");
  assert.deepEqual(catalogRequests.at(-1), {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:2244",
  });

  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes("Check endpoint"))
      ?.click();
  });
  await flush();

  assert.deepEqual(catalogRequests.at(-1), {
    provider: "ollama",
    baseUrl: "http://127.0.0.1:2244",
  });
  assert.equal(catalogRequests.length, 2);
  assert.equal(savedDrafts, 0);
  await act(async () => root.unmount());
});

test("hosted onboarding renders a typed provider failure without exposing provider data", async () => {
  const browser = new Window({ url: "http://localhost/?onboarding=1" });
  const verificationInputs: DesktopOnboardingProviderInput[] = [];
  Object.assign(browser, {
    kestrelDesktop: {
      getLaunchState: async () => ({
        phase: "setup_required",
        message: "Finish setting up Kestrel.",
      }),
      onLaunchState: () => () => {},
      getOnboardingState: async () => ({
        version: 1,
        mode: "resume",
        step: "provider",
        provider: "openai",
        model: "gpt-5",
        providerVerified: false,
        credentialConfigured: false,
        secureStorageAvailable: true,
        projects: [],
        canComplete: false,
      }),
      getModelCatalog: async () => ({
        provider: "openai",
        models: ["gpt-5"],
        source: "live",
      }),
      verifyOnboardingProvider: async (input: DesktopOnboardingProviderInput) => {
        verificationInputs.push(input);
        return {
          ok: false,
          failure: {
            kind: "invalid_credential",
            message: "The API key was not accepted. Check it and try again.",
          },
        } as const;
      },
    },
  });
  installBrowserGlobals(browser);
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<LaunchRoot />));
  await flush();
  const logo = container.querySelector<HTMLImageElement>(".kestrel-mark img");
  assert.ok(logo);
  assert.equal(logo.alt, "Kestrel");
  assert.match(logo.src, /kestrel-full-horz-dark-mode\.png$/u);
  assert.equal(container.querySelector(".kestrel-mark > span"), null);
  const credential = container.querySelector<HTMLInputElement>("#onboarding-key");
  assert.ok(credential);
  await act(async () => {
    credential.value = "write-only-test-key";
    credential.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.includes("Verify connection"))
      ?.click();
  });
  await flush();

  assert.equal(verificationInputs.length, 1);
  assert.match(
    container.querySelector("[role='alert']")?.textContent ?? "",
    /API key was not accepted/u,
  );
  assert.doesNotMatch(container.textContent ?? "", /write-only-test-key/u);
  await act(async () => root.unmount());
});

test("hosted onboarding permits a fresh Keychain retry after cached storage unavailability", async () => {
  const browser = new Window({ url: "http://localhost/?onboarding=1" });
  let verificationAttempts = 0;
  Object.assign(browser, {
    kestrelDesktop: {
      getLaunchState: async () => ({
        phase: "setup_required",
        message: "Finish setting up Kestrel.",
      }),
      onLaunchState: () => () => {},
      getOnboardingState: async () => ({
        version: 1,
        mode: "resume",
        step: "provider",
        provider: "openrouter",
        model: "openai/gpt-5",
        providerVerified: false,
        credentialConfigured: false,
        secureStorageAvailable: false,
        projects: [],
        canComplete: false,
      }),
      getModelCatalog: async () => ({
        provider: "openrouter",
        models: ["openai/gpt-5"],
        source: "live",
      }),
      verifyOnboardingProvider: async () => {
        verificationAttempts += 1;
        return {
          ok: false,
          failure: {
            kind: "secure_storage_unavailable",
            message:
              "Kestrel can’t write to the macOS Keychain from this launch. If the login keychain is locked, unlock it and retry. If Kestrel was opened by a test or automation tool, quit it and open the app from Finder.",
          },
        } as const;
      },
    },
  });
  installBrowserGlobals(browser);
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<LaunchRoot />));
  await flush();

  const verify = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes("Verify connection"));
  assert.ok(verify);
  assert.equal(verify.disabled, false);
  await act(async () => verify.click());
  await flush();

  assert.equal(verificationAttempts, 1);
  assert.equal(container.querySelectorAll("[role='alert']").length, 1);
  assert.match(
    container.querySelector("[role='alert']")?.textContent ?? "",
    /open the app from Finder/u,
  );
  await act(async () => root.unmount());
});

function installBrowserGlobals(browser: Window): void {
  Object.assign(globalThis, {
    React,
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
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
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

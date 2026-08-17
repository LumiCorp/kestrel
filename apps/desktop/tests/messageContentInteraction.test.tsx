import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { MessageContent } from "../renderer/src/MessageContent.js";
import type {
  DesktopLinkPreviewInput,
  DesktopLinkPreviewResult,
} from "../src/contracts.js";

test("preview cards enrich after mount and retain the authored safe-link target", async () => {
  const browser = new Window({ url: "http://localhost/" });
  const previewCalls: DesktopLinkPreviewInput[] = [];
  const opened: string[] = [];
  Object.assign(browser, {
    kestrelDesktop: {
      async getLinkPreviews(input: DesktopLinkPreviewInput): Promise<DesktopLinkPreviewResult[]> {
        previewCalls.push(input);
        return [{
          status: "available",
          requestedUrl: input.urls[0]!,
          finalUrl: "https://resolved.example/story",
          title: "A useful story",
          description: "The Open Graph description.",
          imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
        }];
      },
      async openExternal(url: string) {
        opened.push(url);
      },
    },
  });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<MessageContent
      messageRole="assistant"
      text="https://authored.example/story"
    />);
  });
  await act(async () => Promise.resolve());

  assert.deepEqual(previewCalls, [{ urls: ["https://authored.example/story"] }]);
  assert.match(container.textContent ?? "", /A useful story/u);
  assert.match(container.textContent ?? "", /The Open Graph description/u);
  assert.match(container.textContent ?? "", /resolved\.example/u);
  assert.equal(
    container.querySelector<HTMLImageElement>(".link-preview-thumbnail img")?.src,
    "data:image/png;base64,iVBORw0KGgo=",
  );
  await act(async () => {
    container.querySelector<HTMLImageElement>(".link-preview-thumbnail img")
      ?.dispatchEvent(new browser.Event("error"));
  });
  assert.equal(container.querySelector(".link-preview-thumbnail img"), null);

  const card = container.querySelector<HTMLButtonElement>(".link-preview-main");
  card?.focus();
  await act(async () => card?.click());
  await act(async () => new Promise((resolve) => browser.setTimeout(resolve, 0)));
  assert.match(browser.document.body.textContent, /Observed preview destination/u);
  assert.match(browser.document.body.textContent, /https:\/\/resolved\.example\/story/u);
  assert.equal(browser.document.body.style.overflow, "hidden");
  const close = browser.document.querySelector<HTMLButtonElement>(
    "button[data-initial-focus]",
  );
  assert.equal(browser.document.activeElement, close);
  const open = [...browser.document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Open in browser"));
  assert.ok(open);
  open.focus();
  open.dispatchEvent(new browser.KeyboardEvent("keydown", {
    bubbles: true,
    key: "Tab",
  }));
  assert.equal(browser.document.activeElement, close);
  open.focus();
  await act(async () => open.click());
  assert.deepEqual(opened, ["https://authored.example/story"]);
  assert.equal(browser.document.body.style.overflow, "");
  assert.equal(browser.document.activeElement, card);

  await act(async () => root.unmount());
});

test("inline links remove blank-target behavior and auxiliary activation requests confirmation", async () => {
  const browser = new Window({ url: "http://localhost/" });
  Object.assign(browser, {
    kestrelDesktop: {
      async getLinkPreviews() { return []; },
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
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<MessageContent
    messageRole="assistant"
    text="Read [the report](https://example.com/report)."
  />));
  const link = container.querySelector<HTMLAnchorElement>("a");
  assert.ok(link);
  assert.equal(link.getAttribute("target"), null);
  const allowed = await act(async () => link.dispatchEvent(
    new browser.MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    }),
  ));
  assert.equal(allowed, false);
  assert.match(browser.document.body.textContent, /Open external destination/u);

  await act(async () => root.unmount());
});

test("safe-link actions expose failures and allow retry without changing the authored URL", async () => {
  const browser = new Window({ url: "http://localhost/" });
  const opened: string[] = [];
  let copyAttempts = 0;
  let openAttempts = 0;
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText(value: string) {
        copyAttempts += 1;
        assert.equal(value, "https://authored.example/report");
        if (copyAttempts === 1) throw new Error("clipboard denied");
      },
    },
  });
  Object.assign(browser, {
    kestrelDesktop: {
      async getLinkPreviews() { return []; },
      async openExternal(url: string) {
        openAttempts += 1;
        if (openAttempts === 1) throw new Error("shell failed");
        opened.push(url);
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: browser.navigator,
  });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<MessageContent
    messageRole="assistant"
    text="[Report](https://authored.example/report)"
  />));
  await act(async () => container.querySelector<HTMLAnchorElement>("a")?.click());
  const findButton = (label: string) => [...browser.document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes(label));

  await act(async () => findButton("Copy link")?.click());
  assert.match(browser.document.querySelector("[role='alert']")?.textContent ?? "", /could not copy/u);
  await act(async () => findButton("Copy link")?.click());
  assert.match(findButton("Copied")?.textContent ?? "", /Copied/u);

  await act(async () => findButton("Open in browser")?.click());
  assert.match(browser.document.querySelector("[role='alert']")?.textContent ?? "", /could not open/u);
  await act(async () => findButton("Open in browser")?.click());
  assert.deepEqual(opened, ["https://authored.example/report"]);
  assert.equal(browser.document.querySelector("[role='dialog']"), null);

  await act(async () => root.unmount());
});

test("safe-link pending actions retain focus inside the dialog", async () => {
  const browser = new Window({ url: "http://localhost/" });
  let finishOpen: (() => void) | undefined;
  const openGate = new Promise<void>((resolve) => {
    finishOpen = resolve;
  });
  Object.assign(browser, {
    kestrelDesktop: {
      async getLinkPreviews() { return []; },
      async openExternal() { await openGate; },
    },
  });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
    MouseEvent: browser.MouseEvent,
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<MessageContent
    messageRole="assistant"
    text="[Report](https://authored.example/report)"
  />));
  await act(async () => container.querySelector<HTMLAnchorElement>("a")?.click());
  await act(async () => new Promise((resolve) => browser.setTimeout(resolve, 0)));
  const close = browser.document.querySelector<HTMLButtonElement>(
    "button[data-initial-focus]",
  );
  const open = [...browser.document.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Open in browser"));
  assert.ok(close);
  assert.ok(open);

  open.focus();
  act(() => open.click());
  assert.equal(open.disabled, true);
  assert.equal(browser.document.activeElement, close);
  close.dispatchEvent(new browser.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: "Tab",
  }));
  assert.equal(browser.document.activeElement, close);

  await act(async () => {
    finishOpen?.();
    await openGate;
  });
  await act(async () => root.unmount());
});

test("localhost cards stay compact without requesting remote metadata", async () => {
  const browser = new Window({ url: "http://localhost/" });
  let requests = 0;
  Object.defineProperty(browser.navigator, "clipboard", {
    configurable: true,
    value: {
      async writeText() {
        throw new Error("clipboard denied");
      },
    },
  });
  Object.assign(browser, {
    kestrelDesktop: {
      async getLinkPreviews() {
        requests += 1;
        return [];
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
    KeyboardEvent: browser.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: browser.navigator,
  });
  const container = browser.document.createElement("div") as unknown as HTMLDivElement;
  browser.document.body.append(container);
  const root = createRoot(container);

  await act(async () => root.render(<MessageContent
    messageRole="assistant"
    text="http://localhost:3000/"
  />));
  await act(async () => Promise.resolve());

  assert.equal(requests, 0);
  assert.equal(
    container.querySelector(".link-preview-card")?.getAttribute("data-link-preview-status"),
    "unavailable",
  );
  assert.match(container.textContent ?? "", /localhost/u);
  const copy = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.includes("Copy"));
  await act(async () => copy?.click());
  assert.match(container.querySelector("[role='alert']")?.textContent ?? "", /Copy failed/u);
  await act(async () => root.unmount());
});

import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { BrowserViewer } from "../renderer/src/BrowserViewer.js";
import type {
  DesktopBridge,
  DesktopBrowserViewerInputRequestV1,
  DesktopBrowserViewerStateV1,
} from "../src/contracts.js";

test("Desktop Browser viewer accepts takeover, sends typed secret input, and returns explicitly", async () => {
  const browser = new Window({ url: "http://localhost/" });
  const inputs: DesktopBrowserViewerInputRequestV1[] = [];
  const connections: Parameters<DesktopBridge["connectBrowserViewer"]>[0][] = [];
  let state: DesktopBrowserViewerStateV1 = {
    version: "desktop_browser_viewer_state_v1",
    available: true,
    threadId: "thread-1",
    projectId: "project-1",
    sessionId: "browser-1",
    generation: 1,
    connectionId: "viewer-1",
    sessionState: "ready",
    takeoverRequested: false,
  };
  const bridge = {
    async connectBrowserViewer(input) {
      connections.push(input);
      return state;
    },
    async readBrowserViewerFrame() {
      return {
        version: "desktop_browser_viewer_frame_v1" as const,
        sessionId: "browser-1",
        generation: 1,
        sequence: 1,
        capturedAt: "2026-08-29T12:00:00.000Z",
        mediaType: "image/png" as const,
        dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xk1vAAAAAElFTkSuQmCC",
      };
    },
    async acceptBrowserTakeover() {
      state = {
        ...state,
        sessionState: "human_control",
        takeoverRequested: false,
        inputLeaseId: "lease-1",
        inputLeaseExpiresAt: "2026-08-29T12:00:30.000Z",
      };
      return state;
    },
    async renewBrowserInputLease() {
      return state;
    },
    async sendBrowserViewerInput(input: DesktopBrowserViewerInputRequestV1) {
      inputs.push(input);
      return state;
    },
    async returnBrowserControl() {
      const { inputLeaseId: _lease, inputLeaseExpiresAt: _expiry, ...withoutLease } = state;
      state = {
        ...withoutLease,
        sessionState: "ready",
      };
      return state;
    },
    async disconnectBrowserViewer() {},
    async closeBrowserViewerSession() {},
  } as unknown as DesktopBridge;
  Object.assign(browser, { kestrelDesktop: bridge });
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
    root.render(<BrowserViewer threadId="thread-1" projectId="project-1" />);
    await Promise.resolve();
  });
  assert.equal(
    [...container.querySelectorAll("button")].some(
      (button) => button.textContent === "Take control",
    ),
    false,
  );
  state = { ...state, takeoverRequested: true };
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });
  assert.deepEqual(connections.slice(0, 2), [
    {
      version: "desktop_browser_viewer_request_v1",
      threadId: "thread-1",
      projectId: "project-1",
    },
    {
      version: "desktop_browser_viewer_request_v1",
      threadId: "thread-1",
      projectId: "project-1",
      sessionId: "browser-1",
      generation: 1,
      connectionId: "viewer-1",
    },
  ]);
  const takeControl = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Take control",
  );
  assert.ok(takeControl);
  await act(async () => {
    takeControl.click();
    await Promise.resolve();
  });
  assert.match(container.textContent ?? "", /Human control/u);

  const frame = container.querySelector<HTMLElement>(".browser-viewer-frame");
  assert.ok(frame);
  await act(async () => {
    frame.dispatchEvent(
      new browser.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "S",
        code: "KeyS",
      }),
    );
    await Promise.resolve();
  });
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0]?.input, {
    version: "desktop_browser_viewer_input_v1",
    kind: "keyboard",
    phase: "down",
    key: "S",
    code: "KeyS",
    text: "S",
  });

  const image = container.querySelector<HTMLImageElement>(".browser-viewer-frame img");
  assert.ok(image);
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 200 },
    naturalHeight: { configurable: true, value: 100 },
  });
  image.getBoundingClientRect = () => ({
    x: 20,
    y: 20,
    left: 20,
    top: 20,
    right: 120,
    bottom: 70,
    width: 100,
    height: 50,
    toJSON: () => ({}),
  });
  await act(async () => {
    frame.dispatchEvent(new browser.MouseEvent("pointermove", {
      bubbles: true,
      clientX: 10,
      clientY: 45,
    }));
    image.dispatchEvent(new browser.MouseEvent("pointermove", {
      bubbles: true,
      clientX: 70,
      clientY: 45,
    }));
    await Promise.resolve();
  });
  assert.equal(inputs.length, 2, "Letterbox input must not dispatch outside the image.");
  assert.deepEqual(inputs[1]?.input, {
    version: "desktop_browser_viewer_input_v1",
    kind: "pointer",
    phase: "move",
    x: 100,
    y: 50,
    button: "none",
  });

  const returnControl = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Return to agent",
  );
  assert.ok(returnControl);
  await act(async () => {
    returnControl.click();
    await Promise.resolve();
  });
  assert.match(container.textContent ?? "", /Agent control/u);

  state = {
    ...state,
    sessionState: "human_control",
  };
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });
  assert.match(container.textContent ?? "", /Reconnect required/u);
  assert.match(container.textContent ?? "", /Input paused · Reconnect to continue/u);
  assert.ok(container.querySelector('button[aria-label="Disconnect viewer"]'));
  await act(async () => root.unmount());
});

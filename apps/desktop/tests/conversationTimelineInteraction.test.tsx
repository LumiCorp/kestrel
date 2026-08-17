import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

import { ConversationTimeline } from "../renderer/src/ConversationTimeline.js";
import type { DesktopConversationTimelineItem } from "../renderer/src/runStream.js";

test("Details mounts only while explicitly expanded and collapses on the next click", async () => {
  const browser = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    Event: browser.Event,
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
  const items: DesktopConversationTimelineItem[] = [{
    id: "run-stream:tool-1",
    type: "run_stream",
    item: {
      id: "tool-1",
      runId: "run-1",
      kind: "tool",
      label: "Tool action",
      text: "Completed fs.read_text",
      timestamp: "2026-08-13T12:00:00.000Z",
      status: "completed",
    },
  }];

  await act(async () => root.render(<ConversationTimeline
    items={items}
    active={false}
    activity="Ready"
    endRef={{ current: null }}
  />));

  const toggle = container.querySelector<HTMLButtonElement>(".timeline-details-toggle");
  assert.ok(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector(".timeline-details > ol"), null);

  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.match(container.textContent ?? "", /Completed fs\.read_text/u);
  assert.ok(container.querySelector(".timeline-details > ol"));

  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(container.querySelector(".timeline-details > ol"), null);
  assert.doesNotMatch(container.textContent ?? "", /Completed fs\.read_text/u);

  await act(async () => root.unmount());
});

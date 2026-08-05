import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

import type { DesktopRendererBootstrapReport } from "../src/contracts.js";
import {
  readRendererBootstrapGeneration,
  reportRendererBootstrapReadyAfterCommit,
} from "../renderer/src/rendererBootstrap.js";

test("renderer readiness includes the load generation after the stylesheet sentinel exists", async () => {
  const browser = new Window({
    url: "http://localhost/renderer/index.html?bootstrapGeneration=7",
  });
  const reports: DesktopRendererBootstrapReport[] = [];
  Object.assign(browser, {
    kestrelDesktop: {
      reportRendererBootstrap: async (report: DesktopRendererBootstrapReport) => {
        reports.push(report);
        return true;
      },
    },
  });
  browser.document.documentElement.style.setProperty(
    "--kestrel-renderer-bootstrap-ready",
    "1",
  );
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
  });

  assert.equal(readRendererBootstrapGeneration(), 7);
  reportRendererBootstrapReadyAfterCommit();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(reports, [{ generation: 7, status: "ready" }]);
});

test("renderer readiness reports a missing stylesheet instead of accepting the mount", async () => {
  const browser = new Window({
    url: "http://localhost/renderer/index.html?bootstrapGeneration=8",
  });
  const reports: DesktopRendererBootstrapReport[] = [];
  Object.assign(browser, {
    kestrelDesktop: {
      reportRendererBootstrap: async (report: DesktopRendererBootstrapReport) => {
        reports.push(report);
        return false;
      },
    },
  });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
  });

  reportRendererBootstrapReadyAfterCommit();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(reports, [
    { generation: 8, status: "failed", reason: "stylesheet_missing" },
  ]);
});

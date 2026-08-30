import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_BROWSER_VIEWER_INPUT_VERSION,
  DESKTOP_BROWSER_VIEWER_REQUEST_VERSION,
  DESKTOP_BRIDGE_CAPABILITIES,
  parseDesktopBrowserViewerBinding,
  parseDesktopBrowserViewerInputRequest,
  parseDesktopBrowserViewerLeaseRequest,
} from "../../../src/desktopShell/contracts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Desktop Browser viewer contracts accept only exact typed identities and input", () => {
  const binding = {
    version: DESKTOP_BROWSER_VIEWER_REQUEST_VERSION,
    threadId: "thread-1",
    projectId: "project-1",
    sessionId: "browser-1",
    generation: 1,
    connectionId: "viewer-1",
  };
  assert.deepEqual(parseDesktopBrowserViewerBinding(binding), binding);
  assert.deepEqual(
    parseDesktopBrowserViewerLeaseRequest({ ...binding, leaseId: "lease-1" }),
    { ...binding, leaseId: "lease-1" },
  );
  assert.throws(() =>
    parseDesktopBrowserViewerLeaseRequest({
      ...binding,
      leaseId: "lease-1",
      unsupported: true,
    }),
  );
  const sentinel = "sentinel-password-N3v3rL0g";
  const parsed = parseDesktopBrowserViewerInputRequest({
    ...binding,
    leaseId: "lease-1",
    input: {
      version: DESKTOP_BROWSER_VIEWER_INPUT_VERSION,
      kind: "keyboard",
      phase: "down",
      key: "Unidentified",
      text: sentinel,
    },
  });
  assert.equal(parsed.input.kind, "keyboard");
  assert.equal(parsed.input.text, sentinel);
  assert.throws(
    () => parseDesktopBrowserViewerBinding({ ...binding, cdpUrl: "ws://raw" }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes("ws://raw"),
  );
  assert.throws(
    () =>
      parseDesktopBrowserViewerInputRequest({
        ...binding,
        leaseId: "lease-1",
        input: {
          version: DESKTOP_BROWSER_VIEWER_INPUT_VERSION,
          kind: "keyboard",
          phase: "invalid",
          key: "Unidentified",
          text: sentinel,
        },
      }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(sentinel),
  );
  assert.ok(DESKTOP_BRIDGE_CAPABILITIES.includes("browser_viewer"));
});

test("Desktop Browser viewer is exposed only through typed preload and current-main-window IPC", async () => {
  const [contracts, preload, main, renderer, preview] = await Promise.all([
    readFile(path.join(root, "src/contracts.ts"), "utf8"),
    readFile(path.join(root, "src/preload.ts"), "utf8"),
    readFile(path.join(root, "src/main.ts"), "utf8"),
    readFile(path.join(root, "renderer/src/BrowserViewer.tsx"), "utf8"),
    readFile(path.join(root, "renderer/src/browserPreview.ts"), "utf8"),
  ]);
  for (const method of [
    "connectBrowserViewer",
    "readBrowserViewerFrame",
    "acceptBrowserTakeover",
    "renewBrowserInputLease",
    "sendBrowserViewerInput",
    "returnBrowserControl",
    "disconnectBrowserViewer",
    "closeBrowserViewerSession",
  ]) {
    assert.match(contracts, new RegExp(`${method}\\(`, "u"));
    assert.match(preload, new RegExp(`${method}\\(`, "u"));
  }
  assert.match(main, /requireCurrentDesktopBrowserViewerPrincipal/u);
  assert.match(main, /requireCurrentMainWindowIpcSender\(event\)/u);
  assert.match(main, /requireAvailableDesktopBrowserViewerThread/u);
  assert.match(main, /loseCurrentDesktopBrowserViewerAuthority/u);
  assert.doesNotMatch(renderer, /cdp|devtools|proxyServer|websocket/iu);
  assert.doesNotMatch(preview, /connectBrowserViewer|sendBrowserViewerInput/u);
});

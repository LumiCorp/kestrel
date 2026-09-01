import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { experimental_upgradeWebSocket } from "@vercel/functions";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

test("hosted Browser viewer uses the official versioned Vercel WebSocket route outside the App relay", () => {
  const route = read("app/api/threads/[id]/browser-viewer/v1/route.ts");
  const socketRoute = read("lib/browser/viewer-socket-route.ts");
  const manifest = read("app/route-ownership.manifest.ts");
  const appRelay = read("../environment-router/src/app-relay.ts");
  assert.match(route, /experimental_upgradeWebSocket/u);
  assert.equal(typeof experimental_upgradeWebSocket, "function");
  assert.match(route, /maxPayload: MAX_CLIENT_MESSAGE_BYTES/u);
  assert.match(socketRoute, /HOSTED_BROWSER_VIEWER_ROUTE_VERSION/u);
  assert.match(route, /attachHostedBrowserViewerSocket/u);
  assert.match(route, /claims\.actorId !== requestAuthority\.actorId/u);
  assert.match(route, /claims\.threadId !== requestAuthority\.threadId/u);
  assert.match(manifest, /\/api\/threads\/:id\/browser-viewer\/v1/u);
  assert.doesNotMatch(appRelay, /browser-viewer\/v1/u);
});

test("Web reaches hosted Browser workers only through the Environment Router control route", () => {
  const workerClient = read("lib/browser/viewer-worker-client.ts");
  const composition = read("lib/browser/viewer-composition.ts");
  assert.match(workerClient, /\/internal\/browser\/viewer/u);
  assert.match(workerClient, /signEnvironmentToolCredential/u);
  assert.match(composition, /routerUrl/u);
  assert.doesNotMatch(workerClient, /\.internal|\.vm\./u);
  assert.doesNotMatch(composition, /\.internal|\.vm\./u);
});

test("web viewer exposes acceptance, typed input, reconnect, explicit return, and close without a secret form", () => {
  const component = read("components/browser/hosted-browser-viewer.tsx");
  assert.match(component, /Take control/u);
  assert.match(component, /Return to agent/u);
  assert.match(component, /Close browser/u);
  assert.match(component, /desktop_browser_viewer_input_v1/u);
  assert.match(component, /View browser/u);
  assert.doesNotMatch(component, /type=["']password["']/u);
  assert.doesNotMatch(component, /localStorage|sessionStorage/u);
  assert.match(component, /hostedBrowserViewerCleanupUnknownPresentation/u);
  assert.match(component, /hosted-browser-viewer-cleanup-unknown/u);
  assert.match(component, /value\.cleanupPending/u);
  assert.match(component, /if \(availability\.cleanupPending\) return/u);
  assert.match(component, /result\.kind === "transient"/u);
  assert.match(component, /result\.kind === "unavailable"/u);
  assert.doesNotMatch(component, /catch \{\s*if \(!cancelled\) setAvailability/u);
});

test("web viewer validates every server message and clears stale state on rejection", () => {
  const component = read("components/browser/hosted-browser-viewer.tsx");
  assert.match(component, /HOSTED_BROWSER_VIEWER_MAX_SERIALIZED_FRAME_BYTES/u);
  assert.match(component, /parseHostedBrowserViewerServerMessage/u);
  assert.match(component, /viewerIdentityRef/u);
  assert.match(component, /projectId: message\.state\.projectId/u);
  assert.match(component, /if \(!identity && message\.type === "frame"\)/u);
  assert.match(component, /setState\(null\);\s*setFrame\(null\);\s*socket\.close\(1008/u);
  assert.doesNotMatch(component, /as HostedBrowserViewerServerMessageV1/u);
});

test("cleanup reconciliation bypass is exact and cannot expose viewer status after access loss", () => {
  const composition = read("lib/browser/viewer-composition.ts");
  const service = read("lib/browser/viewer-service.ts");
  assert.match(composition, /pending\.scope\.runId === origin\.runId/u);
  assert.match(composition, /pending\.scope\.actorId === origin\.userId/u);
  assert.match(composition, /pending\?\.scope\.appName === environment\?\.flyAppName/u);
  assert.match(composition, /origin\.userId === input\.actorId/u);
  assert.match(composition, /resolveHostedBrowserViewerRequester/u);
  assert.match(composition, /accessibleProjectId: requestAccess\?\.thread\.projectId/u);
  assert.match(composition, /unavailableViewerWorker/u);
  assert.match(composition, /currentEnvironment\?\.status !== "ready"/u);
  assert.match(composition, /currentEnvironment\.flyAppName !== appName/u);
  assert.match(composition, /composeHostedBrowserViewerLifecycle/u);
  assert.match(composition, /createCleanupSafe: \(\) => createCleanupSafeHostedBrowserViewerLifecycle/u);
  assert.match(composition, /requestAuthorized,/u);
  assert.match(service, /this\.options\.requestAuthorized === false/u);
  assert.match(service, /throw new Error\("BROWSER_SESSION_LOST"\)/u);
  const component = read("components/browser/hosted-browser-viewer.tsx");
  assert.match(component, /if \(transportState !== "closed"\) return/u);
});

test("Kestrel One Mobile has no Browser viewer route, socket, or takeover action", () => {
  const mobileProjection = read("lib/mobile/message-parts.ts");
  const mobileRoutes = read("app/route-ownership.manifest.ts")
    .split("\n")
    .filter((line) => line.includes("/api/mobile/"))
    .join("\n");
  assert.doesNotMatch(mobileProjection, /browser.viewer|browser-viewer|accept_takeover|return_control/u);
  assert.doesNotMatch(mobileRoutes, /browser-viewer|takeover/u);
});

test("viewer evidence and errors exclude ticket, frame, URL, and input bodies", () => {
  const composition = read("lib/browser/viewer-composition.ts");
  const route = read("app/api/threads/[id]/browser-viewer/v1/route.ts");
  assert.match(composition, /Metadata only/u);
  assert.doesNotMatch(composition, /console\.(?:info|error|warn)\([^\n]*(?:ticket|frame|input|url)/iu);
  assert.doesNotMatch(route, /console\./u);
  assert.doesNotMatch(route, /event\.data/u);
});

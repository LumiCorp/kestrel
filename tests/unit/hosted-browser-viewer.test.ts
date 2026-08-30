import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  HOSTED_BROWSER_VIEWER_AUDIENCE,
  HOSTED_BROWSER_VIEWER_TICKET_VERSION,
  issueHostedBrowserViewerTicket,
  parseHostedBrowserViewerClientMessage,
  verifyHostedBrowserViewerTicket,
} from "../../src/browser/hostedViewer.js";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const now = new Date("2026-08-30T12:00:00.000Z");
const claims = {
  version: HOSTED_BROWSER_VIEWER_TICKET_VERSION,
  audience: HOSTED_BROWSER_VIEWER_AUDIENCE,
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  threadId: "thread-1",
  sessionId: "session-1",
  generation: 3,
  actorId: "user-1",
  nonce: "nonce-browser-viewer-1",
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 60_000).toISOString(),
} as const;

test("hosted viewer tickets bind the complete actor and Browser Session authority for exactly 60 seconds", () => {
  const token = issueHostedBrowserViewerTicket({ claims, privateKeyPem, now });
  assert.deepEqual(
    verifyHostedBrowserViewerTicket({ token, publicKeyPem, now }),
    claims,
  );
  assert.throws(() => verifyHostedBrowserViewerTicket({
    token,
    publicKeyPem,
    now: new Date(claims.expiresAt),
  }));
  const payload = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8"));
  assert.equal(payload.machineId, undefined);
  assert.equal(payload.workerAddress, undefined);
  assert.equal(payload.credential, undefined);
  assert.equal(payload.proxy, undefined);
});

test("hosted viewer messages accept only the typed protocol and typed input", () => {
  assert.deepEqual(
    parseHostedBrowserViewerClientMessage({
      version: "hosted_browser_viewer_route_v1",
      type: "input",
      leaseId: "lease-1",
      input: {
        version: "desktop_browser_viewer_input_v1",
        kind: "keyboard",
        phase: "down",
        key: "a",
        text: "a",
      },
    }),
    {
      version: "hosted_browser_viewer_route_v1",
      type: "input",
      leaseId: "lease-1",
      input: {
        version: "desktop_browser_viewer_input_v1",
        kind: "keyboard",
        phase: "down",
        key: "a",
        text: "a",
      },
    },
  );
  assert.throws(() => parseHostedBrowserViewerClientMessage({
    version: "hosted_browser_viewer_route_v1",
    type: "input",
    leaseId: "lease-1",
    input: { kind: "evaluate", javascript: "document.cookie" },
  }));
  assert.throws(() => parseHostedBrowserViewerClientMessage({
    version: "hosted_browser_viewer_route_v1",
    type: "input",
    leaseId: "lease-1",
    input: {
      version: "desktop_browser_viewer_input_v1",
      kind: "keyboard",
      phase: "down",
      key: "a",
      javascript: "document.cookie",
    },
  }));
  assert.throws(() => parseHostedBrowserViewerClientMessage({
    version: "hosted_browser_viewer_route_v1",
    type: "return_control",
    leaseId: "lease-1",
    modelRequested: true,
  }));
});

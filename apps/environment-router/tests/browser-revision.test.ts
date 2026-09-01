import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import {
  authorizeBrowserRevisionControl,
  handleBrowserRevisionControl,
  readBoundedWorkerBody,
} from "../src/browser-revision.js";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function request(issuedAt = 1000) {
  const envelope = {
    organizationId: "org-1",
    environmentId: "env-1",
    userId: "user-1",
    threadId: "thread-1",
    runId: "run-1",
    instruction: {
      version: "hosted_browser_revision_instruction_v1",
      sessionId: "browser-session-1",
      generation: 3,
      revision: "revision-2",
      cause: "personal_revocation",
      authority: {
        version: "browser_effective_domain_authority_v1",
        environmentId: "env-1",
        projectId: "project-1",
        userId: "user-1",
        enabledModes: ["operator"],
        personalGrantsEnabled: true,
        publicDomains: [],
        qaTarget: null,
        effectiveAllowlistRevision: "revision-2",
      },
      capability: "browser-capability",
      machine: { appName: "environment-app", machineId: "machine-1" },
    },
  };
  const body = Buffer.from(JSON.stringify(envelope));
  const token = signEnvironmentToolCredential({
    privateKey,
    ticket: {
      version: 1,
      audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
      organizationId: "org-1",
      environmentId: "env-1",
      workspaceId: "browser:browser-session-1",
      threadId: "thread-1",
      runId: "run-1",
      actorId: "user-1",
      agentId: "kestrel-control-plane",
      providerKey: "built_in.browser",
      resourceId: "browser-session-1",
      capability: "browser.allowlist.adopt",
      operation: "revision.install",
      operationBinding: `sha256:${createHash("sha256").update(body).digest("base64url")}`,
      issuedAt,
      expiresAt: issuedAt + 60,
      nonce: "nonce-1",
    },
  });
  return { body, token };
}

test("browser revision control binds the exact body and session identity", () => {
  const input = request();
  const authorized = authorizeBrowserRevisionControl({
    authorization: `Bearer ${input.token}`,
    body: input.body,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    now: 1030,
  });
  assert.equal(authorized.instruction.sessionId, "browser-session-1");
  assert.equal(authorized.instruction.generation, 3);
  assert.equal(authorized.instruction.revision, "revision-2");

  const changed = Buffer.from(
    input.body.toString("utf8").replace("revision-2", "revision-3"),
  );
  assert.throws(() =>
    authorizeBrowserRevisionControl({
      authorization: `Bearer ${input.token}`,
      body: changed,
      publicKey,
      environmentId: "env-1",
      expectedAppName: "environment-app",
      now: 1030,
    }),
  );
});

test("browser revision control rejects a wrong Environment or worker app", () => {
  const input = request();
  for (const [environmentId, expectedAppName] of [
    ["env-other", "environment-app"],
    ["env-1", "environment-other"],
  ] as const) {
    assert.throws(() =>
      authorizeBrowserRevisionControl({
        authorization: `Bearer ${input.token}`,
        body: input.body,
        publicKey,
        environmentId,
        expectedAppName,
        now: 1030,
      }),
    );
  }
});

test("browser revision control refuses redirects and bounds streamed worker output", async () => {
  const input = request(Math.floor(Date.now() / 1000));
  const requestStream = Readable.from([
    input.body,
  ]) as unknown as IncomingMessage;
  requestStream.headers = { authorization: `Bearer ${input.token}` };
  let status = 0;
  let responseBody = "";
  const response = {
    writeHead(nextStatus: number) {
      status = nextStatus;
      return this;
    },
    end(value?: string | Buffer) {
      responseBody =
        value === undefined ? "" : Buffer.from(value).toString("utf8");
      return this;
    },
  } as unknown as ServerResponse;
  await handleBrowserRevisionControl({
    request: requestStream,
    response,
    publicKey,
    environmentId: "env-1",
    expectedAppName: "environment-app",
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.redirect, "error");
      return new Response("too large", {
        status: 200,
        headers: { "content-length": String(256 * 1024 + 1) },
      });
    }) as unknown as typeof fetch,
  });
  assert.equal(status, 503);
  assert.match(responseBody, /BROWSER_REVISION_INSTALL_UNCONFIRMED/u);

  const oversizedStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(256 * 1024));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  });
  await assert.rejects(
    readBoundedWorkerBody(new Response(oversizedStream)),
    /too large/u,
  );
});

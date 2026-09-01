import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  BROWSER_QA_TARGET_VERSION,
  BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
  canonicalizeTrustedBrowserQaTarget,
  type BrowserEffectiveDomainAuthorityV1,
} from "../../../src/browser/domainAuthority.js";
import {
  HOSTED_BROWSER_CAPABILITY_VERSION,
  issueHostedBrowserOperationCapability,
} from "../../../src/browser/hostedCapability.js";
import { BROWSER_RUNTIME_RELEASE_MANIFEST } from "../../../src/browser/runtimeReleaseManifest.js";
import type { BrowserSessionV1 } from "../../../src/browser/contracts.js";
import {
  createToolActivationRefV1,
  fingerprintToolScopeV1,
  hashCanonical,
} from "../../../src/kestrel/contracts/tool-contract.js";
import { parsePreparedToolCallV1 } from "../../../src/kestrel/contracts/tool-invocation.js";
import { defaultToolCatalog } from "../../../tools/catalog.js";

const IDENTITY = Object.freeze({
  organizationId: "browser-image-smoke-org",
  environmentId: "browser-image-smoke-environment",
  projectId: "browser-image-smoke-project",
  userId: "browser-image-smoke-user",
  threadId: "browser-image-smoke-thread",
  sessionId: "browser-image-smoke-session",
  generation: 1,
});
const RUN_ID = "browser-image-smoke-run";
const RUNTIME_SESSION_ID = "browser-image-smoke-runtime-session";
const PREVIEW_ID = "browser-image-smoke-preview";
const QA_DESTINATION = "http://browser-smoke-preview.internal:43106/";
const QA_TARGET = canonicalizeTrustedBrowserQaTarget(QA_DESTINATION);
const POLICY_REVISION = hashCanonical({
  purpose: "hosted-browser-image-smoke",
  target: QA_DESTINATION,
});
export const HOSTED_BROWSER_IMAGE_SMOKE_EFFECTIVE_ALLOWLIST_REVISION =
  createHash("sha256")
    .update(
      JSON.stringify({
        revision: POLICY_REVISION,
        threadId: IDENTITY.threadId,
        projectId: IDENTITY.projectId,
        qaTarget: QA_TARGET,
      }),
    )
    .digest("hex");

export async function writeHostedBrowserImageSmokeKeys(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  const publicKeyPem = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  await Promise.all([
    writeFile(`${directory}/capability-private.pem`, privateKeyPem, {
      mode: 0o600,
    }),
    writeFile(`${directory}/capability-public.pem`, publicKeyPem, {
      mode: 0o600,
    }),
  ]);
}

export async function runHostedBrowserImageSmokeControl(input: {
  baseUrl: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch | undefined;
  now?: Date | undefined;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? new Date();
  const baseUrl = input.baseUrl.replace(/\/+$/u, "");
  await waitForWorker(baseUrl, fetchImpl);

  const policyRevision = POLICY_REVISION;
  const qaTarget = QA_TARGET;
  const effectiveAllowlistRevision =
    HOSTED_BROWSER_IMAGE_SMOKE_EFFECTIVE_ALLOWLIST_REVISION;
  const authority: BrowserEffectiveDomainAuthorityV1 = {
    version: BROWSER_EFFECTIVE_DOMAIN_AUTHORITY_VERSION,
    environmentId: IDENTITY.environmentId,
    projectId: IDENTITY.projectId,
    userId: IDENTITY.userId,
    enabledModes: ["qa"],
    personalGrantsEnabled: false,
    publicDomains: [],
    qaTarget: {
      version: BROWSER_QA_TARGET_VERSION,
      scheme: qaTarget.scheme,
      hostname: qaTarget.hostname,
      port: qaTarget.port,
    },
    effectiveAllowlistRevision,
  };
  const createdAt = now.toISOString();
  const openingSession: BrowserSessionV1 = {
    version: "browser_session_v1",
    sessionId: IDENTITY.sessionId,
    threadId: IDENTITY.threadId,
    mode: "qa",
    state: "opening",
    engineRevision: BROWSER_RUNTIME_RELEASE_MANIFEST.engine.revision,
    generation: IDENTITY.generation,
    effectiveAllowlistRevision,
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
    idleExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    hardExpiresAt: new Date(now.getTime() + 8 * 60 * 60_000).toISOString(),
  };

  const openPrepared = preparedCall(
    "browser.open",
    "browser-image-smoke-open",
    {
      mode: "qa",
      target: { kind: "kestrel_edge_preview", previewId: PREVIEW_ID },
    },
    policyRevision,
  );
  const openCapability = operationCapability({
    operationId: openPrepared.callId,
    effectiveAllowlistRevision,
    privateKeyPem: input.privateKeyPem,
    now,
  });
  const gatewayProxy = {
    version: "hosted_browser_gateway_proxy_binding_v1",
    proxyServer:
      "http://gateway-machine-1.vm.browser-workers.internal:43109",
    username: "kestrel-browser-smoke",
    password: "kestrel-browser-smoke-secret",
    threadId: IDENTITY.threadId,
    sessionId: IDENTITY.sessionId,
    generation: IDENTITY.generation,
    effectiveAllowlistRevision,
    chromiumFlags: [
      "--proxy-server=http://gateway-machine-1.vm.browser-workers.internal:43109",
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  } as const;
  await requireAcceptance(
    await postJson(fetchImpl, `${baseUrl}/v1/operations/accept`, {
      capability: openCapability,
      prepared: openPrepared,
      authority,
      session: openingSession,
      gatewayProxy,
    }),
    openPrepared.callId,
  );
  const openOutput = requireRecord(
    await postJson(fetchImpl, `${baseUrl}/v1/operations/invoke`, {
      capability: openCapability,
      operationId: openPrepared.callId,
    }),
  );
  const readySession = requireRecord(
    openOutput.session,
  ) as unknown as BrowserSessionV1;
  if (
    openOutput.operation !== "browser.open" ||
    openOutput.outcome !== "opened" ||
    readySession.sessionId !== IDENTITY.sessionId ||
    readySession.generation !== IDENTITY.generation ||
    readySession.state !== "ready"
  ) {
    throw new Error(
      "Hosted Browser image smoke did not open the exact Browser Session.",
    );
  }
  await requireCommit(
    await postJson(fetchImpl, `${baseUrl}/v1/operations/commit`, {
      capability: openCapability,
      operationId: openPrepared.callId,
    }),
    openPrepared.callId,
  );

  const closePrepared = preparedCall(
    "browser.close",
    "browser-image-smoke-close",
    {
      sessionId: IDENTITY.sessionId,
      generation: IDENTITY.generation,
    },
    policyRevision,
  );
  const closeCapability = operationCapability({
    operationId: closePrepared.callId,
    effectiveAllowlistRevision,
    privateKeyPem: input.privateKeyPem,
    now,
  });
  await requireAcceptance(
    await postJson(fetchImpl, `${baseUrl}/v1/operations/accept`, {
      capability: closeCapability,
      prepared: closePrepared,
      authority,
      session: readySession,
      gatewayProxy,
    }),
    closePrepared.callId,
  );
  const closeOutput = requireRecord(
    await postJson(fetchImpl, `${baseUrl}/v1/operations/invoke`, {
      capability: closeCapability,
      operationId: closePrepared.callId,
    }),
  );
  if (
    closeOutput.operation !== "browser.close" ||
    closeOutput.sessionId !== IDENTITY.sessionId ||
    closeOutput.state !== "closed"
  ) {
    throw new Error(
      "Hosted Browser image smoke did not close the exact Browser Session.",
    );
  }
  await requireCommit(
    await postJson(fetchImpl, `${baseUrl}/v1/operations/commit`, {
      capability: closeCapability,
      operationId: closePrepared.callId,
    }),
    closePrepared.callId,
  );
}

function preparedCall(
  toolId: "browser.open" | "browser.close",
  callId: string,
  effectiveInput: Record<string, unknown>,
  policyRevision: string,
) {
  const descriptor = defaultToolCatalog.getDescriptorRef(toolId);
  if (!descriptor)
    throw new Error(`Hosted Browser image smoke is missing ${toolId}.`);
  return parsePreparedToolCallV1({
    version: "v1",
    runId: RUN_ID,
    sessionId: RUNTIME_SESSION_ID,
    callId,
    activation: createToolActivationRefV1({
      descriptor,
      registryGeneration: "hosted-browser-image-smoke",
      scopeFingerprint: fingerprintToolScopeV1({
        hostedBrowserImageSmoke: true,
      }),
    }),
    origin: {
      kind: "trusted_runtime",
      producerId: "hosted-browser-image-smoke",
      adapterId: "hosted-browser-image-smoke",
    },
    effectiveInput,
    policy: {
      decision: "allow",
      policyRevision,
      reasonCode: "environment_policy",
    },
    preparedAt: new Date().toISOString(),
  });
}

function operationCapability(input: {
  operationId: string;
  effectiveAllowlistRevision: string;
  privateKeyPem: string;
  now: Date;
}) {
  return issueHostedBrowserOperationCapability({
    privateKeyPem: input.privateKeyPem,
    now: input.now,
    claims: {
      version: HOSTED_BROWSER_CAPABILITY_VERSION,
      ...IDENTITY,
      operationId: input.operationId,
      effectiveAllowlistRevision: input.effectiveAllowlistRevision,
      expiresAt: new Date(input.now.getTime() + 2 * 60_000).toISOString(),
    },
  });
}

async function waitForWorker(baseUrl: string, fetchImpl: typeof fetch) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      await fetchImpl(baseUrl, { signal: AbortSignal.timeout(1_000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    "Hosted Browser image worker did not listen after runtime measurement.",
  );
}

async function postJson(fetchImpl: typeof fetch, url: string, body: unknown) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const output = (await response.json()) as unknown;
  if (!response.ok) {
    const code = readErrorCode(output);
    throw new Error(
      `Hosted Browser image control request failed (${response.status}, ${code}).`,
    );
  }
  return output;
}

function requireAcceptance(value: unknown, operationId: string) {
  const record = requireRecord(value);
  if (record.accepted !== true || record.operationId !== operationId) {
    throw new Error(
      "Hosted Browser image worker did not accept the exact operation.",
    );
  }
}

function requireCommit(value: unknown, operationId: string) {
  const record = requireRecord(value);
  if (record.committed !== true || record.operationId !== operationId) {
    throw new Error(
      "Hosted Browser image worker did not commit the exact operation.",
    );
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hosted Browser image worker returned invalid JSON.");
  }
  return value as Record<string, unknown>;
}

function readErrorCode(value: unknown): string {
  const record = requireRecord(value);
  const error = record.error;
  if (!error || typeof error !== "object" || Array.isArray(error))
    return "unknown";
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : "unknown";
}

async function main() {
  const command = process.argv[2];
  if (command === "keygen") {
    const directory = process.argv[3];
    if (!directory)
      throw new Error("usage: image-smoke-client.ts keygen DIRECTORY");
    await writeHostedBrowserImageSmokeKeys(directory);
    return;
  }
  if (command === "revision") {
    process.stdout.write(
      `${HOSTED_BROWSER_IMAGE_SMOKE_EFFECTIVE_ALLOWLIST_REVISION}\n`,
    );
    return;
  }
  if (command === "run") {
    const baseUrl = process.argv[3];
    const privateKeyPath = process.argv[4];
    if (!baseUrl || !privateKeyPath) {
      throw new Error(
        "usage: image-smoke-client.ts run BASE_URL PRIVATE_KEY_PATH",
      );
    }
    await runHostedBrowserImageSmokeControl({
      baseUrl,
      privateKeyPem: await readFile(privateKeyPath, "utf8"),
    });
    return;
  }
  throw new Error("usage: image-smoke-client.ts <keygen|revision|run> ...");
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  decryptDesktopCredential,
  desktopCredentialEnvelopeContext,
  encryptDesktopCredential,
  ENVIRONMENT_ROUTER_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
  PREVIEW_EDGE_ROUTE_TICKET_VERSION,
  PREVIEW_RELAY_TICKET_AUDIENCE,
  PREVIEW_RELAY_TICKET_VERSION,
  PREVIEW_RELAY_TICKET_V2_VERSION,
  generateDesktopCredentialEncryptionKeyPair,
  signEnvironmentExecutionTicket,
  signEnvironmentToolCredential,
  signPreviewEdgeRouteTicket,
  signPreviewRelayTicket,
  verifyEnvironmentExecutionTicket,
  verifyEnvironmentToolCredential,
  verifyPreviewEdgeRouteTicket,
  verifyPreviewRelayTicket,
  WORKSPACE_READINESS_TIMEOUT_MS,
  WORKSPACE_READINESS_TIMEOUT_SECONDS,
  type EnvironmentExecutionTicket,
  type EnvironmentToolCredentialTicket,
} from "../src/index.js";
import { contractTest } from "../../../tests/helpers/contract-test.js";


const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();
const publicKey = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const ticket: EnvironmentExecutionTicket = {
  version: 1,
  audience: ENVIRONMENT_ROUTER_AUDIENCE,
  organizationId: "org-1",
  environmentId: "env-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  runId: "run-1",
  actorId: "user-1",
  agentId: "kestrel-one",
  flyAppName: "kestrel-env-1",
  flyMachineId: "machine-1",
  capabilities: ["run.stream", "profile.read"],
  issuedAt: 1000,
  expiresAt: 1300,
  nonce: "nonce-1",
};
const providerNeutralTicket: EnvironmentExecutionTicket = {
  version: 2,
  audience: ENVIRONMENT_ROUTER_AUDIENCE,
  organizationId: "org-1",
  environmentId: "env-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  runId: "run-2",
  actorId: "user-1",
  agentId: "kestrel-one",
  target: {
    provider: "desktop",
    connectionId: "connection-1",
    workspaceRef: "workspace-ref-1",
  },
  capabilities: ["run.stream", "profile.read"],
  issuedAt: 1000,
  expiresAt: 1300,
  nonce: "nonce-2",
};

contractTest(
  "packages.hermetic",
  "Workspace readiness uses the shared 120 second budget",
  () => {
    assert.equal(WORKSPACE_READINESS_TIMEOUT_SECONDS, 120);
    assert.equal(
      WORKSPACE_READINESS_TIMEOUT_MS,
      WORKSPACE_READINESS_TIMEOUT_SECONDS * 1000,
    );
  },
);

contractTest("packages.hermetic", "execution tickets bind the complete routing identity", () => {
  const token = signEnvironmentExecutionTicket({ ticket, privateKey });
  assert.deepEqual(
    verifyEnvironmentExecutionTicket({ token, publicKey, now: 1100 }),
    ticket,
  );
});

contractTest(
  "packages.hermetic",
  "v2 execution tickets bind a provider-neutral Desktop target",
  () => {
    const token = signEnvironmentExecutionTicket({
      ticket: providerNeutralTicket,
      privateKey,
    });
    assert.deepEqual(
      verifyEnvironmentExecutionTicket({ token, publicKey, now: 1100 }),
      providerNeutralTicket,
    );
  },
);

contractTest(
  "packages.hermetic",
  "v2 execution tickets reject malformed or mixed provider targets",
  () => {
    assert.throws(() =>
      signEnvironmentExecutionTicket({
        ticket: {
          ...providerNeutralTicket,
          target: {
            provider: "desktop",
            connectionId: "connection-1",
            workspaceRef: "",
          },
        },
        privateKey,
      }),
    );
    assert.throws(() =>
      signEnvironmentExecutionTicket({
        ticket: {
          ...providerNeutralTicket,
          target: {
            provider: "fly",
            appName: "fly-app",
            machineId: "",
          },
        },
        privateKey,
      }),
    );
  },
);

contractTest("packages.hermetic", "preview relay tickets bind one hostname, Workspace Machine, and loopback port", () => {
  const relayTicket = {
    version: PREVIEW_RELAY_TICKET_VERSION,
    audience: PREVIEW_RELAY_TICKET_AUDIENCE,
    organizationId: "org-1",
    environmentId: "environment-1",
    workspaceId: "workspace-1",
    flyAppName: "kestrel-env-1",
    flyMachineId: "machine-1",
    previewId: "preview-1",
    hostname: "p-one.previews.example.com",
    port: 5173,
    issuedAt: 1000,
    expiresAt: 1120,
    nonce: "relay-nonce",
  } as const;
  const token = signPreviewRelayTicket({ ticket: relayTicket, privateKey });
  assert.deepEqual(
    verifyPreviewRelayTicket({ token, publicKey, now: 1050 }),
    relayTicket
  );
  assert.throws(() => verifyPreviewRelayTicket({ token: `${token}x`, publicKey, now: 1050 }));
  assert.throws(() => verifyPreviewRelayTicket({ token, publicKey, now: 1120 }));
});

contractTest(
  "packages.hermetic",
  "preview relay v2 tickets bind a Desktop connection and workspace",
  () => {
    const relayTicket = {
      version: PREVIEW_RELAY_TICKET_V2_VERSION,
      audience: PREVIEW_RELAY_TICKET_AUDIENCE,
      organizationId: "org-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      target: {
        provider: "desktop",
        connectionId: "connection-1",
        workspaceRef: "workspace-ref-1",
      },
      previewId: "preview-2",
      hostname: "p-two.previews.example.com",
      port: 5173,
      issuedAt: 1000,
      expiresAt: 1120,
      nonce: "relay-nonce-2",
    } as const;
    const token = signPreviewRelayTicket({ ticket: relayTicket, privateKey });
    assert.deepEqual(
      verifyPreviewRelayTicket({ token, publicKey, now: 1050 }),
      relayTicket,
    );
    assert.throws(() =>
      signPreviewRelayTicket({
        ticket: {
          ...relayTicket,
          target: {
            provider: "desktop",
            connectionId: "connection-1",
            workspaceRef: "",
          },
        },
        privateKey,
      }),
    );
  },
);

contractTest(
  "packages.hermetic",
  "Preview Edge route tickets bind one public hostname to one Environment gateway",
  () => {
    const edgeTicket = {
      version: PREVIEW_EDGE_ROUTE_TICKET_VERSION,
      audience: PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
      organizationId: "org-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      flyAppName: "kestrel-env-1",
      previewId: "preview-1",
      hostname: "p-one.preview.kestrelagents.dev",
      issuedAt: 1000,
      expiresAt: 1300,
      nonce: "edge-nonce",
    } as const;
    const token = signPreviewEdgeRouteTicket({
      ticket: edgeTicket,
      privateKey,
    });

    assert.deepEqual(
      verifyPreviewEdgeRouteTicket({ token, publicKey, now: 1030 }),
      edgeTicket
    );
    assert.throws(() =>
      verifyPreviewEdgeRouteTicket({
        token: `${token}x`,
        publicKey,
        now: 1030,
      })
    );
    assert.throws(() =>
      verifyPreviewEdgeRouteTicket({ token, publicKey, now: 1300 })
    );
    assert.throws(() =>
      signPreviewEdgeRouteTicket({
        ticket: { ...edgeTicket, hostname: "UPPER.preview.kestrelagents.dev" },
        privateKey,
      })
    );
  }
);

contractTest(
  "packages.hermetic",
  "Preview Edge tickets reject malformed runtime payload types and unknown fields",
  () => {
    const edgeTicket = {
      version: PREVIEW_EDGE_ROUTE_TICKET_VERSION,
      audience: PREVIEW_EDGE_ROUTE_TICKET_AUDIENCE,
      organizationId: "org-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      flyAppName: "kestrel-env-1",
      previewId: "preview-1",
      hostname: "p-one.preview.kestrelagents.dev",
      issuedAt: 1000,
      expiresAt: 1300,
      nonce: "edge-nonce",
    };
    const header = Buffer.from(
      JSON.stringify({ algorithm: "EdDSA", type: "KPE", version: 1 })
    ).toString("base64url");
    const signPayload = (payload: unknown) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
      const signingInput = `${header}.${encoded}`;
      const signature = sign(null, Buffer.from(signingInput), privateKey).toString("base64url");
      return `${signingInput}.${signature}`;
    };
    for (const malformed of [
      { ...edgeTicket, issuedAt: "1000" },
      { ...edgeTicket, expiresAt: 1300.5 },
      { ...edgeTicket, organizationId: 42 },
      { ...edgeTicket, unexpected: true },
    ]) {
      assert.throws(() =>
        verifyPreviewEdgeRouteTicket({
          token: signPayload(malformed),
          publicKey,
          now: 1030,
        })
      );
    }
  }
);

contractTest("packages.hermetic", "execution tickets reject tampering, expiration, and excessive lifetime", () => {
  const token = signEnvironmentExecutionTicket({ ticket, privateKey });
  assert.throws(() =>
    verifyEnvironmentExecutionTicket({
      token: `${token}x`,
      publicKey,
      now: 1100,
    }),
  );
  assert.throws(() =>
    verifyEnvironmentExecutionTicket({ token, publicKey, now: 1300 }),
  );
  assert.throws(() =>
    signEnvironmentExecutionTicket({
      ticket: { ...ticket, expiresAt: 1301 },
      privateKey,
    }),
  );
});

const toolCredential: EnvironmentToolCredentialTicket = {
  version: 1,
  audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  organizationId: "org-1",
  environmentId: "env-1",
  workspaceId: "workspace-1",
  threadId: "thread-1",
  runId: "run-1",
  actorId: "user-1",
  agentId: "kestrel-one",
  providerKey: "github",
  resourceId: "resource-1",
  capability: "repository.read",
  operation: "git.upload_pack",
  operationBinding: null,
  issuedAt: 1000,
  expiresAt: 1060,
  nonce: "tool-nonce-1",
};

contractTest("packages.hermetic", "tool credentials bind one provider resource capability and operation", () => {
  const token = signEnvironmentToolCredential({
    ticket: toolCredential,
    privateKey,
  });
  assert.deepEqual(
    verifyEnvironmentToolCredential({ token, publicKey, now: 1030 }),
    toolCredential,
  );
  assert.throws(() =>
    verifyEnvironmentExecutionTicket({ token, publicKey, now: 1030 }),
  );
});

contractTest("packages.hermetic", "tool credentials reject tampering expiration and lifetimes over one minute", () => {
  const token = signEnvironmentToolCredential({
    ticket: toolCredential,
    privateKey,
  });
  assert.throws(() =>
    verifyEnvironmentToolCredential({
      token: `${token}x`,
      publicKey,
      now: 1030,
    }),
  );
  assert.throws(() =>
    verifyEnvironmentToolCredential({ token, publicKey, now: 1060 }),
  );
  assert.throws(() =>
    signEnvironmentToolCredential({
      ticket: { ...toolCredential, expiresAt: 1061 },
      privateKey,
    }),
  );
});

contractTest("packages.hermetic", "Desktop credential envelopes are enrollment and run bound", () => {
  const recipient = generateDesktopCredentialEncryptionKeyPair();
  const context = desktopCredentialEnvelopeContext({
    organizationId: "org-1",
    environmentId: "environment-1",
    connectionId: "connection-1",
    runId: "run-1",
  });
  const envelope = encryptDesktopCredential({
    value: { apiKey: "secret", expiresAt: "2030-01-01T00:00:00.000Z" },
    recipientPublicKey: recipient.publicKey,
    context,
  });
  assert.deepEqual(
    decryptDesktopCredential({
      envelope,
      recipientPrivateKey: recipient.privateKey,
      context,
    }),
    { apiKey: "secret", expiresAt: "2030-01-01T00:00:00.000Z" },
  );
  assert.throws(() =>
    decryptDesktopCredential({
      envelope,
      recipientPrivateKey: recipient.privateKey,
      context: `${context}\nother-run`,
    }),
  );
  assert.doesNotMatch(JSON.stringify(envelope), /secret/u);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  encryptConnectorCommandSecrets,
  generateConnectorCredentialEncryptionKeyPair,
  serializeConnectorCommandSecrets,
} from "@lumi/kestrel-environment-auth";
import {
  INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
  INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
  InfrastructureConnectorCompatibilityError,
  negotiateInfrastructureConnectorV1,
  parseInfrastructureConnectorCommandV1,
  parseInfrastructureConnectorResultV1,
} from "./connector-contracts";

const encryption = generateConnectorCredentialEncryptionKeyPair();
const encryptedSecrets = serializeConnectorCommandSecrets(
  encryptConnectorCommandSecrets({
    value: { serviceToken: "secret" },
    recipientPublicKey: encryption.publicKey,
    commandId: "command-1",
  }),
);

const command = {
  contract: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
  id: "command-1",
  idempotencyKey: "operation-1:revision-1",
  connectionId: "connection-1",
  organizationId: "organization-1",
  environmentId: "environment-1",
  workspaceId: "workspace-1",
  desiredRevision: "revision-1",
  type: "ensure_workspace_compute",
  payload: {
    configurationRevision: "c".repeat(64),
    profile: { contract: "kubernetes-byoc-profile-v1" },
    scope: { provider: "kubernetes", role: "environment_scope", externalId: "namespace-1" },
    storage: { provider: "kubernetes", role: "workspace_storage", externalId: "pvc-1" },
    placement: { connectionId: "connection-1", requested: null, observed: null },
    desired: {
      runtimeImage: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
      ticketPublicKey: "x".repeat(32),
      controlPlaneUrl: "https://control.example.test",
      source: { type: "blank" },
      idleTimeoutMinutes: 15,
      serviceTokenHash: "h".repeat(43),
    },
  },
  encryptedSecrets,
} as const;

test("connector command v1 accepts the frozen strict envelope", () => {
  assert.deepEqual(parseInfrastructureConnectorCommandV1(command), command);
});

test("connector command v1 rejects unknown versions, types, keys, identities, and secret envelopes", () => {
  const invalid = [
    { ...command, contract: "infrastructure-connector-command-v2" },
    { ...command, type: "apply_arbitrary_manifest" },
    { ...command, extra: true },
    { ...command, id: "" },
    { ...command, workspaceId: undefined },
    { ...command, encryptedSecrets: "plaintext" },
  ];
  for (const value of invalid) {
    assert.throws(() => parseInfrastructureConnectorCommandV1(value));
  }
});

test("connector result v1 rejects a resource role not owned by the command", () => {
  assert.throws(() =>
    parseInfrastructureConnectorResultV1({
      contract: INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
      commandId: command.id,
      connectionId: command.connectionId,
      commandType: command.type,
      status: "succeeded",
      observedRevision: command.desiredRevision,
      resources: [
        {
          provider: "kubernetes",
          role: "workspace_storage",
          externalId: "namespace/pvc",
        },
      ],
      evidence: [{ level: "implementation" }],
    }),
  );
});

test("connector results cannot carry unapproved plaintext secret fields", () => {
  assert.throws(() =>
    parseInfrastructureConnectorResultV1({
      contract: INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
      commandId: command.id,
      connectionId: command.connectionId,
      commandType: command.type,
      status: "succeeded",
      observedRevision: command.desiredRevision,
      resources: [],
      evidence: [{ level: "implementation" }],
      output: { serviceToken: "plaintext" },
    }),
  );
});

test("connector presence negotiates only the exact v1 command/result pair", () => {
  assert.deepEqual(
    negotiateInfrastructureConnectorV1({
      connectionId: "connection-1",
      connectorVersion: "1.0.0",
      commandVersions: [
        "infrastructure-connector-command-v2",
        INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
      ],
      resultVersions: [
        INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
        "infrastructure-connector-result-v2",
      ],
    }),
    {
      commandVersion: INFRASTRUCTURE_CONNECTOR_COMMAND_VERSION,
      resultVersion: INFRASTRUCTURE_CONNECTOR_RESULT_VERSION,
      connectorVersion: "1.0.0",
    },
  );
  assert.throws(
    () =>
      negotiateInfrastructureConnectorV1({
        connectionId: "connection-1",
        connectorVersion: "1.0.0",
        commandVersions: ["infrastructure-connector-command-v2"],
        resultVersions: [INFRASTRUCTURE_CONNECTOR_RESULT_VERSION],
      }),
    InfrastructureConnectorCompatibilityError,
  );
});

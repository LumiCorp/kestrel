import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  encryptConnectorCommandSecrets,
  generateConnectorCredentialEncryptionKeyPair,
  serializeConnectorCommandSecrets,
} from "@lumi/kestrel-environment-auth";
import type { ConnectorConfig } from "../src/config.js";
import type { ConnectorCommand } from "../src/contracts.js";
import { ControlPlaneClient } from "../src/control-plane-client.js";
import type { ConnectorIdentityStore, ConnectorIdentity } from "../src/identity.js";
import { KubernetesClient } from "../src/kubernetes-client.js";
import { ConnectorRuntime } from "../src/runtime.js";

test("real connector loop preserves provider success across transient event and completion delivery failures", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "kestrel-kube-http-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const keyPath = path.join(temporary, "server.key");
  const certificatePath = path.join(temporary, "server.crt");
  const tokenPath = path.join(temporary, "token");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath,
    "-out", certificatePath,
    "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  await writeFile(tokenPath, "cluster-token\n", "utf8");

  const resources = new Map<string, Record<string, unknown>>();
  const kubernetesServer = https.createServer({
    key: await readFile(keyPath),
    cert: await readFile(certificatePath),
  }, async (request, response) => {
    assert.equal(request.headers.authorization, "Bearer cluster-token");
    const resourcePath = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
    if (request.method === "GET") {
      const value = resources.get(resourcePath);
      response.writeHead(value ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify(value ?? { kind: "Status", code: 404 }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (request.method === "PATCH") {
      const kind = body.kind;
      const stored = structuredClone(body);
      stored.metadata = {
        ...(stored.metadata as Record<string, unknown>),
        uid: `uid-${resources.size + 1}`,
        generation: 1,
      };
      if (kind === "Deployment") stored.status = { readyReplicas: 1 };
      if (kind === "HTTPRoute") {
        stored.status = {
          parents: [{
            conditions: [
              { type: "Accepted", status: "True" },
              { type: "ResolvedRefs", status: "True" },
            ],
          }],
        };
      }
      resources.set(resourcePath, stored);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(stored));
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve) => kubernetesServer.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) =>
    kubernetesServer.close((error) => error ? reject(error) : resolve()),
  ));
  const kubernetesAddress = kubernetesServer.address();
  assert.ok(kubernetesAddress && typeof kubernetesAddress === "object");

  const encryption = generateConnectorCredentialEncryptionKeyPair();
  const signing = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const connectionId = randomUUID();
  const commandId = "gateway-process-command";
  const command: ConnectorCommand = {
    contract: "infrastructure-connector-command-v1",
    id: commandId,
    idempotencyKey: "gateway-process-idempotency",
    connectionId,
    organizationId: "organization-1",
    environmentId: "environment-1",
    desiredRevision: "d".repeat(64),
    type: "ensure_environment_gateway",
    payload: {
      configurationRevision: "c".repeat(64),
      profile: profile(),
      scope: { provider: "kubernetes", role: "environment_scope", externalId: "kestrel-env-052abf5dd623" },
      placement: { connectionId, requested: null, observed: null },
      runtimeImage: `registry.example/router@sha256:${"a".repeat(64)}`,
      ticketPublicKey: "x".repeat(32),
      controlPlaneUrl: "https://control.example.test",
      serviceTokenHash: "h".repeat(43),
    },
    encryptedSecrets: serializeConnectorCommandSecrets(
      encryptConnectorCommandSecrets({
        value: { serviceToken: "gateway-secret" },
        recipientPublicKey: encryption.publicKey,
        commandId,
      }),
    ),
  };
  let runtime: ConnectorRuntime | undefined;
  let claimServed = false;
  let completion: Record<string, unknown> | undefined;
  let eventAttempts = 0;
  let completionAttempts = 0;
  const controlRequests: string[] = [];
  const controlPlaneServer = http.createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.match(request.headers.authorization ?? "", /^Bearer .+/u);
    assert.ok(request.headers["x-kestrel-signature"]);
    const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    controlRequests.push(requestPath);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length > 0
      ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
      : {};
    let value: unknown;
    if (requestPath.endsWith("/presence")) {
      value = {
        status: "active",
        negotiated: {
          commandVersion: "infrastructure-connector-command-v1",
          resultVersion: "infrastructure-connector-result-v1",
          connectorVersion: "0.8.0-test",
        },
      };
    } else if (requestPath.endsWith("/commands/claim")) {
      value = claimServed
        ? null
        : {
            command,
            claimToken: "claim-token".repeat(4),
            claimExpiresAt: new Date(Date.now() + 90_000).toISOString(),
            attempt: 1,
            eventCursor: 0,
          };
      claimServed = true;
    } else if (requestPath.endsWith("/qualification-probe")) {
      value = { passed: true };
    } else if (requestPath.endsWith(`/commands/${commandId}/events`)) {
      eventAttempts += 1;
      if (eventAttempts === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "temporary event outage" }));
        return;
      }
      value = { accepted: true };
    } else if (requestPath.endsWith(`/commands/${commandId}/complete`)) {
      completionAttempts += 1;
      if (completionAttempts === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "temporary completion outage" }));
        return;
      }
      completion = body;
      value = { accepted: true };
      runtime?.stop();
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected path" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => controlPlaneServer.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) =>
    controlPlaneServer.close((error) => error ? reject(error) : resolve()),
  ));
  const controlAddress = controlPlaneServer.address();
  assert.ok(controlAddress && typeof controlAddress === "object");

  const config = {
    kestrelBaseUrl: `http://127.0.0.1:${controlAddress.port}`,
    displayName: "Process connector",
    namespace: "kestrel-system",
    identitySecretName: "identity",
    leaderLeaseName: "enrollment",
    replicaId: "connector-0",
    connectorVersion: "0.8.0-test",
    image: `registry.example/connector@sha256:${"b".repeat(64)}`,
    port: 8080,
    serviceAccountTokenPath: tokenPath,
    serviceAccountCaPath: certificatePath,
    kubernetesHost: "127.0.0.1",
    kubernetesPort: kubernetesAddress.port,
  } as ConnectorConfig;
  const kubernetes = await KubernetesClient.inCluster(config);
  let identity: ConnectorIdentity = {
    version: 1,
    identityId: randomUUID(),
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    connectionId,
    organizationId: "organization-1",
    credential: "connector-credential".repeat(2),
  };
  const identityStore = {
    loadOrCreate: async () => identity,
    read: async () => identity,
    update: async (next: ConnectorIdentity) => {
      identity = next;
      return identity;
    },
    fingerprint: () => "f".repeat(64),
  } as unknown as ConnectorIdentityStore;
  runtime = new ConnectorRuntime(
    config,
    kubernetes,
    identityStore,
    new ControlPlaneClient(config),
  );
  await runtime.run();

  assert.ok(completion);
  const result = completion.result as Record<string, unknown>;
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(eventAttempts, 1);
  assert.equal(completionAttempts, 2);
  assert.equal((result.output as Record<string, unknown>).routerUrl, "https://052abf5dd623.byoc.example.test");
  assert.ok(controlRequests.some((requestPath) => requestPath.endsWith("/commands/claim")));
  assert.ok(controlRequests.some((requestPath) => requestPath.endsWith(`/commands/${commandId}/events`)));
  assert.ok(controlRequests.some((requestPath) => requestPath.endsWith("/qualification-probe")));
  assert.ok(controlRequests.some((requestPath) => requestPath.endsWith(`/commands/${commandId}/complete`)));
  assert.ok([...resources.values()].some((resource) => resource.kind === "Deployment"));
  assert.ok([...resources.values()].some((resource) => resource.kind === "HTTPRoute"));
});

function profile() {
  return {
    contract: "kubernetes-byoc-profile-v1",
    selectedCertificationProfile: "gke-gateway-v1",
    namespacePrefix: "kestrel",
    baseDomain: "byoc.example.test",
    storageClassName: "standard-rwo",
    volumeSnapshotClassName: "snapshots",
    controllerNamespace: "gateway-system",
    controllerPodSelector: { app: "gateway" },
    pullSecretRef: null,
    encryptionAttestations: {},
    edge: { mode: "gateway_api", parentNamespace: "gateway-system", parentName: "shared" },
    platform: {
      distribution: "gke",
      computeProfile: "standard",
      networkPolicyProvider: "gke_dataplane_v2",
      storageCsiDriver: "pd.csi.storage.gke.io",
      snapshotCsiDriver: "pd.csi.storage.gke.io",
      edgeController: "gke_gateway",
    },
  };
}

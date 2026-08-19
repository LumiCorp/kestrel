import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorConfig } from "../src/config.js";
import { ConnectorIdentityStore } from "../src/identity.js";
import { KubernetesApiError } from "../src/kubernetes-client.js";

const config = {
  namespace: "kestrel-system",
  identitySecretName: "identity",
  leaderLeaseName: "leader",
  replicaId: "replica-1",
} as ConnectorConfig;

test("two replicas converge on one create-if-absent identity", async () => {
  let secret: Record<string, unknown> | null = null;
  const client = {
    async get() { return secret; },
    async create(_: string, body: Record<string, unknown>) {
      await Promise.resolve();
      if (secret) throw new KubernetesApiError(409, "conflict", null);
      secret = { ...body, metadata: { ...(body.metadata as object), resourceVersion: "1" } };
      return secret;
    },
    async replace(_: string, body: Record<string, unknown>) {
      secret = { ...body, metadata: { ...(body.metadata as object), resourceVersion: "2" } };
      return secret;
    },
  };
  const first = new ConnectorIdentityStore(client as never, config);
  const second = new ConnectorIdentityStore(client as never, { ...config, replicaId: "replica-2" });
  const identities = await Promise.all([first.loadOrCreate(), second.loadOrCreate()]);
  assert.equal(identities[0].identityId, identities[1].identityId);
  assert.equal(first.fingerprint(identities[0]), second.fingerprint(identities[1]));
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  environmentProviderConnectionConfigurationSchema,
  environmentProviderResourceWriteSchema,
  infrastructureConnectorEventV1Schema,
} from "./provider-persistence-contracts";

const root = path.dirname(fileURLToPath(import.meta.url));

test("provider persistence accepts only versioned, provider-neutral JSON", () => {
  assert.equal(
    environmentProviderConnectionConfigurationSchema.parse({
      contract: "fly-connection-configuration-v1",
      organizationSlug: "customer-fly-org",
    }).contract,
    "fly-connection-configuration-v1",
  );
  assert.throws(() =>
    environmentProviderConnectionConfigurationSchema.parse({
      contract: "fly-connection-configuration-v1",
      organizationSlug: "customer-fly-org",
      apiToken: "must-not-persist",
    }),
  );
  assert.throws(() =>
    environmentProviderConnectionConfigurationSchema.parse({ contract: "v2" }),
  );
});

test("provider resources enforce role scope and bounded metadata", () => {
  const common = {
    organizationId: "organization-a",
    environmentId: "environment-a",
    providerConnectionId: "connection-a",
    provider: "kubernetes" as const,
    externalId: "resource-a",
    providerUid: null,
    desiredRevision: "revision-a",
    observedGeneration: null,
    state: "ready",
    providerMetadata: {
      contract: "provider-resource-metadata-v1" as const,
      source: "provider_observation" as const,
    },
  };
  assert.equal(
    environmentProviderResourceWriteSchema.parse({
      ...common,
      workspaceId: null,
      resourceRole: "environment_scope",
    }).resourceRole,
    "environment_scope",
  );
  assert.throws(() =>
    environmentProviderResourceWriteSchema.parse({
      ...common,
      workspaceId: null,
      resourceRole: "workspace_compute",
    }),
  );
  assert.throws(() =>
    environmentProviderResourceWriteSchema.parse({
      ...common,
      workspaceId: "workspace-a",
      resourceRole: "gateway",
    }),
  );
});

test("connector events are exact, contiguous sequence candidates", () => {
  const event = infrastructureConnectorEventV1Schema.parse({
    contract: "infrastructure-connector-event-v1",
    commandId: "command-a",
    sequence: 1,
    type: "progress",
    state: "applying",
  });
  assert.equal(event.sequence, 1);
  assert.throws(() =>
    infrastructureConnectorEventV1Schema.parse({ ...event, sequence: 0 }),
  );
  assert.throws(() =>
    infrastructureConnectorEventV1Schema.parse({
      ...event,
      bearerToken: "must-not-persist",
    }),
  );
});

test("shared lifecycle entry points resolve providers through the registry", () => {
  const processRuntime = fs.readFileSync(
    path.join(root, "process-runtime.ts"),
    "utf8",
  );
  const backups = fs.readFileSync(path.join(root, "backups.ts"), "utf8");
  const reconcile = fs.readFileSync(path.join(root, "reconcile.ts"), "utf8");
  assert.match(processRuntime, /resolveEnvironmentProvider/u);
  assert.match(backups, /resolveFlyProviderClient/u);
  assert.match(reconcile, /resolveFlyProviderClient/u);
  for (const source of [processRuntime, backups, reconcile]) {
    assert.doesNotMatch(source, /new FlyMachinesEnvironmentProvider/u);
    assert.doesNotMatch(
      source,
      /from "\.\/fly-connection"/u,
      "lifecycle entry points must not bypass the provider registry",
    );
  }
});

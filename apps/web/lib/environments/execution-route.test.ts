import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { verifyEnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import {
  createHostedEnvironmentRoute,
  describeEnvironmentActivation,
} from "./execution-route";


test("Environment activation reports the user-visible wake sequence", () => {
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "provisioning",
      workspaceStatus: "requested",
    }),
    {
      stage: "environment.runtime.connecting",
      detail: "Provisioning the Environment runtime…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "stopped",
    }),
    {
      stage: "environment.machine.starting",
      detail: "Waking the Workspace Machine…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "stopping",
    }),
    {
      stage: "environment.machine.starting",
      detail: "Finishing the Workspace sleep transition…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "provisioning",
    }),
    {
      stage: "environment.workspace.mounting",
      detail: "Mounting the persistent Workspace…",
      status: "pending",
    }
  );
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "ready",
    }),
    {
      stage: "environment.activation.ready",
      detail: "Environment ready.",
      status: "ready",
    }
  );
});

test("Environment activation surfaces the stored failure without leaking a false ready state", () => {
  assert.deepEqual(
    describeEnvironmentActivation({
      environmentStatus: "ready",
      workspaceStatus: "failed",
      failureMessage: "Workspace health check failed.",
    }),
    {
      stage: "environment.activation.failed",
      detail: "Workspace health check failed.",
      status: "failed",
    }
  );
});

test("logical hosted utility routes use gateway authority without Fly identities", async (context) => {
  const keys = generateKeyPairSync("ed25519");
  const previousPrivateKey = process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY;
  process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = keys.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  context.after(() => {
    if (previousPrivateKey === undefined) {
      Reflect.deleteProperty(process.env, "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY");
    } else {
      process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY = previousPrivateKey;
    }
  });

  const route = await createHostedEnvironmentRoute(
    {
      organizationId: "organization-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      actorId: "actor-1",
      agentId: "kestrel-project-skills",
      capabilities: ["workspace.skills.read"],
    },
    {
      routingMode: "logical-v1",
      resolveAuthority: async () => ({
        gateway: { id: "gateway-resource-1" },
        routerUrl: "https://router.example.test",
      }),
    },
  );
  const ticket = verifyEnvironmentExecutionTicket({
    token: route.authToken,
    publicKey: keys.publicKey
      .export({ type: "spki", format: "pem" })
      .toString(),
  });
  assert.equal(route.baseUrl, "https://router.example.test");
  assert.equal(ticket.version, 3);
  assert.deepEqual(ticket.target, {
    kind: "gateway",
    gatewayId: "gateway-resource-1",
  });
  assert.equal("flyAppName" in ticket, false);
  assert.equal("flyMachineId" in ticket, false);
});

test("secondary hosted issuers use the shared logical routing authority", () => {
  for (const file of [
    new URL("../projects/skills.ts", import.meta.url),
    new URL(
      "../../app/api/organization/runs/[runId]/reasoning/route.ts",
      import.meta.url,
    ),
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /createHostedEnvironmentRoute/u);
    assert.doesNotMatch(source, /createEnvironmentMachineRoute/u);
  }
});

import { createFlyProviderClient } from "./fly-connection";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { eq } from "drizzle-orm";
import {
  databaseEnvironmentProvisioningRepository,
  EnvironmentProvisioner,
} from "./provisioner";
import { withEnvironmentOperationLock } from "./reconcile-lock";

export async function processEnvironmentOperation(operationId: string) {
  const operation = await knowledgeDb.query.environmentOperations.findFirst({
    where: eq(schema.environmentOperations.id, operationId),
    columns: { organizationId: true },
  });
  if (!operation) throw new Error("Environment operation was not found.");
  const locked = await withEnvironmentOperationLock({
    operationId,
    run: async () => {
      const provisioner = new EnvironmentProvisioner({
        repository: databaseEnvironmentProvisioningRepository,
        provider: await createFlyProviderClient(operation.organizationId),
        runtimeImage: process.env.KESTREL_WORKSPACE_RUNTIME_IMAGE?.trim() ?? "",
        routerImage: process.env.KESTREL_ENVIRONMENT_ROUTER_IMAGE?.trim() ?? "",
        ticketPublicKey:
          process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
        controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
        credentialBrokerToken:
          process.env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN ?? "",
      });
      const result = await provisioner.process(operationId);
      if (result === "deferred") {
        throw new Error("Environment operation is waiting for a prerequisite.");
      }
      return result;
    },
  });
  return locked.acquired ? locked.result : "not_claimed";
}

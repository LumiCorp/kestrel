import { FlyMachinesClient } from "./providers/fly-machines";
import {
  databaseEnvironmentProvisioningRepository,
  EnvironmentProvisioner,
} from "./provisioner";

export async function processEnvironmentOperation(operationId: string) {
  const provisioner = new EnvironmentProvisioner({
    repository: databaseEnvironmentProvisioningRepository,
    provider: new FlyMachinesClient({
      token: process.env.FLY_API_TOKEN ?? "",
      organizationSlug: process.env.KESTREL_FLY_ORGANIZATION_SLUG ?? "",
    }),
    runtimeImage: process.env.KESTREL_WORKSPACE_RUNTIME_IMAGE ?? "",
    ticketPublicKey: process.env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? "",
    controlPlaneUrl: process.env.KESTREL_ONE_APP_URL ?? "",
    credentialBrokerToken:
      process.env.KESTREL_ONE_CREDENTIAL_BROKER_TOKEN ?? "",
  });
  const result = await provisioner.process(operationId);
  if (result === "deferred") {
    throw new Error("Environment operation is waiting for a prerequisite.");
  }
  return result;
}

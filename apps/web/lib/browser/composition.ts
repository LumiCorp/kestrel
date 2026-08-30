import "server-only";

import { and, eq } from "drizzle-orm";
import type { EnvironmentExecutionTicket } from "@lumi/kestrel-environment-auth";
import { requireImmutableHostedBrowserWorkerImage } from "../../../../src/browser/runtimeReleaseManifest.js";
import { createFlyProviderClient } from "@/lib/environments/fly-connection";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { HostedBrowserPolicy } from "./policy";
import { HostedBrowserService } from "./service";
import { HostedBrowserStore } from "./store";
import { createHostedBrowserArtifactAuthority } from "./artifact-composition";

export async function resolveHostedBrowserService(input: {
  ticket: EnvironmentExecutionTicket;
  projectId: string;
}): Promise<HostedBrowserService> {
  return resolveHostedBrowserServiceForAuthority({
    organizationId: input.ticket.organizationId,
    environmentId: input.ticket.environmentId,
    userId: input.ticket.actorId,
  });
}

export async function resolveHostedBrowserServiceForAuthority(input: {
  organizationId: string;
  environmentId: string;
  userId: string;
}): Promise<HostedBrowserService> {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: and(
      eq(schema.environments.id, input.environmentId),
      eq(schema.environments.organizationId, input.organizationId),
    ),
    columns: {
      provider: true,
      status: true,
      region: true,
      flyAppName: true,
    },
  });
  if (
    !environment ||
    environment.provider !== "fly" ||
    environment.status !== "ready" ||
    !environment.flyAppName
  ) {
    throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }
  const privateKey = required("KESTREL_BROWSER_CAPABILITY_PRIVATE_KEY");
  const runtimeImageDigest = requireImmutableHostedBrowserWorkerImage(
    required("KESTREL_BROWSER_WORKER_IMAGE"),
  );
  const store = new HostedBrowserStore();
  const artifacts = createHostedBrowserArtifactAuthority(privateKey);
  return new HostedBrowserService({
    store,
    policy: new HostedBrowserPolicy(store),
    machines: await createFlyProviderClient(input.organizationId),
    artifacts,
    metrics: {
      emit(name, metadata) {
        console.info("Hosted Browser metric", { name, ...metadata });
      },
    },
    capabilityPrivateKeyPem: privateKey,
    requestAuthority: {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      userId: input.userId,
    },
    appName: environment.flyAppName,
    region: environment.region,
    runtimeImageDigest,
  });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  return value;
}

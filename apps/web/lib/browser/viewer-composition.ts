import "server-only";

import { createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getThreadAccessForUser } from "@/lib/threads/store";
import { HostedBrowserPolicy } from "./policy";
import { resolveHostedBrowserServiceForAuthority } from "./composition";
import { HostedBrowserStore } from "./store";
import { HostedBrowserViewerService } from "./viewer-service";
import { RedisHostedBrowserViewerTicketStore } from "./viewer-transient-store";
import { HostedBrowserViewerWorkerClient } from "./viewer-worker-client";

export async function resolveHostedBrowserViewerService(input: {
  organizationId: string;
  actorId: string;
  threadId: string;
}) {
  const store = new HostedBrowserStore();
  const active = await store.readActiveForThread(input.threadId);
  if (!active?.resource) throw new Error("BROWSER_SESSION_LOST");
  const origin = await store.resolveCurrentOrigin(active.session.sessionId);
  if (
    origin.organizationId !== input.organizationId ||
    origin.userId !== input.actorId ||
    origin.threadId !== input.threadId
  ) throw new Error("BROWSER_SESSION_LOST");
  const environment = await knowledgeDb.query.environments.findFirst({
    where: and(
      eq(schema.environments.id, origin.environmentId),
      eq(schema.environments.organizationId, origin.organizationId),
    ),
    columns: { provider: true, status: true, flyAppName: true, routerUrl: true },
  });
  if (
    !environment ||
    environment.provider !== "fly" ||
    environment.status !== "ready" ||
    !environment.flyAppName ||
    !environment.routerUrl
  ) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  const privateKeyPem = required("KESTREL_BROWSER_CAPABILITY_PRIVATE_KEY");
  const viewerPublicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const lifecycle = await resolveHostedBrowserServiceForAuthority({
    organizationId: origin.organizationId,
    environmentId: origin.environmentId,
    userId: origin.userId,
  });
  const policy = new HostedBrowserPolicy(store);
  return new HostedBrowserViewerService({
    store,
    lifecycle,
    tickets: new RedisHostedBrowserViewerTicketStore(),
    worker: new HostedBrowserViewerWorkerClient({
      environmentPrivateKeyPem: required("KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY"),
      viewerPublicKeyPem,
    }),
    privateKeyPem,
    publicKeyPem: viewerPublicKeyPem,
    appName: environment.flyAppName,
    routerUrl: environment.routerUrl,
    access: {
      async authorize(authority) {
        const access = await getThreadAccessForUser(
          authority.threadId,
          authority.actorId,
          authority.organizationId,
        );
        if (
          !access ||
          access.thread.projectId !== authority.origin.projectId ||
          authority.origin.userId !== authority.actorId
        ) return false;
        const current = await policy.resolve({
          origin: authority.origin,
          operation: "browser.snapshot",
          effectiveInput: {
            sessionId: authority.session.sessionId,
            generation: authority.session.generation,
          },
        });
        return current.resolution.decision === "allow" &&
          current.authority.environmentId === authority.origin.environmentId &&
          current.authority.projectId === authority.origin.projectId &&
          current.authority.userId === authority.origin.userId &&
          current.authority.effectiveAllowlistRevision ===
            authority.session.effectiveAllowlistRevision;
      },
    },
    evidence: {
      emit(name, metadata) {
        // Metadata only. Never include tickets, frames, input, URLs, or page data.
        console.info("Hosted Browser viewer metric", { name, ...metadata });
      },
    },
  });
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  return value;
}

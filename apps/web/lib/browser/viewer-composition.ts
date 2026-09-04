import "server-only";

import { createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getThreadAccessForUser } from "@/lib/threads/store";
import { HostedBrowserPolicy } from "./policy";
import { resolveHostedBrowserServiceForAuthority } from "./composition";
import { HostedBrowserStore } from "./store";
import { HostedBrowserViewerService } from "./viewer-service";
import {
  resolveHostedBrowserViewerPolicyAccess,
  resolveHostedBrowserViewerRequester,
} from "./viewer-composition-access";
import {
  composeHostedBrowserViewerLifecycle,
  createCleanupSafeHostedBrowserViewerLifecycle,
} from "./viewer-lifecycle";
import { RedisHostedBrowserViewerTicketStore } from "./viewer-transient-store";
import {
  HostedBrowserViewerWorkerClient,
  type HostedBrowserViewerWorkerPort,
} from "./viewer-worker-client";

export async function resolveHostedBrowserViewerService(input: {
  organizationId: string;
  actorId: string;
  threadId: string;
}) {
  const store = new HostedBrowserStore();
  const tickets = new RedisHostedBrowserViewerTicketStore();
  const pending = await tickets.readCleanupPending(input.threadId);
  const active = await store.readActiveForThread(input.threadId) ??
    (pending ? await store.read(pending.scope.sessionId) : null);
  if (!active?.resource) throw new Error("BROWSER_SESSION_LOST");
  const origin = await store.resolveCurrentOrigin(active.session.sessionId);
  const requestAccess = await getThreadAccessForUser(
    input.threadId,
    input.actorId,
    input.organizationId,
  );
  const pendingMatchesOrigin = Boolean(
    pending?.scope.organizationId === origin.organizationId &&
    pending.scope.environmentId === origin.environmentId &&
    pending.scope.projectId === origin.projectId &&
    pending.scope.threadId === origin.threadId &&
    pending.scope.runId === origin.runId &&
    pending.scope.actorId === origin.userId &&
    pending.scope.sessionId === active.session.sessionId &&
    pending.scope.generation === active.session.generation &&
    pending.scope.machineId === active.resource.machineId,
  );
  const requester = resolveHostedBrowserViewerRequester({
    organizationId: input.organizationId,
    actorId: input.actorId,
    threadId: input.threadId,
    origin,
    accessibleProjectId: requestAccess?.thread.projectId ?? undefined,
  });
  const { requestMatchesOriginActor, cleanupBypass } = requester;
  const environment = await knowledgeDb.query.environments.findFirst({
    where: and(
      eq(schema.environments.id, origin.environmentId),
      eq(schema.environments.organizationId, origin.organizationId),
    ),
    columns: { provider: true, status: true, flyAppName: true, routerUrl: true },
  });
  const workerRouteUsable = Boolean(
    environment?.provider === "fly" &&
    environment.flyAppName &&
    environment.routerUrl,
  );
  const environmentReady = workerRouteUsable && environment?.status === "ready";
  const pendingMatchesEnvironment = pendingMatchesOrigin &&
    pending?.scope.appName === environment?.flyAppName;
  const workerCleanupUsable = workerRouteUsable &&
    (requestMatchesOriginActor || !pending || pendingMatchesEnvironment);
  if (!(environmentReady || cleanupBypass)) {
    throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  }
  const requestAuthorized = environmentReady &&
    requestAccess?.thread.projectId === origin.projectId &&
    origin.userId === input.actorId;
  if (!(requestAuthorized || cleanupBypass)) {
    throw new Error("BROWSER_SESSION_LOST");
  }
  const privateKeyPem = required("KESTREL_BROWSER_CAPABILITY_PRIVATE_KEY");
  const viewerPublicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const lifecycle = await composeHostedBrowserViewerLifecycle({
    environmentReady: requestAuthorized,
    createReady: () => resolveHostedBrowserServiceForAuthority({
      organizationId: origin.organizationId,
      environmentId: origin.environmentId,
      userId: origin.userId,
    }),
    createCleanupSafe: () => createCleanupSafeHostedBrowserViewerLifecycle({
      store,
      authority: {
        organizationId: origin.organizationId,
        environmentId: origin.environmentId,
        userId: origin.userId,
      },
    }),
  });
  const policy = new HostedBrowserPolicy(store);
  const appName = workerRouteUsable
    ? environment!.flyAppName!
    : pending?.scope.appName ?? "browser-unavailable";
  const routerUrl = workerRouteUsable
    ? environment!.routerUrl!
    : "https://browser-viewer-unavailable.invalid";
  return new HostedBrowserViewerService({
    store,
    lifecycle,
    tickets,
    worker: workerCleanupUsable
      ? new HostedBrowserViewerWorkerClient({
          environmentPrivateKeyPem: required("KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY"),
          viewerPublicKeyPem,
          viewerPrivateKeyPem: privateKeyPem,
        })
      : unavailableViewerWorker(),
    privateKeyPem,
    publicKeyPem: viewerPublicKeyPem,
    appName,
    routerUrl,
    requestAuthorized,
    access: {
      async authorize(authority) {
        const currentEnvironment = await knowledgeDb.query.environments.findFirst({
          where: and(
            eq(schema.environments.id, authority.origin.environmentId),
            eq(schema.environments.organizationId, authority.organizationId),
          ),
          columns: { status: true, provider: true, flyAppName: true, routerUrl: true },
        });
        if (
          currentEnvironment?.status !== "ready" ||
          currentEnvironment.provider !== "fly" ||
          currentEnvironment.flyAppName !== appName ||
          currentEnvironment.routerUrl !== routerUrl
        ) return false;
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
        return resolveHostedBrowserViewerPolicyAccess({
          origin: authority.origin,
          session: authority.session,
          current: { ...current.authority, decision: current.resolution.decision },
        });
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

function unavailableViewerWorker(): HostedBrowserViewerWorkerPort {
  return {
    async invoke() { throw new Error("BROWSER_SERVICE_UNAVAILABLE"); },
    async cleanup() { throw new Error("BROWSER_SERVICE_UNAVAILABLE"); },
  };
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("BROWSER_SERVICE_UNAVAILABLE");
  return value;
}

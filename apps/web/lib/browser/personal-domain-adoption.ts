import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
  ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
  signEnvironmentToolCredential,
} from "@lumi/kestrel-environment-auth";
import { and, eq } from "drizzle-orm";
import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import { createFlyProviderClient } from "@/lib/environments/fly-connection";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { resolveHostedBrowserServiceForAuthority } from "./composition";
import { adoptHostedBrowserPersonalDomainRevisionWithDependencies } from "./personal-domain-adoption-core";
import { HostedBrowserStore, type HostedBrowserResourceRecord } from "./store";

const INSTALL_TIMEOUT_MS = 12_000;
const TERMINAL_STATES = new Set(["closed", "expired", "lost", "failed"]);

export async function adoptHostedBrowserPersonalDomainRevision(input: {
  organizationId: string;
  environmentId: string;
  userId: string;
  personalRevision: number;
}): Promise<{
  personalRevision: number;
  adoptedSessions: readonly {
    sessionId: string;
    effectiveRevision: string;
    closedUnauthorizedConnections: number;
  }[];
}> {
  const environment = await knowledgeDb.query.environments.findFirst({
    where: and(
      eq(schema.environments.id, input.environmentId),
      eq(schema.environments.organizationId, input.organizationId),
    ),
    columns: { routerUrl: true, flyAppName: true },
  });
  if (!environment?.routerUrl || !environment.flyAppName) {
    throw new Error("BROWSER_ALLOWLIST_ADOPTION_UNAVAILABLE");
  }
  const routerUrl = environment.routerUrl;
  const appName = environment.flyAppName;
  const store = new HostedBrowserStore();
  const machines = await createFlyProviderClient(input.organizationId);
  const records = await store.listForPersonalAuthority(input);
  return adoptHostedBrowserPersonalDomainRevisionWithDependencies(input, {
    records,
    resolveOrigin: (sessionId) => store.resolveCurrentOrigin(sessionId),
    resolveService: () => resolveHostedBrowserServiceForAuthority(input),
    install: (installInput) =>
      installRevision({
        routerUrl,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        userId: input.userId,
        ...installInput,
      }),
    destroy: (record) =>
      destroyExactSession({
        store,
        machines,
        appName,
        record,
      }),
  });
}

async function installRevision(input: {
  routerUrl: string;
  organizationId: string;
  environmentId: string;
  userId: string;
  threadId: string;
  runId: string;
  instruction: {
    version: "hosted_browser_revision_instruction_v1";
    sessionId: string;
    generation: number;
    revision: string;
    cause: "personal_grant" | "personal_revocation";
    authority: unknown;
    capability: string;
    machine: { appName: string; machineId: string };
  };
}) {
  const envelope = {
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    userId: input.userId,
    threadId: input.threadId,
    runId: input.runId,
    instruction: input.instruction,
  };
  const body = JSON.stringify(envelope);
  const issuedAt = Math.floor(Date.now() / 1000);
  const token = signEnvironmentToolCredential({
    privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
    ticket: {
      version: ENVIRONMENT_TOOL_CREDENTIAL_VERSION,
      audience: ENVIRONMENT_TOOL_CREDENTIAL_AUDIENCE,
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workspaceId: `browser:${input.instruction.sessionId}`,
      threadId: input.threadId,
      runId: input.runId,
      actorId: input.userId,
      agentId: "kestrel-control-plane",
      providerKey: "built_in.browser",
      resourceId: input.instruction.sessionId,
      capability: "browser.allowlist.adopt",
      operation: "revision.install",
      operationBinding: `sha256:${createHash("sha256").update(body).digest("base64url")}`,
      issuedAt,
      expiresAt: issuedAt + 60,
      nonce: randomUUID(),
    },
  });
  const response = await fetch(
    new URL("/internal/browser/revision", input.routerUrl),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error("BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED");
  const adopted = (await response.json()) as Record<string, unknown>;
  if (
    adopted.revision !== input.instruction.revision ||
    !Number.isSafeInteger(adopted.closedUnauthorizedConnections) ||
    Number(adopted.closedUnauthorizedConnections) < 0
  )
    throw new Error("BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED");
  return {
    revision: adopted.revision,
    closedUnauthorizedConnections:
      adopted.closedUnauthorizedConnections as number,
  };
}

async function destroyExactSession(input: {
  store: HostedBrowserStore;
  machines: Awaited<ReturnType<typeof createFlyProviderClient>>;
  appName: string;
  record: { session: BrowserSessionV1; resource: HostedBrowserResourceRecord };
}) {
  if (!TERMINAL_STATES.has(input.record.session.state)) {
    await input.store.markTerminal({
      sessionId: input.record.session.sessionId,
      expectedGeneration: input.record.session.generation,
      state: "failed",
      reason: "BROWSER_DESTINATION_BLOCKED",
      now: new Date(),
    });
  }
  const machine = await input.machines.getMachine({
    appName: input.appName,
    machineId: input.record.resource.machineId,
  });
  if (machine) {
    await input.machines.deleteMachine({
      appName: input.appName,
      machineId: input.record.resource.machineId,
    });
    await input.machines.waitForMachine({
      appName: input.appName,
      machineId: input.record.resource.machineId,
      state: "destroyed",
      timeoutSeconds: 30,
    });
    if (
      await input.machines.getMachine({
        appName: input.appName,
        machineId: input.record.resource.machineId,
      })
    )
      throw new Error("BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED");
  }
  await input.store.confirmCleanup(input.record.session.sessionId);
}

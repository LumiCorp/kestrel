import { BROWSER_ALLOWLIST_ADOPTION_VERSION } from "../../../../src/browser/contracts.js";
import type { BrowserSessionV1 } from "../../../../src/browser/contracts.js";
import type { HostedBrowserService } from "./service";
import type { HostedBrowserResourceRecord } from "./store";
import type { HostedBrowserRevisionInstructionV1 } from "./worker-contract";

const TERMINAL_STATES = new Set(["closed", "expired", "lost", "failed"]);

export async function adoptHostedBrowserPersonalDomainRevisionWithDependencies(
  input: {
    organizationId: string;
    environmentId: string;
    userId: string;
    personalRevision: number;
  },
  dependencies: {
    records: readonly {
      session: BrowserSessionV1;
      resource: HostedBrowserResourceRecord;
    }[];
    resolveOrigin(sessionId: string): Promise<{
      organizationId: string;
      environmentId: string;
      projectId: string;
      threadId: string;
      runId: string;
      userId: string;
    }>;
    resolveService(): Promise<
      Pick<
        HostedBrowserService,
        | "resolvePolicy"
        | "prepareAllowlistAdoption"
        | "completeAllowlistAdoption"
      >
    >;
    install(input: {
      threadId: string;
      runId: string;
      instruction: HostedBrowserRevisionInstructionV1;
    }): Promise<{ revision: string; closedUnauthorizedConnections: number }>;
    destroy(record: {
      session: BrowserSessionV1;
      resource: HostedBrowserResourceRecord;
    }): Promise<void>;
  },
) {
  const adoptedSessions: Array<{
    sessionId: string;
    effectiveRevision: string;
    closedUnauthorizedConnections: number;
  }> = [];

  for (const record of dependencies.records) {
    if (
      TERMINAL_STATES.has(record.session.state) ||
      record.session.state === "closing"
    ) {
      await dependencies.destroy(record);
      continue;
    }
    try {
      const origin = await dependencies.resolveOrigin(record.session.sessionId);
      if (
        origin.organizationId !== input.organizationId ||
        origin.environmentId !== input.environmentId ||
        origin.userId !== input.userId
      ) {
        throw new Error("BROWSER_SESSION_LOST");
      }
      const service = await dependencies.resolveService();
      const policy = await service.resolvePolicy({
        version: "browser_policy_resolution_v1",
        runId: origin.runId,
        threadId: origin.threadId,
        operation: "browser.snapshot",
        effectiveInput: {
          sessionId: record.session.sessionId,
          generation: record.session.generation,
        },
        authority: { threadId: origin.threadId, projectId: origin.projectId },
      });
      const request = {
        version: BROWSER_ALLOWLIST_ADOPTION_VERSION,
        runId: origin.runId,
        threadId: origin.threadId,
        sessionId: record.session.sessionId,
        effectiveAllowlistRevision: policy.policyRevision,
        cause: "personal_revocation" as const,
      };
      const instruction = await service.prepareAllowlistAdoption(request);
      const adopted = await dependencies.install({
        threadId: origin.threadId,
        runId: origin.runId,
        instruction,
      });
      const receipt = await service.completeAllowlistAdoption(request, adopted);
      adoptedSessions.push({
        sessionId: receipt.sessionId,
        effectiveRevision: receipt.effectiveAllowlistRevision,
        closedUnauthorizedConnections: receipt.closedUnauthorizedConnections,
      });
    } catch (error) {
      await dependencies.destroy(record);
      throw error;
    }
  }
  return { personalRevision: input.personalRevision, adoptedSessions };
}

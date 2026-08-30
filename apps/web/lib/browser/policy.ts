import {
  BROWSER_POLICY_RESOLUTION_VERSION,
  type BrowserMode,
  type BrowserPolicyResolutionV1,
} from "../../../../src/browser/contracts.js";
import {
  BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
  BROWSER_QA_TARGET_VERSION,
  canonicalizePublicBrowserDestination,
  resolveBrowserPublicGrantDecision,
  resolveEffectiveBrowserDomainAuthority,
  type BrowserQaDomainAuthorityV1,
} from "../../../../src/browser/domainAuthority.js";
import {
  hostedBrowserAgentId,
  readHostedBrowserDomainAuthorityInput,
} from "@/lib/apps/browser-domain-service";
import { resolveActiveHostedPreviewSelector } from "@/lib/apps/preview-lifecycle";
import type {
  HostedBrowserPolicyPort,
  HostedBrowserSessionStorePort,
} from "./service";
import type { HostedBrowserOriginAuthority } from "./store";

export class HostedBrowserPolicy implements HostedBrowserPolicyPort {
  constructor(private readonly store: HostedBrowserSessionStorePort) {}

  async resolve(input: {
    origin: HostedBrowserOriginAuthority;
    effectiveInput: Record<string, unknown>;
    operation: string;
  }) {
    const context = await this.#resolveContext(input);
    const authority = resolveEffectiveBrowserDomainAuthority(
      await readHostedBrowserDomainAuthorityInput({
        organizationId: input.origin.organizationId,
        environmentId: input.origin.environmentId,
        projectId: input.origin.projectId,
        userId: input.origin.userId,
        agentId: hostedBrowserAgentId(),
        qa: context.qa,
      }),
    );
    let decision: BrowserPolicyResolutionV1["decision"] = "allow";
    if (!authority.enabledModes.includes(context.mode)) {
      decision = "deny";
    } else if (input.operation === "browser.request_grant") {
      const destination = readString(input.effectiveInput.destination);
      if (!destination) decision = "deny";
      else {
        const grant = resolveBrowserPublicGrantDecision(
          await readHostedBrowserDomainAuthorityInput({
            organizationId: input.origin.organizationId,
            environmentId: input.origin.environmentId,
            projectId: input.origin.projectId,
            userId: input.origin.userId,
            agentId: hostedBrowserAgentId(),
            qa: context.qa,
          }),
          destination,
          context.mode,
        );
        decision =
          grant.decision === "already_allowed"
            ? "allow"
            : grant.decision === "approval_required"
              ? "approval_required"
              : "deny";
      }
    } else {
      const destination = operationDestination(input.effectiveInput);
      if (destination && !isDestinationAllowed(authority, destination)) {
        decision = "deny";
      }
    }
    return {
      authority,
      resolution: {
        version: BROWSER_POLICY_RESOLUTION_VERSION,
        decision,
        policyRevision: authority.effectiveAllowlistRevision,
        sessionMode: context.mode,
      },
    };
  }

  async #resolveContext(input: {
    origin: HostedBrowserOriginAuthority;
    effectiveInput: Record<string, unknown>;
    operation: string;
  }): Promise<{ mode: BrowserMode; qa: BrowserQaDomainAuthorityV1 }> {
    const requestedMode = input.effectiveInput.mode;
    if (input.operation === "browser.open") {
      if (requestedMode === "operator") return { mode: "operator", qa: emptyQa() };
      if (requestedMode !== "qa") throw new Error("BROWSER_DESTINATION_BLOCKED");
      const previewId = readPreviewId(input.effectiveInput);
      if (!previewId) throw new Error("BROWSER_DESTINATION_BLOCKED");
      const preview = await resolveActiveHostedPreviewSelector({
        previewId,
        organizationId: input.origin.organizationId,
        environmentId: input.origin.environmentId,
        projectId: input.origin.projectId,
      });
      return {
        mode: "qa",
        qa: {
          version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
          revision: `preview:${preview.previewId}:${preview.hostname}`,
          target: {
            version: BROWSER_QA_TARGET_VERSION,
            scheme: "https",
            hostname: preview.hostname,
            port: 443,
          },
        },
      };
    }
    const sessionId = readString(input.effectiveInput.sessionId);
    if (!sessionId) throw new Error("BROWSER_SESSION_LOST");
    const record = await this.store.read(sessionId);
    if (!record) throw new Error("BROWSER_SESSION_LOST");
    if (record.session.mode === "operator") {
      return { mode: "operator", qa: emptyQa() };
    }
    if (!record.resource?.previewLeaseId) throw new Error("BROWSER_SESSION_LOST");
    const preview = await resolveActiveHostedPreviewSelector({
      previewId: record.resource.previewLeaseId,
      organizationId: input.origin.organizationId,
      environmentId: input.origin.environmentId,
      projectId: input.origin.projectId,
    });
    return {
      mode: "qa",
      qa: {
        version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
        revision: `preview:${preview.previewId}:${preview.hostname}`,
        target: {
          version: BROWSER_QA_TARGET_VERSION,
          scheme: "https",
          hostname: preview.hostname,
          port: 443,
        },
      },
    };
  }
}

function emptyQa(): BrowserQaDomainAuthorityV1 {
  return { version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION, revision: "none", target: null };
}

function operationDestination(input: Record<string, unknown>): string | undefined {
  if (input.kind === "url") return readString(input.url);
  const target = input.target;
  if (target && typeof target === "object" && !Array.isArray(target)) {
    const record = target as Record<string, unknown>;
    if (record.kind === "public_url") return readString(record.url);
  }
  return;
}

function isDestinationAllowed(
  authority: ReturnType<typeof resolveEffectiveBrowserDomainAuthority>,
  destination: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(destination);
  } catch {
    return false;
  }
  const qa = authority.qaTarget;
  if (
    qa &&
    parsed.protocol === `${qa.scheme}:` &&
    parsed.hostname.toLowerCase().replace(/\.$/u, "") === qa.hostname &&
    Number(parsed.port || (parsed.protocol === "https:" ? "443" : "80")) ===
      qa.port
  ) {
    return true;
  }
  const canonical = canonicalizePublicBrowserDestination(destination);
  return authority.publicDomains.some(
    (domain) => domain.canonicalDomain === canonical.canonicalDomain,
  );
}

function readPreviewId(input: Record<string, unknown>): string | undefined {
  const target = input.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) return;
  const record = target as Record<string, unknown>;
  return record.kind === "kestrel_edge_preview"
    ? readString(record.previewId)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

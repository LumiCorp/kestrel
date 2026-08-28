import "server-only";
import { hashCanonical } from "../../../../src/kestrel/contracts/tool-contract.js";
import {
  parseModelRegistrationV2,
  type ModelRegistrationV2,
} from "../../../../src/kestrel/contracts/model-registration.js";

/**
 * Gmail's restricted OAuth scope is a route-admission concern, not a model
 * name allowlist. A caller must supply retained, route-specific evidence for
 * the primary execution route and every fallback that could receive mailbox
 * content. Missing evidence is intentionally indistinguishable from an
 * ineligible route at this boundary.
 */
export const GMAIL_RESTRICTED_DATA_POLICY_VERSION =
  "gmail_restricted_data_v1" as const;
export const GMAIL_RESTRICTED_DATA_EVIDENCE_KEY =
  "kestrelGmailRestrictedDataEvidenceV1" as const;

export type GmailRestrictedDataRouteEvidence = {
  version: typeof GMAIL_RESTRICTED_DATA_POLICY_VERSION;
  routeFingerprint: string;
  processorId: string;
  purpose: "user_authorized_productivity";
  retention: "documented";
  trainingUse: "prohibited";
  deletion: "documented";
  qualification: "qualified";
  evidenceRevision: string;
  observedAt: string;
};

export type GmailRestrictedDataAdmission =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "GMAIL_RESTRICTED_DATA_PROJECT_DENIED"
        | "GMAIL_RESTRICTED_DATA_SCOPE_DENIED"
        | "GMAIL_RESTRICTED_DATA_ROUTE_UNQUALIFIED";
    };

/** Exact route binding used by persisted restricted-data evidence. */
export function gmailRestrictedDataRouteFingerprint(
  registration: ModelRegistrationV2,
) {
  const parsed = parseModelRegistrationV2(registration);
  return hashCanonical({
    registrationId: parsed.registrationId,
    revision: parsed.revision,
    fingerprint: parsed.fingerprint,
    credentialRevision: parsed.credentialRevision,
    route: parsed.route,
  });
}

/** Server-only authoring path; browser model metadata cannot create this proof. */
export function createGmailRestrictedDataRouteEvidence(input: Omit<
  GmailRestrictedDataRouteEvidence,
  "version" | "routeFingerprint"
> & {
  registration: ModelRegistrationV2;
}): GmailRestrictedDataRouteEvidence {
  const evidence: GmailRestrictedDataRouteEvidence = {
    version: GMAIL_RESTRICTED_DATA_POLICY_VERSION,
    routeFingerprint: gmailRestrictedDataRouteFingerprint(input.registration),
    processorId: input.processorId,
    purpose: input.purpose,
    retention: input.retention,
    trainingUse: input.trainingUse,
    deletion: input.deletion,
    qualification: input.qualification,
    evidenceRevision: input.evidenceRevision,
    observedAt: input.observedAt,
  };
  if (!isQualifiedGmailRestrictedDataRoute(evidence)) {
    throw new Error("Gmail restricted-data route evidence is invalid.");
  }
  return evidence;
}

export function readGmailRestrictedDataRouteEvidence(input: {
  metadata: unknown;
  registration: ModelRegistrationV2;
}): GmailRestrictedDataRouteEvidence | undefined {
  try {
    const value = asRecord(input.metadata)[GMAIL_RESTRICTED_DATA_EVIDENCE_KEY];
    const route = parseGmailRestrictedDataRouteEvidence(value);
    return route?.routeFingerprint === gmailRestrictedDataRouteFingerprint(input.registration)
      ? route
      : undefined;
  } catch {
    return undefined;
  }
}

export function withGmailRestrictedDataRouteEvidence(input: {
  metadata: unknown;
  evidence: GmailRestrictedDataRouteEvidence;
}): Record<string, unknown> {
  if (!isQualifiedGmailRestrictedDataRoute(input.evidence)) {
    throw new Error("Gmail restricted-data route evidence is invalid.");
  }
  return {
    ...asRecord(input.metadata),
    [GMAIL_RESTRICTED_DATA_EVIDENCE_KEY]: input.evidence,
  };
}

export function admitGmailRestrictedData(input: {
  projectAuthorized: boolean;
  gmailReadonlyGranted: boolean;
  primaryRoute: GmailRestrictedDataRouteEvidence | undefined;
  fallbackRoutes: readonly (GmailRestrictedDataRouteEvidence | undefined)[];
}): GmailRestrictedDataAdmission {
  if (!input.projectAuthorized) {
    return { allowed: false, code: "GMAIL_RESTRICTED_DATA_PROJECT_DENIED" };
  }
  if (!input.gmailReadonlyGranted) {
    return { allowed: false, code: "GMAIL_RESTRICTED_DATA_SCOPE_DENIED" };
  }
  if (
    !isQualifiedGmailRestrictedDataRoute(input.primaryRoute) ||
    input.fallbackRoutes.some(
      (route) => !isQualifiedGmailRestrictedDataRoute(route),
    )
  ) {
    return {
      allowed: false,
      code: "GMAIL_RESTRICTED_DATA_ROUTE_UNQUALIFIED",
    };
  }
  return { allowed: true };
}

export function isQualifiedGmailRestrictedDataRoute(
  route: GmailRestrictedDataRouteEvidence | undefined,
): route is GmailRestrictedDataRouteEvidence {
  return Boolean(
    route &&
    route.version === GMAIL_RESTRICTED_DATA_POLICY_VERSION &&
    route.routeFingerprint.trim() &&
    route.processorId.trim() &&
    route.purpose === "user_authorized_productivity" &&
    route.retention === "documented" &&
    route.trainingUse === "prohibited" &&
    route.deletion === "documented" &&
    route.qualification === "qualified" &&
    route.evidenceRevision.trim() &&
    Number.isFinite(Date.parse(route.observedAt)),
  );
}

function parseGmailRestrictedDataRouteEvidence(
  value: unknown,
): GmailRestrictedDataRouteEvidence | undefined {
  const record = asRecord(value);
  const candidate: GmailRestrictedDataRouteEvidence = {
    version: record.version as GmailRestrictedDataRouteEvidence["version"],
    routeFingerprint: typeof record.routeFingerprint === "string" ? record.routeFingerprint : "",
    processorId: typeof record.processorId === "string" ? record.processorId : "",
    purpose: record.purpose as GmailRestrictedDataRouteEvidence["purpose"],
    retention: record.retention as GmailRestrictedDataRouteEvidence["retention"],
    trainingUse: record.trainingUse as GmailRestrictedDataRouteEvidence["trainingUse"],
    deletion: record.deletion as GmailRestrictedDataRouteEvidence["deletion"],
    qualification: record.qualification as GmailRestrictedDataRouteEvidence["qualification"],
    evidenceRevision: typeof record.evidenceRevision === "string" ? record.evidenceRevision : "",
    observedAt: typeof record.observedAt === "string" ? record.observedAt : "",
  };
  return isQualifiedGmailRestrictedDataRoute(candidate) ? candidate : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

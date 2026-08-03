import type { Pool } from "pg";
import { ociMcpEgressDestinationV1Schema } from "@kestrel/mcp-security";

export type McpEgressEventKind =
  | "policy.resolved"
  | "launch.allowed"
  | "launch.denied"
  | "gateway.started"
  | "gateway.failed"
  | "gateway.cleaned"
  | "destination.allowed"
  | "destination.denied"
  | "unrestricted.override_used";

export type McpEgressAddressClassification =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "multicast"
  | "unspecified"
  | "reserved"
  | "broadcast"
  | "metadata"
  | "docker_local"
  | "malformed";

export type McpEgressDenialReason =
  | "POLICY_MISSING"
  | "POLICY_MALFORMED"
  | "POLICY_STALE"
  | "BINDING_MISMATCH"
  | "GATEWAY_UNAVAILABLE"
  | "NETWORK_ISOLATION_INVALID"
  | "DESTINATION_NOT_ALLOWED"
  | "HOSTNAME_INVALID"
  | "PORT_NOT_ALLOWED"
  | "PROTOCOL_NOT_ALLOWED"
  | "DNS_RESOLUTION_FAILED"
  | "ADDRESS_FORBIDDEN"
  | "EVIDENCE_UNAVAILABLE"
  | "GATEWAY_FAILED"
  | "UNSUPPORTED_PROTOCOL";

export type McpEgressEvidence = {
  organizationId: string;
  environmentId: string;
  serverId: string;
  owner:
    | { grantId: string; discoveryJobId?: never }
    | { grantId?: never; discoveryJobId: string };
  executionProfileFingerprint?: string | undefined;
  policyRevision: string;
  policyDigest: string;
  imageDigest: string;
  eventKind: McpEgressEventKind;
  networkMode: "none" | "allow_hosts" | "unrestricted";
  destination?:
    | {
        hostname: string;
        port: number;
        protocol: "http" | "https";
        selectedAddress?: string | undefined;
        addressFamily?: 4 | 6 | undefined;
        addressClassification?: McpEgressAddressClassification | undefined;
      }
    | undefined;
  denialReason?: McpEgressDenialReason | undefined;
  unrestrictedOverride?:
    | { justification: string; actorUserId: string }
    | undefined;
};

export class McpEgressEvidenceWriter {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async persist(evidence: McpEgressEvidence): Promise<string> {
    assertEvidence(evidence);
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO mcp_egress_events (
         id,
         organization_id,
         environment_id,
         server_id,
         grant_id,
         discovery_job_id,
         execution_profile_fingerprint,
         policy_revision,
         policy_digest,
         image_digest,
         event_kind,
         network_mode,
         hostname,
         port,
         protocol,
         selected_address,
         address_family,
         address_classification,
         denial_reason,
         override_justification,
         override_actor_user_id
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, $18, $19, $20, $21
       )`,
      [
        id,
        evidence.organizationId,
        evidence.environmentId,
        evidence.serverId,
        evidence.owner.grantId ?? null,
        evidence.owner.discoveryJobId ?? null,
        evidence.executionProfileFingerprint ?? null,
        evidence.policyRevision,
        evidence.policyDigest,
        evidence.imageDigest,
        evidence.eventKind,
        evidence.networkMode,
        evidence.destination?.hostname ?? null,
        evidence.destination?.port ?? null,
        evidence.destination?.protocol ?? null,
        evidence.destination?.selectedAddress ?? null,
        evidence.destination?.addressFamily ?? null,
        evidence.destination?.addressClassification ?? null,
        evidence.denialReason ?? null,
        evidence.unrestrictedOverride?.justification ?? null,
        evidence.unrestrictedOverride?.actorUserId ?? null,
      ],
    );
    return id;
  }
}

function assertEvidence(evidence: McpEgressEvidence): void {
  for (const [name, value] of Object.entries({
    organizationId: evidence.organizationId,
    environmentId: evidence.environmentId,
    serverId: evidence.serverId,
    policyRevision: evidence.policyRevision,
    policyDigest: evidence.policyDigest,
    imageDigest: evidence.imageDigest,
  })) {
    if (!value.trim())
      throw new Error(`MCP egress evidence ${name} is required.`);
  }
  const isDestination =
    evidence.eventKind === "destination.allowed" ||
    evidence.eventKind === "destination.denied";
  if (isDestination !== Boolean(evidence.destination)) {
    throw new Error("MCP egress destination evidence is incomplete.");
  }
  const requiresDenialReason =
    evidence.eventKind === "launch.denied" ||
    evidence.eventKind === "destination.denied" ||
    evidence.eventKind === "gateway.failed";
  if (requiresDenialReason !== Boolean(evidence.denialReason)) {
    throw new Error("MCP egress denial evidence is incomplete.");
  }
  if (evidence.destination) {
    const canonical = ociMcpEgressDestinationV1Schema.parse({
      hostname: evidence.destination.hostname,
      port: evidence.destination.port,
      protocol: evidence.destination.protocol,
    });
    if (canonical.hostname !== evidence.destination.hostname) {
      throw new Error("MCP egress evidence hostname must be canonical.");
    }
  }
  if (
    evidence.eventKind === "unrestricted.override_used" &&
    (!evidence.unrestrictedOverride || evidence.networkMode !== "unrestricted")
  ) {
    throw new Error(
      "MCP unrestricted egress evidence requires its author and justification.",
    );
  }
  if (
    evidence.unrestrictedOverride &&
    (!evidence.unrestrictedOverride.actorUserId.trim() ||
      !evidence.unrestrictedOverride.justification.trim() ||
      evidence.unrestrictedOverride.justification.length > 1_000)
  ) {
    throw new Error("MCP unrestricted egress evidence is invalid.");
  }
}

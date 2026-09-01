import {
  BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
  canonicalizePublicBrowserDestination,
} from "../browser/domainAuthority.js";
import {
  DESKTOP_BROWSER_PERSONAL_DOMAIN_PARTITION_VERSION,
  DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION,
  DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION,
  DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
  type DesktopBrowserPersonalDomainProjectionV1,
  type DesktopBrowserPersonalDomainRecordV1,
  type DesktopBrowserPersonalDomainsV1,
} from "./contracts.js";

/** Strictly projects one account and Environment from the persisted Desktop settings boundary. */
export function projectDesktopBrowserPersonalDomainAuthority(
  value: unknown,
  scope: { accountId: string; environmentId: string },
): DesktopBrowserPersonalDomainProjectionV1 {
  const accountId = requireText(scope.accountId, "accountId");
  const environmentId = requireText(scope.environmentId, "environmentId");
  const root = requireRecord(value, "browserPersonalDomains");
  exactKeys(root, ["version", "partitions"], "browserPersonalDomains");
  if (root.version !== DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION) {
    throw new Error("browserPersonalDomains.version is invalid.");
  }
  if (!Array.isArray(root.partitions)) {
    throw new Error("browserPersonalDomains.partitions must be an array.");
  }
  const matches = root.partitions.flatMap((raw, index) => {
    const partition = requireRecord(raw, `browserPersonalDomains.partitions[${index}]`);
    exactKeys(
      partition,
      ["version", "accountId", "environmentId", "revision", "domains"],
      `browserPersonalDomains.partitions[${index}]`,
    );
    if (partition.version !== DESKTOP_BROWSER_PERSONAL_DOMAIN_PARTITION_VERSION) {
      throw new Error(`browserPersonalDomains.partitions[${index}].version is invalid.`);
    }
    const candidateAccountId = requireText(partition.accountId, "partition.accountId");
    const candidateEnvironmentId = requireText(partition.environmentId, "partition.environmentId");
    const revision = requireRevision(partition.revision);
    if (!Array.isArray(partition.domains)) {
      throw new Error("partition.domains must be an array.");
    }
    const domains = partition.domains.map((entry, domainIndex) =>
      parseDomainRecord(entry, `partition.domains[${domainIndex}]`),
    );
    const domainKeys = domains.map((domain) => domain.authority.canonicalDomain);
    if (new Set(domainKeys).size !== domainKeys.length) {
      throw new Error("Browser personal-domain partition contains duplicate domains.");
    }
    return candidateAccountId === accountId && candidateEnvironmentId === environmentId
      ? [{ revision, domains }]
      : [];
  });
  if (matches.length > 1) throw new Error("Browser personal-domain partition is duplicated.");
  const revision = matches[0]?.revision ?? 0;
  const domains = matches[0]?.domains ?? [];
  return {
    accountId,
    environmentId,
    revision,
    authority: {
      version: BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
      userId: accountId,
      environmentId,
      revision: String(revision),
      activeDomains: domains
        .filter((record) => record.state === "active")
        .map((record) => ({ ...record.authority })),
    },
    domains: domains.map((record) => structuredClone(record)),
  };
}

function parseDomainRecord(value: unknown, label: string): DesktopBrowserPersonalDomainRecordV1 {
  const record = requireRecord(value, label);
  exactKeys(
    record,
    ["version", "authority", "state", "provenance", "createdAt", "updatedAt", "revokedAt"],
    label,
    true,
  );
  if (record.version !== DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION) {
    throw new Error(`${label}.version is invalid.`);
  }
  if (record.state !== "active" && record.state !== "revoked") {
    throw new Error(`${label}.state is invalid.`);
  }
  const authorityRecord = requireRecord(record.authority, `${label}.authority`);
  const canonicalDomain = requireText(authorityRecord.canonicalDomain, `${label}.authority.canonicalDomain`);
  const authority = canonicalizePublicBrowserDestination(`https://${canonicalDomain}`);
  if (
    authorityRecord.version !== authority.version ||
    authorityRecord.scheme !== "https" ||
    authorityRecord.includeSubdomains !== true ||
    authorityRecord.port !== 443 ||
    authority.canonicalDomain !== canonicalDomain
  ) throw new Error(`${label}.authority is invalid.`);
  const provenance = requireRecord(record.provenance, `${label}.provenance`);
  exactKeys(provenance, ["version", "source", "approvalId", "approvedAt"], `${label}.provenance`);
  if (
    provenance.version !== DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION ||
    provenance.source !== "browser.request_grant"
  ) throw new Error(`${label}.provenance is invalid.`);
  const createdAt = requireTimestamp(record.createdAt, `${label}.createdAt`);
  const updatedAt = requireTimestamp(record.updatedAt, `${label}.updatedAt`);
  const revokedAt = record.revokedAt === undefined
    ? undefined
    : requireTimestamp(record.revokedAt, `${label}.revokedAt`);
  if ((record.state === "revoked") !== (revokedAt !== undefined)) {
    throw new Error(`${label}.revokedAt does not match state.`);
  }
  const approvedAt = requireTimestamp(provenance.approvedAt, `${label}.provenance.approvedAt`);
  if (
    Date.parse(createdAt) > Date.parse(updatedAt) ||
    Date.parse(createdAt) > Date.parse(approvedAt) ||
    Date.parse(approvedAt) > Date.parse(updatedAt) ||
    (revokedAt !== undefined && Date.parse(revokedAt) !== Date.parse(updatedAt))
  ) throw new Error(`${label} timestamps are out of order.`);
  return {
    version: DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION,
    authority,
    state: record.state,
    provenance: {
      version: DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION,
      source: "browser.request_grant",
      approvalId: requireText(provenance.approvalId, `${label}.provenance.approvalId`),
      approvedAt,
    },
    createdAt,
    updatedAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  allowOptionalRevokedAt = false,
): void {
  const allowed = new Set(keys);
  const required = allowOptionalRevokedAt ? keys.filter((key) => key !== "revokedAt") : keys;
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !(key in value))) {
    throw new Error(`${label} fields are invalid.`);
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} is invalid.`);
  return new Date(text).toISOString();
}

function requireRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("partition.revision is invalid.");
  }
  return value as number;
}

export function parseDesktopBrowserPersonalDomains(value: unknown): DesktopBrowserPersonalDomainsV1 {
  const root = requireRecord(value, "browserPersonalDomains");
  exactKeys(root, ["version", "partitions"], "browserPersonalDomains");
  if (root.version !== DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION) {
    throw new Error("browserPersonalDomains.version is invalid.");
  }
  // Project every partition once to apply the same strict validation.
  if (!Array.isArray(root.partitions)) throw new Error("browserPersonalDomains.partitions must be an array.");
  const partitionKeys = root.partitions.map((raw) => {
    const partition = requireRecord(raw, "browserPersonalDomains partition");
    return `${requireText(partition.accountId, "partition.accountId")}\u0000${requireText(partition.environmentId, "partition.environmentId")}`;
  });
  if (new Set(partitionKeys).size !== partitionKeys.length) {
    throw new Error("Browser personal-domain partition is duplicated.");
  }
  for (const raw of root.partitions) {
    const partition = requireRecord(raw, "browserPersonalDomains partition");
    projectDesktopBrowserPersonalDomainAuthority(value, {
      accountId: requireText(partition.accountId, "partition.accountId"),
      environmentId: requireText(partition.environmentId, "partition.environmentId"),
    });
  }
  return structuredClone(value) as DesktopBrowserPersonalDomainsV1;
}

export function rememberDesktopBrowserPersonalDomainAuthority(
  value: unknown,
  input: {
    accountId: string;
    environmentId: string;
    destination: string;
    approvalId: string;
    approvedAt: string;
  },
): {
  value: DesktopBrowserPersonalDomainsV1;
  projection: DesktopBrowserPersonalDomainProjectionV1;
  disposition: "created" | "reactivated" | "unchanged";
} {
  const current = parseDesktopBrowserPersonalDomains(value);
  const accountId = requireText(input.accountId, "accountId");
  const environmentId = requireText(input.environmentId, "environmentId");
  const approvalId = requireText(input.approvalId, "approvalId");
  const approvedAt = requireTimestamp(input.approvedAt, "approvedAt");
  const authority = canonicalizePublicBrowserDestination(input.destination);
  const partition = current.partitions.find(
    (candidate) =>
      candidate.accountId === accountId &&
      candidate.environmentId === environmentId,
  );
  const existing = partition?.domains.find(
    (candidate) =>
      candidate.authority.canonicalDomain === authority.canonicalDomain,
  );
  if (existing?.state === "active") {
    return {
      value: current,
      projection: projectDesktopBrowserPersonalDomainAuthority(current, {
        accountId,
        environmentId,
      }),
      disposition: "unchanged",
    };
  }
  if (
    existing !== undefined &&
    Date.parse(approvedAt) < Date.parse(existing.updatedAt)
  ) {
    throw new Error("approvedAt cannot precede the domain's current state.");
  }
  const revision = (partition?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) {
    throw new Error("Browser personal-domain revision is exhausted.");
  }
  const record: DesktopBrowserPersonalDomainRecordV1 = {
    version: DESKTOP_BROWSER_PERSONAL_DOMAIN_RECORD_VERSION,
    authority,
    state: "active",
    provenance: {
      version: DESKTOP_BROWSER_PERSONAL_DOMAIN_PROVENANCE_VERSION,
      source: "browser.request_grant",
      approvalId,
      approvedAt,
    },
    createdAt: existing?.createdAt ?? approvedAt,
    updatedAt: approvedAt,
  };
  const domains = [
    ...(partition?.domains ?? []).filter(
      (candidate) =>
        candidate.authority.canonicalDomain !== authority.canonicalDomain,
    ),
    record,
  ].sort((left, right) =>
    compareStrings(
      left.authority.canonicalDomain,
      right.authority.canonicalDomain,
    ),
  );
  const replacement = {
    version: DESKTOP_BROWSER_PERSONAL_DOMAIN_PARTITION_VERSION,
    accountId,
    environmentId,
    revision,
    domains,
  } as const;
  const next: DesktopBrowserPersonalDomainsV1 = {
    version: DESKTOP_BROWSER_PERSONAL_DOMAINS_VERSION,
    partitions: [
      ...current.partitions.filter(
        (candidate) =>
          candidate.accountId !== accountId ||
          candidate.environmentId !== environmentId,
      ),
      replacement,
    ].sort((left, right) =>
      compareStrings(
        `${left.accountId}\u0000${left.environmentId}`,
        `${right.accountId}\u0000${right.environmentId}`,
      ),
    ),
  };
  return {
    value: next,
    projection: projectDesktopBrowserPersonalDomainAuthority(next, {
      accountId,
      environmentId,
    }),
    disposition: existing === undefined ? "created" : "reactivated",
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

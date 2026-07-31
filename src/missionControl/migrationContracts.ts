import type { MissionControlLegacyProjectSnapshot } from "./legacyContracts.js";

export type MissionControlMigrationStatus =
  | "staged_empty"
  | "staged"
  | "needs_rebind"
  | "needs_resolution"
  | "resolved";

export type MissionControlMigrationLinkStatus =
  | "linked"
  | "rebound"
  | "moved"
  | "missing_project"
  | "ambiguous_project";

export interface MissionControlLegacyProjectSource {
  sourceId: string;
  kind: "session_snapshot";
  sessionId: string;
  sourceVersion: number;
  projectPath?: string | undefined;
  snapshot: MissionControlLegacyProjectSnapshot;
}

export interface MissionControlMigrationSourceBinding {
  sourceId: string;
  projectId: string;
  sourceFingerprint: string;
  actionId: string;
  boundAt: string;
}

export interface MissionControlMigrationProjectRegistration {
  projectId: string;
  path: string;
  previousPaths: string[];
}

export interface MissionControlMigrationSourceProvenance {
  sourceId: string;
  kind: "session_snapshot";
  sessionId: string;
  sourceVersion: number;
  sourceFingerprint: string;
  projectPath?: string | undefined;
  linkStatus: MissionControlMigrationLinkStatus;
  candidateId?: string | undefined;
}

export interface MissionControlMigrationCandidate {
  id: string;
  canonicalFingerprint: string;
  sourceIds: string[];
  valid: boolean;
  conflicts: string[];
}

export interface MissionControlMigrationRebind {
  sourceId: string;
  sourceFingerprint: string;
  projectId: string;
  actionId: string;
  reboundAt: string;
}

export type MissionControlMigrationResolution =
  | {
      type: "source";
      candidateId: string;
      sourceFingerprints: Record<string, string>;
      actionId: string;
      resolvedAt: string;
    }
  | {
      type: "merged";
      canonicalFingerprint: string;
      sourceFingerprints: Record<string, string>;
      actionId: string;
      resolvedAt: string;
    };

export interface MissionControlMigrationState {
  version: 1;
  status: MissionControlMigrationStatus;
  registeredPath: string;
  sources: MissionControlMigrationSourceProvenance[];
  candidates: MissionControlMigrationCandidate[];
  rebinds: MissionControlMigrationRebind[];
  stagedAt: string;
  updatedAt: string;
  resolution?: MissionControlMigrationResolution | undefined;
}

export function parseMissionControlMigrationState(
  value: unknown,
  field = "migration",
): MissionControlMigrationState {
  const record = object(value, field);
  exactKeys(record, [
    "version",
    "status",
    "registeredPath",
    "sources",
    "candidates",
    "rebinds",
    "stagedAt",
    "updatedAt",
    "resolution",
  ], field);
  if (record.version !== 1) {
    throw new Error(`${field}.version must be 1.`);
  }
  const status = migrationStatus(record.status, `${field}.status`);
  const sources = array(record.sources, `${field}.sources`).map((entry, index) =>
    parseSource(entry, `${field}.sources.${index}`),
  );
  const candidates = array(record.candidates, `${field}.candidates`).map(
    (entry, index) => parseCandidate(entry, `${field}.candidates.${index}`),
  );
  const rebinds = array(record.rebinds, `${field}.rebinds`).map((entry, index) =>
    parseRebind(entry, `${field}.rebinds.${index}`),
  );
  unique(sources.map((source) => source.sourceId), `${field}.sources`);
  unique(candidates.map((candidate) => candidate.id), `${field}.candidates`);
  unique(rebinds.map((rebind) => rebind.sourceId), `${field}.rebinds`);
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  for (const candidate of candidates) {
    if (candidate.sourceIds.some((sourceId) => sourceIds.has(sourceId) === false)) {
      throw new Error(`${field}.candidates must reference persisted sources.`);
    }
    for (const sourceId of candidate.sourceIds) {
      if (
        sources.find((source) => source.sourceId === sourceId)?.candidateId !==
        candidate.id
      ) {
        throw new Error(
          `${field}.candidate provenance must identify its exact source group.`,
        );
      }
    }
  }
  for (const source of sources) {
    if (
      source.candidateId !== undefined &&
      candidates.some(
        (candidate) =>
          candidate.id === source.candidateId &&
          candidate.sourceIds.includes(source.sourceId),
      ) === false
    ) {
      throw new Error(`${field}.sources must reference persisted candidates.`);
    }
  }
  for (const rebind of rebinds) {
    if (sourceIds.has(rebind.sourceId) === false) {
      throw new Error(`${field}.rebinds must reference persisted sources.`);
    }
  }
  const resolution =
    record.resolution === undefined
      ? undefined
      : parseResolution(record.resolution, `${field}.resolution`);
  if (status === "resolved" && resolution === undefined) {
    throw new Error(`${field}.resolution is required when migration is resolved.`);
  }
  if (status !== "resolved" && resolution !== undefined) {
    throw new Error(`${field}.resolution is allowed only when migration is resolved.`);
  }
  const unresolved = sources.some(
    (source) =>
      source.linkStatus !== "linked" && source.linkStatus !== "rebound",
  );
  if (status === "staged_empty" && (unresolved || candidates.length !== 0)) {
    throw new Error(`${field}.staged_empty must have no unresolved source or candidate.`);
  }
  if (
    status === "staged" &&
    (unresolved || candidates.length !== 1 || candidates[0]?.valid !== true)
  ) {
    throw new Error(`${field}.staged must have one valid complete candidate.`);
  }
  if (status === "needs_rebind" && unresolved === false) {
    throw new Error(`${field}.needs_rebind must identify an unresolved source.`);
  }
  if (
    status === "needs_resolution" &&
    (unresolved ||
      candidates.length === 0 ||
      (candidates.length === 1 && candidates[0]?.valid === true))
  ) {
    throw new Error(`${field}.needs_resolution must identify conflicting content.`);
  }
  if (status === "resolved" && unresolved) {
    throw new Error(`${field}.resolved cannot retain unresolved source identity.`);
  }
  if (resolution !== undefined) {
    const resolvedSourceIds = Object.keys(resolution.sourceFingerprints).sort();
    const expectedSourceIds = [...sourceIds].sort();
    if (
      resolvedSourceIds.length !== expectedSourceIds.length ||
      resolvedSourceIds.some(
        (sourceId, index) => sourceId !== expectedSourceIds[index],
      ) ||
      sources.some(
        (source) =>
          resolution.sourceFingerprints[source.sourceId] !==
          source.sourceFingerprint,
      )
    ) {
      throw new Error(`${field}.resolution must freeze every exact source fingerprint.`);
    }
    if (
      resolution.type === "source" &&
      candidates.some(
        (candidate) =>
          candidate.id === resolution.candidateId && candidate.valid,
      ) === false
    ) {
      throw new Error(`${field}.resolution must reference a valid candidate.`);
    }
  }
  return {
    version: 1,
    status,
    registeredPath: text(record.registeredPath, `${field}.registeredPath`, 4_096),
    sources,
    candidates,
    rebinds,
    stagedAt: timestamp(record.stagedAt, `${field}.stagedAt`),
    updatedAt: timestamp(record.updatedAt, `${field}.updatedAt`),
    ...(resolution === undefined ? {} : { resolution }),
  };
}

export function requireMissionControlMigrationFingerprint(
  value: unknown,
  field = "sourceFingerprint",
): string {
  return fingerprint(value, field);
}

function parseSource(
  value: unknown,
  field: string,
): MissionControlMigrationSourceProvenance {
  const record = object(value, field);
  exactKeys(record, [
    "sourceId",
    "kind",
    "sessionId",
    "sourceVersion",
    "sourceFingerprint",
    "projectPath",
    "linkStatus",
    "candidateId",
  ], field);
  if (record.kind !== "session_snapshot") {
    throw new Error(`${field}.kind is invalid.`);
  }
  return {
    sourceId: text(record.sourceId, `${field}.sourceId`),
    kind: record.kind,
    sessionId: text(record.sessionId, `${field}.sessionId`),
    sourceVersion: nonNegativeInteger(
      record.sourceVersion,
      `${field}.sourceVersion`,
    ),
    sourceFingerprint: fingerprint(
      record.sourceFingerprint,
      `${field}.sourceFingerprint`,
    ),
    ...(record.projectPath === undefined
      ? {}
      : { projectPath: text(record.projectPath, `${field}.projectPath`, 4_096) }),
    linkStatus: linkStatus(record.linkStatus, `${field}.linkStatus`),
    ...(record.candidateId === undefined
      ? {}
      : { candidateId: fingerprint(record.candidateId, `${field}.candidateId`) }),
  };
}

function parseCandidate(
  value: unknown,
  field: string,
): MissionControlMigrationCandidate {
  const record = object(value, field);
  exactKeys(record, [
    "id",
    "canonicalFingerprint",
    "sourceIds",
    "valid",
    "conflicts",
  ], field);
  if (typeof record.valid !== "boolean") {
    throw new Error(`${field}.valid must be boolean.`);
  }
  const sourceIds = stringArray(record.sourceIds, `${field}.sourceIds`);
  const conflicts = stringArray(record.conflicts, `${field}.conflicts`, 32_000);
  unique(sourceIds, `${field}.sourceIds`);
  unique(conflicts, `${field}.conflicts`);
  return {
    id: fingerprint(record.id, `${field}.id`),
    canonicalFingerprint: fingerprint(
      record.canonicalFingerprint,
      `${field}.canonicalFingerprint`,
    ),
    sourceIds,
    valid: record.valid,
    conflicts,
  };
}

function parseRebind(
  value: unknown,
  field: string,
): MissionControlMigrationRebind {
  const record = object(value, field);
  exactKeys(record, [
    "sourceId",
    "sourceFingerprint",
    "projectId",
    "actionId",
    "reboundAt",
  ], field);
  return {
    sourceId: text(record.sourceId, `${field}.sourceId`),
    sourceFingerprint: fingerprint(
      record.sourceFingerprint,
      `${field}.sourceFingerprint`,
    ),
    projectId: uuid(record.projectId, `${field}.projectId`),
    actionId: text(record.actionId, `${field}.actionId`),
    reboundAt: timestamp(record.reboundAt, `${field}.reboundAt`),
  };
}

function parseResolution(
  value: unknown,
  field: string,
): MissionControlMigrationResolution {
  const record = object(value, field);
  if (record.type === "source") {
    exactKeys(record, [
      "type",
      "candidateId",
      "sourceFingerprints",
      "actionId",
      "resolvedAt",
    ], field);
    return {
      type: record.type,
      candidateId: fingerprint(record.candidateId, `${field}.candidateId`),
      sourceFingerprints: fingerprintMap(
        record.sourceFingerprints,
        `${field}.sourceFingerprints`,
      ),
      actionId: text(record.actionId, `${field}.actionId`),
      resolvedAt: timestamp(record.resolvedAt, `${field}.resolvedAt`),
    };
  }
  if (record.type === "merged") {
    exactKeys(record, [
      "type",
      "canonicalFingerprint",
      "sourceFingerprints",
      "actionId",
      "resolvedAt",
    ], field);
    return {
      type: record.type,
      canonicalFingerprint: fingerprint(
        record.canonicalFingerprint,
        `${field}.canonicalFingerprint`,
      ),
      sourceFingerprints: fingerprintMap(
        record.sourceFingerprints,
        `${field}.sourceFingerprints`,
      ),
      actionId: text(record.actionId, `${field}.actionId`),
      resolvedAt: timestamp(record.resolvedAt, `${field}.resolvedAt`),
    };
  }
  throw new Error(`${field}.type is invalid.`);
}

function fingerprintMap(value: unknown, field: string): Record<string, string> {
  const record = object(value, field);
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, candidate]): [string, string] => [
        text(key, `${field}.key`),
        fingerprint(candidate, `${field}.${key}`),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function migrationStatus(value: unknown, field: string): MissionControlMigrationStatus {
  if (
    value !== "staged_empty" &&
    value !== "staged" &&
    value !== "needs_rebind" &&
    value !== "needs_resolution" &&
    value !== "resolved"
  ) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function linkStatus(value: unknown, field: string): MissionControlMigrationLinkStatus {
  if (
    value !== "linked" &&
    value !== "rebound" &&
    value !== "moved" &&
    value !== "missing_project" &&
    value !== "ambiguous_project"
  ) {
    throw new Error(`${field} is invalid.`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  const normalized = text(value, field);
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      normalized,
    ) === false
  ) {
    throw new Error(`${field} must be a UUID v4.`);
  }
  return normalized.toLowerCase();
}

function fingerprint(value: unknown, field: string): string {
  const normalized = text(value, field, 80);
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized) === false) {
    throw new Error(`${field} must be a sha256 fingerprint.`);
  }
  return normalized;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (Array.isArray(value) === false) {
    throw new Error(`${field} must be an array.`);
  }
  return value;
}

function stringArray(
  value: unknown,
  field: string,
  maximum = 256,
): string[] {
  return array(value, field).map((entry, index) =>
    text(entry, `${field}.${index}`, maximum),
  );
}

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} must not contain duplicates.`);
  }
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (allowedSet.has(key) === false) {
      throw new Error(`${field}.${key} is not allowed.`);
    }
  }
}

function text(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(`${field} exceeds ${maximum} characters.`);
  }
  return normalized;
}

function timestamp(value: unknown, field: string): string {
  const normalized = text(value, field, 64);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${field} must be an ISO timestamp.`);
  }
  return normalized;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    Number.isSafeInteger(value) === false ||
    value < 0
  ) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

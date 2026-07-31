import { createHash } from "node:crypto";
import path from "node:path";

import type { MissionControlProjectRepository } from "../kestrel/contracts/store.js";
import type { ProductBoardCard, ProductProjectSnapshot } from "../project/contracts.js";
import type { Task } from "./contracts.js";
import {
  type MissionControlLegacyProjectSource,
  type MissionControlMigrationCandidate,
  type MissionControlMigrationProjectRegistration,
  type MissionControlMigrationRebind,
  type MissionControlMigrationSourceBinding,
  type MissionControlMigrationSourceProvenance,
  type MissionControlMigrationState,
} from "./migrationContracts.js";
import {
  MissionControlProjectService,
  MissionControlTransitionError,
  createEmptyMissionControlProjectDocument,
  parseMissionControlProjectDocument,
  requireMissionControlActionId,
  requireMissionControlExpectedRevision,
  requireMissionControlProjectId,
  type MissionControlProjectDocument,
  type MissionControlProjectMutationResult,
  type MissionControlWorkItem,
} from "./projectAuthority.js";

interface MigrationActionBase {
  projectId: string;
  actionId: string;
  actionTs: string;
  expectedRevision: number;
}

export type MissionControlMigrationAction =
  | (MigrationActionBase & {
      type: "migration.stage";
      registrations: MissionControlMigrationProjectRegistration[];
    })
  | (MigrationActionBase & {
      type: "migration.rebind";
      registrations: MissionControlMigrationProjectRegistration[];
      sourceId: string;
      sourceFingerprint: string;
      operatorId: string;
    })
  | (MigrationActionBase & {
      type: "migration.resolve";
      registrations: MissionControlMigrationProjectRegistration[];
      operatorId: string;
      resolution:
        | { type: "source"; candidateId: string }
        | { type: "merged"; document: unknown };
    })
  | (MigrationActionBase & {
      type: "migration.clear";
      operatorId: string;
    });

type MigrationRepository = Pick<
  MissionControlProjectRepository,
  | "getMissionControlProjectState"
  | "updateMissionControlProjectState"
  | "listMissionControlLegacySources"
  | "listMissionControlMigrationSourceBindings"
>;

interface CanonicalMigrationContent {
  autopilot: MissionControlProjectDocument["autopilot"];
  items: MissionControlProjectDocument["items"];
}

interface ConvertedSource {
  source: MissionControlLegacyProjectSource;
  provenance: MissionControlMigrationSourceProvenance;
  content?: CanonicalMigrationContent | undefined;
  canonicalFingerprint?: string | undefined;
  conflicts: string[];
}

interface MigrationInventory {
  state: MissionControlMigrationState;
  content?: CanonicalMigrationContent | undefined;
  converted: ConvertedSource[];
}

export type MissionControlMigrationGateReason =
  | "authority_already_active"
  | "canonical_state_not_empty"
  | "project_registration_missing"
  | "source_not_rebindable"
  | "source_binding_conflict"
  | "source_drift"
  | "candidate_invalid"
  | "candidate_not_found"
  | "migration_not_staged";

export class MissionControlMigrationGateError extends Error {
  readonly code = "MISSION_CONTROL_MIGRATION_REJECTED";

  constructor(
    readonly reason: MissionControlMigrationGateReason,
    message: string,
  ) {
    super(message);
    this.name = "MissionControlMigrationGateError";
  }
}

export class MissionControlMigrationService {
  readonly projects: MissionControlProjectService;

  constructor(private readonly store: MigrationRepository) {
    this.projects = new MissionControlProjectService(store);
  }

  async execute(
    actionValue: unknown,
  ): Promise<MissionControlProjectMutationResult> {
    const action = parseMissionControlMigrationAction(actionValue);
    const current = await this.projects.getProject(action.projectId);
    if (current.document.history.some((entry) => entry.actionId === action.actionId)) {
      return this.replay(action);
    }
    if (current.authorityEpoch !== 0) {
      throw gate(
        "authority_already_active",
        "Mission Control migration cannot change an activated project.",
      );
    }
    if (action.type === "migration.clear") {
      const sourceIds = current.document.migration?.rebinds.map(
        (rebind) => rebind.sourceId,
      ) ?? [];
      return this.store.updateMissionControlProjectState({
        projectId: action.projectId,
        actionId: action.actionId,
        requestFingerprint: fingerprint(action),
        expectedRevision: action.expectedRevision,
        releaseMigrationSourceClaims: sourceIds,
        apply: (document) => ({
          document: appendMigrationHistory(
            clearStagedMigration(document),
            action,
          ),
          effects: [],
        }),
      });
    }
    if (
      action.type === "migration.stage" &&
      current.document.migration === undefined &&
      (Object.keys(current.document.items).length > 0 ||
        current.document.history.length > 0)
    ) {
      throw gate(
        "canonical_state_not_empty",
        "Migration cannot replace existing canonical project work.",
      );
    }
    const sources = await this.listLegacySources();
    const bindings = await this.listSourceBindings();
    if (action.type === "migration.rebind") {
      const source = sources.find((candidate) => candidate.sourceId === action.sourceId);
      const actualFingerprint =
        source === undefined ? undefined : fingerprintLegacySource(source);
      if (
        source === undefined ||
        actualFingerprint !== action.sourceFingerprint
      ) {
        throw gate(
          "source_drift",
          "The legacy source changed before it could be rebound.",
        );
      }
      const existingBinding = bindings.find(
        (binding) => binding.sourceId === action.sourceId,
      );
      if (
        existingBinding !== undefined &&
        existingBinding.projectId !== action.projectId
      ) {
        throw gate(
          "source_binding_conflict",
          "The legacy source is already rebound to another project.",
        );
      }
      const before = buildInventory({
        action,
        sources,
        bindings,
        rebinds: current.document.migration?.rebinds ?? [],
      });
      const eligible = before.state.sources.find(
        (candidate) =>
          candidate.sourceId === action.sourceId &&
          candidate.linkStatus !== "linked" &&
          candidate.linkStatus !== "rebound",
      );
      if (eligible === undefined) {
        throw gate(
          "source_not_rebindable",
          "Only an unbound, moved, or ambiguous source can be rebound.",
        );
      }
      const rebind: MissionControlMigrationRebind = {
        sourceId: action.sourceId,
        sourceFingerprint: action.sourceFingerprint,
        projectId: action.projectId,
        actionId: action.actionId,
        reboundAt: action.actionTs,
      };
      const inventory = buildInventory({
        action,
        sources,
        bindings: [
          ...bindings.filter((binding) => binding.sourceId !== action.sourceId),
          {
            sourceId: action.sourceId,
            projectId: action.projectId,
            sourceFingerprint: action.sourceFingerprint,
            actionId: action.actionId,
            boundAt: action.actionTs,
          },
        ],
        rebinds: [
          ...(current.document.migration?.rebinds ?? []).filter(
            (candidate) => candidate.sourceId !== action.sourceId,
          ),
          rebind,
        ],
      });
      return this.store.updateMissionControlProjectState({
        projectId: action.projectId,
        actionId: action.actionId,
        requestFingerprint: fingerprint(action),
        expectedRevision: action.expectedRevision,
        migrationSourceClaim: {
          sourceId: action.sourceId,
          sourceFingerprint: action.sourceFingerprint,
          boundAt: action.actionTs,
        },
        apply: (document) => ({
          document: appendMigrationHistory(
            applyInventory(document, inventory),
            action,
          ),
          effects: [],
        }),
      });
    }
    const inventory = buildInventory({
      action,
      sources,
      bindings,
      rebinds: current.document.migration?.rebinds ?? [],
    });
    if (action.type === "migration.resolve") {
      const staged = current.document.migration;
      if (staged === undefined) {
        throw gate(
          "migration_not_staged",
          "Mission Control migration must be staged before resolution.",
        );
      }
      assertNoSourceDrift(staged, inventory.state);
      const content =
        action.resolution.type === "source"
          ? resolveSourceCandidate(action.resolution.candidateId, inventory)
          : parsePreparedContent(
              action.resolution.document,
              action.projectId,
            );
      const canonicalFingerprint = fingerprintCanonicalContent(content);
      const sourceFingerprints = Object.fromEntries(
        inventory.state.sources
          .map(
            (source): [string, string] => [
              source.sourceId,
              source.sourceFingerprint,
            ],
          )
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      const state: MissionControlMigrationState = {
        ...inventory.state,
        status: "resolved",
        updatedAt: action.actionTs,
        resolution:
          action.resolution.type === "source"
            ? {
                type: "source",
                candidateId: action.resolution.candidateId,
                sourceFingerprints,
                actionId: action.actionId,
                resolvedAt: action.actionTs,
              }
            : {
                type: "merged",
                canonicalFingerprint,
                sourceFingerprints,
                actionId: action.actionId,
                resolvedAt: action.actionTs,
              },
      };
      return this.persist(action, state, content);
    }
    return this.persist(action, inventory.state, inventory.content);
  }

  private persist(
    action: MissionControlMigrationAction,
    state: MissionControlMigrationState,
    content?: CanonicalMigrationContent | undefined,
  ): Promise<MissionControlProjectMutationResult> {
    return this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprint(action),
      expectedRevision: action.expectedRevision,
      apply: (document) => ({
        document: appendMigrationHistory(
          applyMigration(document, state, content),
          action,
        ),
        effects: [],
      }),
    });
  }

  private replay(
    action: MissionControlMigrationAction,
  ): Promise<MissionControlProjectMutationResult> {
    return this.store.updateMissionControlProjectState({
      projectId: action.projectId,
      actionId: action.actionId,
      requestFingerprint: fingerprint(action),
      expectedRevision: action.expectedRevision,
      apply: (document) => ({ document, effects: [] }),
    });
  }

  private listLegacySources(): Promise<MissionControlLegacyProjectSource[]> {
    if (this.store.listMissionControlLegacySources === undefined) {
      throw new MissionControlTransitionError(
        "Mission Control legacy source inventory is unavailable.",
      );
    }
    return this.store.listMissionControlLegacySources();
  }

  private listSourceBindings(): Promise<MissionControlMigrationSourceBinding[]> {
    if (this.store.listMissionControlMigrationSourceBindings === undefined) {
      throw new MissionControlTransitionError(
        "Mission Control migration source bindings are unavailable.",
      );
    }
    return this.store.listMissionControlMigrationSourceBindings();
  }
}

export function parseMissionControlMigrationAction(
  value: unknown,
): MissionControlMigrationAction {
  const record = object(value, "Mission Control migration action");
  const type = text(record.type, "type");
  const base = {
    projectId: requireMissionControlProjectId(record.projectId),
    actionId: requireMissionControlActionId(record.actionId),
    actionTs: timestamp(record.actionTs, "actionTs"),
    expectedRevision: requireMissionControlExpectedRevision(
      record.expectedRevision,
    ),
  };
  switch (type) {
    case "migration.stage":
      exactKeys(record, [...BASE_KEYS, "registrations"]);
      return {
        ...base,
        type,
        registrations: registrations(record.registrations),
      };
    case "migration.rebind":
      exactKeys(record, [
        ...BASE_KEYS,
        "registrations",
        "sourceId",
        "sourceFingerprint",
        "operatorId",
      ]);
      return {
        ...base,
        type,
        registrations: registrations(record.registrations),
        sourceId: text(record.sourceId, "sourceId"),
        sourceFingerprint: sha256(record.sourceFingerprint, "sourceFingerprint"),
        operatorId: text(record.operatorId, "operatorId"),
      };
    case "migration.resolve": {
      exactKeys(record, [
        ...BASE_KEYS,
        "registrations",
        "operatorId",
        "resolution",
      ]);
      const resolution = object(record.resolution, "resolution");
      if (resolution.type === "source") {
        exactKeys(resolution, ["type", "candidateId"]);
        return {
          ...base,
          type,
          registrations: registrations(record.registrations),
          operatorId: text(record.operatorId, "operatorId"),
          resolution: {
            type: "source",
            candidateId: sha256(resolution.candidateId, "candidateId"),
          },
        };
      }
      if (resolution.type === "merged") {
        exactKeys(resolution, ["type", "document"]);
        return {
          ...base,
          type,
          registrations: registrations(record.registrations),
          operatorId: text(record.operatorId, "operatorId"),
          resolution: {
            type: "merged",
            document: resolution.document,
          },
        };
      }
      throw new Error("resolution.type is invalid.");
    }
    case "migration.clear":
      exactKeys(record, [...BASE_KEYS, "operatorId"]);
      return {
        ...base,
        type,
        operatorId: text(record.operatorId, "operatorId"),
      };
    default:
      throw new Error(`Unsupported Mission Control migration action: ${type}.`);
  }
}

function buildInventory(input: {
  action: Exclude<MissionControlMigrationAction, { type: "migration.clear" }>;
  sources: MissionControlLegacyProjectSource[];
  bindings: MissionControlMigrationSourceBinding[];
  rebinds: MissionControlMigrationRebind[];
}): MigrationInventory {
  const target = targetRegistration(
    input.action.projectId,
    input.action.registrations,
  );
  const registrationsByPath = new Map<string, string[]>();
  for (const registration of input.action.registrations) {
    const normalized = normalizePath(registration.path);
    registrationsByPath.set(normalized, [
      ...(registrationsByPath.get(normalized) ?? []),
      registration.projectId,
    ]);
  }
  const bindings = new Map(
    input.bindings.map((binding) => [binding.sourceId, binding]),
  );
  const converted: ConvertedSource[] = [];
  for (const source of [...input.sources].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  )) {
    const sourceFingerprint = fingerprintLegacySource(source);
    const binding = bindings.get(source.sourceId);
    if (binding !== undefined && binding.projectId !== input.action.projectId) {
      continue;
    }
    const projectPath =
      source.projectPath === undefined ? undefined : normalizePath(source.projectPath);
    const matches =
      projectPath === undefined ? [] : registrationsByPath.get(projectPath) ?? [];
    let linkStatus: MissionControlMigrationSourceProvenance["linkStatus"];
    let include = true;
    if (binding?.projectId === input.action.projectId) {
      if (binding.sourceFingerprint !== sourceFingerprint) {
        linkStatus = "missing_project";
      } else {
        linkStatus = "rebound";
      }
    } else if (matches.length > 1 && matches.includes(input.action.projectId)) {
      linkStatus = "ambiguous_project";
    } else if (matches.length === 1 && matches[0] === input.action.projectId) {
      linkStatus = "linked";
    } else if (matches.length === 1) {
      include = false;
      linkStatus = "linked";
    } else if (
      projectPath !== undefined &&
      target.previousPaths.map(normalizePath).includes(projectPath)
    ) {
      linkStatus = "moved";
    } else {
      linkStatus = "missing_project";
    }
    if (include === false) continue;
    const convertedSource =
      linkStatus === "linked" || linkStatus === "rebound"
        ? convertLegacySource(source, sourceFingerprint, linkStatus, target.path)
        : {
            source,
            provenance: {
              sourceId: source.sourceId,
              kind: source.kind,
              sessionId: source.sessionId,
              sourceVersion: source.sourceVersion,
              sourceFingerprint,
              ...(projectPath === undefined ? {} : { projectPath }),
              linkStatus,
            },
            conflicts: [],
          };
    converted.push(convertedSource);
  }
  const grouped = new Map<string, ConvertedSource[]>();
  for (const source of converted) {
    if (source.canonicalFingerprint === undefined) continue;
    grouped.set(source.canonicalFingerprint, [
      ...(grouped.get(source.canonicalFingerprint) ?? []),
      source,
    ]);
  }
  const candidates: MissionControlMigrationCandidate[] = [...grouped.entries()]
    .map(([canonicalFingerprint, sources]) => {
      const sourceIds = sources.map((entry) => entry.source.sourceId).sort();
      const conflicts = [...new Set(sources.flatMap((entry) => entry.conflicts))].sort();
      const id = sha({ canonicalFingerprint, sourceIds });
      for (const entry of sources) entry.provenance.candidateId = id;
      return {
        id,
        canonicalFingerprint,
        sourceIds,
        valid: conflicts.length === 0,
        conflicts,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const unresolved = converted.some(
    (source) =>
      source.provenance.linkStatus !== "linked" &&
      source.provenance.linkStatus !== "rebound",
  );
  const validCandidate =
    candidates.length === 1 && candidates[0]?.valid === true
      ? converted.find(
          (source) =>
            source.canonicalFingerprint === candidates[0]?.canonicalFingerprint,
        )?.content
      : undefined;
  const status: MissionControlMigrationState["status"] = unresolved
    ? "needs_rebind"
    : candidates.length === 0
      ? "staged_empty"
      : validCandidate !== undefined
        ? "staged"
        : "needs_resolution";
  return {
    state: {
      version: 1,
      status,
      registeredPath: normalizePath(target.path),
      sources: converted.map((source) => source.provenance),
      candidates,
      rebinds: [...input.rebinds].sort((left, right) =>
        left.sourceId.localeCompare(right.sourceId)
      ),
      stagedAt: input.action.actionTs,
      updatedAt: input.action.actionTs,
    },
    ...(status === "staged_empty"
      ? { content: emptyContent(input.action.projectId) }
      : status === "staged" && validCandidate !== undefined
        ? { content: validCandidate }
        : {}),
    converted,
  };
}

function convertLegacySource(
  source: MissionControlLegacyProjectSource,
  sourceFingerprint: string,
  linkStatus: "linked" | "rebound",
  registeredPath: string,
): ConvertedSource {
  const items: Record<string, MissionControlWorkItem> = {};
  const conflicts: string[] = [];
  for (const task of Object.values(source.snapshot.taskQueue.tasks).sort(
    compareLegacy,
  )) {
    if (
      task.projectPath !== undefined &&
      normalizePath(task.projectPath) !== normalizePath(registeredPath)
    ) {
      conflicts.push(`task:${task.id}:cross_project_path`);
      continue;
    }
    const converted = convertTask(task, conflicts);
    items[converted.id] = converted;
  }
  for (const card of Object.values(source.snapshot.board.cards).sort(compareLegacy)) {
    const converted = convertCard(card, conflicts);
    items[converted.id] = converted;
  }
  const content: CanonicalMigrationContent = {
    autopilot: {
      enabled: false,
      wipLimit: source.snapshot.board.settings.wipLimit,
    },
    items,
  };
  const canonicalFingerprint = fingerprintCanonicalContent(content);
  return {
    source,
    provenance: {
      sourceId: source.sourceId,
      kind: source.kind,
      sessionId: source.sessionId,
      sourceVersion: source.sourceVersion,
      sourceFingerprint,
      ...(source.projectPath === undefined
        ? {}
        : { projectPath: normalizePath(source.projectPath) }),
      linkStatus,
    },
    content,
    canonicalFingerprint,
    conflicts: conflicts.sort(),
  };
}

function convertTask(task: Task, conflicts: string[]): MissionControlWorkItem {
  const phase = taskPhase(task.status);
  if (phase === "active") conflicts.push(`task:${task.id}:running_without_attempt`);
  if (phase === "review") conflicts.push(`task:${task.id}:review_without_bundle`);
  if (phase === "done") conflicts.push(`task:${task.id}:done_without_acceptance`);
  return {
    id: `legacy:task:${task.id}`,
    title: task.title,
    instructions: task.instructions,
    createdBy: task.createdBy === "user" ? "operator" : "agent",
    phase,
    order: task.order,
    attempts: [],
    ...(phase === "needs_attention"
      ? { attentionReason: "runtime_authority_changed" as const }
      : {}),
    reviewBundles: [],
    reviewDecisions: [],
    version: 1,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function convertCard(
  card: ProductBoardCard,
  conflicts: string[],
): MissionControlWorkItem {
  const phase = cardPhase(card.lane);
  if (phase === "active") conflicts.push(`board:${card.id}:running_without_attempt`);
  if (phase === "review") conflicts.push(`board:${card.id}:review_without_bundle`);
  if (phase === "done") conflicts.push(`board:${card.id}:done_without_acceptance`);
  return {
    id: `legacy:board:${card.id}`,
    title: card.title,
    instructions: card.prompt,
    createdBy: "operator",
    phase,
    order: card.order,
    attempts: [],
    reviewBundles: [],
    reviewDecisions: [],
    version: 1,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function parsePreparedContent(
  value: unknown,
  projectId: string,
): CanonicalMigrationContent {
  const record = object(value, "resolution.document");
  exactKeys(record, ["autopilot", "items"]);
  const parsed = parseMissionControlProjectDocument(
    {
      ...createEmptyMissionControlProjectDocument(projectId),
      autopilot: record.autopilot,
      items: record.items,
    },
    projectId,
  );
  for (const item of Object.values(parsed.items)) {
    if (item.phase === "active") {
      const attempt = item.attempts.find(
        (candidate) => candidate.id === item.currentAttemptId,
      );
      if (
        attempt === undefined ||
        (attempt.status !== "starting" &&
          attempt.status !== "running" &&
          attempt.status !== "waiting" &&
          attempt.status !== "cancelling")
      ) {
        throw gate(
          "candidate_invalid",
          `Merged item ${item.id} has no authoritative active attempt.`,
        );
      }
    }
    if (item.phase === "review" && item.currentReviewBundleId === undefined) {
      throw gate(
        "candidate_invalid",
        `Merged item ${item.id} has no frozen Review bundle.`,
      );
    }
    if (
      item.phase === "done" &&
      item.reviewDecisions?.some((decision) => decision.decision === "accepted") !==
        true
    ) {
      throw gate(
        "candidate_invalid",
        `Merged item ${item.id} has no durable acceptance.`,
      );
    }
  }
  return { autopilot: parsed.autopilot, items: parsed.items };
}

function resolveSourceCandidate(
  candidateId: string,
  inventory: MigrationInventory,
): CanonicalMigrationContent {
  const candidate = inventory.state.candidates.find(
    (entry) => entry.id === candidateId,
  );
  if (candidate === undefined) {
    throw gate("candidate_not_found", "The selected migration source is unavailable.");
  }
  if (candidate.valid === false) {
    throw gate(
      "candidate_invalid",
      "The selected legacy source cannot satisfy canonical lifecycle contracts.",
    );
  }
  const content = inventory.converted.find(
    (entry) => entry.canonicalFingerprint === candidate.canonicalFingerprint,
  )?.content;
  if (content === undefined) {
    throw gate("candidate_not_found", "The selected migration content is unavailable.");
  }
  return content;
}

function assertNoSourceDrift(
  staged: MissionControlMigrationState,
  current: MissionControlMigrationState,
): void {
  const expected = staged.sources
    .map((source) => `${source.sourceId}:${source.sourceFingerprint}`)
    .sort();
  const actual = current.sources
    .map((source) => `${source.sourceId}:${source.sourceFingerprint}`)
    .sort();
  if (
    expected.length !== actual.length ||
    expected.some((value, index) => value !== actual[index])
  ) {
    throw gate(
      "source_drift",
      "Legacy Mission Control sources changed after staging.",
    );
  }
}

function applyInventory(
  current: MissionControlProjectDocument,
  inventory: MigrationInventory,
): MissionControlProjectDocument {
  return applyMigration(current, inventory.state, inventory.content);
}

function applyMigration(
  current: MissionControlProjectDocument,
  migration: MissionControlMigrationState,
  content?: CanonicalMigrationContent | undefined,
): MissionControlProjectDocument {
  return parseMissionControlProjectDocument(
    {
      ...current,
      ...(content === undefined
        ? { autopilot: { enabled: false, wipLimit: 1 }, items: {} }
        : { autopilot: content.autopilot, items: content.items }),
      migration,
    },
    current.projectId,
  );
}

function clearStagedMigration(
  current: MissionControlProjectDocument,
): MissionControlProjectDocument {
  if (current.migration === undefined) return current;
  const empty = createEmptyMissionControlProjectDocument(current.projectId);
  return {
    ...empty,
    history: current.history,
  };
}

function appendMigrationHistory(
  current: MissionControlProjectDocument,
  action: MissionControlMigrationAction,
): MissionControlProjectDocument {
  return {
    ...current,
    history: [
      ...current.history,
      {
        actionId: action.actionId,
        actionType: action.type,
        revision: action.expectedRevision + 1,
        timestamp: action.actionTs,
      },
    ],
  };
}

function emptyContent(projectId: string): CanonicalMigrationContent {
  const document = createEmptyMissionControlProjectDocument(projectId);
  return { autopilot: document.autopilot, items: document.items };
}

function targetRegistration(
  projectId: string,
  values: MissionControlMigrationProjectRegistration[],
): MissionControlMigrationProjectRegistration {
  const matches = values.filter((registration) => registration.projectId === projectId);
  if (matches.length !== 1) {
    throw gate(
      "project_registration_missing",
      "Migration requires the exact registered Desktop project UUID.",
    );
  }
  return matches[0]!;
}

function registrations(value: unknown): MissionControlMigrationProjectRegistration[] {
  if (Array.isArray(value) === false) {
    throw new Error("registrations must be an array.");
  }
  const parsed = value.map((entry, index) => {
    const record = object(entry, `registrations.${index}`);
    exactKeys(record, ["projectId", "path", "previousPaths"]);
    if (Array.isArray(record.previousPaths) === false) {
      throw new Error(`registrations.${index}.previousPaths must be an array.`);
    }
    return {
      projectId: requireMissionControlProjectId(record.projectId),
      path: normalizePath(text(record.path, `registrations.${index}.path`, 4_096)),
      previousPaths: record.previousPaths.map((candidate, previousIndex) =>
        normalizePath(
          text(
            candidate,
            `registrations.${index}.previousPaths.${previousIndex}`,
            4_096,
          ),
        ),
      ),
    };
  });
  if (new Set(parsed.map((registration) => registration.projectId)).size !== parsed.length) {
    throw new Error("registrations must contain unique project IDs.");
  }
  return parsed.sort((left, right) => left.projectId.localeCompare(right.projectId));
}

function taskPhase(status: Task["status"]): MissionControlWorkItem["phase"] {
  switch (status) {
    case "proposed":
      return "proposed";
    case "queued":
      return "ready";
    case "running":
      return "active";
    case "needs_attention":
      return "needs_attention";
    case "ready_for_review":
      return "review";
    case "done":
      return "done";
    case "discarded":
      return "discarded";
  }
}

function cardPhase(
  lane: ProductBoardCard["lane"],
): MissionControlWorkItem["phase"] {
  switch (lane) {
    case "idea":
      return "proposed";
    case "planned":
      return "ready";
    case "wip":
      return "active";
    case "testing":
      return "review";
    case "done":
      return "done";
  }
}

function compareLegacy(
  left: { order: number; id: string },
  right: { order: number; id: string },
): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

export function fingerprintLegacySource(
  source: MissionControlLegacyProjectSource,
): string {
  return sha({
    sourceId: source.sourceId,
    kind: source.kind,
    sessionId: source.sessionId,
    sourceVersion: source.sourceVersion,
    projectPath: source.projectPath,
    snapshot: source.snapshot,
  });
}

export function fingerprintCanonicalContent(
  content: CanonicalMigrationContent,
): string {
  return sha(content);
}

function fingerprint(action: MissionControlMigrationAction): string {
  return createHash("sha256").update(stableJson(action)).digest("hex");
}

function sha(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizePath(value: string): string {
  return path.resolve(value);
}

function gate(
  reason: MissionControlMigrationGateReason,
  message: string,
): MissionControlMigrationGateError {
  return new MissionControlMigrationGateError(reason, message);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => allowedSet.has(key) === false);
  if (unexpected.length > 0) {
    throw new Error(`Unexpected Mission Control migration fields: ${unexpected.join(", ")}.`);
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

function sha256(value: unknown, field: string): string {
  const normalized = text(value, field, 80);
  if (/^sha256:[a-f0-9]{64}$/u.test(normalized) === false) {
    throw new Error(`${field} must be a sha256 fingerprint.`);
  }
  return normalized;
}

const BASE_KEYS = [
  "type",
  "projectId",
  "actionId",
  "actionTs",
  "expectedRevision",
] as const;

export const KESTREL_UNINSTALL_PLAN_VERSION = "kestrel_uninstall_plan_v1";
export const KESTREL_UNINSTALL_APPLY_RESULT_VERSION =
  "kestrel_uninstall_apply_result_v1";

export type KestrelUninstallInitiator = "cli" | "desktop";
export type KestrelUninstallScope =
  | "current_component"
  | "all_software"
  | "complete";

export interface KestrelUninstallPlanOptions {
  disconnectKestrelOne?: boolean | undefined;
  exportWorktreesDirectory?: string | undefined;
  discardWorktrees?: boolean | undefined;
}

export interface KestrelUninstallTarget {
  id: string;
  kind:
    | "cli_symlink"
    | "cli_bundle"
    | "cli_package"
    | "kcron_launch_agent"
    | "desktop_bundle"
    | "state_root"
    | "electron_profile"
    | "legacy_root"
    | "preferences"
    | "cache"
    | "saved_state"
    | "keychain_service"
    | "manual";
  path?: string | undefined;
  verified: boolean;
  selected: boolean;
  removal: "unlink" | "rm" | "trash" | "keychain_purge" | "package_manager" | "manual";
  fingerprint: string;
  evidence: string[];
  command?: string[] | undefined;
  blockedReason?: string | undefined;
}

export interface KestrelUninstallBlocker {
  code: string;
  message: string;
  targetId?: string | undefined;
}

export interface KestrelUninstallWorktreeSummary {
  cleanDisposable: number;
  retained: number;
  blocked: number;
  totalBytes: number;
  entries: Array<{
    worktreeRoot: string;
    disposition: "clean_disposable" | "retain_with_snapshot" | "blocked";
    dirty: boolean;
    aheadCommitCount: number;
    storageBytes: number;
    reasons: string[];
  }>;
}

export interface KestrelUninstallKestrelOneSummary {
  disconnectSelected: boolean;
  environments: Array<{
    connectionId: string;
    organizationId?: string | undefined;
    baseUrl?: string | undefined;
    status?: string | undefined;
  }>;
}

export interface KestrelUninstallLifecycle {
  state: "idle" | "busy" | "missing" | "unavailable";
  owner?: {
    pid: number;
    executable: string;
  } | undefined;
  blockers: KestrelUninstallBlocker[];
}

export interface KestrelUninstallConfirmation {
  kind: "plan_id" | "delete_data" | "discard_worktrees";
  phrase: string;
}

export interface KestrelUninstallPlanV1 {
  version: typeof KESTREL_UNINSTALL_PLAN_VERSION;
  planId: string;
  generatedAt: string;
  platform: NodeJS.Platform;
  initiator: KestrelUninstallInitiator;
  scope: KestrelUninstallScope;
  options: Required<KestrelUninstallPlanOptions>;
  targets: KestrelUninstallTarget[];
  lifecycle: KestrelUninstallLifecycle;
  worktrees: KestrelUninstallWorktreeSummary;
  kestrelOne: KestrelUninstallKestrelOneSummary;
  confirmations: KestrelUninstallConfirmation[];
  blockers: KestrelUninstallBlocker[];
}

export interface KestrelUninstallApplyRequest {
  plan: KestrelUninstallPlanV1;
  confirmPlanId: string;
  deleteDataPhrase?: string | undefined;
  discardWorktreesPhrase?: string | undefined;
  dryRun?: boolean | undefined;
}

export interface KestrelUninstallApplyResultV1 {
  version: typeof KESTREL_UNINSTALL_APPLY_RESULT_VERSION;
  planId: string;
  appliedAt: string;
  status: "applied" | "blocked" | "partial";
  removedTargets: string[];
  skippedTargets: string[];
  blockers: KestrelUninstallBlocker[];
  finalTargets: KestrelUninstallTarget[];
}

export function parseKestrelUninstallScope(
  value: unknown,
): KestrelUninstallScope {
  if (
    value === "current_component" ||
    value === "all_software" ||
    value === "complete"
  ) {
    return value;
  }
  if (value === "current") return "current_component";
  if (value === "software") return "all_software";
  throw new Error(
    "Uninstall scope must be current_component, all_software, complete, current, or software.",
  );
}

export function parseKestrelUninstallPlanV1(
  value: unknown,
): KestrelUninstallPlanV1 {
  const record = requireRecord(value, "uninstall plan");
  rejectUnknownFields(
    record,
    new Set([
      "version",
      "planId",
      "generatedAt",
      "platform",
      "initiator",
      "scope",
      "options",
      "targets",
      "lifecycle",
      "worktrees",
      "kestrelOne",
      "confirmations",
      "blockers",
    ]),
    "uninstall plan",
  );
  if (record.version !== KESTREL_UNINSTALL_PLAN_VERSION) {
    throw new Error("Uninstall plan version is invalid.");
  }
  const initiator = requireEnum(
    record.initiator,
    ["cli", "desktop"],
    "uninstall plan.initiator",
  );
  const scope = parseKestrelUninstallScope(record.scope);
  return {
    version: KESTREL_UNINSTALL_PLAN_VERSION,
    planId: requireString(record.planId, "uninstall plan.planId"),
    generatedAt: requireString(record.generatedAt, "uninstall plan.generatedAt"),
    platform: requireString(record.platform, "uninstall plan.platform") as NodeJS.Platform,
    initiator,
    scope,
    options: parseOptions(record.options),
    targets: requireArray(record.targets, "uninstall plan.targets").map(
      parseTarget,
    ),
    lifecycle: parseLifecycle(record.lifecycle),
    worktrees: parseWorktrees(record.worktrees),
    kestrelOne: parseKestrelOne(record.kestrelOne),
    confirmations: requireArray(
      record.confirmations,
      "uninstall plan.confirmations",
    ).map(parseConfirmation),
    blockers: requireArray(record.blockers, "uninstall plan.blockers").map(
      parseBlocker,
    ),
  };
}

function parseOptions(value: unknown): Required<KestrelUninstallPlanOptions> {
  const record = requireRecord(value, "uninstall plan.options");
  rejectUnknownFields(
    record,
    new Set([
      "disconnectKestrelOne",
      "exportWorktreesDirectory",
      "discardWorktrees",
    ]),
    "uninstall plan.options",
  );
  return {
    disconnectKestrelOne: requireBoolean(
      record.disconnectKestrelOne,
      "uninstall plan.options.disconnectKestrelOne",
    ),
    exportWorktreesDirectory:
      record.exportWorktreesDirectory === undefined
        ? ""
        : requireString(
            record.exportWorktreesDirectory,
            "uninstall plan.options.exportWorktreesDirectory",
          ),
    discardWorktrees: requireBoolean(
      record.discardWorktrees,
      "uninstall plan.options.discardWorktrees",
    ),
  };
}

function parseTarget(value: unknown): KestrelUninstallTarget {
  const record = requireRecord(value, "uninstall target");
  rejectUnknownFields(
    record,
    new Set([
      "id",
      "kind",
      "path",
      "verified",
      "selected",
      "removal",
      "fingerprint",
      "evidence",
      "command",
      "blockedReason",
    ]),
    "uninstall target",
  );
  return {
    id: requireString(record.id, "uninstall target.id"),
    kind: requireString(record.kind, "uninstall target.kind") as KestrelUninstallTarget["kind"],
    ...(record.path !== undefined
      ? { path: requireString(record.path, "uninstall target.path") }
      : {}),
    verified: requireBoolean(record.verified, "uninstall target.verified"),
    selected: requireBoolean(record.selected, "uninstall target.selected"),
    removal: requireString(record.removal, "uninstall target.removal") as KestrelUninstallTarget["removal"],
    fingerprint: requireString(
      record.fingerprint,
      "uninstall target.fingerprint",
    ),
    evidence: requireArray(record.evidence, "uninstall target.evidence").map(
      (entry, index) => requireString(entry, `uninstall target.evidence[${index}]`),
    ),
    ...(record.command !== undefined
      ? {
          command: requireArray(record.command, "uninstall target.command").map(
            (entry, index) => requireString(entry, `uninstall target.command[${index}]`),
          ),
        }
      : {}),
    ...(record.blockedReason !== undefined
      ? {
          blockedReason: requireString(
            record.blockedReason,
            "uninstall target.blockedReason",
          ),
        }
      : {}),
  };
}

function parseLifecycle(value: unknown): KestrelUninstallLifecycle {
  const record = requireRecord(value, "uninstall lifecycle");
  rejectUnknownFields(
    record,
    new Set(["state", "owner", "blockers"]),
    "uninstall lifecycle",
  );
  const state = requireEnum(
    record.state,
    ["idle", "busy", "missing", "unavailable"],
    "uninstall lifecycle.state",
  );
  const owner =
    record.owner === undefined
      ? undefined
      : (() => {
          const ownerRecord = requireRecord(
            record.owner,
            "uninstall lifecycle.owner",
          );
          rejectUnknownFields(
            ownerRecord,
            new Set(["pid", "executable"]),
            "uninstall lifecycle.owner",
          );
          return {
            pid: requireInteger(ownerRecord.pid, "uninstall lifecycle.owner.pid"),
            executable: requireString(
              ownerRecord.executable,
              "uninstall lifecycle.owner.executable",
            ),
          };
        })();
  return {
    state,
    ...(owner !== undefined ? { owner } : {}),
    blockers: requireArray(record.blockers, "uninstall lifecycle.blockers").map(
      parseBlocker,
    ),
  };
}

function parseWorktrees(value: unknown): KestrelUninstallWorktreeSummary {
  const record = requireRecord(value, "uninstall worktrees");
  rejectUnknownFields(
    record,
    new Set(["cleanDisposable", "retained", "blocked", "totalBytes", "entries"]),
    "uninstall worktrees",
  );
  return {
    cleanDisposable: requireInteger(
      record.cleanDisposable,
      "uninstall worktrees.cleanDisposable",
    ),
    retained: requireInteger(record.retained, "uninstall worktrees.retained"),
    blocked: requireInteger(record.blocked, "uninstall worktrees.blocked"),
    totalBytes: requireInteger(record.totalBytes, "uninstall worktrees.totalBytes"),
    entries: requireArray(record.entries, "uninstall worktrees.entries").map(
      (entry) => {
        const entryRecord = requireRecord(entry, "uninstall worktree entry");
        rejectUnknownFields(
          entryRecord,
          new Set([
            "worktreeRoot",
            "disposition",
            "dirty",
            "aheadCommitCount",
            "storageBytes",
            "reasons",
          ]),
          "uninstall worktree entry",
        );
        return {
          worktreeRoot: requireString(
            entryRecord.worktreeRoot,
            "uninstall worktree entry.worktreeRoot",
          ),
          disposition: requireString(
            entryRecord.disposition,
            "uninstall worktree entry.disposition",
          ) as KestrelUninstallWorktreeSummary["entries"][number]["disposition"],
          dirty: requireBoolean(entryRecord.dirty, "uninstall worktree entry.dirty"),
          aheadCommitCount: requireInteger(
            entryRecord.aheadCommitCount,
            "uninstall worktree entry.aheadCommitCount",
          ),
          storageBytes: requireInteger(
            entryRecord.storageBytes,
            "uninstall worktree entry.storageBytes",
          ),
          reasons: requireArray(
            entryRecord.reasons,
            "uninstall worktree entry.reasons",
          ).map((reason, index) =>
            requireString(reason, `uninstall worktree entry.reasons[${index}]`),
          ),
        };
      },
    ),
  };
}

function parseKestrelOne(value: unknown): KestrelUninstallKestrelOneSummary {
  const record = requireRecord(value, "uninstall Kestrel One");
  rejectUnknownFields(
    record,
    new Set(["disconnectSelected", "environments"]),
    "uninstall Kestrel One",
  );
  return {
    disconnectSelected: requireBoolean(
      record.disconnectSelected,
      "uninstall Kestrel One.disconnectSelected",
    ),
    environments: requireArray(
      record.environments,
      "uninstall Kestrel One.environments",
    ).map((entry) => {
      const entryRecord = requireRecord(entry, "uninstall Kestrel One environment");
      rejectUnknownFields(
        entryRecord,
        new Set(["connectionId", "organizationId", "baseUrl", "status"]),
        "uninstall Kestrel One environment",
      );
      return {
        connectionId: requireString(
          entryRecord.connectionId,
          "uninstall Kestrel One environment.connectionId",
        ),
        ...(entryRecord.organizationId !== undefined
          ? {
              organizationId: requireString(
                entryRecord.organizationId,
                "uninstall Kestrel One environment.organizationId",
              ),
            }
          : {}),
        ...(entryRecord.baseUrl !== undefined
          ? {
              baseUrl: requireString(
                entryRecord.baseUrl,
                "uninstall Kestrel One environment.baseUrl",
              ),
            }
          : {}),
        ...(entryRecord.status !== undefined
          ? {
              status: requireString(
                entryRecord.status,
                "uninstall Kestrel One environment.status",
              ),
            }
          : {}),
      };
    }),
  };
}

function parseConfirmation(value: unknown): KestrelUninstallConfirmation {
  const record = requireRecord(value, "uninstall confirmation");
  rejectUnknownFields(
    record,
    new Set(["kind", "phrase"]),
    "uninstall confirmation",
  );
  return {
    kind: requireString(
      record.kind,
      "uninstall confirmation.kind",
    ) as KestrelUninstallConfirmation["kind"],
    phrase: requireString(record.phrase, "uninstall confirmation.phrase"),
  };
}

function parseBlocker(value: unknown): KestrelUninstallBlocker {
  const record = requireRecord(value, "uninstall blocker");
  rejectUnknownFields(
    record,
    new Set(["code", "message", "targetId"]),
    "uninstall blocker",
  );
  return {
    code: requireString(record.code, "uninstall blocker.code"),
    message: requireString(record.message, "uninstall blocker.message"),
    ...(record.targetId !== undefined
      ? { targetId: requireString(record.targetId, "uninstall blocker.targetId") }
      : {}),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (Array.isArray(value) === false) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || Number.isSafeInteger(value) === false) {
    throw new Error(`${label} must be an integer.`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || allowed.includes(value as T) === false) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T;
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const field of Object.keys(record)) {
    if (allowed.has(field) === false) {
      throw new Error(`${label} has unsupported field '${field}'.`);
    }
  }
}

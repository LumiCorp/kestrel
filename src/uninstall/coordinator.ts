import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { uninstallManagedService } from "../../cli/kcron/service.js";
import { LocalCoreClient } from "../localCore/client.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "../localCore/home.js";
import { detectLocalCoreMigrationState } from "../localCore/legacyState.js";
import { readCoreManifest } from "../localCore/manifest.js";
import {
  hasMacosLocalCoreKeychainServiceItems,
  purgeMacosLocalCoreKeychainService,
} from "../localCore/macosKeychainCredentialStore.js";
import {
  ManagedTaskWorktreeService,
  type ManagedTaskWorktreeInventoryEntry,
} from "../workspace/ManagedTaskWorktreeService.js";
import {
  KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
  KESTREL_UNINSTALL_PLAN_VERSION,
  parseKestrelUninstallPlanV1,
  type KestrelUninstallApplyRequest,
  type KestrelUninstallApplyResultV1,
  type KestrelUninstallBlocker,
  type KestrelUninstallInitiator,
  type KestrelUninstallKestrelOneSummary,
  type KestrelUninstallLifecycle,
  type KestrelOneDisconnectResult,
  type KestrelUninstallDeferredCompletion,
  type KestrelUninstallPlanOptions,
  type KestrelUninstallPlanV1,
  type KestrelUninstallScope,
  type KestrelUninstallTarget,
  type KestrelUninstallWorktreeSummary,
} from "./contracts.js";

const execFileAsync = promisify(execFile);
const KESTREL_PACKAGE_NAME = "@kestrel-agents/kestrel";
const DESKTOP_HELPER_NAME = "kestrel-uninstall-helper";
const CLI_BUNDLE_MANIFEST_NAME = "kestrel-bundle.json";
const UNINSTALL_REPORT_ROOT = "/private/var/tmp/com.kestrel.uninstall";
const NON_BLOCKING_APPLY_FAILURE_CODES = new Set([
  "KESTREL_ONE_DISCONNECT_FAILED",
  "UNINSTALL_CLI_FINALIZER_SCHEDULED",
  "DESKTOP_PRIVACY_RESET_FAILED",
]);

export interface KestrelUninstallCoordinatorOperations {
  now?(): Date;
  inventoryTargets?(input: {
    initiator: KestrelUninstallInitiator;
    scope: KestrelUninstallScope;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): Promise<KestrelUninstallTarget[]>;
  inspectLifecycle?(input: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): Promise<KestrelUninstallLifecycle>;
  inspectWorktrees?(input: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): Promise<KestrelUninstallWorktreeSummary>;
  inspectKestrelOne?(input: {
    lifecycle: KestrelUninstallLifecycle;
    disconnectSelected: boolean;
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): Promise<KestrelUninstallKestrelOneSummary>;
  unlinkPath?(targetPath: string): Promise<void>;
  removePath?(targetPath: string): Promise<void>;
  trashPath?(targetPath: string): Promise<void>;
  runPackageManager?(command: string[]): Promise<void>;
  scheduleCliFinalizer?(
    target: KestrelUninstallTarget,
    planId: string,
  ): Promise<string | void>;
  unloadKcron?(): Promise<void>;
  purgeKeychain?(): Promise<void>;
  keychainServiceHasItems?(): Promise<boolean>;
  resetDesktopPrivacy?(): Promise<void>;
  shutdownLocalCore?(platform: NodeJS.Platform): Promise<void>;
  disconnectKestrelOne?(
    connectionId: string,
  ): Promise<"disconnected" | "already_disconnected" | void>;
  listManagedWorktrees?(input: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): Promise<ManagedTaskWorktreeInventoryEntry[]>;
  createRecoveryBundle?(
    entry: ManagedTaskWorktreeInventoryEntry,
    exportRoot: string,
    ignoredFiles: string[],
  ): Promise<void>;
  removeManagedWorktree?(entry: ManagedTaskWorktreeInventoryEntry): Promise<void>;
  listGitFiles?(worktreeRoot: string, args: string[]): Promise<string[]>;
  listProtectedPaths?(input: {
    env: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
  }): Promise<string[]>;
}

export interface CreateKestrelUninstallPlanInput {
  initiator: KestrelUninstallInitiator;
  scope: KestrelUninstallScope;
  options?: KestrelUninstallPlanOptions | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  now?: Date | undefined;
  operations?: KestrelUninstallCoordinatorOperations | undefined;
}

export async function createKestrelUninstallPlan(
  input: CreateKestrelUninstallPlanInput,
): Promise<KestrelUninstallPlanV1> {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin" && process.platform === "darwin") {
    await pruneExpiredUninstallReports().catch(() => {});
  }
  const env = input.env ?? process.env;
  const operations = input.operations ?? {};
  const options = normalizeOptions(input.options);
  const blockers: KestrelUninstallBlocker[] = [];
  if (platform !== "darwin") {
    blockers.push({
      code: "UNINSTALL_PLATFORM_UNSUPPORTED",
      message: "Kestrel uninstall v1 supports macOS only.",
    });
  }

  let targets = operations.inventoryTargets !== undefined
    ? await operations.inventoryTargets({
        initiator: input.initiator,
        scope: input.scope,
        env,
        platform,
      })
    : [
        ...(await inventoryCliSymlinks({
          initiator: input.initiator,
          scope: input.scope,
          env,
        })),
        await inventoryKcronLaunchAgent({
          initiator: input.initiator,
          scope: input.scope,
        }),
        ...(await inventoryDesktopBundles({
          initiator: input.initiator,
          scope: input.scope,
        })),
        ...(await inventoryStateTargets({
          scope: input.scope,
          env,
          platform,
        })),
      ].filter((target): target is KestrelUninstallTarget => target !== undefined);
  targets = await deduplicateSelectedTargets(targets);

  for (const target of targets) {
    if (target.selected && target.verified === false) {
      blockers.push({
        code: "UNINSTALL_TARGET_UNVERIFIED",
        message: `Uninstall target '${target.id}' is not verified.`,
        targetId: target.id,
      });
    }
    if (target.selected && target.blockedReason !== undefined) {
      blockers.push({
        code: "UNINSTALL_TARGET_BLOCKED",
        message: target.blockedReason,
        targetId: target.id,
      });
    }
  }

  const lifecycle = operations.inspectLifecycle !== undefined
    ? await operations.inspectLifecycle({ env, platform })
    : await inspectLocalCoreLifecycle({ env, platform });
  blockers.push(...lifecycle.blockers);
  const protectedPaths = operations.listProtectedPaths !== undefined
    ? await operations.listProtectedPaths({ env, platform })
    : await listRegisteredExternalProjectPaths({ lifecycle, env, platform });
  blockers.push(...await protectedPathBlockers(targets, protectedPaths));

  const worktrees = operations.inspectWorktrees !== undefined
    ? await operations.inspectWorktrees({ env, platform })
    : await inspectManagedWorktrees({ env, platform });
  if (input.scope === "complete" && worktrees.blocked > 0) {
    blockers.push({
      code: "UNINSTALL_WORKTREES_BLOCKED",
      message:
        "Managed worktrees with active, leased, or invalid lifecycle state block complete uninstall.",
    });
  }
  if (
    input.scope === "complete" &&
    worktrees.retained > 0 &&
    options.discardWorktrees === false &&
    (options.exportWorktreesDirectory ?? "").length === 0
  ) {
    blockers.push({
      code: "UNINSTALL_WORKTREE_RECOVERY_REQUIRED",
      message:
        "Dirty or unpromoted managed worktrees require a recovery export or explicit discard.",
    });
  }

  const kestrelOne = operations.inspectKestrelOne !== undefined
    ? await operations.inspectKestrelOne({
        lifecycle,
        disconnectSelected: options.disconnectKestrelOne === true,
        env,
        platform,
      })
    : await inspectKestrelOne({
        lifecycle,
        disconnectSelected: options.disconnectKestrelOne === true,
        env,
        platform,
      });
  const confirmations = [
    { kind: "plan_id" as const, phrase: "" },
    ...(input.scope === "complete"
      ? [{ kind: "delete_data" as const, phrase: "DELETE KESTREL DATA" }]
      : []),
    ...(worktrees.retained > 0 || options.discardWorktrees
      ? [
          {
            kind: "discard_worktrees" as const,
            phrase: `DISCARD ${worktrees.retained} KESTREL WORKTREES`,
          },
        ]
      : []),
  ];

  const generatedAt = (input.now ?? operations.now?.() ?? new Date()).toISOString();
  const planWithoutId = {
    version: KESTREL_UNINSTALL_PLAN_VERSION,
    planId: "",
    generatedAt,
    platform,
    initiator: input.initiator,
    scope: input.scope,
    options,
    targets,
    lifecycle,
    worktrees,
    kestrelOne,
    confirmations,
    blockers,
  } satisfies KestrelUninstallPlanV1;
  const planId = hashPlan(planWithoutId);
  return {
    ...planWithoutId,
    planId,
    confirmations: confirmations.map((confirmation) =>
      confirmation.kind === "plan_id"
        ? { ...confirmation, phrase: planId }
        : confirmation,
    ),
  };
}

export async function applyKestrelUninstallPlan(
  request: KestrelUninstallApplyRequest & {
    deferredTargetIds?: string[] | undefined;
    operations?: KestrelUninstallCoordinatorOperations | undefined;
  },
): Promise<KestrelUninstallApplyResultV1> {
  const plan = parseKestrelUninstallPlanV1(request.plan);
  const operations = request.operations ?? {};
  const deferredTargetIds = new Set(request.deferredTargetIds ?? []);
  if (request.confirmPlanId !== plan.planId) {
    throw new Error("Uninstall apply requires the matching plan id.");
  }
  if (
    plan.scope === "complete" &&
    request.deleteDataPhrase !== "DELETE KESTREL DATA"
  ) {
    throw new Error("Complete uninstall requires DELETE KESTREL DATA.");
  }
  const discardPhrase = plan.confirmations.find(
    (confirmation) => confirmation.kind === "discard_worktrees",
  )?.phrase;
  if (
    plan.options.discardWorktrees &&
    discardPhrase !== undefined &&
    request.discardWorktreesPhrase !== discardPhrase
  ) {
    throw new Error(`Worktree discard requires ${discardPhrase}.`);
  }

  const current = await createKestrelUninstallPlan({
    initiator: plan.initiator,
    scope: plan.scope,
    options: plan.options,
    platform: plan.platform,
    operations,
  });
  const staleBlockers = buildStalePlanBlockers(plan, current);
  if (staleBlockers.length > 0) {
    return {
      version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
      planId: plan.planId,
      appliedAt: (operations.now?.() ?? new Date()).toISOString(),
      status: "blocked",
      removedTargets: [],
      skippedTargets: [],
      blockers: staleBlockers,
      finalTargets: current.targets,
      kestrelOneDisconnects: [],
      deferredCompletions: [],
    };
  }
  if (current.blockers.length > 0) {
    return {
      version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
      planId: plan.planId,
      appliedAt: (operations.now?.() ?? new Date()).toISOString(),
      status: "blocked",
      removedTargets: [],
      skippedTargets: [],
      blockers: current.blockers,
      finalTargets: current.targets,
      kestrelOneDisconnects: [],
      deferredCompletions: [],
    };
  }
  if (plan.blockers.length > 0) {
    return {
      version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
      planId: plan.planId,
      appliedAt: (operations.now?.() ?? new Date()).toISOString(),
      status: "blocked",
      removedTargets: [],
      skippedTargets: [],
      blockers: plan.blockers,
      finalTargets: current.targets,
      kestrelOneDisconnects: [],
      deferredCompletions: [],
    };
  }
  if (request.dryRun === true) {
    return {
      version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
      planId: plan.planId,
      appliedAt: (operations.now?.() ?? new Date()).toISOString(),
      status: "applied",
      removedTargets: [],
      skippedTargets: plan.targets.filter((target) => target.selected).map((target) => target.id),
      blockers: [],
      finalTargets: current.targets,
      kestrelOneDisconnects: [],
      deferredCompletions: [],
    };
  }

  const removedTargets: string[] = [];
  const skippedTargets: string[] = [];
  const blockers: KestrelUninstallBlocker[] = [];
  const kestrelOneDisconnects: KestrelOneDisconnectResult[] = [];
  const deferredCompletions: KestrelUninstallDeferredCompletion[] = [];

  if (plan.scope === "complete") {
    const recovery = await recoverOrDiscardManagedWorktrees(plan, operations);
    blockers.push(...recovery.blockers);
    if (blockers.length > 0) {
      return await buildApplyResult(
        plan,
        removedTargets,
        skippedTargets,
        blockers,
        operations,
        deferredTargetIds,
        kestrelOneDisconnects,
        deferredCompletions,
      );
    }
  }

  if (plan.options.disconnectKestrelOne) {
    for (const environment of plan.kestrelOne.environments) {
      try {
        let outcome: "disconnected" | "already_disconnected" | void;
        if (operations.disconnectKestrelOne !== undefined) {
          outcome = await operations.disconnectKestrelOne(environment.connectionId);
        } else {
          await disconnectKestrelOneEnvironment(environment.connectionId, plan.platform);
          outcome = "disconnected";
        }
        kestrelOneDisconnects.push({
          connectionId: environment.connectionId,
          baseUrl: environment.baseUrl ?? "",
          status: outcome === "already_disconnected"
            ? "already_disconnected"
            : "disconnected",
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        const message = safeDisconnectErrorMessage(errorCode);
        kestrelOneDisconnects.push({
          connectionId: environment.connectionId,
          baseUrl: environment.baseUrl ?? "",
          status: "failed",
          errorCode,
          message,
        });
        blockers.push({
          code: "KESTREL_ONE_DISCONNECT_FAILED",
          message: `Kestrel One environment ${environment.connectionId} (${environment.baseUrl ?? "unknown base URL"}) could not be disconnected: ${message}`,
        });
      }
    }
  }

  const selectedKcronTargets = plan.targets.filter(
    (target) => target.selected && target.kind === "kcron_launch_agent",
  );
  for (const target of selectedKcronTargets) {
    try {
      await removeTarget(target, operations, plan.planId);
      removedTargets.push(target.id);
    } catch (error) {
      return await buildApplyResult(
        plan,
        removedTargets,
        skippedTargets,
        [
          ...blockers,
          {
            code: "KCRON_UNLOAD_FAILED",
            message: error instanceof Error ? error.message : String(error),
            targetId: target.id,
          },
        ],
        operations,
        deferredTargetIds,
        kestrelOneDisconnects,
        deferredCompletions,
      );
    }
  }

  if (plan.scope === "all_software" || plan.scope === "complete") {
    try {
      if (operations.shutdownLocalCore !== undefined) {
        await operations.shutdownLocalCore(plan.platform);
      } else {
        await shutdownLocalCoreIfPresent({ platform: plan.platform });
      }
    } catch (error) {
      return await buildApplyResult(plan, removedTargets, skippedTargets, [
        ...blockers,
        {
          code: "LOCAL_CORE_SHUTDOWN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      operations,
      deferredTargetIds,
      kestrelOneDisconnects,
      deferredCompletions);
    }
  }

  const currentTargetIds = new Set(current.targets.map((target) => target.id));
  const processedTargetIds = new Set(removedTargets);
  let desktopPrivacyReset = false;
  for (const target of [...plan.targets].sort(
    (left, right) => applyTargetPriority(left) - applyTargetPriority(right),
  )) {
    if (
      desktopPrivacyReset === false &&
      applyTargetPriority(target) >= 20 &&
      plan.targets.some(
        (candidate) =>
          candidate.selected && candidate.kind === "desktop_bundle",
      )
    ) {
      desktopPrivacyReset = true;
      try {
        if (operations.resetDesktopPrivacy !== undefined) {
          await operations.resetDesktopPrivacy();
        } else if (plan.platform === "darwin" && process.platform === "darwin") {
          await execFileAsync(
            "/usr/bin/tccutil",
            ["reset", "All", "com.kestrel.desktop"],
            { timeout: 5_000 },
          );
        }
      } catch (error) {
        blockers.push({
          code: "DESKTOP_PRIVACY_RESET_FAILED",
          message: `macOS privacy reset failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    if (processedTargetIds.has(target.id)) continue;
    if (target.selected === false) {
      skippedTargets.push(target.id);
      continue;
    }
    if (deferredTargetIds.has(target.id)) {
      skippedTargets.push(target.id);
      continue;
    }
    if (target.kind !== "keychain_service" && currentTargetIds.has(target.id) === false) {
      skippedTargets.push(target.id);
      continue;
    }
    try {
      const removal = await removeTarget(target, operations, plan.planId);
      if (removal?.deferredCompletion !== undefined) {
        deferredCompletions.push(removal.deferredCompletion);
        deferredTargetIds.add(target.id);
        skippedTargets.push(target.id);
        blockers.push({
          code: "UNINSTALL_CLI_FINALIZER_SCHEDULED",
          message: `Target '${target.id}' is scheduled for removal after the running CLI exits. Report: ${removal.deferredCompletion.reportPath}`,
          targetId: target.id,
        });
        continue;
      }
      removedTargets.push(target.id);
      processedTargetIds.add(target.id);
    } catch (error) {
      blockers.push({
        code: "UNINSTALL_TARGET_REMOVE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        targetId: target.id,
      });
      if (target.kind === "keychain_service") {
        return await buildApplyResult(
          plan,
          removedTargets,
          skippedTargets,
          blockers,
          operations,
          deferredTargetIds,
          kestrelOneDisconnects,
          deferredCompletions,
        );
      }
    }
  }

  return await buildApplyResult(
    plan,
    removedTargets,
    skippedTargets,
    blockers,
    operations,
    deferredTargetIds,
    kestrelOneDisconnects,
    deferredCompletions,
  );
}

function applyTargetPriority(target: KestrelUninstallTarget): number {
  if (target.kind === "keychain_service") return 0;
  if (
    target.kind === "state_root" ||
    target.kind === "electron_profile" ||
    target.kind === "legacy_root" ||
    target.kind === "preferences" ||
    target.kind === "cache" ||
    target.kind === "saved_state"
  ) {
    return 10;
  }
  if (target.kind === "kcron_launch_agent") return 15;
  return 20;
}

export function formatKestrelUninstallPlan(plan: KestrelUninstallPlanV1): string {
  const selected = plan.targets.filter((target) => target.selected);
  const lines = [
    `Uninstall plan: ${plan.planId}`,
    `Scope: ${plan.scope}`,
    `Initiator: ${plan.initiator}`,
    `Local Core: ${plan.lifecycle.state}`,
    `Selected targets: ${selected.length}`,
    ...selected.map((target) => `- ${target.id}: ${target.path ?? target.kind}`),
    `Blockers: ${plan.blockers.length}`,
    ...plan.blockers.map((blocker) => `- ${blocker.code}: ${blocker.message}`),
    ...plan.confirmations
      .filter((confirmation) => confirmation.kind !== "plan_id")
      .map((confirmation) => `Confirmation required: ${confirmation.phrase}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function normalizeOptions(
  options: KestrelUninstallPlanOptions | undefined,
): Required<KestrelUninstallPlanOptions> {
  return {
    disconnectKestrelOne: options?.disconnectKestrelOne === true,
    exportWorktreesDirectory: options?.exportWorktreesDirectory?.trim() ?? "",
    discardWorktrees: options?.discardWorktrees === true,
  };
}

async function deduplicateSelectedTargets(
  targets: KestrelUninstallTarget[],
): Promise<KestrelUninstallTarget[]> {
  const canonical = new Map<string, string>();
  for (const target of targets) {
    if (target.path === undefined) continue;
    const resolved = await realpath(target.path).catch(() =>
      path.resolve(target.path!),
    );
    canonical.set(target.id, resolved);
  }
  const selectedRoots = targets
    .filter(
      (target) =>
        target.selected &&
        target.path !== undefined &&
        (target.removal === "rm" || target.removal === "trash"),
    )
    .sort(
      (left, right) =>
        (canonical.get(left.id)?.length ?? 0) -
        (canonical.get(right.id)?.length ?? 0),
    );
  const coveringRoots: Array<{ id: string; path: string }> = [];
  return targets.map((target) => {
    const targetPath = canonical.get(target.id);
    if (target.selected === false || targetPath === undefined) return target;
    const covering = coveringRoots.find(
      (root) => root.path === targetPath || isAncestor(root.path, targetPath),
    );
    if (covering !== undefined) {
      return {
        ...target,
        selected: false,
        evidence: [
          ...target.evidence,
          `covered by selected target ${covering.id}`,
        ],
      };
    }
    if (selectedRoots.some((candidate) => candidate.id === target.id)) {
      coveringRoots.push({ id: target.id, path: targetPath });
    }
    return target;
  });
}

async function listRegisteredExternalProjectPaths(input: {
  lifecycle: KestrelUninstallLifecycle;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<string[]> {
  if (
    input.lifecycle.state === "missing" ||
    input.lifecycle.state === "unavailable"
  ) {
    return [];
  }
  try {
    const client = await localCoreClientFor({
      env: input.env,
      platform: input.platform,
    });
    const projection = await client.desktopSettings<{
      projects?: unknown;
    }>();
    if (Array.isArray(projection.settings.projects) === false) return [];
    return projection.settings.projects.flatMap((project) => {
      if (typeof project !== "object" || project === null) return [];
      const candidate = (project as { path?: unknown }).path;
      return typeof candidate === "string" && path.isAbsolute(candidate)
        ? [candidate]
        : [];
    });
  } catch {
    return [];
  }
}

async function protectedPathBlockers(
  targets: KestrelUninstallTarget[],
  protectedPaths: string[],
): Promise<KestrelUninstallBlocker[]> {
  const canonicalProtected = (
    await Promise.all(
      protectedPaths.map((candidate) =>
        realpath(candidate).catch(() => path.resolve(candidate)),
      ),
    )
  ).filter((candidate, index, all) => all.indexOf(candidate) === index);
  const blockers: KestrelUninstallBlocker[] = [];
  for (const target of targets) {
    if (
      target.selected === false ||
      target.path === undefined ||
      target.removal === "unlink" ||
      target.removal === "package_manager"
    ) {
      continue;
    }
    if (path.isAbsolute(target.path) === false || path.normalize(target.path) !== target.path) {
      blockers.push({
        code: "UNINSTALL_TARGET_PATH_INVALID",
        message: `Selected target '${target.id}' is not a canonical absolute path.`,
        targetId: target.id,
      });
      continue;
    }
    const targetPath = await realpath(target.path).catch(() =>
      path.resolve(target.path!),
    );
    for (const protectedPath of canonicalProtected) {
      if (
        targetPath === protectedPath ||
        isAncestor(targetPath, protectedPath)
      ) {
        blockers.push({
          code: "UNINSTALL_PROTECTED_EXTERNAL_PATH",
          message: `Selected target '${target.id}' contains registered external project '${protectedPath}'.`,
          targetId: target.id,
        });
      }
    }
    if (
      target.kind !== "desktop_bundle" &&
      existsSync(path.join(targetPath, ".git"))
    ) {
      blockers.push({
        code: "UNINSTALL_SOURCE_REPOSITORY_PROTECTED",
        message: `Selected target '${target.id}' is a source repository.`,
        targetId: target.id,
      });
    }
  }
  return blockers;
}

function buildStalePlanBlockers(
  planned: KestrelUninstallPlanV1,
  current: KestrelUninstallPlanV1,
): KestrelUninstallBlocker[] {
  const blockers: KestrelUninstallBlocker[] = [];
  const currentTargets = new Map(current.targets.map((target) => [target.id, target]));
  const plannedTargets = new Map(planned.targets.map((target) => [target.id, target]));
  for (const target of planned.targets.filter((entry) => entry.selected)) {
    if (target.kind === "keychain_service") continue;
    const currentTarget = currentTargets.get(target.id);
    if (currentTarget === undefined) continue;
    if (sameTargetIdentity(target, currentTarget) === false) {
      blockers.push(staleBlocker(`Selected target '${target.id}' changed since planning.`, target.id));
    }
  }
  for (const target of current.targets.filter((entry) => entry.selected)) {
    if (target.kind === "keychain_service") continue;
    if (plannedTargets.has(target.id) === false) {
      blockers.push(staleBlocker(`New selected target '${target.id}' appeared since planning.`, target.id));
    }
  }
  if (current.lifecycle.blockers.length > 0) return blockers;
  if (
    current.lifecycle.state !== planned.lifecycle.state &&
    (planned.lifecycle.state === "idle" && current.lifecycle.state === "missing") === false
  ) {
    blockers.push(staleBlocker("Local Core lifecycle changed since planning."));
  }
  blockers.push(...staleWorktreeBlockers(planned, current));
  blockers.push(...staleKestrelOneBlockers(planned, current));
  return blockers;
}

function sameTargetIdentity(
  left: KestrelUninstallTarget,
  right: KestrelUninstallTarget,
): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    left.verified === right.verified &&
    left.removal === right.removal &&
    left.fingerprint === right.fingerprint &&
    JSON.stringify(left.command ?? []) === JSON.stringify(right.command ?? [])
  );
}

function staleWorktreeBlockers(
  planned: KestrelUninstallPlanV1,
  current: KestrelUninstallPlanV1,
): KestrelUninstallBlocker[] {
  if (planned.scope !== "complete") return [];
  const blockers: KestrelUninstallBlocker[] = [];
  const plannedEntries = new Map(planned.worktrees.entries.map((entry) => [entry.worktreeRoot, entry]));
  const currentEntries = new Map(current.worktrees.entries.map((entry) => [entry.worktreeRoot, entry]));
  for (const entry of current.worktrees.entries) {
    if (plannedEntries.has(entry.worktreeRoot) === false) {
      blockers.push(staleBlocker(`Managed worktree '${entry.worktreeRoot}' appeared since planning.`));
    }
  }
  for (const entry of planned.worktrees.entries) {
    const currentEntry = currentEntries.get(entry.worktreeRoot);
    if (currentEntry === undefined) continue;
    if (
      entry.disposition !== currentEntry.disposition ||
      entry.dirty !== currentEntry.dirty ||
      entry.aheadCommitCount !== currentEntry.aheadCommitCount ||
      entry.ignoredFileCount !== currentEntry.ignoredFileCount ||
      entry.ignoredBytes !== currentEntry.ignoredBytes ||
      JSON.stringify(entry.reasons) !== JSON.stringify(currentEntry.reasons)
    ) {
      blockers.push(staleBlocker(`Managed worktree '${entry.worktreeRoot}' changed since planning.`));
    }
  }
  return blockers;
}

function staleKestrelOneBlockers(
  planned: KestrelUninstallPlanV1,
  current: KestrelUninstallPlanV1,
): KestrelUninstallBlocker[] {
  if (planned.options.disconnectKestrelOne === false) return [];
  const blockers: KestrelUninstallBlocker[] = [];
  const plannedEnvironments = new Map(
    planned.kestrelOne.environments.map((environment) => [environment.connectionId, environment]),
  );
  for (const environment of current.kestrelOne.environments) {
    const plannedEnvironment = plannedEnvironments.get(environment.connectionId);
    if (plannedEnvironment === undefined) {
      blockers.push(staleBlocker(`Kestrel One environment '${environment.connectionId}' appeared since planning.`));
      continue;
    }
    if (
      plannedEnvironment.organizationId !== environment.organizationId ||
      plannedEnvironment.baseUrl !== environment.baseUrl
    ) {
      blockers.push(staleBlocker(`Kestrel One environment '${environment.connectionId}' changed since planning.`));
    }
  }
  return blockers;
}

function staleBlocker(message: string, targetId?: string | undefined): KestrelUninstallBlocker {
  return {
    code: "UNINSTALL_PLAN_STALE",
    message: `${message} Re-run planning before applying destructive changes.`,
    ...(targetId !== undefined ? { targetId } : {}),
  };
}

async function inventoryCliSymlinks(input: {
  initiator: KestrelUninstallInitiator;
  scope: KestrelUninstallScope;
  env: NodeJS.ProcessEnv;
}): Promise<KestrelUninstallTarget[]> {
  const packageRoot = await findPackageRoot();
  const expected = new Map([
    ["kestrel", path.join(packageRoot, "bin", "kestrel.js")],
    ["ks", path.join(packageRoot, "bin", "kestrel.js")],
    ["kcron", path.join(packageRoot, "bin", "kcron.js")],
  ]);
  const pnpmHome =
    input.env.PNPM_HOME?.trim() ||
    path.join(os.homedir(), "Library", "pnpm");
  const selected =
    input.scope === "all_software" ||
    input.scope === "complete" ||
    (input.scope === "current_component" && input.initiator === "cli");
  const targets: KestrelUninstallTarget[] = [];
  const seenBundleRoots = new Set<string>();
  const seenPackageRoots = new Set<string>();
  for (const [name, expectedTarget] of expected) {
    const linkPath = path.join(pnpmHome, name);
    const link = await readSymlinkTarget(linkPath);
    if (link === undefined) continue;
    const verified = link.realTarget === path.resolve(expectedTarget);
    if (verified) {
      targets.push({
        id: `cli.symlink.${name}`,
        kind: "cli_symlink",
        path: linkPath,
        verified,
        selected,
        removal: "unlink",
        fingerprint: hashValue({ linkPath, realTarget: link.realTarget, verified }),
        evidence: [`symlink target ${link.realTarget}`],
      });
      continue;
    }
    const bundle = await inspectCliBundle(link.realTarget);
    if (bundle !== undefined) {
      if (seenBundleRoots.has(bundle.rootPath) === false) {
        seenBundleRoots.add(bundle.rootPath);
        targets.push({
          id: `cli.bundle.${hashString(bundle.rootPath).slice(0, 12)}`,
          kind: "cli_bundle",
          path: bundle.rootPath,
          verified: true,
          selected,
          removal: "rm",
          fingerprint: hashValue(bundle.manifest),
          evidence: [
            `bundle version ${bundle.manifest.version}`,
            `bundle package ${bundle.manifest.package}`,
            `launcher symlink ${linkPath}`,
          ],
        });
      }
      targets.push({
        id: `cli.symlink.${name}`,
        kind: "cli_symlink",
        path: linkPath,
        verified: true,
        selected,
        removal: "unlink",
        fingerprint: hashValue({ linkPath, realTarget: link.realTarget, bundleRoot: bundle.rootPath }),
        evidence: [`standalone bundle launcher ${link.realTarget}`],
      });
      continue;
    }
    const packageInstall = await inspectCliPackageInstall(link.realTarget, input.env);
    if (packageInstall !== undefined) {
      if (packageInstall.status === "ambiguous") {
        targets.push({
          id: `cli.package.${hashString(packageInstall.packageRoot).slice(0, 12)}`,
          kind: "cli_package",
          path: packageInstall.packageRoot,
          verified: false,
          selected,
          removal: "manual",
          fingerprint: hashValue(packageInstall),
          evidence: packageInstall.managers.map(
            (manager) => `matching package manager ${manager}`,
          ),
          blockedReason:
            "Multiple package managers claim the same global Kestrel installation.",
        });
        continue;
      }
      if (seenPackageRoots.has(packageInstall.packageRoot) === false) {
        seenPackageRoots.add(packageInstall.packageRoot);
        targets.push({
          id: `cli.package.${hashString(packageInstall.packageRoot).slice(0, 12)}`,
          kind: "cli_package",
          path: packageInstall.packageRoot,
          verified: true,
          selected,
          removal: "package_manager",
          command: packageInstall.command,
          fingerprint: hashValue(packageInstall),
          evidence: [
            `package ${packageInstall.name}`,
            `package manager ${packageInstall.command[0]}`,
            `launcher symlink ${linkPath}`,
          ],
        });
      }
      targets.push({
        id: `cli.symlink.${name}`,
        kind: "cli_symlink",
        path: linkPath,
        verified: true,
        selected,
        removal: "unlink",
        fingerprint: hashValue({ linkPath, realTarget: link.realTarget, packageRoot: packageInstall.packageRoot }),
        evidence: [`package launcher ${link.realTarget}`],
      });
      continue;
    }
    targets.push({
      id: `cli.symlink.${name}`,
      kind: "cli_symlink",
      path: linkPath,
      verified: false,
      selected,
      removal: "unlink",
      fingerprint: hashValue({ linkPath, realTarget: link.realTarget, verified }),
      evidence: [`foreign symlink target ${link.realTarget}`],
      blockedReason: "CLI symlink target is not a verified Kestrel source, bundle, or package install.",
    });
  }
  return targets;
}

async function inventoryKcronLaunchAgent(input: {
  initiator: KestrelUninstallInitiator;
  scope: KestrelUninstallScope;
}): Promise<KestrelUninstallTarget | undefined> {
  const filePath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    "com.kestrel.kcron.plist",
  );
  if (existsSync(filePath) === false) return undefined;
  const label = await execFileAsync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :Label", filePath],
    { timeout: 5_000 },
  ).then(({ stdout }) => stdout.trim()).catch(() => "");
  const pathIdentity = await fingerprintPath(filePath);
  const verified = label === "com.kestrel.kcron" && pathIdentity.verified;
  const selected =
    input.scope === "all_software" ||
    input.scope === "complete" ||
    (input.scope === "current_component" && input.initiator === "cli");
  return {
    id: "kcron.launch_agent",
    kind: "kcron_launch_agent",
    path: filePath,
    verified,
    selected,
    removal: "unlink",
    fingerprint: hashValue({
      filePath,
      label,
      pathFingerprint: pathIdentity.fingerprint,
    }),
    evidence: [
      ...(verified
        ? ["LaunchAgent label com.kestrel.kcron"]
        : [`LaunchAgent label '${label || "unreadable"}' is not verified`]),
      ...pathIdentity.evidence,
    ],
    ...(verified ? {} : { blockedReason: "kcron LaunchAgent label is not verified." }),
  };
}

async function inventoryDesktopBundles(input: {
  initiator: KestrelUninstallInitiator;
  scope: KestrelUninstallScope;
}): Promise<KestrelUninstallTarget[]> {
  const selected =
    input.scope === "all_software" ||
    input.scope === "complete" ||
    (input.scope === "current_component" && input.initiator === "desktop");
  const candidates = [
    path.join("/", "Applications", "Kestrel.app"),
    path.join(os.homedir(), "Applications", "Kestrel.app"),
  ];
  const targets: KestrelUninstallTarget[] = [];
  for (const bundlePath of candidates) {
    const infoPath = path.join(bundlePath, "Contents", "Info.plist");
    if (existsSync(infoPath) === false) continue;
    const helperPath = path.join(bundlePath, "Contents", "Resources", DESKTOP_HELPER_NAME);
    const identity = await inspectDesktopReleaseIdentity(bundlePath, helperPath);
    const verified = identity.verified;
    const blockedReason = selected && verified === false
      ? identity.blockedReason
      : undefined;
    targets.push({
      id: `desktop.bundle.${hashString(bundlePath).slice(0, 12)}`,
      kind: "desktop_bundle",
      path: bundlePath,
      verified,
      selected,
      removal: verified ? "trash" : "manual",
      ...(verified ? { command: [helperPath, "--plan", "<plan>"] } : {}),
      fingerprint: hashValue({
        bundlePath,
        bundleId: identity.bundleId,
        bundleRealPath: identity.bundleRealPath,
        bundleUid: identity.bundleUid,
        designatedRequirement: identity.designatedRequirement,
        signingAuthorities: identity.signingAuthorities,
        helperRealPath: identity.helperRealPath,
        helperUid: identity.helperUid,
        helperArchitectures: identity.helperArchitectures,
        helperDesignatedRequirement: identity.helperDesignatedRequirement,
      }),
      evidence: identity.evidence,
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    });
  }
  return targets;
}

async function inspectDesktopReleaseIdentity(
  bundlePath: string,
  helperPath: string,
): Promise<{
  verified: boolean;
  blockedReason: string;
  bundleId: string;
  bundleRealPath: string;
  bundleUid: number;
  designatedRequirement: string;
  signingAuthorities: string[];
  helperRealPath: string;
  helperUid: number;
  helperArchitectures: string[];
  helperDesignatedRequirement: string;
  evidence: string[];
}> {
  const empty = {
    verified: false,
    blockedReason:
      "Desktop self-removal requires an exact Developer ID-signed release bundle and signed arm64 helper.",
    bundleId: "",
    bundleRealPath: "",
    bundleUid: -1,
    designatedRequirement: "",
    signingAuthorities: [] as string[],
    helperRealPath: "",
    helperUid: -1,
    helperArchitectures: [] as string[],
    helperDesignatedRequirement: "",
    evidence: [] as string[],
  };
  try {
    const bundleEntry = await lstat(bundlePath);
    const helperEntry = await lstat(helperPath);
    const currentUid = process.getuid?.();
    const bundleRealPath = await realpath(bundlePath);
    const helperRealPath = await realpath(helperPath);
    const { stdout: bundleIdOutput } = await execFileAsync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :CFBundleIdentifier", path.join(bundlePath, "Contents", "Info.plist")],
      { timeout: 5_000 },
    );
    const bundleId = bundleIdOutput.trim();
    await execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--deep", "--strict", bundlePath],
      { timeout: 10_000 },
    );
    await execFileAsync(
      "/usr/bin/codesign",
      ["--verify", "--strict", helperPath],
      { timeout: 10_000 },
    );
    const bundleSignature = await codeSigningDetails(bundlePath);
    const helperSignature = await codeSigningDetails(helperPath);
    const { stdout: architecturesOutput } = await execFileAsync(
      "/usr/bin/lipo",
      ["-archs", helperPath],
      { timeout: 5_000 },
    );
    const helperArchitectures = architecturesOutput.trim().split(/\s+/u).filter(Boolean);
    const releaseAuthority = bundleSignature.authorities.some((authority) =>
      authority.startsWith("Developer ID Application:"),
    );
    const sameAuthority =
      bundleSignature.authorities.length > 0 &&
      bundleSignature.authorities[0] === helperSignature.authorities[0];
    const owned =
      currentUid === undefined ||
      (bundleEntry.uid === currentUid && helperEntry.uid === currentUid);
    const verified =
      bundleId === "com.kestrel.desktop" &&
      bundleEntry.isSymbolicLink() === false &&
      helperEntry.isSymbolicLink() === false &&
      helperEntry.isFile() &&
      (helperEntry.mode & 0o111) !== 0 &&
      helperArchitectures.includes("arm64") &&
      releaseAuthority &&
      sameAuthority &&
      owned;
    return {
      verified,
      blockedReason: verified
        ? ""
        : empty.blockedReason,
      bundleId,
      bundleRealPath,
      bundleUid: bundleEntry.uid,
      designatedRequirement: bundleSignature.designatedRequirement,
      signingAuthorities: bundleSignature.authorities,
      helperRealPath,
      helperUid: helperEntry.uid,
      helperArchitectures,
      helperDesignatedRequirement: helperSignature.designatedRequirement,
      evidence: [
        `bundle id ${bundleId}`,
        `bundle realpath ${bundleRealPath}`,
        `bundle uid ${bundleEntry.uid}`,
        ...bundleSignature.authorities.map((authority) => `bundle authority ${authority}`),
        `helper realpath ${helperRealPath}`,
        `helper uid ${helperEntry.uid}`,
        `helper architectures ${helperArchitectures.join(",")}`,
        ...helperSignature.authorities.map((authority) => `helper authority ${authority}`),
      ],
    };
  } catch (error) {
    return {
      ...empty,
      evidence: [
        `Desktop release identity verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

async function codeSigningDetails(inputPath: string): Promise<{
  authorities: string[];
  designatedRequirement: string;
}> {
  const details = await execFileAsync(
    "/usr/bin/codesign",
    ["-d", "--verbose=4", "--requirements", "-", inputPath],
    { timeout: 10_000 },
  ).catch((error: unknown) => {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof (error as { stderr?: unknown }).stderr === "string"
        ? (error as { stderr: string }).stderr
        : "";
    if (stderr.length > 0) return { stdout: "", stderr };
    throw error;
  });
  const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
  return {
    authorities: [...output.matchAll(/^Authority=(.+)$/gmu)].map(
      (match) => match[1]!.trim(),
    ),
    designatedRequirement:
      output.match(/^designated => (.+)$/mu)?.[1]?.trim() ?? "",
  };
}

async function inventoryStateTargets(input: {
  scope: KestrelUninstallScope;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<KestrelUninstallTarget[]> {
  const selected = input.scope === "complete";
  const home = resolveKestrelCoreHome(input.env, input.platform);
  const migration = detectLocalCoreMigrationState({
    env: input.env,
    platform: input.platform,
  });
  const targets: KestrelUninstallTarget[] = [];
  if (home.isolated || home.source !== "default") {
    targets.push(await pathTarget({
      id: "state.custom_core_home",
      kind: "state_root",
      path: home.productRootPath,
      selected: false,
      removal: "manual",
      evidence: [`custom Core home source ${home.source}`],
      blockedReason:
        "Custom or isolated Core homes are reported but preserved unless individually selected and manifest-verified.",
    }));
  } else if (existsSync(home.productRootPath)) {
    const target = await pathTarget({
      id: "state.default_product_root",
      kind: "state_root",
      path: home.productRootPath,
      selected,
      removal: "rm",
      evidence: ["default macOS Kestrel product root"],
    });
    const manifest = await readCoreManifest(home.homePath).catch(() => undefined);
    const manifestVerified =
      manifest !== undefined &&
      manifest.homePath === home.homePath &&
      manifest.stateEpoch === home.stateEpoch;
    targets.push({
      ...target,
      verified: target.verified && manifestVerified,
      fingerprint: hashValue({
        pathFingerprint: target.fingerprint,
        manifest: manifest === undefined
          ? null
          : {
              version: manifest.version,
              stateEpoch: manifest.stateEpoch,
              coreVersion: manifest.coreVersion,
              schemaVersion: manifest.schemaVersion,
              homePath: manifest.homePath,
              dbMode: manifest.dbMode,
            },
      }),
      evidence: [
        ...target.evidence,
        manifestVerified
          ? `Local Core manifest ${manifest.coreVersion}`
          : "Local Core manifest missing or invalid",
      ],
      ...(
        manifestVerified
          ? {}
          : {
              blockedReason:
                "Default Kestrel product root is not manifest-verified.",
            }
      ),
    });
  }

  const homeDir = os.homedir();
  const stateCandidates: Array<Omit<PathTargetInput, "selected">> = [
    {
      id: "state.electron_profile_current",
      kind: "electron_profile",
      path: path.join(homeDir, "Library", "Application Support", "Kestrel"),
      removal: "rm",
      evidence: ["current Electron profile path"],
    },
    {
      id: "state.electron_profile",
      kind: "electron_profile",
      path: path.join(homeDir, "Library", "Application Support", "@kestrel", "desktop"),
      removal: "rm",
      evidence: ["legacy Electron profile path"],
    },
    {
      id: "state.cli_legacy",
      kind: "legacy_root",
      path: path.join(homeDir, ".kestrel"),
      removal: "rm",
      evidence: ["legacy CLI state path"],
    },
    {
      id: "state.desktop_preferences",
      kind: "preferences",
      path: path.join(homeDir, "Library", "Preferences", "com.kestrel.desktop.plist"),
      removal: "rm",
      evidence: ["Desktop preferences domain"],
    },
    {
      id: "state.desktop_cache_current",
      kind: "cache",
      path: path.join(homeDir, "Library", "Caches", "Kestrel"),
      removal: "rm",
      evidence: ["current Desktop cache path"],
    },
    {
      id: "state.desktop_cache",
      kind: "cache",
      path: path.join(homeDir, "Library", "Caches", "com.kestrel.desktop"),
      removal: "rm",
      evidence: ["Desktop cache domain"],
    },
    {
      id: "state.desktop_saved_state",
      kind: "saved_state",
      path: path.join(homeDir, "Library", "Saved Application State", "com.kestrel.desktop.savedState"),
      removal: "rm",
      evidence: ["Desktop saved-state domain"],
    },
  ];
  for (const candidate of stateCandidates) {
    if (existsSync(candidate.path)) {
      targets.push(await pathTarget({ ...candidate, selected }));
    }
  }
  if (selected) {
    targets.push({
      id: "credentials.local_core_keychain_service",
      kind: "keychain_service",
      verified: input.platform === "darwin",
      selected,
      removal: "keychain_purge",
      fingerprint: "com.kestrel.local-core.credentials",
      evidence: ["Keychain service com.kestrel.local-core.credentials"],
    });
  }
  for (const entry of migration.entries) {
    if (
      entry.status === "present" &&
      targets.some((target) => target.path === entry.path) === false
    ) {
      targets.push(await pathTarget({
        id: `state.${entry.name}`,
        kind: "legacy_root",
        path: entry.path,
        selected,
        removal: "rm",
        evidence: entry.evidence,
      }));
    }
  }
  return targets;
}

async function inspectLocalCoreLifecycle(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<KestrelUninstallLifecycle> {
  const home = resolveKestrelCoreHome(input.env, input.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  if (existsSync(paths.apiSocketPath) === false || existsSync(paths.apiTokenPath) === false) {
    return { state: "missing", blockers: [] };
  }
  try {
    const token = (await readFile(paths.apiTokenPath, "utf8")).trim();
    const client = new LocalCoreClient({
      socketPath: paths.apiSocketPath,
      token,
      timeoutMs: 2_000,
    });
    const lifecycle = await client.systemLifecycle();
    return lifecycle;
  } catch {
    return {
      state: "unavailable",
      blockers: [
        {
          code: "LOCAL_CORE_UNVERIFIABLE",
          message:
            "A Local Core socket/token exists but could not be authenticated. Uninstall must not signal a PID from lock data alone.",
        },
      ],
    };
  }
}

async function shutdownLocalCoreIfPresent(input: {
  platform: NodeJS.Platform;
}): Promise<void> {
  const home = resolveKestrelCoreHome(process.env, input.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  if (existsSync(paths.apiSocketPath) === false || existsSync(paths.apiTokenPath) === false) {
    return;
  }
  const token = (await readFile(paths.apiTokenPath, "utf8")).trim();
  const client = new LocalCoreClient({
    socketPath: paths.apiSocketPath,
    token,
    timeoutMs: 2_000,
  });
  const before = await client.systemLifecycle();
  if (before.state === "busy") {
    throw new Error("Local Core is busy and cannot shut down for uninstall.");
  }
  const lifecycle = await client.shutdownForUninstall();
  if (lifecycle.state !== "idle") {
    throw new Error("Local Core remained busy during uninstall shutdown.");
  }
  const deadline = Date.now() + 5_000;
  for (;;) {
    const socketExists = existsSync(paths.apiSocketPath);
    const lockExists = existsSync(paths.lockPath);
    const ownerAlive =
      before.owner !== undefined && isProcessAlive(before.owner.pid);
    if (socketExists === false && lockExists === false && ownerAlive === false) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Local Core did not remove its socket/lock or terminate its verified owner after shutdown.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ESRCH"
    );
  }
}

async function inspectManagedWorktrees(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<KestrelUninstallWorktreeSummary> {
  const home = resolveKestrelCoreHome(input.env, input.platform);
  const service = new ManagedTaskWorktreeService({ homeDir: home.homePath });
  const inventory = await service.listManagedWorktrees();
  let cleanDisposable = 0;
  let retained = 0;
  let blocked = 0;
  let totalBytes = 0;
  const entries: KestrelUninstallWorktreeSummary["entries"] = [];
  for (const entry of inventory) {
    const { inspection } = entry;
    const ignoredFiles = await listGitFiles(
      inspection.binding.worktreeRoot,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
    ).catch(() => []);
    const ignored = await summarizeFiles(
      inspection.binding.worktreeRoot,
      ignoredFiles,
    );
    const disposition =
      inspection.retention.disposition === "clean_disposable" &&
      ignored.count > 0
        ? "retain_with_snapshot"
        : inspection.retention.disposition;
    if (disposition === "clean_disposable") cleanDisposable += 1;
    else if (disposition === "retain_with_snapshot") retained += 1;
    else blocked += 1;
    totalBytes += inspection.storageBytes;
    entries.push({
      worktreeRoot: inspection.binding.worktreeRoot,
      disposition,
      dirty: inspection.dirtyState.dirty,
      aheadCommitCount: inspection.aheadCommitCount,
      storageBytes: inspection.storageBytes,
      ignoredFileCount: ignored.count,
      ignoredBytes: ignored.bytes,
      reasons: [
        ...inspection.retention.reasons,
        ...(ignored.count > 0
          ? [
              `${ignored.count} ignored file(s), ${ignored.bytes} byte(s), require explicit discard`,
            ]
          : []),
      ],
    });
  }
  return { cleanDisposable, retained, blocked, totalBytes, entries };
}

async function inspectKestrelOne(input: {
  lifecycle: KestrelUninstallLifecycle;
  disconnectSelected: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<KestrelUninstallKestrelOneSummary> {
  if (input.lifecycle.state === "missing" || input.lifecycle.state === "unavailable") {
    return { disconnectSelected: input.disconnectSelected, environments: [] };
  }
  try {
    const client = await localCoreClientFor({ env: input.env, platform: input.platform });
    const projection = await client.kestrelOneEnvironments();
    return {
      disconnectSelected: input.disconnectSelected,
      environments: projection.environments.map((environment) => ({
        connectionId: environment.connectionId,
        organizationId: environment.organizationId,
        baseUrl: environment.baseUrl,
        status: environment.connectionStatus,
      })),
    };
  } catch {
    return { disconnectSelected: input.disconnectSelected, environments: [] };
  }
}

async function disconnectKestrelOneEnvironment(
  connectionId: string,
  platform: NodeJS.Platform,
): Promise<void> {
  const client = await localCoreClientFor({ env: process.env, platform });
  await client.disconnectKestrelOneEnvironment(connectionId);
}

async function localCoreClientFor(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}): Promise<LocalCoreClient> {
  const home = resolveKestrelCoreHome(input.env, input.platform);
  const paths = resolveLocalCorePaths(home.homePath);
  const token = (await readFile(paths.apiTokenPath, "utf8")).trim();
  return new LocalCoreClient({
    socketPath: paths.apiSocketPath,
    token,
    timeoutMs: 2_000,
  });
}

async function removeTarget(
  target: KestrelUninstallTarget,
  operations: KestrelUninstallCoordinatorOperations,
  planId: string,
): Promise<{ deferredCompletion?: KestrelUninstallDeferredCompletion } | void> {
  if (target.verified === false) {
    throw new Error(`Refusing to remove unverified target '${target.id}'.`);
  }
  if (target.removal === "manual") {
    throw new Error(`Target '${target.id}' requires manual removal.`);
  }
  if (target.kind === "keychain_service") {
    if (operations.purgeKeychain !== undefined) await operations.purgeKeychain();
    else await purgeMacosLocalCoreKeychainService();
    return;
  }
  if (target.kind === "kcron_launch_agent") {
    if (operations.unloadKcron !== undefined) await operations.unloadKcron();
    else await uninstallManagedService("darwin");
    return;
  }
  if (target.removal === "package_manager") {
    if (target.command === undefined || target.command.length === 0) {
      throw new Error(`Target '${target.id}' has no package manager command.`);
    }
    if (target.path !== undefined && await isCurrentProcessInside(target.path)) {
      const reportPath = operations.scheduleCliFinalizer !== undefined
        ? await operations.scheduleCliFinalizer(target, planId)
        : await scheduleCliSelfRemovalFinalizer(target, planId);
      if (typeof reportPath !== "string" || reportPath.length === 0) {
        throw new Error("CLI uninstall finalizer did not provide a report path.");
      }
      return {
        deferredCompletion: {
          executor: "cli_finalizer",
          state: "scheduled",
          reportPath,
        },
      };
    }
    if (operations.runPackageManager !== undefined) {
      await operations.runPackageManager(target.command);
    } else {
      const [command, ...args] = target.command;
      if (command === undefined || path.isAbsolute(command) === false) {
        throw new Error(`Target '${target.id}' package manager command is not absolute.`);
      }
      await execFileAsync(command, args);
    }
    return;
  }
  if (target.path === undefined) {
    throw new Error(`Target '${target.id}' has no path.`);
  }
  if (target.kind === "cli_bundle" && await isCurrentProcessInside(target.path)) {
    const reportPath = operations.scheduleCliFinalizer !== undefined
      ? await operations.scheduleCliFinalizer(target, planId)
      : await scheduleCliSelfRemovalFinalizer(target, planId);
    if (typeof reportPath !== "string" || reportPath.length === 0) {
      throw new Error("CLI uninstall finalizer did not provide a report path.");
    }
    return {
      deferredCompletion: {
        executor: "cli_finalizer",
        state: "scheduled",
        reportPath,
      },
    };
  }
  await assertSafeRemovalPath(target.path, target.kind);
  if (target.removal === "unlink") {
    if (operations.unlinkPath !== undefined) await operations.unlinkPath(target.path);
    else await unlink(target.path).catch(ignoreMissingPath);
    return;
  }
  if (target.removal === "trash") {
    if (operations.trashPath === undefined) {
      throw new Error(`Target '${target.id}' requires native Trash helper removal.`);
    }
    await operations.trashPath(target.path);
    return;
  }
  if (operations.removePath !== undefined) await operations.removePath(target.path);
  else await rm(target.path, { recursive: true, force: true });
}

async function isCurrentProcessInside(candidatePath: string): Promise<boolean> {
  const candidate = await realpath(candidatePath).catch(() => undefined);
  if (candidate === undefined) return false;
  const processPaths = [process.argv[1], process.execPath].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  for (const processPath of processPaths) {
    const processRealPath = await realpath(processPath).catch(() => undefined);
    if (processRealPath !== undefined && (processRealPath === candidate || isAncestor(candidate, processRealPath))) {
      return true;
    }
  }
  return false;
}

async function scheduleCliSelfRemovalFinalizer(
  target: KestrelUninstallTarget,
  planId: string,
): Promise<string> {
  const finalizerDir = path.join(os.tmpdir(), `kestrel-uninstall-finalizer-${process.pid}-${Date.now()}`);
  await mkdir(finalizerDir, { recursive: true, mode: 0o700 });
  const reportDir = path.join(UNINSTALL_REPORT_ROOT, planId);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const reportPath = path.join(reportDir, "cli-finalizer.json");
  const scriptPath = path.join(finalizerDir, "finalize.mjs");
  await writeFile(scriptPath, cliFinalizerScript(), { encoding: "utf8", mode: 0o600 });
  await chmod(scriptPath, 0o700);
  const child = spawn(process.execPath, [scriptPath, JSON.stringify({
    parentPid: process.pid,
    planId,
    target,
    finalizerDir,
    reportPath,
  })], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return reportPath;
}

function cliFinalizerScript(): string {
  return [
    "import { chmod, rename, rm, unlink, writeFile } from 'node:fs/promises';",
    "import { spawn } from 'node:child_process';",
    "const input = JSON.parse(process.argv[2] || '{}');",
    "while (true) {",
    "  try { process.kill(input.parentPid, 0); await new Promise((resolve) => setTimeout(resolve, 200)); }",
    "  catch { break; }",
    "}",
    "const target = input.target || {};",
    "const removedTargets = [];",
    "const failures = [];",
    "try {",
    "  try {",
    "    if (target.removal === 'package_manager') {",
    "      const [command, ...args] = target.command || [];",
    "      if (!command || !command.startsWith('/')) throw new Error('package manager command must be absolute');",
    "      await new Promise((resolve, reject) => {",
    "        const child = spawn(command, args, { stdio: 'ignore' });",
    "        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`package manager exited ${code}`)));",
    "        child.once('error', reject);",
    "      });",
    "    } else if (target.removal === 'unlink' && target.path) {",
    "      await unlink(target.path).catch((error) => { if (error?.code !== 'ENOENT') throw error; });",
    "    } else if (target.path) {",
    "      await rm(target.path, { recursive: true, force: true });",
    "    } else {",
    "      throw new Error('target path is missing');",
    "    }",
    "    removedTargets.push(target.id);",
    "  } catch (error) {",
    "    failures.push({ code: 'UNINSTALL_TARGET_REMOVE_FAILED', targetId: target.id || '', message: error instanceof Error ? error.message : String(error) });",
    "  }",
    "  const report = {",
    "    version: 'kestrel_uninstall_completion_report_v1',",
    "    executor: 'cli_finalizer',",
    "    planId: input.planId,",
    "    status: failures.length === 0 ? 'complete' : 'partial',",
    "    completedAt: new Date().toISOString(),",
    "    removedTargets,",
    "    failures,",
    "    reportPath: input.reportPath,",
    "  };",
    "  const temporaryReportPath = `${input.reportPath}.tmp-${process.pid}`;",
    "  await writeFile(temporaryReportPath, `${JSON.stringify(report, null, 2)}\\n`, { mode: 0o600 });",
    "  await chmod(temporaryReportPath, 0o600);",
    "  await rename(temporaryReportPath, input.reportPath);",
    "} finally {",
    "  if (input.finalizerDir) await rm(input.finalizerDir, { recursive: true, force: true }).catch(() => {});",
    "}",
    "",
  ].join("\n");
}

function ignoreMissingPath(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }
  throw error;
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    /^(?:EAI_AGAIN|ECONNABORTED|ECONNREFUSED|ECONNRESET|ENETUNREACH|ETIMEDOUT)$/u.test(
      (error as { code: string }).code,
    )
  ) {
    return (error as { code: string }).code;
  }
  return "KESTREL_ONE_DISCONNECT_FAILED";
}

function safeDisconnectErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case "EAI_AGAIN":
      return "The Kestrel One address could not be resolved; local uninstall continued.";
    case "ECONNABORTED":
    case "ECONNRESET":
      return "The Kestrel One connection ended before disconnect completed; local uninstall continued.";
    case "ECONNREFUSED":
      return "The Kestrel One service refused the connection; local uninstall continued.";
    case "ENETUNREACH":
      return "The Kestrel One network was unreachable; local uninstall continued.";
    case "ETIMEDOUT":
      return "The Kestrel One disconnect timed out; local uninstall continued.";
    default:
      return "Kestrel One disconnect failed; local uninstall continued.";
  }
}

interface PathTargetInput {
  id: string;
  kind: KestrelUninstallTarget["kind"];
  path: string;
  selected: boolean;
  removal: KestrelUninstallTarget["removal"];
  evidence: string[];
  blockedReason?: string | undefined;
}

async function pathTarget(input: PathTargetInput): Promise<KestrelUninstallTarget> {
  const fingerprint = await fingerprintPath(input.path);
  return {
    id: input.id,
    kind: input.kind,
    path: input.path,
    verified: fingerprint.verified,
    selected: input.selected,
    removal: input.removal,
    fingerprint: fingerprint.fingerprint,
    evidence: [...input.evidence, ...fingerprint.evidence],
    ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
  };
}

async function fingerprintPath(inputPath: string): Promise<{
  verified: boolean;
  fingerprint: string;
  evidence: string[];
}> {
  try {
    const entry = await lstat(inputPath);
    const real = await realpath(inputPath);
    const currentUid = process.getuid?.();
    const ownedByCurrentUser =
      currentUid === undefined || entry.uid === currentUid;
    return {
      verified: entry.isSymbolicLink() === false && ownedByCurrentUser,
      fingerprint: hashValue({
        path: inputPath,
        real,
        mode: entry.mode,
        uid: entry.uid,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }),
      evidence: [
        `realpath ${real}`,
        `uid ${entry.uid}`,
        ownedByCurrentUser ? "owned by current user" : "foreign owner",
        entry.isSymbolicLink() ? "root is symlink" : "root is not symlink",
      ],
    };
  } catch {
    return {
      verified: false,
      fingerprint: hashValue({ path: inputPath, missing: true }),
      evidence: ["path unavailable"],
    };
  }
}

async function readSymlinkTarget(linkPath: string): Promise<{ realTarget: string } | undefined> {
  try {
    const entry = await lstat(linkPath);
    if (entry.isSymbolicLink() === false) return undefined;
    return { realTarget: await realpath(linkPath) };
  } catch {
    return undefined;
  }
}

async function inspectCliBundle(realTarget: string): Promise<{
  rootPath: string;
  manifest: {
    version: "kestrel_cli_bundle_v1";
    package: typeof KESTREL_PACKAGE_NAME;
    entrypoint: string;
    packageVersion?: string | undefined;
    sourceCommit?: string | undefined;
    platform?: string | undefined;
    arch?: string | undefined;
  };
} | undefined> {
  const candidates = [
    path.resolve(realTarget, "..", ".."),
    path.resolve(realTarget, "..", "..", ".."),
  ];
  for (const candidate of candidates) {
    const manifestPath = path.join(candidate, CLI_BUNDLE_MANIFEST_NAME);
    const raw = await readFile(manifestPath, "utf8").catch(() => undefined);
    if (raw === undefined) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      parsed.version !== "kestrel_cli_bundle_v1" ||
      parsed.package !== KESTREL_PACKAGE_NAME ||
      typeof parsed.entrypoint !== "string"
    ) {
      continue;
    }
    const entrypointPath = await realpath(path.join(candidate, parsed.entrypoint)).catch(() => undefined);
    if (entrypointPath !== realTarget) continue;
    return {
      rootPath: await realpath(candidate),
      manifest: {
        version: "kestrel_cli_bundle_v1",
        package: KESTREL_PACKAGE_NAME,
        entrypoint: parsed.entrypoint,
        ...(typeof parsed.packageVersion === "string" ? { packageVersion: parsed.packageVersion } : {}),
        ...(typeof parsed.sourceCommit === "string" ? { sourceCommit: parsed.sourceCommit } : {}),
        ...(typeof parsed.platform === "string" ? { platform: parsed.platform } : {}),
        ...(typeof parsed.arch === "string" ? { arch: parsed.arch } : {}),
      },
    };
  }
  return undefined;
}

async function inspectCliPackageInstall(realTarget: string, env: NodeJS.ProcessEnv): Promise<{
  status: "verified";
  packageRoot: string;
  name: typeof KESTREL_PACKAGE_NAME;
  command: string[];
} | {
  status: "ambiguous";
  packageRoot: string;
  managers: string[];
} | undefined> {
  const packageRoot = await findOwningPackageRoot(realTarget);
  if (packageRoot === undefined) return undefined;
  const matches: Array<{ managerName: "pnpm" | "npm"; manager: string }> = [];
  for (const managerName of ["pnpm", "npm"] as const) {
    const manager = await findExecutable(managerName, env);
    if (manager === undefined) continue;
    const globalRoot = await packageManagerGlobalRoot(manager);
    if (globalRoot === undefined) continue;
    const expectedPackageRoot = await realpath(
      path.join(globalRoot, "@kestrel-agents", "kestrel"),
    ).catch(() => undefined);
    if (expectedPackageRoot !== packageRoot) continue;
    matches.push({ managerName, manager });
  }
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      packageRoot,
      managers: matches.map(({ manager }) => manager),
    };
  }
  const match = matches[0]!;
  return {
    status: "verified",
    packageRoot,
    name: KESTREL_PACKAGE_NAME,
    command: [
      match.manager,
      match.managerName === "pnpm" ? "remove" : "uninstall",
      "--global",
      KESTREL_PACKAGE_NAME,
    ],
  };
}

async function findOwningPackageRoot(realTarget: string): Promise<string | undefined> {
  let current = path.dirname(realTarget);
  for (let index = 0; index < 8; index += 1) {
    const manifestPath = path.join(current, "package.json");
    const raw = await readFile(manifestPath, "utf8").catch(() => undefined);
    if (raw !== undefined) {
      try {
        const manifest = JSON.parse(raw) as { name?: unknown; bin?: unknown };
        if (manifest.name === KESTREL_PACKAGE_NAME) {
          const bin = manifest.bin;
          const kestrelBin =
            typeof bin === "string"
              ? bin
              : typeof bin === "object" && bin !== null
                ? (bin as Record<string, unknown>).kestrel
                : undefined;
          if (typeof kestrelBin !== "string") return undefined;
          const binPath = await realpath(path.join(current, kestrelBin)).catch(() => undefined);
          if (binPath === realTarget) return await realpath(current);
        }
      } catch {
        return undefined;
      }
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return undefined;
}

async function findExecutable(name: "npm" | "pnpm", env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = [
    env[`KESTREL_UNINSTALL_${name.toUpperCase()}_PATH`],
    path.join("/opt/homebrew/bin", name),
    path.join("/usr/local/bin", name),
    path.join("/usr/bin", name),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    const real = await realpath(candidate).catch(() => undefined);
    if (real !== undefined && await isExecutableFile(real)) return real;
  }
  return undefined;
}

async function packageManagerGlobalRoot(managerPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(managerPath, ["root", "--global"], {
      timeout: 5_000,
    });
    const root = stdout.trim();
    if (root.length === 0) return undefined;
    return await realpath(root);
  } catch {
    return undefined;
  }
}

async function buildApplyResult(
  plan: KestrelUninstallPlanV1,
  removedTargets: string[],
  skippedTargets: string[],
  blockers: KestrelUninstallBlocker[],
  operations: KestrelUninstallCoordinatorOperations,
  requestedDeferredTargetIds: ReadonlySet<string> = new Set(),
  kestrelOneDisconnects: KestrelOneDisconnectResult[] = [],
  deferredCompletions: KestrelUninstallDeferredCompletion[] = [],
): Promise<KestrelUninstallApplyResultV1> {
  const finalPlan = await createKestrelUninstallPlan({
    initiator: plan.initiator,
    scope: plan.scope,
    options: plan.options,
    platform: plan.platform,
    operations,
  });
  const deferredTargetIds = new Set(
    blockers
      .filter((blocker) => blocker.code === "UNINSTALL_CLI_FINALIZER_SCHEDULED" && blocker.targetId !== undefined)
      .map((blocker) => blocker.targetId as string),
  );
  for (const targetId of requestedDeferredTargetIds) {
    deferredTargetIds.add(targetId);
  }
  const selectedTargetIds = new Set(
    plan.targets
      .filter((target) =>
        target.selected &&
        target.kind !== "keychain_service" &&
        deferredTargetIds.has(target.id) === false,
      )
      .map((target) => target.id),
  );
  const remainingTargets = finalPlan.targets.filter((target) =>
    target.selected && selectedTargetIds.has(target.id),
  );
  const keychainVerificationBlockers: KestrelUninstallBlocker[] = [];
  if (
    removedTargets.includes("credentials.local_core_keychain_service") &&
    (
      operations.keychainServiceHasItems !== undefined ||
      (operations.purgeKeychain === undefined && process.platform === "darwin")
    )
  ) {
    try {
      const hasItems = operations.keychainServiceHasItems !== undefined
        ? await operations.keychainServiceHasItems()
        : await hasMacosLocalCoreKeychainServiceItems();
      if (hasItems) {
        keychainVerificationBlockers.push({
          code: "UNINSTALL_FINAL_VERIFICATION_FAILED",
          message:
            "The Kestrel Local Core Keychain service still contains credential items.",
          targetId: "credentials.local_core_keychain_service",
        });
      }
    } catch (error) {
      keychainVerificationBlockers.push({
        code: "UNINSTALL_FINAL_VERIFICATION_FAILED",
        message: `Keychain purge verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        targetId: "credentials.local_core_keychain_service",
      });
    }
  }
  const finalBlockers = [
    ...blockers,
    ...keychainVerificationBlockers,
    ...remainingTargets.map((target) => ({
      code: "UNINSTALL_FINAL_VERIFICATION_FAILED",
      message: `Selected uninstall target '${target.id}' remains after apply.`,
      targetId: target.id,
    })),
  ];
  const hasBlockingFailures = finalBlockers.some(
    (blocker) => NON_BLOCKING_APPLY_FAILURE_CODES.has(blocker.code) === false,
  );
  return {
    version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
    planId: plan.planId,
    appliedAt: (operations.now?.() ?? new Date()).toISOString(),
    status:
      finalBlockers.length === 0
        ? "applied"
        : hasBlockingFailures === false || removedTargets.length > 0
          ? "partial"
          : "blocked",
    removedTargets,
    skippedTargets,
    blockers: finalBlockers,
    finalTargets: finalPlan.targets,
    kestrelOneDisconnects,
    deferredCompletions,
  };
}

async function recoverOrDiscardManagedWorktrees(
  plan: KestrelUninstallPlanV1,
  operations: KestrelUninstallCoordinatorOperations,
): Promise<{ blockers: KestrelUninstallBlocker[] }> {
  const blockers: KestrelUninstallBlocker[] = [];
  const entries = await loadManagedWorktreeEntries(plan, operations);
  if (entries.length === 0) return { blockers };
  const exportDirectory = plan.options.exportWorktreesDirectory ?? "";
  const exportRoot =
    exportDirectory.length > 0
      ? await prepareWorktreeExportRoot(exportDirectory, plan).catch((error) => {
          blockers.push({
            code: "UNINSTALL_WORKTREE_EXPORT_DIRECTORY_INVALID",
            message: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        })
      : undefined;
  if (blockers.length > 0) return { blockers };
  for (const entry of entries) {
    const currentEntry = entry;
    const { inspection } = currentEntry;
    if (inspection.retention.disposition === "blocked") {
      blockers.push({
        code: "UNINSTALL_WORKTREE_BLOCKED",
        message: `Managed worktree '${inspection.binding.worktreeRoot}' is ${inspection.status}; ${inspection.retention.reasons.join(", ")}`,
      });
      continue;
    }
    const ignored = await listManagedWorktreeGitFiles(operations, inspection.binding.worktreeRoot, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    if (
      ignored.length > 0 &&
      plan.options.discardWorktrees === false
    ) {
      blockers.push({
        code: "UNINSTALL_WORKTREE_IGNORED_FILES_REQUIRE_DISCARD",
        message: `Managed worktree '${inspection.binding.worktreeRoot}' contains ${ignored.length} ignored file(s). Ignored files are not exported and require explicit discard.`,
      });
      continue;
    }
    if (inspection.retention.disposition === "retain_with_snapshot") {
      if (exportRoot === undefined && plan.options.discardWorktrees === false) {
        blockers.push({
          code: "UNINSTALL_WORKTREE_RECOVERY_REQUIRED",
          message: `Managed worktree '${inspection.binding.worktreeRoot}' requires export or discard.`,
        });
        continue;
      }
      if (exportRoot !== undefined) {
        if (operations.createRecoveryBundle !== undefined) {
          await operations.createRecoveryBundle(currentEntry, exportRoot, ignored);
        } else {
          await createRecoveryBundle(currentEntry, exportRoot, ignored, operations);
        }
      }
    }
    if (operations.removeManagedWorktree !== undefined) {
      await operations.removeManagedWorktree(currentEntry);
    } else {
      await removeManagedWorktree(currentEntry);
    }
  }
  return { blockers };
}

async function loadManagedWorktreeEntries(
  plan: KestrelUninstallPlanV1,
  operations: KestrelUninstallCoordinatorOperations,
): Promise<ManagedTaskWorktreeInventoryEntry[]> {
  if (operations.listManagedWorktrees !== undefined) {
    return await operations.listManagedWorktrees({ env: process.env, platform: plan.platform });
  }
  const service = new ManagedTaskWorktreeService({
    homeDir: resolveKestrelCoreHome(process.env, plan.platform).homePath,
  });
  const entries = await service.listManagedWorktrees();
  const refreshed: ManagedTaskWorktreeInventoryEntry[] = [];
  for (const entry of entries) {
    refreshed.push({
      binding: entry.binding,
      inspection: await service.inspectLifecycle(entry.binding),
    });
  }
  return refreshed;
}

async function prepareWorktreeExportRoot(
  exportDirectory: string,
  plan: KestrelUninstallPlanV1,
): Promise<string> {
  await mkdir(exportDirectory, { recursive: true, mode: 0o700 });
  const exportRoot = await realpath(exportDirectory);
  const homeDir = await realpath(os.homedir());
  if (exportRoot === "/" || exportRoot === homeDir) {
    throw new Error(`Refusing broad worktree export directory '${exportRoot}'.`);
  }
  const exportEntry = await lstat(exportRoot);
  if (exportEntry.isSymbolicLink()) {
    throw new Error(`Refusing symlink worktree export directory '${exportRoot}'.`);
  }
  for (const target of plan.targets) {
    if (target.selected === false || target.path === undefined) continue;
    const targetReal = await realpath(target.path).catch(() => undefined);
    if (targetReal !== undefined && (exportRoot === targetReal || isAncestor(targetReal, exportRoot))) {
      throw new Error(`Worktree export directory '${exportRoot}' is inside selected uninstall target '${target.id}'.`);
    }
  }
  return exportRoot;
}

async function createRecoveryBundle(
  entry: ManagedTaskWorktreeInventoryEntry,
  exportRoot: string,
  ignoredFiles: string[],
  operations: KestrelUninstallCoordinatorOperations,
): Promise<void> {
  const worktreeRoot = entry.binding.worktreeRoot;
  const bundleRoot = path.join(exportRoot, `worktree-${hashString(worktreeRoot).slice(0, 16)}`);
  await mkdir(bundleRoot, { recursive: true, mode: 0o700 });
  const ignoredSummary = await summarizeFiles(worktreeRoot, ignoredFiles);
  const untracked = await listManagedWorktreeGitFiles(operations, worktreeRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  for (const relativePath of untracked) {
    assertSafeRecoveryRelativePath(relativePath);
    const source = path.join(worktreeRoot, relativePath);
    const destination = path.join(bundleRoot, "untracked", relativePath);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await cp(source, destination, { recursive: true, force: true, errorOnExist: false });
  }
  await execFileAsync("git", ["-C", worktreeRoot, "bundle", "create", path.join(bundleRoot, "commits.bundle"), "HEAD"]);
  await writeGitOutput(worktreeRoot, ["diff", "--binary", "--cached", "HEAD", "--"], path.join(bundleRoot, "staged.patch"));
  await writeGitOutput(worktreeRoot, ["diff", "--binary", "--"], path.join(bundleRoot, "unstaged.patch"));
  await writeFile(
    path.join(bundleRoot, "restore.sh"),
    [
      "#!/usr/bin/env sh",
      "set -eu",
      "if [ \"$#\" -ne 1 ]; then",
      "  echo \"usage: $0 /path/to/clean-clone\" >&2",
      "  exit 64",
      "fi",
      "SCRIPT_DIR=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)",
      "DESTINATION=$1",
      "if [ ! -d \"$DESTINATION/.git\" ] && ! git -C \"$DESTINATION\" rev-parse --git-dir >/dev/null 2>&1; then",
      "  echo \"restore destination must be a Git worktree\" >&2",
      "  exit 65",
      "fi",
      "if [ -n \"$(git -C \"$DESTINATION\" status --porcelain --untracked-files=all)\" ]; then",
      "  echo \"restore destination must be clean\" >&2",
      "  exit 66",
      "fi",
      "(cd \"$SCRIPT_DIR\" && shasum -a 256 -c checksums.sha256)",
      "git -C \"$DESTINATION\" bundle verify \"$SCRIPT_DIR/commits.bundle\" >/dev/null",
      "git -C \"$DESTINATION\" fetch \"$SCRIPT_DIR/commits.bundle\" HEAD",
      "git -C \"$DESTINATION\" checkout --detach FETCH_HEAD",
      "if [ -s \"$SCRIPT_DIR/staged.patch\" ]; then",
      "  git -C \"$DESTINATION\" apply --index --binary \"$SCRIPT_DIR/staged.patch\"",
      "fi",
      "if [ -s \"$SCRIPT_DIR/unstaged.patch\" ]; then",
      "  git -C \"$DESTINATION\" apply --binary \"$SCRIPT_DIR/unstaged.patch\"",
      "fi",
      "if [ -d \"$SCRIPT_DIR/untracked\" ]; then",
      "  cp -R \"$SCRIPT_DIR/untracked/.\" \"$DESTINATION/\"",
      "fi",
      "git -C \"$DESTINATION\" status --short",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  const metadataPath = path.join(bundleRoot, "metadata.json");
  await writeFile(
    metadataPath,
    `${JSON.stringify({
      version: "kestrel_worktree_recovery_bundle_v1",
      createdAt: new Date().toISOString(),
      binding: entry.binding,
      inspection: entry.inspection,
      ignored: ignoredSummary,
      untrackedCount: untracked.length,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const checksums = await recoveryChecksums(bundleRoot);
  await writeFile(
    path.join(bundleRoot, "checksums.json"),
    `${JSON.stringify(checksums, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(
    path.join(bundleRoot, "checksums.sha256"),
    `${Object.entries(checksums)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, checksum]) => `${checksum}  ${relativePath}`)
      .join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function assertSafeRecoveryRelativePath(relativePath: string): void {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\n") ||
    relativePath.includes("\r") ||
    path.isAbsolute(relativePath) ||
    path.normalize(relativePath) !== relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Unsafe worktree recovery path '${relativePath}'.`);
  }
}

async function removeManagedWorktree(entry: ManagedTaskWorktreeInventoryEntry): Promise<void> {
  const root = entry.binding.worktreeRoot;
  if (existsSync(root)) {
    await execFileAsync("git", [
      "-C",
      entry.binding.sourceRepoRoot,
      "worktree",
      "remove",
      "--force",
      "--force",
      root,
    ]);
  }
  await rm(`${root}.binding.json`, { force: true });
}

async function listGitFiles(worktreeRoot: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", worktreeRoot, ...args], {
    encoding: "buffer",
  });
  return stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

async function listManagedWorktreeGitFiles(
  operations: KestrelUninstallCoordinatorOperations,
  worktreeRoot: string,
  args: string[],
): Promise<string[]> {
  if (operations.listGitFiles !== undefined) {
    return await operations.listGitFiles(worktreeRoot, args);
  }
  return await listGitFiles(worktreeRoot, args);
}

async function writeGitOutput(
  worktreeRoot: string,
  args: string[],
  destination: string,
): Promise<void> {
  const { stdout } = await execFileAsync("git", ["-C", worktreeRoot, ...args], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  await writeFile(destination, stdout, { mode: 0o600 });
}

async function summarizeFiles(root: string, files: string[]): Promise<{ count: number; bytes: number }> {
  let bytes = 0;
  for (const relativePath of files) {
    const fileStat = await stat(path.join(root, relativePath)).catch(() => undefined);
    bytes += fileStat?.size ?? 0;
  }
  return { count: files.length, bytes };
}

async function recoveryChecksums(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() === false || entry.name === "checksums.json") continue;
      const relativePath = path.relative(root, fullPath);
      output[relativePath] = createHash("sha256").update(await readFile(fullPath)).digest("hex");
    }
  };
  await walk(root);
  return output;
}

async function assertSafeRemovalPath(
  candidatePath: string,
  kind: KestrelUninstallTarget["kind"],
): Promise<void> {
  const resolved = await realpath(candidatePath);
  const homeDir = await realpath(os.homedir());
  const packageRoot = await findPackageRoot();
  if (resolved === "/" || resolved === homeDir) {
    throw new Error(`Refusing to remove broad path '${resolved}'.`);
  }
  if (resolved === packageRoot || isAncestor(resolved, packageRoot)) {
    throw new Error(`Refusing to remove source repository path '${resolved}'.`);
  }
  if (
    kind !== "cli_symlink" &&
    kind !== "preferences" &&
    kind !== "cache" &&
    kind !== "saved_state" &&
    kind !== "electron_profile" &&
    kind !== "legacy_root" &&
    kind !== "state_root" &&
    kind !== "kcron_launch_agent" &&
    kind !== "cli_bundle" &&
    kind !== "desktop_bundle"
  ) {
    throw new Error(`Unsupported filesystem removal kind '${kind}'.`);
  }
  const entry = await lstat(candidatePath);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && entry.uid !== currentUid) {
    throw new Error(
      `Refusing to remove foreign-owned path '${candidatePath}' (uid ${entry.uid}).`,
    );
  }
  if (entry.isSymbolicLink() && kind !== "cli_symlink") {
    throw new Error(`Refusing to remove symlink root '${candidatePath}'.`);
  }
}

async function findPackageRoot(): Promise<string> {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let index = 0; index < 8; index += 1) {
    const manifestPath = path.join(current, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          name?: unknown;
        };
        if (manifest.name === "@kestrel-agents/kestrel") {
          return await realpath(current);
        }
      } catch {
        // Continue walking upward.
      }
    }
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return await realpath(process.cwd());
}

function hashPlan(plan: KestrelUninstallPlanV1): string {
  return hashValue({
    initiator: plan.initiator,
    scope: plan.scope,
    options: plan.options,
    targets: plan.targets.map((target) => ({
      id: target.id,
      kind: target.kind,
      path: target.path,
      selected: target.selected,
      fingerprint: target.fingerprint,
    })),
    lifecycle: plan.lifecycle,
    worktrees: plan.worktrees,
    kestrelOne: plan.kestrelOne,
  }).slice(0, 24);
}

async function pruneExpiredUninstallReports(): Promise<void> {
  const retentionCutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  const entries = await readdir(UNINSTALL_REPORT_ROOT, {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() === false) continue;
    const reportDirectory = path.join(UNINSTALL_REPORT_ROOT, entry.name);
    const reportStat = await stat(reportDirectory).catch(() => undefined);
    if (reportStat !== undefined && reportStat.mtimeMs < retentionCutoff) {
      await rm(reportDirectory, { recursive: true, force: true });
    }
  }
}

function hashValue(value: unknown): string {
  return hashString(JSON.stringify(value));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAncestor(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && relative.startsWith("..") === false && path.isAbsolute(relative) === false;
}

export async function writeKestrelUninstallPlan(
  plan: KestrelUninstallPlanV1,
  filePath: string,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readKestrelUninstallPlan(
  filePath: string,
): Promise<KestrelUninstallPlanV1> {
  return parseKestrelUninstallPlanV1(
    JSON.parse(await readFile(filePath, "utf8")),
  );
}

export async function createTemporarySymlinkFixtureForUninstallTests(
  root: string,
  target: string,
): Promise<string> {
  const linkPath = path.join(root, "kestrel");
  await symlink(target, linkPath);
  return linkPath;
}

export async function directoryExists(inputPath: string): Promise<boolean> {
  try {
    return (await stat(inputPath)).isDirectory();
  } catch {
    return false;
  }
}

async function isExecutableFile(inputPath: string): Promise<boolean> {
  try {
    const entry = await stat(inputPath);
    return entry.isFile() && (entry.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

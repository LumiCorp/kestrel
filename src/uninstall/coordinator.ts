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
import { purgeMacosLocalCoreKeychainService } from "../localCore/macosKeychainCredentialStore.js";
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
const NON_BLOCKING_APPLY_FAILURE_CODES = new Set([
  "KESTREL_ONE_DISCONNECT_FAILED",
  "UNINSTALL_CLI_FINALIZER_SCHEDULED",
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
  scheduleCliFinalizer?(target: KestrelUninstallTarget): Promise<void>;
  unloadKcron?(): Promise<void>;
  purgeKeychain?(): Promise<void>;
  shutdownLocalCore?(platform: NodeJS.Platform): Promise<void>;
  disconnectKestrelOne?(connectionId: string): Promise<void>;
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

  const targets = operations.inventoryTargets !== undefined
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
    operations?: KestrelUninstallCoordinatorOperations | undefined;
  },
): Promise<KestrelUninstallApplyResultV1> {
  const plan = parseKestrelUninstallPlanV1(request.plan);
  const operations = request.operations ?? {};
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
    };
  }

  const removedTargets: string[] = [];
  const skippedTargets: string[] = [];
  const blockers: KestrelUninstallBlocker[] = [];

  if (plan.scope === "complete") {
    const recovery = await recoverOrDiscardManagedWorktrees(plan, operations);
    blockers.push(...recovery.blockers);
    if (blockers.length > 0) {
      return await buildApplyResult(plan, removedTargets, skippedTargets, blockers, operations);
    }
  }

  if (plan.options.disconnectKestrelOne) {
    for (const environment of plan.kestrelOne.environments) {
      try {
        if (operations.disconnectKestrelOne !== undefined) {
          await operations.disconnectKestrelOne(environment.connectionId);
        } else {
          await disconnectKestrelOneEnvironment(environment.connectionId, plan.platform);
        }
      } catch (error) {
        blockers.push({
          code: "KESTREL_ONE_DISCONNECT_FAILED",
          message: `Kestrel One environment ${environment.connectionId} could not be disconnected: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
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
        {
          code: "LOCAL_CORE_SHUTDOWN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      ], operations);
    }
  }

  const currentTargetIds = new Set(current.targets.map((target) => target.id));
  for (const target of plan.targets) {
    if (target.selected === false) {
      skippedTargets.push(target.id);
      continue;
    }
    if (target.kind !== "keychain_service" && currentTargetIds.has(target.id) === false) {
      skippedTargets.push(target.id);
      continue;
    }
    try {
      await removeTarget(target, operations);
      removedTargets.push(target.id);
    } catch (error) {
      const code = error instanceof NonBlockingUninstallFailure
        ? error.code
        : "UNINSTALL_TARGET_REMOVE_FAILED";
      blockers.push({
        code,
        message: error instanceof Error ? error.message : String(error),
        targetId: target.id,
      });
    }
  }

  return await buildApplyResult(plan, removedTargets, skippedTargets, blockers, operations);
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
  const content = await readFile(filePath, "utf8").catch(() => "");
  const verified = content.includes("<string>com.kestrel.kcron</string>");
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
    fingerprint: hashValue({ filePath, contentHash: hashString(content), verified }),
    evidence: verified ? ["LaunchAgent label com.kestrel.kcron"] : ["LaunchAgent label not verified"],
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
    const info = await readFile(infoPath, "utf8").catch(() => "");
    const helperPath = path.join(bundlePath, "Contents", "Resources", DESKTOP_HELPER_NAME);
    const helperReady = await isExecutableFile(helperPath);
    const verified = info.includes("com.kestrel.desktop");
    const blockedReason = selected && helperReady === false
      ? "Packaged Desktop removal requires the signed native helper."
      : undefined;
    targets.push({
      id: `desktop.bundle.${hashString(bundlePath).slice(0, 12)}`,
      kind: "desktop_bundle",
      path: bundlePath,
      verified,
      selected,
      removal: helperReady ? "trash" : "manual",
      ...(helperReady ? { command: [helperPath, "--plan", "<plan>"] } : {}),
      fingerprint: hashValue({ bundlePath, infoHash: hashString(info), verified, helperReady }),
      evidence: verified
        ? ["bundle id com.kestrel.desktop", ...(helperReady ? [`helper ${helperPath}`] : [])]
        : ["bundle id not verified"],
      ...(blockedReason !== undefined ? { blockedReason } : {}),
    });
  }
  return targets;
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
    targets.push(await pathTarget({
      id: "state.default_product_root",
      kind: "state_root",
      path: home.productRootPath,
      selected,
      removal: "rm",
      evidence: ["default macOS Kestrel product root"],
    }));
  }

  const homeDir = os.homedir();
  const stateCandidates: Array<Omit<PathTargetInput, "selected">> = [
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
  const lifecycle = await client.shutdownForUninstall();
  if (lifecycle.state !== "idle") {
    throw new Error("Local Core remained busy during uninstall shutdown.");
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
    const disposition = inspection.retention.disposition;
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
      reasons: inspection.retention.reasons,
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
): Promise<void> {
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
      if (operations.scheduleCliFinalizer !== undefined) await operations.scheduleCliFinalizer(target);
      else await scheduleCliSelfRemovalFinalizer(target);
      throw new NonBlockingUninstallFailure(
        "UNINSTALL_CLI_FINALIZER_SCHEDULED",
        `Target '${target.id}' is owned by the running CLI and was scheduled for removal after process exit.`,
      );
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
    if (operations.scheduleCliFinalizer !== undefined) await operations.scheduleCliFinalizer(target);
    else await scheduleCliSelfRemovalFinalizer(target);
    throw new NonBlockingUninstallFailure(
      "UNINSTALL_CLI_FINALIZER_SCHEDULED",
      `Target '${target.id}' is owned by the running CLI and was scheduled for removal after process exit.`,
    );
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

class NonBlockingUninstallFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
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

async function scheduleCliSelfRemovalFinalizer(target: KestrelUninstallTarget): Promise<void> {
  const finalizerDir = path.join(os.tmpdir(), `kestrel-uninstall-finalizer-${process.pid}-${Date.now()}`);
  await mkdir(finalizerDir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(finalizerDir, "finalize.mjs");
  await writeFile(scriptPath, cliFinalizerScript(), { encoding: "utf8", mode: 0o600 });
  await chmod(scriptPath, 0o700);
  const child = spawn(process.execPath, [scriptPath, JSON.stringify({
    parentPid: process.pid,
    target,
    finalizerDir,
  })], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function cliFinalizerScript(): string {
  return [
    "import { rm, unlink } from 'node:fs/promises';",
    "import { spawn } from 'node:child_process';",
    "const input = JSON.parse(process.argv[2] || '{}');",
    "while (true) {",
    "  try { process.kill(input.parentPid, 0); await new Promise((resolve) => setTimeout(resolve, 200)); }",
    "  catch { break; }",
    "}",
    "const target = input.target || {};",
    "try {",
    "  if (target.removal === 'package_manager') {",
    "    const [command, ...args] = target.command || [];",
    "    if (!command) throw new Error('missing package manager command');",
    "    await new Promise((resolve, reject) => {",
    "      const child = spawn(command, args, { stdio: 'ignore' });",
    "      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`package manager exited ${code}`)));",
    "      child.once('error', reject);",
    "    });",
    "  } else if (target.removal === 'unlink' && target.path) {",
    "    await unlink(target.path).catch((error) => { if (error?.code !== 'ENOENT') throw error; });",
    "  } else if (target.path) {",
    "    await rm(target.path, { recursive: true, force: true });",
    "  }",
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
    return {
      verified: entry.isSymbolicLink() === false,
      fingerprint: hashValue({
        path: inputPath,
        real,
        mode: entry.mode,
        uid: entry.uid,
        mtimeMs: Math.trunc(entry.mtimeMs),
      }),
      evidence: [
        `realpath ${real}`,
        `uid ${entry.uid}`,
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
  packageRoot: string;
  name: typeof KESTREL_PACKAGE_NAME;
  command: string[];
} | undefined> {
  const packageRoot = await findOwningPackageRoot(realTarget);
  if (packageRoot === undefined) return undefined;
  for (const managerName of ["pnpm", "npm"] as const) {
    const manager = await findExecutable(managerName, env);
    if (manager === undefined) continue;
    const globalRoot = await packageManagerGlobalRoot(manager);
    if (globalRoot === undefined) continue;
    const expectedPackageRoot = await realpath(
      path.join(globalRoot, "@kestrel-agents", "kestrel"),
    ).catch(() => undefined);
    if (expectedPackageRoot !== packageRoot) continue;
    return {
      packageRoot,
      name: KESTREL_PACKAGE_NAME,
      command: [manager, managerName === "pnpm" ? "remove" : "uninstall", "--global", KESTREL_PACKAGE_NAME],
    };
  }
  return undefined;
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
  const finalBlockers = [
    ...blockers,
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
      inspection.retention.disposition === "retain_with_snapshot" &&
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
      "echo 'Restore this Kestrel worktree bundle into a clean clone manually:'",
      "echo '  git bundle unbundle commits.bundle'",
      "echo '  git apply staged.patch'",
      "echo '  git apply unstaged.patch'",
      "echo '  copy files from untracked/ as needed'",
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
  await writeFile(
    path.join(bundleRoot, "checksums.json"),
    `${JSON.stringify(await recoveryChecksums(bundleRoot), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
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

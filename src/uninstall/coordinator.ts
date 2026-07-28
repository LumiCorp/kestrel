import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
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

import { uninstallManagedService } from "../../cli/kcron/service.js";
import { LocalCoreClient } from "../localCore/client.js";
import { resolveKestrelCoreHome, resolveLocalCorePaths } from "../localCore/home.js";
import { detectLocalCoreMigrationState } from "../localCore/legacyState.js";
import { purgeMacosLocalCoreKeychainService } from "../localCore/macosKeychainCredentialStore.js";
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

export interface CreateKestrelUninstallPlanInput {
  initiator: KestrelUninstallInitiator;
  scope: KestrelUninstallScope;
  options?: KestrelUninstallPlanOptions | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  now?: Date | undefined;
}

export async function createKestrelUninstallPlan(
  input: CreateKestrelUninstallPlanInput,
): Promise<KestrelUninstallPlanV1> {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const options = normalizeOptions(input.options);
  const blockers: KestrelUninstallBlocker[] = [];
  if (platform !== "darwin") {
    blockers.push({
      code: "UNINSTALL_PLATFORM_UNSUPPORTED",
      message: "Kestrel uninstall v1 supports macOS only.",
    });
  }

  const targets = [
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

  const lifecycle = await inspectLocalCoreLifecycle({ env, platform });
  blockers.push(...lifecycle.blockers);

  const worktrees = await inspectManagedWorktrees();
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

  const kestrelOne = await inspectKestrelOne({
    lifecycle,
    disconnectSelected: options.disconnectKestrelOne === true,
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

  const generatedAt = (input.now ?? new Date()).toISOString();
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
  request: KestrelUninstallApplyRequest,
): Promise<KestrelUninstallApplyResultV1> {
  const plan = parseKestrelUninstallPlanV1(request.plan);
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
  });
  if (current.planId !== plan.planId) {
    return {
      version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
      planId: plan.planId,
      appliedAt: new Date().toISOString(),
      status: "blocked",
      removedTargets: [],
      skippedTargets: [],
      blockers: [
        {
          code: "UNINSTALL_PLAN_STALE",
          message:
            "Uninstall plan is stale. Re-run planning before applying destructive changes.",
        },
      ],
      finalTargets: current.targets,
    };
  }
  if (plan.blockers.length > 0) {
    return {
      version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
      planId: plan.planId,
      appliedAt: new Date().toISOString(),
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
      appliedAt: new Date().toISOString(),
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

  if (plan.scope === "all_software" || plan.scope === "complete") {
    try {
      await shutdownLocalCoreIfPresent({ platform: plan.platform });
    } catch (error) {
      return {
        version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
        planId: plan.planId,
        appliedAt: new Date().toISOString(),
        status: "blocked",
        removedTargets,
        skippedTargets,
        blockers: [
          {
            code: "LOCAL_CORE_SHUTDOWN_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
        finalTargets: current.targets,
      };
    }
  }

  for (const target of plan.targets) {
    if (target.selected === false) {
      skippedTargets.push(target.id);
      continue;
    }
    try {
      await removeTarget(target);
      removedTargets.push(target.id);
    } catch (error) {
      blockers.push({
        code: "UNINSTALL_TARGET_REMOVE_FAILED",
        message: error instanceof Error ? error.message : String(error),
        targetId: target.id,
      });
    }
  }

  const finalPlan = await createKestrelUninstallPlan({
    initiator: plan.initiator,
    scope: plan.scope,
    options: plan.options,
    platform: plan.platform,
  });
  return {
    version: KESTREL_UNINSTALL_APPLY_RESULT_VERSION,
    planId: plan.planId,
    appliedAt: new Date().toISOString(),
    status: blockers.length === 0 ? "applied" : removedTargets.length > 0 ? "partial" : "blocked",
    removedTargets,
    skippedTargets,
    blockers,
    finalTargets: finalPlan.targets,
  };
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
  for (const [name, expectedTarget] of expected) {
    const linkPath = path.join(pnpmHome, name);
    const link = await readSymlinkTarget(linkPath);
    if (link === undefined) continue;
    const verified = link.realTarget === path.resolve(expectedTarget);
    targets.push({
      id: `cli.symlink.${name}`,
      kind: "cli_symlink",
      path: linkPath,
      verified,
      selected,
      removal: "unlink",
      fingerprint: hashValue({ linkPath, realTarget: link.realTarget, verified }),
      evidence: verified
        ? [`symlink target ${link.realTarget}`]
        : [`foreign symlink target ${link.realTarget}`],
      ...(verified ? {} : { blockedReason: "CLI symlink target is not the verified Kestrel binary." }),
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
    const verified = info.includes("com.kestrel.desktop");
    const blockedReason = selected
      ? "Packaged Desktop removal requires the signed native helper."
      : undefined;
    targets.push({
      id: `desktop.bundle.${hashString(bundlePath).slice(0, 12)}`,
      kind: "desktop_bundle",
      path: bundlePath,
      verified,
      selected,
      removal: "manual",
      fingerprint: hashValue({ bundlePath, infoHash: hashString(info), verified }),
      evidence: verified
        ? ["bundle id com.kestrel.desktop"]
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

async function inspectManagedWorktrees(): Promise<KestrelUninstallWorktreeSummary> {
  return {
    cleanDisposable: 0,
    retained: 0,
    blocked: 0,
    totalBytes: 0,
    entries: [],
  };
}

async function inspectKestrelOne(input: {
  lifecycle: KestrelUninstallLifecycle;
  disconnectSelected: boolean;
}): Promise<KestrelUninstallKestrelOneSummary> {
  if (input.lifecycle.state === "missing" || input.lifecycle.state === "unavailable") {
    return { disconnectSelected: input.disconnectSelected, environments: [] };
  }
  return { disconnectSelected: input.disconnectSelected, environments: [] };
}

async function removeTarget(target: KestrelUninstallTarget): Promise<void> {
  if (target.verified === false) {
    throw new Error(`Refusing to remove unverified target '${target.id}'.`);
  }
  if (target.removal === "manual") {
    throw new Error(`Target '${target.id}' requires manual removal.`);
  }
  if (target.kind === "keychain_service") {
    await purgeMacosLocalCoreKeychainService();
    return;
  }
  if (target.kind === "kcron_launch_agent") {
    await uninstallManagedService("darwin");
    return;
  }
  if (target.path === undefined) {
    throw new Error(`Target '${target.id}' has no path.`);
  }
  await assertSafeRemovalPath(target.path, target.kind);
  if (target.removal === "unlink") {
    await unlink(target.path);
    return;
  }
  await rm(target.path, { recursive: true, force: true });
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
    kind !== "kcron_launch_agent"
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

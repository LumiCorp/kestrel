import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

import type {
  InstalledWorkspaceSkillRevision,
  WorkspaceSkillCatalogEntry,
  WorkspaceSkillManifest,
  WorkspaceSkillSource,
  WorkspaceSkillSyncResult,
} from "./contracts.js";

const execFileAsync = promisify(execFile);
const SKILLS_ROOT = path.join(".kestrel", "skills");
const MAX_SKILL_FILES = 500;
const MAX_SKILL_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const NON_PUBLIC_ADDRESSES = buildNonPublicAddressBlockList();

export interface WorkspaceSkillInstallerDependencies {
  now?: (() => Date) | undefined;
  resolveHost?: ((hostname: string) => Promise<readonly string[]>) | undefined;
  runGit?: ((input: { args: string[]; cwd?: string | undefined; resolve?: GitHostResolution | undefined }) => Promise<string>) | undefined;
}

interface GitHostResolution {
  hostname: string;
  address: string;
}

interface ValidatedWorkspaceSkillSource extends Required<Pick<WorkspaceSkillSource, "gitUrl" | "branch">>, Pick<WorkspaceSkillSource, "path"> {
  resolution: GitHostResolution;
}

interface PackageFile {
  relativePath: string;
  absolutePath: string;
  size: number;
  mode: number;
}

interface ValidatedPackage {
  manifest: WorkspaceSkillManifest;
  files: PackageFile[];
  contentDigest: string;
  totalBytes: number;
}

export class WorkspaceSkillInstaller {
  private readonly now: () => Date;
  private readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  private readonly runGit: (input: { args: string[]; cwd?: string | undefined; resolve?: GitHostResolution | undefined }) => Promise<string>;

  constructor(dependencies: WorkspaceSkillInstallerDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.resolveHost = dependencies.resolveHost ?? resolvePublicHost;
    this.runGit = dependencies.runGit ?? runHardenedGit;
  }

  async sync(input: {
    workspaceRoot: string;
    installationId: string;
    source: WorkspaceSkillSource;
    acceptManifest?: ((manifest: WorkspaceSkillManifest) => Promise<void>) | undefined;
  }): Promise<WorkspaceSkillSyncResult> {
    const attemptedAt = this.now().toISOString();
    let current: InstalledWorkspaceSkillRevision | undefined;
    try {
      current = await this.readCurrentRevision(input.workspaceRoot, input.installationId);
      const source = await validateWorkspaceSkillSource(input.source, this.resolveHost);
      const installationRoot = resolveInstallationRoot(input.workspaceRoot, input.installationId);
      await mkdir(path.join(installationRoot, "revisions"), { recursive: true, mode: 0o700 });
      const checkoutRoot = await mkdtemp(path.join(installationRoot, ".staging-"));
      try {
        await this.runGit({ args: ["init", "--quiet"], cwd: checkoutRoot });
        const remoteRef = `refs/heads/${source.branch}`;
        await this.runGit({
          args: ["fetch", "--quiet", "--depth=1", source.gitUrl, remoteRef],
          cwd: checkoutRoot,
          resolve: source.resolution,
        });
        const commitSha = normalizeCommitSha((await this.runGit({ args: ["rev-parse", "FETCH_HEAD"], cwd: checkoutRoot })).trim());
        let replaceInvalidRevision = false;
        if (current?.commitSha === commitSha) {
          try {
            await verifyInstalledRevision(input.workspaceRoot, current);
            return { status: "ready", changed: false, attemptedAt, revision: current };
          } catch {
            current = undefined;
            replaceInvalidRevision = true;
          }
        }
        await this.runGit({ args: ["checkout", "--quiet", "--detach", commitSha], cwd: checkoutRoot });
        const packageRoot = resolvePackageRoot(checkoutRoot, source.path);
        const validated = await validateWorkspaceSkillPackage(packageRoot);
        await input.acceptManifest?.(validated.manifest);
        const revision = await this.publishRevision({
          workspaceRoot: input.workspaceRoot,
          installationId: input.installationId,
          commitSha,
          installedAt: attemptedAt,
          validated,
          replaceInvalidRevision,
        });
        return { status: "ready", changed: true, attemptedAt, revision };
      } finally {
        await rm(checkoutRoot, { recursive: true, force: true });
      }
    } catch (error) {
      const message = sanitizeSkillSyncError(error);
      return current === undefined
        ? { status: "failed", changed: false, attemptedAt, error: message }
        : { status: "stale", changed: false, attemptedAt, revision: current, error: message };
    }
  }

  async readCatalog(workspaceRoot: string, installationIds: readonly string[]): Promise<WorkspaceSkillCatalogEntry[]> {
    const catalog: WorkspaceSkillCatalogEntry[] = [];
    for (const installationId of installationIds) {
      const revision = await this.readCurrentRevision(workspaceRoot, installationId);
      if (revision === undefined) continue;
      await verifyInstalledRevision(workspaceRoot, revision);
      catalog.push({
        installationId: revision.installationId,
        name: revision.name,
        description: revision.description,
        commitSha: revision.commitSha,
        contentDigest: revision.contentDigest,
        skillFile: revision.skillFile,
      });
    }
    return catalog.sort((left, right) => left.name.localeCompare(right.name));
  }

  async readWorkspaceCatalog(workspaceRoot: string): Promise<WorkspaceSkillCatalogEntry[]> {
    const root = path.join(path.resolve(workspaceRoot), SKILLS_ROOT);
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return this.readCatalog(workspaceRoot, entries);
  }

  async readCurrentRevision(
    workspaceRoot: string,
    installationId: string,
  ): Promise<InstalledWorkspaceSkillRevision | undefined> {
    const installationRoot = resolveInstallationRoot(workspaceRoot, installationId);
    try {
      const raw = await readFile(path.join(installationRoot, "current.json"), "utf8");
      return parseInstalledRevision(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async remove(input: { workspaceRoot: string; installationId: string }): Promise<void> {
    await rm(resolveInstallationRoot(input.workspaceRoot, input.installationId), {
      recursive: true,
      force: true,
    });
  }

  private async publishRevision(input: {
    workspaceRoot: string;
    installationId: string;
    commitSha: string;
    installedAt: string;
    validated: ValidatedPackage;
    replaceInvalidRevision?: boolean | undefined;
  }): Promise<InstalledWorkspaceSkillRevision> {
    const installationRoot = resolveInstallationRoot(input.workspaceRoot, input.installationId);
    const relativeRoot = path.posix.join(SKILLS_ROOT, input.installationId, "revisions", input.commitSha);
    const revisionRoot = path.join(input.workspaceRoot, ...relativeRoot.split("/"));
    const stagingRoot = `${revisionRoot}.staging-${process.pid}-${randomUUID()}`;
    if (input.replaceInvalidRevision === true) {
      await rm(revisionRoot, { recursive: true, force: true });
    }
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    try {
      for (const file of input.validated.files) {
        const destination = path.join(stagingRoot, ...file.relativePath.split("/"));
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await copyFile(file.absolutePath, destination);
        await chmod(destination, file.mode & 0o111 ? 0o700 : 0o600);
      }
      try {
        await rename(stagingRoot, revisionRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        await rm(stagingRoot, { recursive: true, force: true });
      }
      const revision: InstalledWorkspaceSkillRevision = {
        installationId: input.installationId,
        ...input.validated.manifest,
        commitSha: input.commitSha,
        contentDigest: input.validated.contentDigest,
        relativeRoot,
        skillFile: path.posix.join(relativeRoot, "SKILL.md"),
        installedAt: input.installedAt,
        fileCount: input.validated.files.length,
        totalBytes: input.validated.totalBytes,
      };
      const pointerTemp = path.join(installationRoot, `current.json.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(pointerTemp, `${JSON.stringify(revision, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(pointerTemp, path.join(installationRoot, "current.json"));
      return revision;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

export async function materializeWorkspaceSkillSnapshot(input: {
  sourceWorkspaceRoot: string;
  targetWorkspaceRoot: string;
  catalog: readonly WorkspaceSkillCatalogEntry[];
}): Promise<void> {
  const sourceRoot = path.resolve(input.sourceWorkspaceRoot);
  const targetRoot = path.resolve(input.targetWorkspaceRoot);
  if (sourceRoot === targetRoot || input.catalog.length === 0) return;
  for (const entry of input.catalog) {
    const sourceSkillFile = resolveCatalogSkillFile(sourceRoot, entry);
    const sourceRevisionRoot = path.dirname(sourceSkillFile);
    const sourceInstallationRoot = path.dirname(path.dirname(sourceRevisionRoot));
    const sourceRevision = parseInstalledRevision(JSON.parse(
      await readFile(path.join(sourceInstallationRoot, "current.json"), "utf8"),
    ));
    if (
      sourceRevision.installationId !== entry.installationId ||
      sourceRevision.commitSha !== entry.commitSha ||
      sourceRevision.contentDigest !== entry.contentDigest
    ) {
      throw new Error(`Workspace skill snapshot '${entry.name}' has an inconsistent current revision.`);
    }
    const targetRevisionRoot = path.join(targetRoot, path.relative(sourceRoot, sourceRevisionRoot));
    const targetInstallationRoot = path.dirname(path.dirname(targetRevisionRoot));
    try {
      const existing = await validateWorkspaceSkillPackage(targetRevisionRoot);
      if (existing.contentDigest === entry.contentDigest && existing.manifest.name === entry.name) {
        await publishSnapshotPointer(targetInstallationRoot, sourceRevision);
        continue;
      }
    } catch {
      // Missing or invalid snapshots are replaced while the workspace is idle.
    }
    const stagingRoot = `${targetRevisionRoot}.staging-${process.pid}-${randomUUID()}`;
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(path.dirname(targetRevisionRoot), { recursive: true, mode: 0o700 });
    await cp(sourceRevisionRoot, stagingRoot, { recursive: true, errorOnExist: true });
    const validated = await validateWorkspaceSkillPackage(stagingRoot);
    if (validated.contentDigest !== entry.contentDigest || validated.manifest.name !== entry.name) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw new Error(`Workspace skill snapshot '${entry.name}' failed integrity validation.`);
    }
    await rm(targetRevisionRoot, { recursive: true, force: true });
    await rename(stagingRoot, targetRevisionRoot);
    await publishSnapshotPointer(targetInstallationRoot, sourceRevision);
  }
}

async function publishSnapshotPointer(
  installationRoot: string,
  revision: InstalledWorkspaceSkillRevision,
): Promise<void> {
  await mkdir(installationRoot, { recursive: true, mode: 0o700 });
  const temp = path.join(installationRoot, `current.json.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(revision, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path.join(installationRoot, "current.json"));
}

export async function validateWorkspaceSkillSource(
  input: WorkspaceSkillSource,
  resolveHost: (hostname: string) => Promise<readonly string[]> = resolvePublicHost,
): Promise<ValidatedWorkspaceSkillSource> {
  const normalized = normalizeWorkspaceSkillSource(input);
  const url = new URL(normalized.gitUrl);
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error("Skill Git URL must resolve only to public network addresses.");
  }
  const address = addresses[0];
  if (address === undefined) throw new Error("Skill Git URL must resolve to a public network address.");
  return {
    ...normalized,
    resolution: { hostname, address },
  };
}

export function normalizeWorkspaceSkillSource(
  input: WorkspaceSkillSource,
): WorkspaceSkillSource {
  let url: URL;
  try {
    url = new URL(input.gitUrl.trim());
  } catch {
    throw new Error("Skill Git URL must be a valid public HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Skill Git URL must use public HTTPS without credentials or a custom port.");
  }
  if (url.search || url.hash) throw new Error("Skill Git URL must not contain query parameters or fragments.");
  if (!url.pathname || url.pathname === "/") throw new Error("Skill Git URL must identify a repository path.");
  const branch = input.branch.trim();
  if (!isValidBranch(branch)) throw new Error("Skill branch is not a valid Git branch name.");
  const skillPath = normalizeSkillPath(input.path);
  return {
    gitUrl: url.toString(),
    branch,
    ...(skillPath ? { path: skillPath } : {}),
  };
}

export async function validateWorkspaceSkillPackage(packageRoot: string): Promise<ValidatedPackage> {
  const rootStat = await lstat(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Skill path must be a regular directory.");
  const files: PackageFile[] = [];
  await collectPackageFiles(packageRoot, packageRoot, files);
  if (files.length === 0 || files.length > MAX_SKILL_FILES) throw new Error(`Skill packages must contain between 1 and ${MAX_SKILL_FILES} files.`);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_SKILL_BYTES) throw new Error("Skill package exceeds the 10 MiB size limit.");
  const skillFile = files.find((file) => file.relativePath === "SKILL.md");
  if (skillFile === undefined) throw new Error("Skill package must contain SKILL.md at its root.");
  if (skillFile.size > MAX_SKILL_FILE_BYTES) throw new Error("SKILL.md exceeds the 64 KiB size limit.");
  if (files.some((file) => file.relativePath === ".gitmodules")) throw new Error("Skill packages cannot contain Git submodules.");
  const manifest = parseSkillManifest(await readFile(skillFile.absolutePath, "utf8"));
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    digest.update(file.relativePath).update("\0").update(String(file.size)).update("\0");
    const handle = await open(file.absolutePath, "r");
    try {
      for await (const chunk of handle.createReadStream()) digest.update(chunk);
    } finally {
      await handle.close();
    }
  }
  return { manifest, files, contentDigest: `sha256:${digest.digest("hex")}`, totalBytes };
}

export function parseSkillManifest(content: string): WorkspaceSkillManifest {
  const normalized = content.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    throw new Error("SKILL.md must begin with YAML frontmatter.");
  }
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match?.[1]) throw new Error("SKILL.md frontmatter is not terminated.");
  const parsed = parseYaml(match[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("SKILL.md frontmatter must be an object.");
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
    throw new Error("Skill name must be a lowercase hyphenated identifier of at most 64 characters.");
  }
  if (description.length === 0 || description.length > 500) {
    throw new Error("Skill description must contain between 1 and 500 characters.");
  }
  return { name, description };
}

async function collectPackageFiles(root: string, directory: string, output: PackageFile[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") throw new Error("Skill packages cannot contain nested Git metadata.");
    const absolutePath = path.join(directory, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error("Skill packages cannot contain symbolic links.");
    if (metadata.isDirectory()) {
      await collectPackageFiles(root, absolutePath, output);
      continue;
    }
    if (!metadata.isFile()) throw new Error("Skill packages can contain only regular files and directories.");
    output.push({
      absolutePath,
      relativePath: path.relative(root, absolutePath).split(path.sep).join("/"),
      size: metadata.size,
      mode: metadata.mode,
    });
    if (output.length > MAX_SKILL_FILES) return;
  }
}

async function resolvePublicHost(hostname: string): Promise<readonly string[]> {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !NON_PUBLIC_ADDRESSES.check(address, family === 6 ? "ipv6" : "ipv4");
}

function buildNonPublicAddressBlockList(): BlockList {
  const list = new BlockList();
  const ipv4Ranges = [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 3],
  ] as const;
  for (const [network, prefix] of ipv4Ranges) {
    list.addSubnet(network, prefix, "ipv4");
    list.addSubnet(`::ffff:${network}`, prefix + 96, "ipv6");
  }
  for (const [network, prefix] of [
    ["::", 128], ["::1", 128], ["64:ff9b:1::", 48],
    ["100::", 64], ["2001:db8::", 32], ["2001:10::", 28], ["fc00::", 7],
    ["fe80::", 10], ["ff00::", 8],
  ] as const) list.addSubnet(network, prefix, "ipv6");
  return list;
}

function isValidBranch(branch: string): boolean {
  return branch.length > 0 && branch.length <= 255 && !branch.startsWith("-") && !branch.startsWith("/") && !branch.endsWith("/") && !branch.endsWith(".") && !branch.includes("..") && !branch.includes("@{") && !/[\u0000-\u0020~^:?*[\\]/u.test(branch) && !branch.split("/").some((part) => part.length === 0 || part.startsWith(".") || part.endsWith(".lock"));
}

function normalizeSkillPath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
  if (!normalized) return;
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Skill path must be a normalized repository-relative directory.");
  }
  return normalized;
}

function resolvePackageRoot(checkoutRoot: string, relativePath: string | undefined): string {
  const candidate = relativePath ? path.join(checkoutRoot, ...relativePath.split("/")) : checkoutRoot;
  const relative = path.relative(checkoutRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill path escapes the repository checkout.");
  return candidate;
}

function resolveInstallationRoot(workspaceRoot: string, installationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(installationId)) throw new Error("Skill installation id is invalid.");
  return path.join(path.resolve(workspaceRoot), SKILLS_ROOT, installationId);
}

function resolveCatalogSkillFile(workspaceRoot: string, entry: WorkspaceSkillCatalogEntry): string {
  const expectedPrefix = path.posix.join(SKILLS_ROOT, entry.installationId, "revisions", entry.commitSha);
  if (entry.skillFile !== path.posix.join(expectedPrefix, "SKILL.md")) {
    throw new Error(`Workspace skill '${entry.name}' has an invalid catalog path.`);
  }
  const absolute = path.join(path.resolve(workspaceRoot), ...entry.skillFile.split("/"));
  const relative = path.relative(path.resolve(workspaceRoot), absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workspace skill path escapes its workspace.");
  return absolute;
}

async function verifyInstalledRevision(workspaceRoot: string, revision: InstalledWorkspaceSkillRevision): Promise<void> {
  const skillFile = resolveCatalogSkillFile(workspaceRoot, revision);
  const validated = await validateWorkspaceSkillPackage(path.dirname(skillFile));
  if (
    validated.contentDigest !== revision.contentDigest ||
    validated.manifest.name !== revision.name ||
    validated.manifest.description !== revision.description ||
    validated.files.length !== revision.fileCount ||
    validated.totalBytes !== revision.totalBytes
  ) {
    throw new Error(`Installed workspace skill '${revision.name}' failed integrity validation.`);
  }
}

function normalizeCommitSha(value: string): string {
  if (!/^[a-f0-9]{40,64}$/u.test(value)) throw new Error("Git remote did not resolve to a valid commit SHA.");
  return value;
}

async function runHardenedGit(input: { args: string[]; cwd?: string | undefined; resolve?: GitHostResolution | undefined }): Promise<string> {
  const pinnedAddress = input.resolve?.address.includes(":")
    ? `[${input.resolve.address}]`
    : input.resolve?.address;
  const result = await execFileAsync("git", [
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ext.allow=never",
    "-c", "http.followRedirects=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "submodule.recurse=false",
    "-c", "core.fsmonitor=false",
    ...(input.resolve && pinnedAddress && isIP(input.resolve.hostname) === 0
      ? ["-c", `http.curloptResolve=${input.resolve.hostname}:443:${pinnedAddress}`]
      : []),
    ...input.args,
  ], {
    ...(input.cwd ? { cwd: input.cwd } : {}),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout;
}

function sanitizeSkillSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https:\/\/[^\s/@]+:[^\s/@]+@/giu, "https://[redacted]@").replace(/[\r\n\t]+/gu, " ").slice(0, 500);
}

function parseInstalledRevision(value: unknown): InstalledWorkspaceSkillRevision {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Installed skill revision is invalid.");
  const record = value as Record<string, unknown>;
  const required = (key: string) => {
    const candidate = record[key];
    if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`Installed skill revision '${key}' is invalid.`);
    return candidate;
  };
  const fileCount = record.fileCount;
  const totalBytes = record.totalBytes;
  if (!Number.isInteger(fileCount) || !Number.isInteger(totalBytes)) throw new Error("Installed skill revision size metadata is invalid.");
  return {
    installationId: required("installationId"),
    name: required("name"),
    description: required("description"),
    commitSha: required("commitSha"),
    contentDigest: required("contentDigest"),
    relativeRoot: required("relativeRoot"),
    skillFile: required("skillFile"),
    installedAt: required("installedAt"),
    fileCount: fileCount as number,
    totalBytes: totalBytes as number,
  };
}

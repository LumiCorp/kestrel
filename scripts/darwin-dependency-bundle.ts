import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

interface SourceMapping {
  sourceRoot: string;
  targetRoot: string;
}
interface BinaryEntry {
  sourcePath: string;
  targetPath: string;
}

export interface DarwinDependencyBundleResult {
  bundledLibraries: string[];
  scannedBinaries: number;
}

export interface DarwinDependencyAuditResult {
  scannedBinaries: number;
}

export function bundleDarwinDependencies(input: {
  bundleLibDir: string;
  sourceExecutableDir: string;
  sourceMappings: SourceMapping[];
}): DarwinDependencyBundleResult {
  const queue: BinaryEntry[] = [];
  const queuedTargets = new Set<string>();
  const processedTargets = new Set<string>();
  const bundledByBasename = new Map<string, { sourcePath: string; targetPath: string }>();
  const copiedLibraries = new Set<string>();

  for (const mapping of input.sourceMappings) {
    for (const targetPath of listFiles(mapping.targetRoot)) {
      if (isMachOBinary(targetPath) === false) {
        continue;
      }
      const relativePath = path.relative(mapping.targetRoot, targetPath);
      const sourcePath = path.join(mapping.sourceRoot, relativePath);
      enqueue({ sourcePath, targetPath });
      if (isInside(targetPath, input.bundleLibDir)) {
        registerBundledLibrary(path.basename(targetPath), sourcePath, targetPath);
      }
    }
  }

  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === undefined || processedTargets.has(entry.targetPath)) {
      continue;
    }
    processedTargets.add(entry.targetPath);

    const dependencies = readMachODependencies(entry.targetPath);
    const changes: string[] = [];
    for (const [index, loadPath] of dependencies.entries()) {
      if (isOwnDylibId(entry.targetPath, loadPath, index)) {
        continue;
      }
      if (isSystemLibrary(loadPath)) {
        continue;
      }

      const dependency = ensureBundledDependency(entry, loadPath);
      const rewrittenPath = toLoaderPath(entry.targetPath, dependency.targetPath);
      if (loadPath !== rewrittenPath) {
        changes.push("-change", loadPath, rewrittenPath);
      }
    }

    if (entry.targetPath.endsWith(".dylib")) {
      changes.push("-id", `@loader_path/${path.basename(entry.targetPath)}`);
    }
    if (changes.length > 0) {
      execFileSync("install_name_tool", [...changes, entry.targetPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  }

  for (const binaryPath of [...processedTargets].sort()) {
    execFileSync("codesign", ["--force", "--sign", "-", binaryPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  assertNoExternalDarwinDependencies({
    binaryRoots: input.sourceMappings.map((mapping) => mapping.targetRoot),
    bundleLibDir: input.bundleLibDir,
  });

  return {
    bundledLibraries: [...copiedLibraries].sort(),
    scannedBinaries: processedTargets.size,
  };

  function enqueue(entry: BinaryEntry): void {
    const targetPath = path.resolve(entry.targetPath);
    if (queuedTargets.has(targetPath)) {
      return;
    }
    queuedTargets.add(targetPath);
    queue.push({
      sourcePath: resolveExistingPath(entry.sourcePath),
      targetPath,
    });
  }

  function registerBundledLibrary(
    basename: string,
    sourcePath: string,
    targetPath: string,
  ): { sourcePath: string; targetPath: string } {
    const resolvedSource = resolveExistingPath(sourcePath);
    const existing = bundledByBasename.get(basename);
    if (existing !== undefined) {
      if (resolveExistingPath(existing.sourcePath) !== resolvedSource) {
        throw new Error(
          `Darwin dependency basename collision for '${basename}': `
            + `'${existing.sourcePath}' and '${sourcePath}'.`,
        );
      }
      return existing;
    }
    const registered = {
      sourcePath: resolvedSource,
      targetPath: path.resolve(targetPath),
    };
    bundledByBasename.set(basename, registered);
    return registered;
  }

  function ensureBundledDependency(
    entry: BinaryEntry,
    loadPath: string,
  ): { sourcePath: string; targetPath: string } {
    const basename = path.basename(loadPath);
    const existing = bundledByBasename.get(basename);
    const sourcePath = resolveDependencySource({
      loadPath,
      sourceBinaryPath: entry.sourcePath,
      sourceExecutableDir: input.sourceExecutableDir,
    });

    if (existing !== undefined) {
      if (
        sourcePath !== undefined
        && resolveExistingPath(existing.sourcePath) !== resolveExistingPath(sourcePath)
      ) {
        throw new Error(
          `Darwin dependency basename collision for '${basename}': `
            + `'${existing.sourcePath}' and '${sourcePath}'.`,
        );
      }
      return existing;
    }
    if (sourcePath === undefined) {
      throw new Error(
        `Unable to resolve non-system Darwin dependency '${loadPath}' from '${entry.sourcePath}'.`,
      );
    }

    const targetPath = path.join(input.bundleLibDir, basename);
    cpSync(sourcePath, targetPath, {
      dereference: true,
      force: true,
      preserveTimestamps: true,
    });
    makeOwnerWritable(targetPath);
    const registered = registerBundledLibrary(basename, sourcePath, targetPath);
    copiedLibraries.add(basename);
    enqueue(registered);
    return registered;
  }
}

export function assertNoExternalDarwinDependencies(input: {
  binaryRoots: string[];
  bundleLibDir: string;
}): DarwinDependencyAuditResult {
  const errors: string[] = [];
  let scannedBinaries = 0;
  for (const root of input.binaryRoots) {
    for (const binaryPath of listFiles(root)) {
      if (isMachOBinary(binaryPath) === false) {
        continue;
      }
      scannedBinaries += 1;
      const dependencies = readMachODependencies(binaryPath);
      for (const [index, loadPath] of dependencies.entries()) {
        if (isOwnDylibId(binaryPath, loadPath, index) || isSystemLibrary(loadPath)) {
          continue;
        }
        if (loadPath.startsWith("/")) {
          errors.push(`${binaryPath}: external absolute dependency '${loadPath}'`);
          continue;
        }
        if (resolveBundledLoadPath(binaryPath, loadPath, input.bundleLibDir) === undefined) {
          errors.push(`${binaryPath}: unresolved bundled dependency '${loadPath}'`);
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(`Darwin bundle contains external dependencies:\n${errors.join("\n")}`);
  }
  return { scannedBinaries };
}

export function readMachODependencies(binaryPath: string): string[] {
  const output = execFileSync("otool", ["-L", binaryPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => /^\s*(.+?)\s+\(compatibility version/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

function resolveDependencySource(input: {
  loadPath: string;
  sourceBinaryPath: string;
  sourceExecutableDir: string;
}): string | undefined {
  if (input.loadPath.startsWith("/")) {
    return existsSync(input.loadPath) ? resolveExistingPath(input.loadPath) : undefined;
  }
  if (input.loadPath.startsWith("@loader_path/")) {
    return firstExistingPath([
      path.join(path.dirname(input.sourceBinaryPath), input.loadPath.slice("@loader_path/".length)),
    ]);
  }
  if (input.loadPath.startsWith("@executable_path/")) {
    return firstExistingPath([
      path.join(input.sourceExecutableDir, input.loadPath.slice("@executable_path/".length)),
    ]);
  }
  if (input.loadPath.startsWith("@rpath/")) {
    const suffix = input.loadPath.slice("@rpath/".length);
    const rpathCandidates = readMachORpaths(input.sourceBinaryPath).map((rpath) =>
      path.join(
        expandSourceToken(rpath, input.sourceBinaryPath, input.sourceExecutableDir),
        suffix,
      )
    );
    return firstExistingPath([
      ...rpathCandidates,
      path.join(path.dirname(input.sourceBinaryPath), suffix),
    ]);
  }
  return firstExistingPath([path.resolve(path.dirname(input.sourceBinaryPath), input.loadPath)]);
}

function readMachORpaths(binaryPath: string): string[] {
  const output = execFileSync("otool", ["-l", binaryPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = output.split(/\r?\n/u);
  const rpaths: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== "cmd LC_RPATH") {
      continue;
    }
    for (let offset = index + 1; offset < Math.min(index + 6, lines.length); offset += 1) {
      const match = /^\s*path\s+(.+?)\s+\(offset\s+\d+\)/u.exec(lines[offset] ?? "");
      if (match?.[1] !== undefined) {
        rpaths.push(match[1]);
        break;
      }
    }
  }
  return rpaths;
}

function expandSourceToken(
  value: string,
  sourceBinaryPath: string,
  sourceExecutableDir: string,
): string {
  return value
    .replace(/^@loader_path/u, path.dirname(sourceBinaryPath))
    .replace(/^@executable_path/u, sourceExecutableDir);
}

function resolveBundledLoadPath(
  binaryPath: string,
  loadPath: string,
  bundleLibDir: string,
): string | undefined {
  const candidates: string[] = [];
  if (loadPath.startsWith("@loader_path/")) {
    candidates.push(path.join(path.dirname(binaryPath), loadPath.slice("@loader_path/".length)));
  } else if (loadPath.startsWith("@executable_path/")) {
    candidates.push(path.join(path.dirname(binaryPath), loadPath.slice("@executable_path/".length)));
  } else if (loadPath.startsWith("@rpath/")) {
    candidates.push(path.join(bundleLibDir, loadPath.slice("@rpath/".length)));
  } else {
    candidates.push(path.resolve(path.dirname(binaryPath), loadPath));
  }
  const resolvedPath = firstExistingPath(candidates);
  if (resolvedPath === undefined || isInside(resolvedPath, bundleLibDir) === false) {
    return undefined;
  }
  return resolvedPath;
}

function toLoaderPath(binaryPath: string, dependencyPath: string): string {
  const relativePath = path.relative(path.dirname(binaryPath), dependencyPath);
  return `@loader_path/${relativePath.split(path.sep).join("/")}`;
}

function isOwnDylibId(binaryPath: string, loadPath: string, index: number): boolean {
  return index === 0
    && binaryPath.endsWith(".dylib")
    && path.basename(loadPath) === path.basename(binaryPath);
}

function isSystemLibrary(loadPath: string): boolean {
  return loadPath.startsWith("/usr/lib/") || loadPath.startsWith("/System/Library/");
}

function isMachOBinary(filePath: string): boolean {
  try {
    const output = execFileSync("file", ["-b", filePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.includes("Mach-O");
  } catch {
    return false;
  }
}

function listFiles(rootPath: string): string[] {
  if (existsSync(rootPath) === false) {
    return [];
  }
  const files: string[] = [];
  const visit = (entryPath: string): void => {
    const entryStat = statSync(entryPath);
    if (entryStat.isDirectory() === false) {
      files.push(entryPath);
      return;
    }
    for (const entry of readdirSync(entryPath)) {
      visit(path.join(entryPath, entry));
    }
  };
  visit(rootPath);
  return files;
}

function makeOwnerWritable(filePath: string): void {
  const mode = statSync(filePath).mode;
  chmodSync(filePath, (mode & 0o777) | 0o200);
}

function resolveExistingPath(candidatePath: string): string {
  return existsSync(candidatePath) ? realpathSync(candidatePath) : path.resolve(candidatePath);
}

function firstExistingPath(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }
  return undefined;
}

function isInside(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === "" || (relativePath.startsWith("..") === false && path.isAbsolute(relativePath) === false);
}

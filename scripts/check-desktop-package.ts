import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = resolveRepoRoot(process.cwd());
const appPath = path.resolve(
  process.argv[2] ??
    path.join(repoRoot, "apps", "desktop", "out", "mac-arm64", "Kestrel.app"),
);
const resourcesPath = path.join(appPath, "Contents", "Resources");
const shellRoot = path.join(resourcesPath, "app");
const runtimeRoot = path.join(resourcesPath, "kestrel-runtime");
const payloadRoot = path.join(runtimeRoot, "payload");
const executable = path.join(appPath, "Contents", "MacOS", "Kestrel");
const helper = path.join(resourcesPath, "kestrel-uninstall-helper");

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Desktop package preflight supports macOS arm64 only.");
}
for (const required of [
  executable,
  helper,
  path.join(shellRoot, "package.json"),
  path.join(shellRoot, "dist", "apps", "desktop", "src", "main.js"),
  path.join(shellRoot, "dist", "apps", "desktop", "src", "preload.js"),
  path.join(shellRoot, "node_modules", "electron-updater"),
  path.join(runtimeRoot, "package.json"),
  path.join(runtimeRoot, "node_modules", "tsx"),
  path.join(runtimeRoot, "node_modules", "@electric-sql", "pglite"),
  path.join(payloadRoot, "package.json"),
  path.join(payloadRoot, "cli", "runner", "main.ts"),
  path.join(payloadRoot, "db", "migrations"),
  path.join(payloadRoot, "src", "localCore", "api.ts"),
]) {
  if (!existsSync(required)) {
    throw new Error(`Packaged Desktop dependency is missing: ${required}`);
  }
}

for (const entry of walk(resourcesPath)) {
  const basename = path.basename(entry);
  if (basename === ".env" || basename.startsWith(".env.")) {
    throw new Error(`Packaged Desktop contains a forbidden env file: ${entry}`);
  }
  if (!lstatSync(entry).isSymbolicLink()) continue;
  let target: string;
  try {
    target = realpathSync(entry);
  } catch {
    throw new Error(`Packaged Desktop contains a broken link: ${entry}`);
  }
  if (!isInside(appPath, target)) {
    throw new Error(
      `Packaged Desktop link escapes the application: ${entry} -> ${target}`,
    );
  }
}

for (const manifestPath of [
  path.join(shellRoot, "package.json"),
  path.join(runtimeRoot, "package.json"),
]) {
  const raw = readFileSync(manifestPath, "utf8");
  if (
    /\b(?:file|link):/u.test(raw) ||
    raw.includes(repoRoot) ||
    raw.includes(process.env.HOME ?? "\u0000")
  ) {
    throw new Error(`Packaged manifest contains a local path: ${manifestPath}`);
  }
  if (/secret|password|private[_-]?key|apple[_-]?id/iu.test(raw)) {
    throw new Error(`Packaged manifest contains a secret-shaped key: ${manifestPath}`);
  }
}

assertArm64(helper);
for (const entry of walk(resourcesPath)) {
  if (entry.endsWith(".node") && lstatSync(entry).isFile()) {
    assertArm64(entry);
  }
}

const imports = [
  path.join(shellRoot, "dist", "apps", "desktop", "src", "updater.js"),
  path.join(payloadRoot, "src", "localCore", "api.ts"),
  path.join(payloadRoot, "src", "localCore", "migrations.ts"),
  path.join(payloadRoot, "cli", "runner", "RunnerHost.ts"),
];
const importScript = [
  "const { createRequire } = await import('node:module');",
  `const require = createRequire(${JSON.stringify(pathToFileURL(path.join(runtimeRoot, "package.json")).href)});`,
  "require('@electric-sql/pglite');",
  "require('node-pty');",
  ...imports.map(
    (entry) => `await import(${JSON.stringify(pathToFileURL(entry).href)});`,
  ),
  "console.log('desktop package imports passed');",
].join("\n");
execFileSync(
  executable,
  ["--import", "tsx", "--input-type=module", "--eval", importScript],
  {
    cwd: runtimeRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  },
);

console.log(`[desktop] package preflight passed: ${appPath}`);

function walk(root: string): string[] {
  const entries: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const entryPath = path.join(current, entry);
      entries.push(entryPath);
      if (lstatSync(entryPath).isDirectory()) visit(entryPath);
    }
  };
  visit(root);
  return entries;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertArm64(filePath: string): void {
  const description = execFileSync("/usr/bin/file", ["-b", filePath], {
    encoding: "utf8",
  });
  if (!description.includes("arm64")) {
    throw new Error(`Packaged native executable is not arm64: ${filePath}: ${description.trim()}`);
  }
}

function resolveRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to locate repo root from '${cwd}'.`);
    }
    current = parent;
  }
}

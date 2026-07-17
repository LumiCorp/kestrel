import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors: string[] = [];
const canonicalRepositoryUrl = "git+https://github.com/LumiCorp/kestrel.git";
const canonicalHomepageBase = "https://github.com/LumiCorp/kestrel";
const canonicalIssuesUrl = `${canonicalHomepageBase}/issues`;

const forbiddenPaths = [
  "apps/studio",
  "apps/kestrel-one",
  "docs/analysis/kestrel-studio-backlog-review",
  "docs/runbooks/2026-04-22-studio-cutover-baseline-ledger.md",
  "docs/runbooks/2026-04-22-studio-runner-service-operations-runbook.md",
  "docs/documentation-staleness-audit-2026-03-24.md",
  "docs/plans/context-captures",
  ".vercel",
  "scripts/test-studio-cutover.ts",
  "tests/integration/studio-runner-adapter-parity-smoke.test.ts",
] as const;

const generatedPathPatterns = [
  /^(?:\.next|coverage|dist|jobs|logs|out|output|runs)\//u,
  /^apps\/web\/\.next\//u,
  /^apps\/desktop\/(?:dist|out|resources|static\/renderer)\//u,
  /^packages\/[^/]+\/dist\//u,
];
const personalMachineRoot = ["/Users", "gregasher"].join("/");
const oldRepositorySlug = ["kestrel", "harness"].join("-");
const legacyEvaluatorTerms = [
  ["Scene", "Runner"].join(" "),
  ["Scene", "Runner"].join(""),
  ["scene", "runner"].join(""),
];
const credentialPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
];

for (const relativePath of forbiddenPaths) {
  if (existsSync(path.join(repoRoot, relativePath))) {
    errors.push(`forbidden private or generated path remains in the public tree: ${relativePath}`);
  }
}

const canonicalWebPackage = JSON.parse(
  readFileSync(path.join(repoRoot, "apps", "web", "package.json"), "utf8"),
) as { name?: string };
if (canonicalWebPackage.name !== "@kestrel/kestrel-one") {
  errors.push("apps/web must contain the canonical Kestrel One hosted product");
}

const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  repository?: { url?: string };
  homepage?: string;
  bugs?: { url?: string };
};
for (const scriptName of Object.keys(rootPackage.scripts ?? {})) {
  if (scriptName.startsWith("studio:") || scriptName === "test:studio-cutover") {
    errors.push(`public root package exposes private Studio script '${scriptName}'`);
  }
}
for (const [name, version] of Object.entries({
  ...(rootPackage.dependencies ?? {}),
  ...(rootPackage.devDependencies ?? {}),
})) {
  if (name === "@kestrel/studio") {
    errors.push(`public root package depends on private package '${name}@${version}'`);
  }
}

for (const relativePath of [
  "package.json",
  "packages/protocol/package.json",
  "packages/sdk/package.json",
  "packages/observability/package.json",
  "packages/next/package.json",
] as const) {
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as {
    repository?: { url?: string };
    homepage?: string;
    bugs?: { url?: string };
  };
  if (manifest.repository?.url !== canonicalRepositoryUrl) {
    errors.push(`${relativePath} must point to the canonical public repository`);
  }
  if (manifest.homepage?.startsWith(canonicalHomepageBase) !== true) {
    errors.push(`${relativePath} must use the canonical public homepage`);
  }
  if (manifest.bugs?.url !== canonicalIssuesUrl) {
    errors.push(`${relativePath} must use the canonical public issue tracker`);
  }
}

for (const trackedPath of listTrackedPaths()) {
  if (trackedPath.startsWith("apps/studio/")) {
    errors.push(`private Studio file is tracked publicly: ${trackedPath}`);
  }
  if (/(?:^|\/)tests\/\.auth\//u.test(trackedPath)) {
    errors.push(`generated browser auth state is tracked publicly: ${trackedPath}`);
  }
  if (generatedPathPatterns.some((pattern) => pattern.test(trackedPath))) {
    errors.push(`generated output is tracked publicly: ${trackedPath}`);
  }
  if (isForbiddenEnvironmentFile(trackedPath)) {
    errors.push(`local environment file is tracked publicly: ${trackedPath}`);
  }
  if (/\.(?:pem|key|p12|b64)$/iu.test(trackedPath)) {
    errors.push(`credential-like file is tracked publicly: ${trackedPath}`);
  }

  const contents = readTrackedText(trackedPath);
  if (contents === undefined) {
    continue;
  }
  if (contents.includes(personalMachineRoot)) {
    errors.push(`personal machine path is tracked publicly: ${trackedPath}`);
  }
  if (contents.includes(oldRepositorySlug)) {
    errors.push(`old private repository slug is tracked publicly: ${trackedPath}`);
  }
  if (legacyEvaluatorTerms.some((term) => contents.includes(term))) {
    errors.push(`legacy evaluator reference is tracked publicly: ${trackedPath}`);
  }
  if (credentialPatterns.some((pattern) => pattern.test(contents))) {
    errors.push(`credential-shaped content is tracked publicly: ${trackedPath}`);
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    process.stderr.write(`[public-boundary] ${error}\n`);
  }
  process.stderr.write(`[public-boundary] failed with ${errors.length} issue(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("[public-boundary] public/private product boundary passed\n");
}

function listTrackedPaths(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0);
}

function isForbiddenEnvironmentFile(relativePath: string): boolean {
  const baseName = path.posix.basename(relativePath);
  if (baseName === ".env.example") {
    return false;
  }
  return baseName === ".env" || baseName.startsWith(".env.");
}

function readTrackedText(relativePath: string): string | undefined {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return ;
  }
  const contents = readFileSync(absolutePath);
  if (contents.includes(0)) {
    return ;
  }
  return contents.toString("utf8");
}

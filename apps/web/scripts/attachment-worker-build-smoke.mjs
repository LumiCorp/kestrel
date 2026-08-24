import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(webRoot, "../..");
const nextServerRoot = resolve(webRoot, ".next/server");

const REQUIRED_ROUTE_TRACES = [
  /app\/api\/cron\/attachments\/cleanup\/route\.js\.nft\.json$/u,
  /app\/api\/files\/route\.js\.nft\.json$/u,
  /app\/api\/files\/\[fileId\]\/route\.js\.nft\.json$/u,
  /app\/api\/knowledge\/documents\/route\.js\.nft\.json$/u,
  /app\/api\/threads\/\[id\]\/attachments\/route\.js\.nft\.json$/u,
];

const REQUIRED_ATTACHMENT_PATHS = [
  /packages\/attachments\/package\.json$/u,
  /packages\/attachments\/dist\/index\.cjs$/u,
  /packages\/attachments\/dist\/index\.js$/u,
  /packages\/attachments\/dist\/worker\.js$/u,
];

export async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files;
}

export async function assertNoBundledAttachmentWorker(files) {
  const serverJavaScript = files.filter((path) => path.endsWith(".js"));
  for (const path of serverJavaScript) {
    const source = await readFile(path, "utf8");
    if (source.includes("Attachment processor worker requires a parent port.")) {
      throw new Error(`Next bundled the attachment worker into server output: ${path}`);
    }
    if (source.includes("Attachment processor input exceeds the 100 MiB limit.")) {
      throw new Error(`Next bundled the attachment package into server output: ${path}`);
    }
  }
}

export async function resolveTracedAttachmentPackage(files) {
  const traces = files.filter((path) => path.endsWith(".nft.json"));
  let commonJsIndexPath;
  for (const requiredRoute of REQUIRED_ROUTE_TRACES) {
    const tracePath = traces.find((path) => requiredRoute.test(path));
    if (!tracePath) {
      throw new Error(`Required attachment route trace is missing: ${requiredRoute}`);
    }
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    if (!Array.isArray(trace.files)) {
      throw new Error(`Route trace does not contain a files array: ${tracePath}`);
    }
    const resolvedFiles = trace.files.map((path) => resolve(dirname(tracePath), path));
    for (const requiredPath of REQUIRED_ATTACHMENT_PATHS) {
      const match = resolvedFiles.find((path) => requiredPath.test(path));
      if (!match) {
        throw new Error(`Route trace ${tracePath} is missing ${requiredPath}.`);
      }
      if (requiredPath.source.includes("index\\.cjs")) commonJsIndexPath ??= match;
    }
  }
  if (!commonJsIndexPath) throw new Error("The traced CommonJS attachment package entrypoint is missing.");
  return commonJsIndexPath;
}

export async function assertFileRouteUsesExternalPackage(files) {
  const routePath = files.find((path) => /app\/api\/files\/route\.js$/u.test(path));
  if (!routePath) throw new Error("The compiled attachment upload route is missing.");
  const routeSource = await readFile(routePath, "utf8");
  if (!routeSource.includes('require("@kestrel-agents/files")')) {
    throw new Error("The compiled attachment upload route does not use the external attachment package.");
  }
}

export function runTracedExtractionSmoke(commonJsIndexPath) {
  const require = createRequire(resolve(webRoot, "package.json"));
  const resolvedPackagePath = require.resolve("@kestrel-agents/files");
  if (resolve(resolvedPackagePath) !== resolve(commonJsIndexPath)) {
    throw new Error([
      "CommonJS attachment package resolution does not match the traced entrypoint.",
      `Resolved: ${resolvedPackagePath}`,
      `Traced: ${commonJsIndexPath}`,
    ].join("\n"));
  }
  const pdfPath = resolve(
    repositoryRoot,
    "apps/web/tests/fixtures/knowledge-rag/incident-playbook.pdf",
  );
  const markdownSentinel = "vercel-packaging-markdown-sentinel-aug24";
  const pdfSentinel = "fixture-pdf-anchor-signal";
  const script = [
    'const { readFile } = require("node:fs/promises");',
    `const { extractAttachmentTextIsolated } = require(${JSON.stringify(commonJsIndexPath)});`,
    `const markdownSentinel = ${JSON.stringify(markdownSentinel)};`,
    "void (async () => {",
    "  const markdown = await extractAttachmentTextIsolated({ buffer: Buffer.from(markdownSentinel), filename: 'sentinel.md', mediaType: 'text/markdown' });",
    "  if (!markdown.text.includes(markdownSentinel)) throw new Error('Markdown sentinel was not extracted.');",
    `  const pdf = await extractAttachmentTextIsolated({ buffer: await readFile(${JSON.stringify(pdfPath)}), filename: 'sentinel.pdf', mediaType: 'application/pdf' });`,
    `  if (!pdf.text.includes(${JSON.stringify(pdfSentinel)})) throw new Error('PDF sentinel was not extracted.');`,
    "})().catch((error) => { console.error(error); process.exitCode = 1; });",
  ].join("\n");
  const child = spawnSync(process.execPath, [
    "--expose-gc",
    "--max-semi-space-size=34",
    "--max-old-space-size=1844",
    "--eval",
    script,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 45_000,
  });
  if (child.status !== 0) {
    throw new Error([
      "Traced attachment extraction failed under the Vercel Node flags.",
      child.stdout,
      child.stderr,
    ].filter(Boolean).join("\n"));
  }
}

export async function runAttachmentWorkerBuildSmoke() {
  const files = await listFiles(nextServerRoot);
  await assertNoBundledAttachmentWorker(files);
  await assertFileRouteUsesExternalPackage(files);
  const commonJsIndexPath = await resolveTracedAttachmentPackage(files);
  runTracedExtractionSmoke(commonJsIndexPath);
  process.stdout.write("Attachment worker build smoke passed.\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAttachmentWorkerBuildSmoke();
}

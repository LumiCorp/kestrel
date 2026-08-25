import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(webRoot, "../..");
const nextServerRoot = resolve(webRoot, ".next/server");

export const REQUIRED_ROUTE_TRACES = [
  /app\/api\/cron\/attachments\/cleanup\/route\.js\.nft\.json$/u,
  /app\/api\/files\/route\.js\.nft\.json$/u,
  /app\/api\/files\/\[fileId\]\/route\.js\.nft\.json$/u,
  /app\/api\/knowledge\/documents\/route\.js\.nft\.json$/u,
  /app\/api\/threads\/\[id\]\/attachments\/\[attachmentId\]\/route\.js\.nft\.json$/u,
];

export const REQUIRED_RUNTIME_PATHS = [
  /packages\/attachments\/package\.json$/u,
  /packages\/attachments\/dist\/index\.cjs$/u,
  /packages\/attachments\/dist\/index\.js$/u,
  /packages\/attachments\/dist\/worker\.js$/u,
  /packages\/attachments\/node_modules\/pdf-parse$/u,
  /node_modules\/pdf-parse\/package\.json$/u,
  /node_modules\/pdf-parse\/dist\/worker\/(?:cjs\/index\.cjs|esm\/index\.js)$/u,
  /node_modules\/pdf-parse\/dist\/worker\/pdf\.worker\.mjs$/u,
  /node_modules\/\.pnpm\/pdf-parse@[^/]+\/node_modules\/pdfjs-dist$/u,
  /node_modules\/pdfjs-dist\/package\.json$/u,
  /node_modules\/pdfjs-dist\/legacy\/build\/pdf\.mjs$/u,
  /node_modules\/pdfjs-dist\/legacy\/build\/pdf\.worker\.mjs$/u,
  /node_modules\/pdfjs-dist\/cmaps\/[^/]+\.bcmap$/u,
  /node_modules\/pdfjs-dist\/standard_fonts\/[^/]+\.(?:pfb|ttf)$/u,
  /node_modules\/pdfjs-dist\/wasm\/[^/]+\.(?:wasm|js)$/u,
  /node_modules\/@napi-rs\/canvas\/package\.json$/u,
  /node_modules\/@napi-rs\/canvas\/js-binding\.js$/u,
  /node_modules\/@napi-rs\/canvas-[^/]+\/package\.json$/u,
  /node_modules\/@napi-rs\/canvas-[^/]+\/[^/]+\.node$/u,
];

const RUNTIME_WARNING = /Cannot load "@napi-rs\/canvas"|fake worker|pdf\.worker load error|Unable to load.+(?:CMap|font|WASM)|(?:cMapUrl|standardFontDataUrl|wasmUrl).+(?:missing|invalid)/iu;

function slash(path) {
  return path.split(sep).join("/");
}

function isWithin(root, path) {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

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

async function readRequiredRouteTraces(files) {
  const traces = files.filter((path) => path.endsWith(".nft.json"));
  const requiredTraces = [];
  for (const requiredRoute of REQUIRED_ROUTE_TRACES) {
    const tracePath = traces.find((path) => requiredRoute.test(slash(path)));
    if (!tracePath) throw new Error(`Required attachment route trace is missing: ${requiredRoute}`);
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    if (!Array.isArray(trace.files)) throw new Error(`Route trace does not contain a files array: ${tracePath}`);
    const resolvedFiles = trace.files.map((path) => resolve(dirname(tracePath), path));
    requiredTraces.push({ tracePath, resolvedFiles });
  }
  return requiredTraces;
}

export async function resolveTracedAttachmentPackage(files) {
  const requiredTraces = await readRequiredRouteTraces(files);
  let commonJsIndexPath;
  for (const { tracePath, resolvedFiles } of requiredTraces) {
    for (const requiredPath of REQUIRED_RUNTIME_PATHS) {
      const match = resolvedFiles.find((path) => requiredPath.test(slash(path)));
      if (!match) throw new Error(`Route trace ${tracePath} is missing ${requiredPath}.`);
      if (requiredPath.source.includes("index\\.cjs") && requiredPath.source.includes("attachments")) {
        commonJsIndexPath ??= match;
      }
    }
  }
  if (!commonJsIndexPath) throw new Error("The traced CommonJS attachment package entrypoint is missing.");
  return commonJsIndexPath;
}

export async function assertFileRouteUsesExternalPackage(files) {
  const routePath = files.find((path) => /app\/api\/files\/route\.js$/u.test(slash(path)));
  if (!routePath) throw new Error("The compiled attachment upload route is missing.");
  const routeSource = await readFile(routePath, "utf8");
  if (!routeSource.includes('require("@kestrel-agents/files")')) {
    throw new Error("The compiled attachment upload route does not use the external attachment package.");
  }
}

async function discoverSourceSymlinks(sourcePath) {
  if (!isWithin(repositoryRoot, sourcePath)) throw new Error(`Traced file escapes the repository: ${sourcePath}`);
  const symlinks = [];
  let cursor = repositoryRoot;
  for (const component of relative(repositoryRoot, sourcePath).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink()) symlinks.push({ path: cursor, target: await readlink(cursor) });
  }
  return symlinks;
}

export async function assertRuntimeSymlinksContained(root) {
  const canonicalRoot = await realpath(root);
  const files = await listFiles(root);
  for (const path of files) {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) continue;
    const linkTarget = await readlink(path);
    const lexicalTarget = resolve(dirname(path), linkTarget);
    if (!isWithin(root, lexicalTarget)) throw new Error(`Runtime symlink escapes the isolated tree: ${path} -> ${linkTarget}`);
    const resolvedTarget = await realpath(path);
    if (!isWithin(canonicalRoot, resolvedTarget)) throw new Error(`Runtime symlink resolves outside the isolated tree: ${path} -> ${resolvedTarget}`);
  }
}

async function materializeTracedRuntime(sourceFiles, isolatedRoot) {
  const symlinks = new Map();
  const copiedPaths = new Set();
  for (const sourcePath of sourceFiles) {
    if (!isWithin(repositoryRoot, sourcePath)) throw new Error(`Traced file escapes the repository: ${sourcePath}`);
    for (const link of await discoverSourceSymlinks(sourcePath)) symlinks.set(link.path, link.target);
    const canonicalSource = await realpath(sourcePath);
    if (!isWithin(repositoryRoot, canonicalSource)) throw new Error(`Traced file resolves outside the repository: ${sourcePath}`);
    const canonicalRelative = relative(repositoryRoot, canonicalSource);
    if (copiedPaths.has(canonicalRelative)) continue;
    copiedPaths.add(canonicalRelative);
    const destination = resolve(isolatedRoot, canonicalRelative);
    const stats = await lstat(canonicalSource);
    if (stats.isDirectory()) {
      await mkdir(destination, { recursive: true });
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(canonicalSource, destination);
    }
  }

  const orderedSymlinks = [...symlinks.entries()].sort(([left], [right]) => left.split(sep).length - right.split(sep).length);
  for (const [sourceLink, sourceTarget] of orderedSymlinks) {
    const destinationLink = resolve(isolatedRoot, relative(repositoryRoot, sourceLink));
    const absoluteSourceTarget = resolve(dirname(sourceLink), sourceTarget);
    if (!isWithin(repositoryRoot, absoluteSourceTarget)) {
      throw new Error(`Source runtime symlink escapes the repository: ${sourceLink} -> ${sourceTarget}`);
    }
    const destinationTarget = resolve(isolatedRoot, relative(repositoryRoot, absoluteSourceTarget));
    const destinationLinkTarget = relative(dirname(destinationLink), destinationTarget) || ".";
    await mkdir(dirname(destinationLink), { recursive: true });
    await symlink(destinationLinkTarget, destinationLink);
  }
  await assertRuntimeSymlinksContained(isolatedRoot);
}

export async function runTracedExtractionSmoke(files) {
  const traces = await readRequiredRouteTraces(files);
  for (const { tracePath, resolvedFiles } of traces) {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "kestrel-attachment-runtime-"));
    try {
      const runtimeRoot = resolve(isolatedRoot, "runtime");
      const harnessRoot = resolve(isolatedRoot, "harness");
      await materializeTracedRuntime(resolvedFiles, runtimeRoot);
      const fixtureRoot = resolve(harnessRoot, "fixtures");
      const matrixPath = resolve(harnessRoot, "extraction-matrix.mjs");
      const runnerPath = resolve(harnessRoot, "run.mjs");
      await mkdir(harnessRoot, { recursive: true });
      await copyFile(resolve(repositoryRoot, "packages/attachments/scripts/extraction-matrix.mjs"), matrixPath);
      await cp(resolve(repositoryRoot, "packages/attachments/tests/fixtures"), fixtureRoot, { recursive: true });

      const commonJsIndexPath = resolvedFiles.find((path) => /packages\/attachments\/dist\/index\.cjs$/u.test(slash(path)));
      if (!commonJsIndexPath) throw new Error(`Route trace ${tracePath} has no CommonJS attachment entrypoint.`);
      const canonicalCommonJsPath = await realpath(commonJsIndexPath);
      const isolatedCommonJsPath = resolve(runtimeRoot, relative(repositoryRoot, canonicalCommonJsPath));
      const sourceRoutePath = tracePath.slice(0, -".nft.json".length);
      const requireBase = resolve(runtimeRoot, relative(repositoryRoot, sourceRoutePath));
      await writeFile(runnerPath, [
        'import assert from "node:assert/strict";',
        'import { realpath } from "node:fs/promises";',
        'import { createRequire } from "node:module";',
        `import { runExtractionMatrix } from ${JSON.stringify(pathToFileURL(matrixPath).href)};`,
        `const expectedEntry = ${JSON.stringify(isolatedCommonJsPath)};`,
        `const require = createRequire(${JSON.stringify(requireBase)});`,
        'assert.equal(await realpath(require.resolve("@kestrel-agents/files")), await realpath(expectedEntry));',
        `const outcomes = await runExtractionMatrix({ entryPath: expectedEntry, fixtureRoot: ${JSON.stringify(fixtureRoot)} });`,
        'process.stdout.write(`${JSON.stringify({ ok: true, outcomes })}\\n`);',
      ].join("\n"));

      const child = spawnSync(process.execPath, [
        "--expose-gc",
        "--max-semi-space-size=34",
        "--max-old-space-size=1844",
        runnerPath,
      ], {
        cwd: runtimeRoot,
        encoding: "utf8",
        env: {
          LANG: "C.UTF-8",
          NODE_OPTIONS: "",
          NODE_PATH: "",
          PATH: process.env.PATH ?? "",
          TMPDIR: tmpdir(),
        },
        timeout: 90_000,
      });
      if (child.status !== 0 || RUNTIME_WARNING.test(child.stderr)) {
        throw new Error([
          `Route trace ${tracePath} failed its hermetic Vercel runtime closure.`,
          child.stdout,
          child.stderr,
        ].filter(Boolean).join("\n"));
      }
      const evidence = JSON.parse(child.stdout.trim());
      if (evidence.ok !== true) throw new Error(`Route trace ${tracePath} returned invalid extraction evidence.`);
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  }
}

export async function runAttachmentWorkerBuildSmoke() {
  const files = await listFiles(nextServerRoot);
  await assertNoBundledAttachmentWorker(files);
  await assertFileRouteUsesExternalPackage(files);
  await resolveTracedAttachmentPackage(files);
  await runTracedExtractionSmoke(files);
  process.stdout.write(`Hermetic attachment runtime closure smoke passed for ${REQUIRED_ROUTE_TRACES.length} route traces.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runAttachmentWorkerBuildSmoke();
}

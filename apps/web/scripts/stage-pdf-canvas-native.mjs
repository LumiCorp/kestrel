import { copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
export const STAGED_CANVAS_NATIVE_PATH = resolve(webRoot, ".kestrel-runtime/canvas-native.node");

function isMusl() {
  if (process.platform !== "linux") return false;
  const report = typeof process.report?.getReport === "function"
    ? process.report.getReport()
    : undefined;
  if (report?.header && "glibcVersionRuntime" in report.header) return false;
  return Array.isArray(report?.sharedObjects)
    && report.sharedObjects.some((path) => path.includes("libc.musl-") || path.includes("ld-musl-"));
}

export function canvasNativePackageName({
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
} = {}) {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `@napi-rs/canvas-darwin-${arch}`;
  }
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) {
    return `@napi-rs/canvas-linux-${arch}-${musl ? "musl" : "gnu"}`;
  }
  if (platform === "win32" && arch === "x64") {
    return "@napi-rs/canvas-win32-x64-msvc";
  }
  throw new Error(`Unsupported PDF canvas build platform: ${platform}/${arch}.`);
}

export async function stagePdfCanvasNative({ destination = STAGED_CANVAS_NATIVE_PATH } = {}) {
  const require = createRequire(import.meta.url);
  const canvasPackageJson = require.resolve("@napi-rs/canvas/package.json");
  const canvasRequire = createRequire(canvasPackageJson);
  const nativePackage = canvasNativePackageName();
  const nativeBinding = canvasRequire.resolve(nativePackage);
  await rm(dirname(destination), { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(nativeBinding, destination);
  return { destination, nativeBinding, nativePackage };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const staged = await stagePdfCanvasNative();
  process.stdout.write(`Staged ${staged.nativePackage} for the hosted PDF runtime.\n`);
}

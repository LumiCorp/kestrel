import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const STAGED_CANVAS_NATIVE_RELATIVE_PATH = ".kestrel-runtime/canvas-native.node";

export function resolveStagedPdfCanvasNativeBinding(
  cwd = process.cwd(),
  fileExists: (path: string) => boolean = existsSync,
  lambdaTaskRoot = process.env.LAMBDA_TASK_ROOT?.trim(),
): string | undefined {
  const candidates = [
    resolve(cwd, STAGED_CANVAS_NATIVE_RELATIVE_PATH),
    resolve(cwd, "apps/web", STAGED_CANVAS_NATIVE_RELATIVE_PATH),
    ...(lambdaTaskRoot
      ? [resolve(lambdaTaskRoot, "apps/web", STAGED_CANVAS_NATIVE_RELATIVE_PATH)]
      : []),
  ];
  return candidates.find(fileExists);
}

export function configurePdfCanvasNativeBinding(): string | undefined {
  const configured = process.env.NAPI_RS_NATIVE_LIBRARY_PATH?.trim();
  if (configured) return configured;
  const staged = resolveStagedPdfCanvasNativeBinding();
  if (staged) process.env.NAPI_RS_NATIVE_LIBRARY_PATH = staged;
  return staged;
}

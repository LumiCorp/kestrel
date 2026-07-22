import type { DesktopRuntimeThreadInspection } from "./contracts.js";
import type { DesktopThreadAuthorityResult } from "./contracts.js";

export async function inspectDesktopThreadAuthority(input: {
  inspect: () => Promise<DesktopRuntimeThreadInspection>;
}): Promise<DesktopThreadAuthorityResult> {
  try {
    return { status: "available", view: await input.inspect() };
  } catch (error) {
    if (errorCode(error) === "OPERATOR_THREAD_NOT_FOUND") {
      return { status: "missing" };
    }
    throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

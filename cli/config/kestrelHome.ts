import { resolveKestrelHomePath } from "../../src/runtime/kestrelHome.js";

export function resolveKestrelHome(_cwd = process.cwd()): string {
  return resolveKestrelHomePath();
}

import { homedir } from "node:os";
import path from "node:path";
import { resolveKestrelCoreHome } from "../localCore/home.js";

export function resolveKestrelHomePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = normalizeString(env.KESTREL_HOME);
  if (explicit !== undefined) {
    return resolvePathWithHome(explicit);
  }
  return resolveKestrelCoreHome(env, process.platform).homePath;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resolvePathWithHome(candidate: string): string {
  if (candidate === "~") {
    return homedir();
  }
  if (candidate.startsWith("~/")) {
    return path.join(homedir(), candidate.slice(2));
  }
  return path.resolve(candidate);
}

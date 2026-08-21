const WORKSPACE_REVISION = /^"kestrel-sha256-[0-9a-f]{64}"$/u;

export function parseWorkspaceCanaryRevision(value: string | null): string {
  const revision = value?.startsWith("W/") ? value.slice(2) : value;
  if (!revision || !WORKSPACE_REVISION.test(revision)) {
    throw new Error("The canary file had no valid Kestrel revision ETag.");
  }
  return revision;
}

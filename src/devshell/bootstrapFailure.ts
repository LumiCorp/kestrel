export function formatDevShellBootstrapFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const migrationOutput = readStringDetail(error, "migrationOutput");
  if (migrationOutput === undefined) {
    return message;
  }
  return `${message}\n${migrationOutput}`;
}

function readStringDetail(error: unknown, key: string): string | undefined {
  if (typeof error !== "object" || error === null) {
    return ;
  }
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) {
    return ;
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

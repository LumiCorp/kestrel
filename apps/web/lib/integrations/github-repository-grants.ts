import { z } from "zod";

const repositoryGrantSchema = z.object({
  repositoryId: z.string().trim().min(1),
  fullName: z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/u),
});

export type GitHubRepositoryGrant = z.infer<typeof repositoryGrantSchema>;

export function parseGitHubRepositoryGrants(
  settings: unknown,
): GitHubRepositoryGrant[] {
  if (!(settings && typeof settings === "object" && !Array.isArray(settings))) {
    return [];
  }
  const raw = (settings as Record<string, unknown>).repositoryGrantsV1;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    const parsed = repositoryGrantSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
}

export function withGitHubRepositoryGrants(
  settings: unknown,
  grants: GitHubRepositoryGrant[],
) {
  const current =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  return {
    ...current,
    repositoryGrantsV1: [...grants]
      .sort((left, right) => left.fullName.localeCompare(right.fullName))
      .map((grant) => repositoryGrantSchema.parse(grant)),
  };
}

export function readGitHubRepositoryId(metadata: unknown): string | null {
  if (!(metadata && typeof metadata === "object" && !Array.isArray(metadata))) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).repositoryId;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

export function readGitHubRepositoryPrivate(metadata: unknown) {
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      !Array.isArray(metadata) &&
      (metadata as Record<string, unknown>).private === true,
  );
}

export function readGitHubRepositoryEmpty(metadata: unknown): boolean | null {
  if (!(metadata && typeof metadata === "object" && !Array.isArray(metadata))) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).isEmpty;
  return typeof value === "boolean" ? value : null;
}

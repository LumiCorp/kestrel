const migrationDatabaseUrlKeys = [
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "DATABASE_URL",
] as const;

export type MigrationDatabaseConnection = {
  key: (typeof migrationDatabaseUrlKeys)[number];
  url: string;
};

export function resolveMigrationDatabaseConnection(
  environment: Readonly<Record<string, string | undefined>> = process.env
): MigrationDatabaseConnection | null {
  for (const key of migrationDatabaseUrlKeys) {
    const url = environment[key]?.trim();
    if (url) {
      return { key, url };
    }
  }
  return null;
}

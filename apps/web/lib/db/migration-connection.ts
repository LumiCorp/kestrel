const migrationDatabaseUrlKeys = [
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL",
  "DATABASE_URL",
] as const;

const unpooledMigrationDatabaseUrlKeys = [
  "POSTGRES_URL_NON_POOLING",
  "DATABASE_URL_UNPOOLED",
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

export function requireUnpooledMigrationDatabaseConnection(
  environment: Readonly<Record<string, string | undefined>> = process.env
): MigrationDatabaseConnection {
  for (const key of unpooledMigrationDatabaseUrlKeys) {
    const url = environment[key]?.trim();
    if (url) return { key, url };
  }
  throw new Error(
    "Production database migrations require POSTGRES_URL_NON_POOLING or DATABASE_URL_UNPOOLED."
  );
}

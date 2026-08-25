import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import postgres from "postgres";
import { requireUnpooledMigrationDatabaseConnection } from "../lib/db/migration-connection";
import { confirmExact, loadProductionEnvironment } from "./lib/production-command";
import {
  applyOrganizationFileReset,
  assertNoActiveLumiKnowledgeWork,
  exactActionConfirmation,
  exactResetConfirmation,
  inspectOrganizationFileReset,
  LUMI_RESET_ORGANIZATION_NAME,
} from "./lib/reset-organization-files";

export type ResetLumiFilesArgs = {
  organizationId: string;
  organizationName: typeof LUMI_RESET_ORGANIZATION_NAME;
  operator: string;
  restorePoint: string;
  manifestPath: string;
  apply: boolean;
};

export function parseResetLumiFilesArgs(argv: string[]): ResetLumiFilesArgs {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      if (apply) throw new Error("--apply may be supplied only once.");
      apply = true;
      continue;
    }
    if (!argument?.startsWith("--")) throw new Error(`Unknown argument: ${argument ?? ""}.`);
    const value = args[index + 1]?.trim();
    if (!value || value.startsWith("--")) throw new Error(`${argument} is required.`);
    if (values.has(argument)) throw new Error(`${argument} may be supplied only once.`);
    values.set(argument, value);
    index += 1;
  }
  const allowed = new Set([
    "--organization-id",
    "--organization-name",
    "--operator",
    "--restore-point",
    "--manifest",
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown argument: ${key}.`);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`${name} is required.`);
    return value;
  };
  const organizationName = required("--organization-name");
  if (organizationName !== LUMI_RESET_ORGANIZATION_NAME) {
    throw new Error(`--organization-name must be exactly '${LUMI_RESET_ORGANIZATION_NAME}'.`);
  }
  const manifestPath = required("--manifest");
  if (!isAbsolute(manifestPath)) throw new Error("--manifest must be an absolute path.");
  return {
    organizationId: required("--organization-id"),
    organizationName,
    operator: required("--operator"),
    restorePoint: required("--restore-point"),
    manifestPath,
    apply,
  };
}

export async function runResetLumiFiles(argv = process.argv.slice(2)) {
  const args = parseResetLumiFilesArgs(argv);
  const authenticatedOperator = await loadProductionEnvironment();
  if (authenticatedOperator !== args.operator) {
    throw new Error("--operator does not match the authenticated Vercel operator identity.");
  }
  const connection = requireUnpooledMigrationDatabaseConnection();
  const sql = postgres(connection.url, {
    max: 1,
    prepare: false,
    connection: { application_name: "kestrel-lumi-file-reset" },
  });
  try {
    await assertNoActiveLumiKnowledgeWork(sql, args.organizationId);
    const manifest = await inspectOrganizationFileReset(sql, args);
    process.stdout.write(`${JSON.stringify({ mode: args.apply ? "apply" : "dry-run", manifest }, null, 2)}\n`);
    await writeFile(args.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (!args.apply) return { mode: "dry-run" as const, manifest };

    await confirmExact(exactResetConfirmation(manifest));
    const refreshed = await inspectOrganizationFileReset(sql, args);
    await assertNoActiveLumiKnowledgeWork(sql, args.organizationId);
    if (refreshed.fingerprint !== manifest.fingerprint) {
      throw new Error("Lumi file state changed after the manifest was captured; run a new dry-run.");
    }
    await confirmExact(exactActionConfirmation(refreshed));
    const result = await applyOrganizationFileReset({ sql, expected: refreshed });
    process.stdout.write(`${JSON.stringify({ mode: "apply", result }, null, 2)}\n`);
    return { mode: "apply" as const, manifest: refreshed, result };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await runResetLumiFiles();
}

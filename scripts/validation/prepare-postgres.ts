import { spawnSync } from "node:child_process";

const container = required("KESTREL_VALIDATION_POSTGRES_CONTAINER");
const baseUrl = required("KESTREL_VALIDATION_POSTGRES_BASE_URL");

for (const database of ["kestrel_web_template", "kestrel_runtime_template"]) {
  sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  sql(`CREATE DATABASE ${database}`);
}

const webTemplate = `${baseUrl}/kestrel_web_template`;
for (let pass = 1; pass <= 2; pass += 1) {
  process.stdout.write(`[postgres] Web migration compatibility pass ${pass}/2\n`);
  run("pnpm", ["--filter", "@kestrel/kestrel-one", "run", "db:migrate"], {
    DATABASE_URL: webTemplate,
    POSTGRES_URL: webTemplate,
  });
  run("pnpm", ["--filter", "@kestrel/kestrel-one", "run", "db:migrate:contract"], {
    DATABASE_URL: webTemplate,
    POSTGRES_URL: webTemplate,
  });
}

const runtimeTemplate = `${baseUrl}/kestrel_runtime_template`;
run("pnpm", ["run", "db:migrate"], { DATABASE_URL: runtimeTemplate });

for (const database of ["kestrel_turns", "kestrel_environment", "kestrel_apps", "kestrel_product"]) {
  sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  sql(`CREATE DATABASE ${database} TEMPLATE kestrel_web_template`);
}
sql("DROP DATABASE IF EXISTS kestrel_runtime WITH (FORCE)");
sql("CREATE DATABASE kestrel_runtime TEMPLATE kestrel_runtime_template");

function sql(statement: string): void {
  run("docker", ["exec", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", statement]);
}

function run(command: string, args: string[], extraEnvironment: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...extraEnvironment, CI: "true" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

import { spawnSync } from "node:child_process";

const port = process.env.LOCAL_POSTGRES_PORT?.trim() || "58432";
const database = "kestrel_ci";
const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/${database}`;
const compose = ["compose", "-f", "apps/web/docker-compose.yml"];
const composeEnv = {
  ...process.env,
  COMPOSE_PROJECT_NAME:
    process.env.COMPOSE_PROJECT_NAME?.trim() || "kestrel-one",
};

run("docker", [...compose, "up", "-d", "postgres"], composeEnv);
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ready = spawnSync(
    "docker",
    [
      ...compose,
      "exec",
      "-T",
      "postgres",
      "pg_isready",
      "-U",
      "postgres",
      "-d",
      "better_auth",
    ],
    { env: composeEnv, stdio: "ignore" }
  );
  if (ready.status === 0) break;
  if (attempt === 59) {
    throw new Error("Local PostgreSQL did not become ready.");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

run(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
  ],
  composeEnv
);
run(
  "docker",
  [
    ...compose,
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `CREATE DATABASE ${database}`,
  ],
  composeEnv
);

run("pnpm", ["run", "ci:postgres"], {
  ...composeEnv,
  KESTREL_APPS_DB_TEST_URL: databaseUrl,
  KESTREL_ENVIRONMENT_DB_TEST_URL: databaseUrl,
  KESTREL_TURN_DB_TEST_URL: databaseUrl,
});

function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
) {
  const result = spawnSync(executable, args, { stdio: "inherit", env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

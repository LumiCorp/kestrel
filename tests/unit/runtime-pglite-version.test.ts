import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";


test("the runner cannot downgrade the production PGlite store", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8")
  ) as { dependencies?: Record<string, string> };
  const lockfile = await readFile(
    new URL("../../pnpm-lock.yaml", import.meta.url),
    "utf8"
  );

  assert.equal(packageJson.dependencies?.["@electric-sql/pglite"], "^0.4.6");
  assert.match(
    lockfile,
    /'@electric-sql\/pglite':\n\s+specifier: \^0\.4\.6\n\s+version: 0\.4\.6/u
  );
});

test("the Workspace image builds and launches compiled runtime artifacts", async () => {
  const dockerfile = await readFile(new URL("../../apps/workspace-runtime/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /pnpm exec tsc -p tsconfig\.json/u);
  assert.match(dockerfile, /COPY --from=build \/app\/dist \.\/dist/u);
  assert.match(dockerfile, /COPY --from=build \/app\/db \.\/dist\/db/u);
  assert.match(dockerfile, /CMD \["node", "apps\/workspace-runtime\/dist\/server\.js"\]/u);
});

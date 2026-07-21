import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "the runner cannot downgrade the production PGlite store", async () => {
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

contractTest("runtime.hermetic", "the runner image builds and launches compiled runtime artifacts", async () => {
  const dockerfile = await readFile(
    new URL(
      "../../deploy/fly/kestrel-one-runner/Dockerfile",
      import.meta.url
    ),
    "utf8"
  );
  const entrypoint = await readFile(
    new URL(
      "../../deploy/fly/kestrel-one-runner/runner-entrypoint.mjs",
      import.meta.url
    ),
    "utf8"
  );
  const dockerignore = await readFile(
    new URL(
      "../../deploy/fly/kestrel-one-runner/Dockerfile.dockerignore",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(dockerfile, /RUN pnpm run build/u);
  assert.match(dockerfile, /RUN chmod -R a\+rX \/opt\/kestrel/u);
  assert.match(
    dockerfile,
    /COPY --from=builder \/workspace\/package\.json \/app\/dist\/package\.json/u
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/opt\/kestrel\/db\/migrations \/app\/dist\/db\/migrations/u
  );
  assert.match(
    dockerfile,
    /CMD \["node", "runner-entrypoint\.mjs", "--host", "0\.0\.0\.0", "--port", "8080"\]/u
  );
  assert.match(entrypoint, /\.\/dist\/cli\/commandMode\.js/u);
  assert.doesNotMatch(entrypoint, /tsx/u);
  assert.match(dockerignore, /^\.artifacts$/mu);
  assert.match(dockerignore, /^apps$/mu);
  assert.match(dockerignore, /^runs$/mu);
});

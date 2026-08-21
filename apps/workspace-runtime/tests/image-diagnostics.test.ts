import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("workspace image includes and smokes common HTTP and process diagnostics", async () => {
  const dockerfile = await readFile(
    path.resolve(import.meta.dirname, "../Dockerfile"),
    "utf8",
  );
  assert.match(dockerfile, /apt-get install[^\n]*curl[^\n]*procps/u);
  assert.match(dockerfile, /curl --version/u);
  assert.match(dockerfile, /ps -ef/u);
});

test("workspace image exposes pnpm to hosted project commands", async () => {
  const [dockerfile, imageSmoke, devShellPackageSmoke] = await Promise.all([
    readFile(path.resolve(import.meta.dirname, "../Dockerfile"), "utf8"),
    readFile(
      path.resolve(import.meta.dirname, "../scripts/image-smoke.sh"),
      "utf8",
    ),
    readFile(
      path.resolve(
        import.meta.dirname,
        "../scripts/dev-shell-package-smoke.mjs",
      ),
      "utf8",
    ),
  ]);
  const runtimeStage = dockerfile.slice(
    dockerfile.lastIndexOf("FROM node:22-bookworm-slim"),
  );
  const manifestCopy = runtimeStage.indexOf(
    "COPY --from=build /app/package.json ./package.json",
  );
  const corepackEnable = runtimeStage.indexOf("RUN corepack enable pnpm");

  assert.match(runtimeStage, /ENV COREPACK_HOME=\/opt\/corepack/u);
  assert.match(runtimeStage, /ENV PNPM_HOME=\/pnpm/u);
  assert.match(runtimeStage, /ENV PATH=\$PNPM_HOME:\$PATH/u);
  assert.match(runtimeStage, /RUN corepack enable pnpm/u);
  assert.match(
    runtimeStage,
    /corepack install --global "\$\(node -p "require\('\.\/package\.json'\)\.packageManager"\)"/u,
  );
  assert.match(
    dockerfile,
    /COPY packages\/attachments\/package\.json packages\/attachments\/package\.json/u,
  );
  assert.match(dockerfile, /COPY packages\/attachments packages\/attachments/u);
  assert.match(
    dockerfile,
    /pnpm --filter @kestrel-agents\/files build/u,
  );
  assert.match(
    runtimeStage,
    /COPY --from=build \/app\/packages\/attachments \.\/packages\/attachments/u,
  );
  assert.ok(
    manifestCopy >= 0 && manifestCopy < corepackEnable,
    "the pinned packageManager manifest must precede Corepack activation",
  );
  assert.match(imageSmoke, /expected_pnpm=.*packageManager/u);
  assert.match(imageSmoke, /actual_pnpm="\$\(docker run --rm/u);
  assert.match(imageSmoke, /--network none/u);
  assert.match(imageSmoke, /--env HOME=\/workspace\/\.kestrel\/runner/u);
  assert.match(imageSmoke, /--workdir \/workspace/u);
  assert.match(imageSmoke, /-lc 'pnpm --version'/u);
  assert.match(imageSmoke, /test "\$actual_pnpm" = "\$expected_pnpm"/u);
  assert.match(imageSmoke, /--entrypoint node/u);
  assert.match(imageSmoke, /dev-shell-package-smoke\.mjs/u);
  assert.match(imageSmoke, /dev-shell-execution-ok/u);
  assert.match(devShellPackageSmoke, /LocalDevShellService/u);
  assert.match(devShellPackageSmoke, /printf '%s\\\\n' \\"\$HOME\\"; pnpm --version/u);
  assert.match(devShellPackageSmoke, /result\.text, `\$\{runnerHome\}\\n\$\{expectedPnpm\}\\n`/u);
  assert.match(imageSmoke, /import\("@kestrel-agents\/files"\)/u);
});

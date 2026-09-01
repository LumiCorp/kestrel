import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const launcherPath = fileURLToPath(new URL("../../bin/kestrel.js", import.meta.url));

test("kestrel aliases default the TUI child to production mode", async (t) => {
  const fixture = await createLauncherFixture(t);

  for (const alias of ["kestrel", "ks"]) {
    const captured = await fixture.run(alias);
    assert.deepEqual(captured, {
      alias,
      nodeEnv: "production",
    });
  }
});

test("kestrel aliases preserve an explicit NODE_ENV", async (t) => {
  const fixture = await createLauncherFixture(t);

  assert.deepEqual(await fixture.run("ks", "development"), {
    alias: "ks",
    nodeEnv: "development",
  });
});

async function createLauncherFixture(t: test.TestContext): Promise<{
  run(alias: string, nodeEnv?: string): Promise<{ alias: string; nodeEnv: string | null }>;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "kestrel-cli-launcher-"));
  const preloadPath = path.join(tempDir, "capture-child-env.cjs");
  await writeFile(
    preloadPath,
    [
      'const fs = require("node:fs");',
      'if (process.argv[1]?.endsWith("/cli/tui.ts")) {',
      '  fs.writeFileSync(process.env.KESTREL_ENV_CAPTURE_PATH, JSON.stringify({',
      '    alias: process.env.KESTREL_ENTRYPOINT_ALIAS,',
      '    nodeEnv: process.env.NODE_ENV ?? null,',
      '  }));',
      '}',
    ].join("\n"),
    "utf8",
  );
  t.after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  return {
    async run(alias, nodeEnv) {
      const aliasPath = path.join(tempDir, alias);
      const capturePath = path.join(tempDir, `${alias}.json`);
      await symlink(launcherPath, aliasPath);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        KESTREL_ENV_CAPTURE_PATH: capturePath,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preloadPath}`].filter(Boolean).join(" "),
      };
      if (nodeEnv === undefined) {
        delete env.NODE_ENV;
      } else {
        env.NODE_ENV = nodeEnv;
      }

      await execFileAsync(aliasPath, ["--version"], { env });
      return JSON.parse(await readFile(capturePath, "utf8")) as {
        alias: string;
        nodeEnv: string | null;
      };
    },
  };
}

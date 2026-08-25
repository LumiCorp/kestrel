import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("runtime package publishes only the public executable boundary", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
  ) as {
    main?: string;
    types?: string;
    files?: string[];
    dependencies?: Record<string, string>;
  };
  const files = pkg.files ?? [];

  assert.equal(pkg.main, "dist/src/index.js");
  assert.equal(pkg.types, "dist/src/index.d.ts");
  assert.equal(pkg.dependencies?.["@kestrel-agents/protocol"], "workspace:*");
  assert.equal(
    pkg.dependencies?.["@kestrel-agents/workspace-skills"],
    "workspace:*",
  );
  assert.equal(
    pkg.dependencies?.["@kestrel/mcp-security"],
    undefined,
    "the private MCP security workspace is vendored into the runtime package, not fetched from npm",
  );
  for (const required of [
    "dist/src",
    "dist/agents",
    "dist/models",
    "dist/tools",
    "dist/cli",
    "bin",
    "cli",
    "src",
    "agents",
    "models",
    "tools",
    "db/migrations",
  ]) {
    assert.ok(
      files.includes(required),
      `published files must include ${required}`,
    );
  }
  for (const forbidden of [
    "apps",
    "packages",
    "tests",
    "docs",
    ".github",
    "benchmarks",
    "coding-agent-review",
    "node_modules",
  ]) {
    assert.ok(
      !files.includes(forbidden),
      `published files must exclude ${forbidden}`,
    );
  }
});

test("Local Core release smoke follows the owning state epoch", async () => {
  const source = await readFile(
    path.join(process.cwd(), "scripts", "local-core-release-smoke.ts"),
    "utf8",
  );
  assert.match(source, /path\.join\(home, "state", LOCAL_CORE_STATE_EPOCH\)/u);
  assert.doesNotMatch(source, /path\.join\(home, "state", "0\.7"\)/u);
});

test("workspace skills package exports only published build artifacts", async () => {
  const pkg = JSON.parse(
    await readFile(
      path.join(process.cwd(), "packages/workspace-skills/package.json"),
      "utf8",
    ),
  ) as {
    files?: string[];
    main?: string;
    types?: string;
    exports?: { "."?: { import?: string; types?: string } };
  };
  assert.equal(pkg.main, "dist/index.js");
  assert.equal(pkg.types, "dist/index.d.ts");
  assert.equal(pkg.exports?.["."]?.import, "./dist/index.js");
  assert.equal(pkg.exports?.["."]?.types, "./dist/index.d.ts");
  assert.ok(pkg.files?.includes("dist"));
  assert.equal(pkg.files?.includes("src"), false);
});

test("the public package release gate includes Files", async () => {
  const pkg = JSON.parse(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };

  assert.equal(
    pkg.scripts?.["files:release-check"],
    "pnpm --filter @kestrel-agents/files release:check",
  );
  assert.match(
    pkg.scripts?.["packages:release-check"] ?? "",
    /pnpm run files:release-check/u,
  );
});

test("AI SDK builds its conversation dependency before compiling itself", async () => {
  const pkg = JSON.parse(
    await readFile(
      path.join(process.cwd(), "packages/ai-sdk/package.json"),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };
  const build = pkg.scripts?.build ?? "";

  assert.match(build, /--filter @kestrel-agents\/conversation build/u);
  assert.ok(
    build.indexOf("--filter @kestrel-agents/conversation build") <
      build.indexOf("build:self"),
    "conversation must build before AI SDK compiles itself",
  );
});

test("every cron runtime uses the DST-correct parser version", async () => {
  const manifests = await Promise.all(
    [
      "package.json",
      "apps/desktop-runtime/package.json",
      "apps/web/package.json",
    ].map(async (manifestPath) => ({
      manifestPath,
      manifest: JSON.parse(
        await readFile(path.join(process.cwd(), manifestPath), "utf8"),
      ) as { dependencies?: Record<string, string> },
    })),
  );

  for (const { manifestPath, manifest } of manifests) {
    assert.equal(
      manifest.dependencies?.["cron-parser"],
      "^5.9.0",
      `${manifestPath} must use the DST-correct cron-parser version`,
    );
  }
});

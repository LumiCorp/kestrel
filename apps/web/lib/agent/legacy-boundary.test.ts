import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if ([".next", "node_modules"].includes(entry.name)) {
        continue;
      }
      files.push(...listSourceFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(
        path.relative(packageRoot, absolutePath).replaceAll(path.sep, "/")
      );
    }
  }
  return files.sort();
}

function readPackageFile(file: string) {
  return fs.readFileSync(path.join(packageRoot, file), "utf8");
}

contractTest("web.hermetic", "Kestrel-One agent barrel stays canonical on the Kestrel runtime adapter", () => {
  const source = readPackageFile("lib/agent/index.ts");

  assert.match(source, /from "\.\/kestrel-runtime"/);
  assert.doesNotMatch(source, /legacy/);
});

contractTest("web.hermetic", "Kestrel-One adapts the public SDK agent without an unknown cast", () => {
  const source = readPackageFile("lib/agent/kestrel-runtime.ts");

  assert.match(source, /adaptKestrelAgentForKestrelOne\(agent\)/);
  assert.doesNotMatch(source, /as unknown as KestrelOneAgent/);
});

contractTest("web.hermetic", "Kestrel-One no longer contains a legacy agent runtime", () => {
  assert.equal(
    fs.existsSync(path.join(packageRoot, "lib/agent/generate.ts")),
    false
  );
  assert.equal(
    fs.existsSync(path.join(packageRoot, "lib/agent/legacy")),
    false
  );
});

contractTest("web.hermetic", "Kestrel-One production source has no legacy agent imports", () => {
  const imports = listSourceFiles(packageRoot)
    .filter((file) => !file.startsWith("lib/agent/legacy/"))
    .filter(
      (file) => !(file.endsWith(".test.ts") || file.endsWith(".test.tsx"))
    )
    .filter((file) => /(?:^|\/)(app|components|lib)\//.test(file))
    .flatMap((file) => {
      const source = readPackageFile(file);
      return source.includes("lib/agent/legacy") ? [file] : [];
    });

  assert.deepEqual(imports, []);
});

contractTest("web.hermetic", "legacy global runner configuration is only referenced by the hosted cutover guard", () => {
  const references = listSourceFiles(packageRoot)
    .filter(
      (file) => !(file.endsWith(".test.ts") || file.endsWith(".test.tsx"))
    )
    .filter((file) => /(?:^|\/)(app|components|lib)\//.test(file))
    .flatMap((file) => {
      const source = readPackageFile(file);
      return source.includes("KESTREL_RUNNER_SERVICE_URL") ||
        source.includes("KESTREL_RUNNER_SERVICE_TOKEN")
        ? [file]
        : [];
    });

  assert.deepEqual(references, ["lib/environments/config.ts"]);
});

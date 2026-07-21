import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  listFiles,
  shouldSkipGovernanceDirectory,
  toPosixPath,
} from "../../scripts/governance-utils.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "governance traversal skips ignored artifact roots but keeps source files", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "kestrel-governance-utils-"));
  try {
    await mkdir(path.join(tmp, "src"), { recursive: true });
    await mkdir(path.join(tmp, "runs", "swe-verified", "src"), { recursive: true });
    await mkdir(path.join(tmp, ".external", "src"), { recursive: true });
    await writeFile(path.join(tmp, "src", "real.ts"), "export const real = true;\n", "utf8");
    await writeFile(path.join(tmp, "runs", "swe-verified", "src", "copy.ts"), "throw new Error('noise');\n", "utf8");
    await writeFile(path.join(tmp, ".external", "src", "external.ts"), "throw new Error('noise');\n", "utf8");

    const files = (await listFiles(tmp, (file) => file.endsWith(".ts")))
      .map((file) => toPosixPath(path.relative(tmp, file)))
      .sort();

    assert.deepEqual(files, ["src/real.ts"]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

contractTest("runtime.hermetic", "governance ignored directory list includes benchmark artifact roots", () => {
  for (const name of ["runs", "jobs", "logs", "output", ".kestrel", ".external", ".cli-package", ".pnpm-store", ".venv-swebench", "test-results"]) {
    assert.equal(shouldSkipGovernanceDirectory(name), true);
  }
  assert.equal(shouldSkipGovernanceDirectory("src"), false);
});

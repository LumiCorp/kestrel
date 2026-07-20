import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const specPath = path.join(root, "tests/proof/mutations.json");
const evidencePath = path.join(root, "tests/proof/mutation-evidence.json");
const specs = JSON.parse(readFileSync(specPath, "utf8"));
const requested = process.argv.slice(2).filter((value) => value !== "--write");
const selected = requested.length > 0
  ? specs.mutations.filter((mutation) => requested.includes(mutation.id))
  : specs.mutations;

if (requested.length > 0 && selected.length !== requested.length) {
  throw new Error("One or more requested mutation ids do not exist.");
}

const existing = JSON.parse(readFileSync(evidencePath, "utf8"));
const byId = new Map(existing.evidence.map((item) => [item.id, item]));
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "kestrel-mutation-audit-"));
const checkout = path.join(temporaryRoot, "checkout");

try {
  execFileSync("git", ["worktree", "add", "--detach", checkout, "HEAD"], {
    cwd: root,
    stdio: "pipe",
  });
  linkDependencyTrees(root, checkout);

  for (const mutation of selected) {
    requireCommittedInputs(mutation, checkout);
    const targetPath = path.join(checkout, mutation.target);
    const original = readFileSync(targetPath, "utf8");
    const occurrences = original.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${mutation.id}: expected one exact mutation target, found ${occurrences}`);
    }
    if (mutation.find === mutation.replace) {
      throw new Error(`${mutation.id}: replacement must change production behavior`);
    }

    process.stdout.write(`[mutation] applying ${mutation.id} in ${checkout}\n`);
    let result;
    const childEnvironment = { ...process.env, CI: "true" };
    delete childEnvironment.NODE_TEST_CONTEXT;
    try {
      writeFileSync(targetPath, original.replace(mutation.find, mutation.replace), "utf8");
      result = spawnSync(mutation.command, mutation.args, {
        cwd: checkout,
        env: childEnvironment,
        encoding: "utf8",
        stdio: "pipe",
        timeout: 20 * 60 * 1000,
      });
    } finally {
      writeFileSync(targetPath, original, "utf8");
    }

    if (result.error) throw result.error;
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`${mutation.id}: mutation survived its owning tests`);
    }

    const testHash = createHash("sha256");
    for (const file of mutation.testFiles) {
      testHash.update(readFileSync(path.join(checkout, file)));
    }
    byId.set(mutation.id, {
      id: mutation.id,
      contractId: mutation.contractId,
      target: mutation.target,
      sourceSha256: sha256(targetPath),
      testFiles: mutation.testFiles,
      testsSha256: testHash.digest("hex"),
      command: [mutation.command, ...mutation.args].join(" "),
      result: "killed",
    });
    process.stdout.write(`[mutation] killed ${mutation.id} with exit ${result.status}\n`);
  }
} finally {
  spawnSync("git", ["worktree", "remove", "--force", checkout], {
    cwd: root,
    stdio: "ignore",
  });
  rmSync(temporaryRoot, { recursive: true, force: true });
}

writeFileSync(
  evidencePath,
  `${JSON.stringify({ version: 1, evidence: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)) }, null, 2)}\n`,
  "utf8",
);

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function requireCommittedInputs(mutation, checkoutRoot) {
  for (const relative of [mutation.target, ...mutation.testFiles]) {
    const workingPath = path.join(root, relative);
    const checkoutPath = path.join(checkoutRoot, relative);
    if (!existsSync(checkoutPath) || sha256(workingPath) !== sha256(checkoutPath)) {
      throw new Error(`${mutation.id}: ${relative} must be committed before mutation audit`);
    }
  }
}

function linkDependencyTrees(sourceRoot, checkoutRoot) {
  const visit = (relative = "") => {
    const sourceDirectory = path.join(sourceRoot, relative);
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const childRelative = path.join(relative, entry.name);
      if (entry.name === "node_modules") {
        const destination = path.join(checkoutRoot, childRelative);
        if (!existsSync(destination)) {
          mkdirSync(path.dirname(destination), { recursive: true });
          symlinkSync(path.join(sourceRoot, childRelative), destination, "dir");
        }
      } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
        visit(childRelative);
      }
    }
  };
  visit();
}

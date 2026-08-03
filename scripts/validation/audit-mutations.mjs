import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
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
const specs = JSON.parse(readFileSync(specPath, "utf8"));
const requested = process.argv.slice(2).filter((value) => value !== "--");
const selected = requested.length > 0
  ? specs.mutations.filter((mutation) => requested.includes(mutation.id))
  : specs.mutations;

if (requested.length > 0 && selected.length !== requested.length) {
  throw new Error("One or more requested mutation ids do not exist.");
}

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "kestrel-mutation-audit-"));
const checkout = path.join(temporaryRoot, "checkout");

try {
  execFileSync("git", ["worktree", "add", "--detach", checkout, "HEAD"], {
    cwd: root,
    stdio: "pipe",
  });
  stageCandidateTree(root, checkout);
  linkDependencyTrees(root, checkout);

  for (const mutation of selected) {
    requireCandidateInputs(mutation, checkout);
  }
  verifyOwningTestsPass(selected, checkout);

  for (const mutation of selected) {
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
    delete childEnvironment.NODE_V8_COVERAGE;
    try {
      writeFileSync(targetPath, original.replace(mutation.find, mutation.replace), "utf8");
      result = spawnSync(mutation.command, mutation.args, {
        cwd: checkout,
        env: childEnvironment,
        encoding: "utf8",
        stdio: "pipe",
      });
    } finally {
      writeFileSync(targetPath, original, "utf8");
    }

    if (result.error) throw result.error;
    if (result.signal !== null || result.status === null) {
      throw new Error(
        `${mutation.id}: owning tests terminated before proving the mutation (${result.signal ?? "unknown signal"})`,
      );
    }
    if (result.status === 0) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(`${mutation.id}: mutation survived its owning tests`);
    }

    process.stdout.write(`[mutation] killed ${mutation.id} with exit ${result.status}\n`);
  }
} finally {
  spawnSync("git", ["worktree", "remove", "--force", checkout], {
    cwd: root,
    stdio: "ignore",
  });
  rmSync(temporaryRoot, { recursive: true, force: true });
}
process.stdout.write(`[mutation] verified ${selected.length}/${selected.length} killed\n`);

function requireCandidateInputs(mutation, checkoutRoot) {
  for (const relative of [mutation.target, ...mutation.testFiles]) {
    const checkoutPath = path.join(checkoutRoot, relative);
    if (!existsSync(checkoutPath)) {
      throw new Error(`${mutation.id}: candidate input is missing: ${relative}`);
    }
  }
}

function stageCandidateTree(sourceRoot, checkoutRoot) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: sourceRoot, encoding: "utf8" },
  ).split("\0").filter(Boolean);
  for (const relative of files) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(checkoutRoot, relative);
    const stat = lstatIfPresent(source);
    if (stat === undefined) {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) {
      rmSync(destination, { recursive: true, force: true });
      symlinkSync(readlinkSync(source), destination);
      continue;
    }
    rmSync(destination, { recursive: true, force: true });
    copyFileSync(source, destination);
    chmodSync(destination, stat.mode);
  }
}

function lstatIfPresent(filePath) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function verifyOwningTestsPass(mutations, checkoutRoot) {
  const commands = new Map();
  for (const mutation of mutations) {
    const key = JSON.stringify([mutation.command, mutation.args]);
    const existing = commands.get(key);
    if (existing === undefined) {
      commands.set(key, {
        command: mutation.command,
        args: mutation.args,
        mutationIds: [mutation.id],
      });
    } else {
      existing.mutationIds.push(mutation.id);
    }
  }

  const childEnvironment = { ...process.env, CI: "true" };
  delete childEnvironment.NODE_TEST_CONTEXT;
  delete childEnvironment.NODE_V8_COVERAGE;
  for (const command of commands.values()) {
    const result = spawnSync(command.command, command.args, {
      cwd: checkoutRoot,
      env: childEnvironment,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.error) throw result.error;
    if (result.signal !== null || result.status === null) {
      throw new Error(
        `owning tests terminated before mutation for ${command.mutationIds.join(", ")} (${result.signal ?? "unknown signal"})`,
      );
    }
    if (result.status !== 0) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      throw new Error(
        `owning tests fail before mutation for ${command.mutationIds.join(", ")} (exit ${result.status})`,
      );
    }
    process.stdout.write(
      `[mutation] baseline passed for ${command.mutationIds.join(", ")}\n`,
    );
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

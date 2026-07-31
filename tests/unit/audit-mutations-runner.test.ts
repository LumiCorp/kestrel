import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const mutationRunner = fileURLToPath(
  new URL("../../scripts/validation/audit-mutations.mjs", import.meta.url),
);

test("mutation audit rejects an owning test that fails before mutation", () => {
  const fixture = createFixture({
    testSource: "process.exit(7);\n",
  });
  try {
    const result = runMutationAudit(fixture.repo);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /owning tests fail before mutation/u);
    assert.doesNotMatch(result.stdout, /verified 1\/1 killed/u);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mutation audit does not follow a checkout symlink when staging a regular file", () => {
  const fixture = createFixture({
    absoluteTargetSymlink: true,
    testSource: [
      'import { readFileSync } from "node:fs";',
      'process.exit(readFileSync("target.txt", "utf8") === "MUTANT\\n" ? 1 : 0);',
      "",
    ].join("\n"),
  });
  try {
    const result = runMutationAudit(fixture.repo);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.outside, "utf8"), "OUTSIDE\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture(options: {
  testSource: string;
  absoluteTargetSymlink?: boolean | undefined;
}): { root: string; repo: string; outside: string } {
  const root = mkdtempSync(path.join(tmpdir(), "kestrel-mutation-runner-test-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside.txt");
  mkdirSync(path.join(repo, "tests", "proof"), { recursive: true });
  writeFileSync(outside, "OUTSIDE\n", "utf8");

  const target = path.join(repo, "target.txt");
  if (options.absoluteTargetSymlink === true) {
    symlinkSync(outside, target);
  } else {
    writeFileSync(target, "LIVE\n", "utf8");
  }
  writeFileSync(path.join(repo, "owning-test.mjs"), options.testSource, "utf8");
  writeFileSync(
    path.join(repo, "tests", "proof", "mutations.json"),
    `${JSON.stringify({
      version: 2,
      mutations: [
        {
          id: "fixture-mutation",
          target: "target.txt",
          find: "LIVE",
          replace: "MUTANT",
          command: process.execPath,
          args: ["owning-test.mjs"],
          testFiles: ["owning-test.mjs"],
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Kestrel Test",
      "-c",
      "user.email=kestrel-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: repo },
  );

  if (options.absoluteTargetSymlink === true) {
    unlinkSync(target);
    writeFileSync(target, "LIVE\n", "utf8");
  }

  return { root, repo, outside };
}

function runMutationAudit(repo: string) {
  return spawnSync(process.execPath, [mutationRunner], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
  });
}

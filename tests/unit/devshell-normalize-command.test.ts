import assert from "node:assert/strict";
import test from "node:test";

import {
  findDevShellCommandSafetyIssue,
  normalizeDevShellExecCommand,
} from "../../src/devshell/normalizeCommand.js";

test("normalizeDevShellExecCommand trims blank input to undefined", () => {
  assert.equal(normalizeDevShellExecCommand(undefined), undefined);
  assert.equal(normalizeDevShellExecCommand(""), undefined);
  assert.equal(normalizeDevShellExecCommand("   \n"), undefined);
});

test("normalizeDevShellExecCommand unwraps whole-command markdown fences", () => {
  assert.equal(
    normalizeDevShellExecCommand("```bash\npnpm lint\n```"),
    "pnpm lint",
  );
});

test("normalizeDevShellExecCommand unwraps whole-command quotes without touching inner content", () => {
  assert.equal(
    normalizeDevShellExecCommand("\"pnpm exec tsc --noEmit\""),
    "pnpm exec tsc --noEmit",
  );
  assert.equal(
    normalizeDevShellExecCommand("'printf '\\''done'\\'''"),
    "printf 'done'",
  );
});

test("normalizeDevShellExecCommand preserves already-raw commands", () => {
  const command = "cat <<'EOF' > app/page.tsx\nhello\nEOF";
  assert.equal(normalizeDevShellExecCommand(command), command);
});

test("findDevShellCommandSafetyIssue rejects unquoted bracket route path segments", () => {
  const issue = findDevShellCommandSafetyIssue("mkdir -p src/app/api/auth/[...all]");

  assert.equal(issue?.code, "UNQUOTED_SHELL_GLOB_PATH_SEGMENT");
  assert.equal(issue?.token, "src/app/api/auth/[...all]");
  assert.match(issue?.correction ?? "", /Quote or escape bracketed path segments/u);
});

test("findDevShellCommandSafetyIssue allows quoted or escaped bracket route path segments", () => {
  assert.equal(
    findDevShellCommandSafetyIssue("mkdir -p 'src/app/api/auth/[...all]'"),
    undefined,
  );
  assert.equal(
    findDevShellCommandSafetyIssue("mkdir -p src/app/api/auth/\\[...all\\]"),
    undefined,
  );
});

test("findDevShellCommandSafetyIssue ignores heredoc body content", () => {
  const command = "cat <<'EOF' > route-notes.txt\nsrc/app/api/auth/[...all]\nEOF";

  assert.equal(findDevShellCommandSafetyIssue(command), undefined);
});

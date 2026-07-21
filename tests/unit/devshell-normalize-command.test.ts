import assert from "node:assert/strict";

import {
  findDevShellCommandSafetyIssue,
  normalizeDevShellExecCommand,
} from "../../src/devshell/normalizeCommand.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "normalizeDevShellExecCommand trims blank input to undefined", () => {
  assert.equal(normalizeDevShellExecCommand(undefined), undefined);
  assert.equal(normalizeDevShellExecCommand(""), undefined);
  assert.equal(normalizeDevShellExecCommand("   \n"), undefined);
});

contractTest("runtime.hermetic", "normalizeDevShellExecCommand unwraps whole-command markdown fences", () => {
  assert.equal(
    normalizeDevShellExecCommand("```bash\npnpm lint\n```"),
    "pnpm lint",
  );
});

contractTest("runtime.hermetic", "normalizeDevShellExecCommand unwraps whole-command quotes without touching inner content", () => {
  assert.equal(
    normalizeDevShellExecCommand("\"pnpm exec tsc --noEmit\""),
    "pnpm exec tsc --noEmit",
  );
  assert.equal(
    normalizeDevShellExecCommand("'printf '\\''done'\\'''"),
    "printf 'done'",
  );
});

contractTest("runtime.hermetic", "normalizeDevShellExecCommand preserves already-raw commands", () => {
  const command = "cat <<'EOF' > app/page.tsx\nhello\nEOF";
  assert.equal(normalizeDevShellExecCommand(command), command);
});

contractTest("runtime.hermetic", "findDevShellCommandSafetyIssue rejects unquoted bracket route path segments", () => {
  const issue = findDevShellCommandSafetyIssue("mkdir -p src/app/api/auth/[...all]");

  assert.equal(issue?.code, "UNQUOTED_SHELL_GLOB_PATH_SEGMENT");
  assert.equal(issue?.token, "src/app/api/auth/[...all]");
  assert.match(issue?.correction ?? "", /Quote or escape bracketed path segments/u);
});

contractTest("runtime.hermetic", "findDevShellCommandSafetyIssue allows quoted or escaped bracket route path segments", () => {
  assert.equal(
    findDevShellCommandSafetyIssue("mkdir -p 'src/app/api/auth/[...all]'"),
    undefined,
  );
  assert.equal(
    findDevShellCommandSafetyIssue("mkdir -p src/app/api/auth/\\[...all\\]"),
    undefined,
  );
});

contractTest("runtime.hermetic", "findDevShellCommandSafetyIssue ignores heredoc body content", () => {
  const command = "cat <<'EOF' > route-notes.txt\nsrc/app/api/auth/[...all]\nEOF";

  assert.equal(findDevShellCommandSafetyIssue(command), undefined);
});

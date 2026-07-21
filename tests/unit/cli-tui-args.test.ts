import assert from "node:assert/strict";

import { formatKestrelHelp, isHelpArgs, isVersionArgs, parseArgs } from "../../cli/tui.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "parseArgs accepts --scripted alongside existing flags", () => {
  const parsed = parseArgs([
    "--scripted",
    "--new-session",
    "ops-root-live",
    "--profile",
    "reference",
  ]);

  assert.equal(parsed.scripted, true);
  assert.equal(parsed.freshSessionName, "ops-root-live");
  assert.equal(parsed.profileId, "reference");
});

contractTest("runtime.hermetic", "parseArgs rejects the removed embedded-runner escape hatch", () => {
  assert.throws(
    () => parseArgs(["--inprocess-runner"]),
    /Unknown argument '--inprocess-runner'/u,
  );
});

contractTest("runtime.hermetic", "parseArgs defaults scripted mode to false when omitted", () => {
  const parsed = parseArgs(["--session", "default"]);

  assert.equal(parsed.scripted, undefined);
  assert.equal(parsed.sessionName, "default");
});

contractTest("runtime.hermetic", "parseArgs accepts explicit fresh-session startup", () => {
  const parsed = parseArgs(["--new-session", "fresh-session"]);

  assert.equal(parsed.freshSessionName, "fresh-session");
  assert.equal(parsed.sessionName, undefined);
});

contractTest("runtime.hermetic", "top-level version and help args are recognized before interactive parsing", () => {
  assert.equal(isVersionArgs(["--version"]), true);
  assert.equal(isVersionArgs(["version"]), true);
  assert.equal(isHelpArgs(["--help"]), true);
  assert.equal(isHelpArgs(["help"]), true);
  assert.match(formatKestrelHelp(), /Usage: kestrel/u);
  assert.match(formatKestrelHelp(), /workspace status\|list/u);
});

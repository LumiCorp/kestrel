import test from "node:test";
import assert from "node:assert/strict";

import { formatKestrelHelp, isHelpArgs, isVersionArgs, parseArgs } from "../../cli/tui.js";

test("parseArgs accepts --scripted alongside existing flags", () => {
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

test("parseArgs rejects the removed embedded-runner escape hatch", () => {
  assert.throws(
    () => parseArgs(["--inprocess-runner"]),
    /Unknown argument '--inprocess-runner'/u,
  );
});

test("parseArgs defaults scripted mode to false when omitted", () => {
  const parsed = parseArgs(["--session", "default"]);

  assert.equal(parsed.scripted, undefined);
  assert.equal(parsed.sessionName, "default");
});

test("parseArgs accepts explicit fresh-session startup", () => {
  const parsed = parseArgs(["--new-session", "fresh-session"]);

  assert.equal(parsed.freshSessionName, "fresh-session");
  assert.equal(parsed.sessionName, undefined);
});

test("top-level version and help args are recognized before interactive parsing", () => {
  assert.equal(isVersionArgs(["--version"]), true);
  assert.equal(isVersionArgs(["version"]), true);
  assert.equal(isHelpArgs(["--help"]), true);
  assert.equal(isHelpArgs(["help"]), true);
  assert.match(formatKestrelHelp(), /Usage: kestrel/u);
  assert.match(formatKestrelHelp(), /workspace status\|list/u);
});

import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import { applySkillPackToProfile, getSkillPackById } from "../../cli/runtime/skillPacks.js";
import { contractTest } from "../helpers/contract-test.js";


function baseProfile(toolAllowlist: string[]): TuiProfile {
  return {
    id: "test",
    label: "Test",
    agent: "reference-react",
    sessionPrefix: "test",
    toolAllowlist,
  };
}

contractTest("runtime.hermetic", "code skill pack preserves profile-allowed dev.shell tools", () => {
  const codePack = getSkillPackById("code");
  assert.notEqual(codePack, undefined);

  const narrowed = applySkillPackToProfile(
    baseProfile([
      "fs.list",
      "fs.read_text",
      "code.execute",
      "dev.shell.run",
      "dev.process.write",
    ]),
    codePack,
  );

  assert.equal(narrowed.toolAllowlist?.includes("dev.shell.run"), true);
  assert.equal(narrowed.toolAllowlist?.includes("dev.process.write"), true);
  assert.equal(narrowed.toolAllowlist?.includes("FinalizeAnswer"), true);
  assert.equal(narrowed.toolAllowlist?.includes("effect_result_lookup"), true);
});

contractTest("runtime.hermetic", "code skill pack does not invent dev.shell tools that profile disallows", () => {
  const codePack = getSkillPackById("code");
  assert.notEqual(codePack, undefined);

  const narrowed = applySkillPackToProfile(
    baseProfile([
      "fs.list",
      "fs.read_text",
      "code.execute",
    ]),
    codePack,
  );

  assert.equal(narrowed.toolAllowlist?.includes("dev.process.write"), false);
  assert.equal(narrowed.toolAllowlist?.includes("dev.shell.run"), false);
});

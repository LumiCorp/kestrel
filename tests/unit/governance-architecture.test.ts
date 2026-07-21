import assert from "node:assert/strict";

import { evaluateArchitecture } from "../../src/governance/architecture.js";
import type { ArchitectureRuleSet } from "../../src/governance/contracts.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "evaluateArchitecture reports disallowed layer dependency", () => {
  const rules: ArchitectureRuleSet[] = [
    {
      layer: "engine",
      can_depend_on: ["io", "tools"],
    },
  ];

  const violations = evaluateArchitecture({
    file: "/repo/src/engine/ExecutionEngine.ts",
    imports: ["/repo/src/store/PostgresSessionStore.ts"],
    rules,
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.toLayer, "store");
});

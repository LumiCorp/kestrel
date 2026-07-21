import assert from "node:assert/strict";

import { findDocDrift, requiresFreshness } from "../../src/governance/docs.js";
import type { DocIndexEntry } from "../../src/governance/contracts.js";
import { contractTest } from "../helpers/contract-test.js";


function entry(status: DocIndexEntry["status"], lastVerifiedAt = "2026-01-01"): DocIndexEntry {
  return {
    id: `doc-${status}`,
    domain: "docs",
    status,
    owner: "kestrel-quality",
    last_verified_at: lastVerifiedAt,
  };
}

contractTest("runtime.hermetic", "document freshness is required only for active and draft docs", () => {
  assert.equal(requiresFreshness(entry("active")), true);
  assert.equal(requiresFreshness(entry("draft")), true);
  assert.equal(requiresFreshness(entry("deprecated")), false);
  assert.equal(requiresFreshness(entry("historical")), false);
});

contractTest("runtime.hermetic", "historical and deprecated docs do not fail stale freshness checks", () => {
  for (const status of ["deprecated", "historical"] as const) {
    const findings = findDocDrift({
      docPath: `docs/${status}.md`,
      entry: entry(status),
      now: new Date("2026-05-08T00:00:00Z"),
      staleAfterDays: 45,
      content: "[docs](index.md)",
    });

    assert.deepEqual(findings.filter((finding) => finding.type === "stale"), []);
  }
});

contractTest("runtime.hermetic", "active docs still fail stale freshness checks", () => {
  const findings = findDocDrift({
    docPath: "docs/active.md",
    entry: entry("active"),
    now: new Date("2026-05-08T00:00:00Z"),
    staleAfterDays: 45,
    content: "[docs](index.md)",
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.type, "stale");
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { desktopClaimRuntimeBindingMatches } from "./desktop-runtime-binding";

const desktopSource = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "desktop.ts"),
  "utf8",
);

const base = {
  id: "binding-1",
  threadId: "thread-1",
  capabilityDigest: "capability-digest",
} as const;

test("Desktop claims accept an unscoped Kestrel binding", () => {
  const input = {
    bindingId: base.id,
    threadId: base.threadId,
    claimedRuntimeId: "kestrel" as const,
    authenticatedEnvironmentId: "environment-1",
  };
  for (const [environmentId, expected] of [
    [null, true],
    ["environment-1", true],
    ["environment-2", false],
  ] as const) {
    assert.equal(
      desktopClaimRuntimeBindingMatches({
        ...input,
        binding: { ...base, runtimeId: "kestrel", environmentId },
      }),
      expected,
    );
  }
});

test("Desktop claims require an exact Environment for foreign Runtimes", () => {
  for (const runtimeId of ["codex", "claude"] as const) {
    const input = {
      bindingId: base.id,
      threadId: base.threadId,
      claimedRuntimeId: runtimeId,
      authenticatedEnvironmentId: "environment-1",
    } as const;
    assert.equal(
      desktopClaimRuntimeBindingMatches({
        ...input,
        binding: { ...base, runtimeId, environmentId: null },
      }),
      false,
    );
    assert.equal(
      desktopClaimRuntimeBindingMatches({
        ...input,
        binding: { ...base, runtimeId, environmentId: "environment-2" },
      }),
      false,
    );
    assert.equal(
      desktopClaimRuntimeBindingMatches({
        ...input,
        binding: {
          ...base,
          runtimeId,
          environmentId: "environment-1",
          capabilityDigest: null,
        },
      }),
      false,
    );
    assert.equal(
      desktopClaimRuntimeBindingMatches({
        ...input,
        binding: { ...base, runtimeId, environmentId: "environment-1" },
      }),
      true,
    );
  }
});

test("Desktop claims fail closed on binding, Thread, or Runtime mismatch", () => {
  const binding = {
    ...base,
    runtimeId: "kestrel" as const,
    environmentId: null,
  };
  for (const input of [
    { bindingId: "binding-2", threadId: base.threadId, claimedRuntimeId: "kestrel" as const },
    { bindingId: base.id, threadId: "thread-2", claimedRuntimeId: "kestrel" as const },
    { bindingId: base.id, threadId: base.threadId, claimedRuntimeId: "codex" as const },
  ]) {
    assert.equal(
      desktopClaimRuntimeBindingMatches({
        binding,
        ...input,
        authenticatedEnvironmentId: "environment-1",
      }),
      false,
    );
  }
});

test("Desktop command claims load binding identity before route policy", () => {
  const lookup = desktopSource.slice(
    desktopSource.indexOf("const runtimeBinding = thread?.runtimeBindingId"),
    desktopSource.indexOf("const storedCommand = parseRunnerCommandV2"),
  );
  assert.match(lookup, /eq\(table\.id, thread\.runtimeBindingId!\)/u);
  assert.match(lookup, /eq\(table\.threadId, execution\.threadId\)/u);
  assert.doesNotMatch(lookup, /table\.environmentId/u);
  assert.match(desktopSource, /desktopClaimRuntimeBindingMatches\(\{/u);
});

import assert from "node:assert/strict";
import test from "node:test";

import { immutableImageReference } from "./production-command.js";

test("runtime image references are pinned to the published manifest digest", () => {
  const image = immutableImageReference(
    "ghcr.io/lumicorp/kestrel-workspace-runtime",
    "0.8.5",
    (reference) => ({
      Ref: reference,
      Descriptor: { digest: `sha256:${"a".repeat(64)}` },
    }),
  );

  assert.equal(
    image,
    `ghcr.io/lumicorp/kestrel-workspace-runtime@sha256:${"a".repeat(64)}`,
  );
});

test("runtime image references reject a manifest without an immutable digest", () => {
  assert.throws(
    () =>
      immutableImageReference(
        "ghcr.io/lumicorp/kestrel-workspace-runtime",
        "0.8.5",
        () => ({ Descriptor: { digest: "not-a-digest" } }),
      ),
    /immutable digest/u,
  );
});

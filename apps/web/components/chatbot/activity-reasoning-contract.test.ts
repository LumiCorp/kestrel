import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contractTest } from "../../../../tests/helpers/contract-test.js";

contractTest("web.hermetic", "provider reasoning renders as a card and is excluded from Activity details", async () => {
  const source = await readFile(
    new URL("./message.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /part\.type === "data-kestrel-provider-reasoning"[\s\S]*return false;/u,
  );
  assert.match(
    source,
    /liveReasoning[\s\S]*<MessageReasoning[\s\S]*displayLiveReasoning/u,
  );
  assert.doesNotMatch(
    source,
    /part\.data\.event === "delta"[\s\S]*part\.data\.delta/u,
  );
});

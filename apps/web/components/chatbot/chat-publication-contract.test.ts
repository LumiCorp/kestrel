import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const chatSource = readFileSync(new URL("./chat.tsx", import.meta.url), "utf8");
const webPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as {
  dependencies: Record<string, string>;
};
const aiSdkPackage = JSON.parse(
  readFileSync(
    new URL("../../../../packages/ai-sdk/package.json", import.meta.url),
    "utf8"
  )
) as {
  devDependencies: Record<string, string>;
};
const installedReactPackage = require("@ai-sdk/react/package.json") as {
  version: string;
};

test("thread chat uses the fixed throttled AI SDK publication contract", () => {
  assert.match(chatSource, /experimental_throttle:\s*50/u);
  assert.equal(webPackage.dependencies["@ai-sdk/react"], "3.0.248");
  assert.equal(
    installedReactPackage.version,
    webPackage.dependencies["@ai-sdk/react"],
    "the installed React SDK must include the v6 snapshot publication fix"
  );
  assert.equal(webPackage.dependencies.ai, "6.0.246");
  assert.equal(
    aiSdkPackage.devDependencies.ai,
    webPackage.dependencies.ai,
    "Kestrel One and @kestrel-agents/ai-sdk must use the same AI SDK v6 patch"
  );
});

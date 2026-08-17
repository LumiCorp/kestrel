import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appsRoot = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(appsRoot, "../..");

function read(relativePath: string) {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

test("Environment App OAuth returns to the canonical detail route", () => {
  const callback = read(
    "app/api/environments/[environmentId]/apps/[appKey]/oauth/callback/route.ts",
  );

  assert.match(
    callback,
    /\/organization\/environments\/\$\{encodeURIComponent\(input\.environmentId\)\}\/apps\/\$\{encodeURIComponent\(input\.appKey\)\}/u,
  );
  assert.match(callback, /: "\/organization"/u);
  assert.doesNotMatch(callback, /\/settings\/environments/u);
});

test("nested Environment App details preserve the Environment as the sole h1", () => {
  const layout = read("components/apps/app-settings-layout.tsx");
  const environmentDetail = read("components/apps/environment-apps-panel.tsx");

  assert.match(layout, /headingLevel\?: 1 \| 2/u);
  assert.match(layout, /headingLevel === 1/u);
  assert.match(layout, /<h2 className=/u);
  assert.match(environmentDetail, /headingLevel=\{2\}/u);
});

test("Environment capability switches show their current on or off state", () => {
  const environmentDetail = read("components/apps/environment-apps-panel.tsx");

  assert.match(
    environmentDetail,
    /capability\.enabled \? "On" : "Off"/u,
  );
  assert.match(environmentDetail, /aria-label=\{`Enable \$\{capability\.displayName\}`\}/u);
});

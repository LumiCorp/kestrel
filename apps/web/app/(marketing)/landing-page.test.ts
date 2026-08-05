import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST } from "../route-ownership.manifest";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testRoot, "../..");

function readPackageFile(file: string) {
  return fs.readFileSync(path.join(packageRoot, file), "utf8");
}

test(
  "public Kestrel landing page presents unified 0.8, public One source, and separate hosted access",
  () => {
    const rootRoute = KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST.find(
      (entry) => entry.kind === "page" && entry.route === "/",
    );
    const pageSource = readPackageFile("app/(marketing)/page.tsx");
    const landingSource = readPackageFile(
      "components/marketing/landing-page.tsx",
    );
    const headerSource = readPackageFile(
      "components/marketing/marketing-header.tsx",
    );
    const showcaseSource = readPackageFile(
      "components/marketing/product-showcase.tsx",
    );
    const proxySource = readPackageFile("proxy.ts");

    assert.deepEqual(rootRoute, {
      file: "app/(marketing)/page.tsx",
      route: "/",
      kind: "page",
      owner: "public",
      access: "public",
      unauthorized: "public",
    });
    assert.match(pageSource, /\bawait auth\(\)/u);
    assert.match(pageSource, /\bredirectAuthenticatedUser\b/u);
    assert.match(pageSource, /return <LandingPage \/>/u);
    assert.match(proxySource, /"\/product"/u);
    assert.match(proxySource, /"\/robots\.txt"/u);
    assert.match(proxySource, /"\/sitemap\.xml"/u);
    assert.match(pageSource, /url: "\/"/u);

    assert.match(
      landingSource,
      /Kestrel 0\.8 is one coordinated Beta release/u,
    );
    assert.match(landingSource, /Download Desktop Beta/u);
    assert.match(landingSource, /One Kestrel everywhere\./u);
    assert.match(landingSource, /Access hosted Kestrel One/u);
    assert.match(landingSource, /View Kestrel One source/u);
    assert.match(landingSource, /github\.com\/LumiCorp\/kestrel\/tree\/v0\.8\.0\/apps\/web/u);
    assert.match(landingSource, /SDK 0\.8/u);
    assert.match(landingSource, /@kestrel-agents\/kestrel@0\.8\.1/u);
    assert.match(landingSource, /corrected Runtime npm package is 0\.8\.1/u);
    assert.match(landingSource, /invitation-only/u);
    assert.match(
      landingSource,
      /Kestrel is maintained and supported by Lumi\./u,
    );
    assert.match(landingSource, /https:\/\/www\.lumicorp\.ai/u);
    assert.match(headerSource, /https:\/\/www\.lumicorp\.ai/u);
    assert.doesNotMatch(landingSource, /release independently/iu);
    assert.doesNotMatch(landingSource, /private beta/iu);
    assert.doesNotMatch(landingSource, /Release readiness/u);
    assert.doesNotMatch(showcaseSource, /Release readiness/u);
    assert.match(
      landingSource,
      /product\/desktop\/checkout-result\.png/u,
    );
    assert.match(showcaseSource, /product\/kestrel-one\/knowledge\.png/u);
    assert.match(landingSource, /Skip to content/u);
    assert.match(landingSource, /id="main-content"/u);
    assert.match(landingSource, /scroll-mt-24/u);

    for (const semanticToken of [
      "bg-background",
      "bg-card",
      "bg-surface",
      "text-foreground",
      "text-muted-foreground",
      "border-border",
      "text-primary",
      "text-accent",
    ]) {
      assert.match(landingSource, new RegExp(`\\b${semanticToken}\\b`, "u"));
    }
    assert.doesNotMatch(landingSource, /#[\da-f]{3,8}\b/iu);
  },
);

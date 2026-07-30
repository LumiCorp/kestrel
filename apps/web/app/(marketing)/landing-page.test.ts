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
  "public Kestrel landing page keeps Beta status and authenticated workspace entry explicit",
  () => {
    const rootRoute = KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST.find(
      (entry) => entry.kind === "page" && entry.route === "/",
    );
    const pageSource = readPackageFile("app/(marketing)/page.tsx");
    const landingSource = readPackageFile(
      "components/marketing/landing-page.tsx",
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
      /Kestrel Desktop and Kestrel One are in Beta\./u,
    );
    assert.match(landingSource, /Download Desktop Beta/u);
    assert.match(landingSource, /Explore Kestrel One Beta/u);
    assert.match(landingSource, /SDK 0\.7/u);
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

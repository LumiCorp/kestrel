import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import nextConfig from "../next.config";
import { getNavigation, getPageMetaBySlug, getPublicPages, getSearchDocuments } from "@/lib/content";
import { resolveDocsAppRoot, resolveRepoRoot } from "@/lib/site";


test("public surfaces never expose excluded content or Studio", async () => {
  const [pages, navigation, search] = await Promise.all([getPublicPages(), getNavigation(), getSearchDocuments()]);
  const corpus = JSON.stringify({ pages, navigation, search });
  assert.doesNotMatch(corpus, /Kestrel Studio|\/studio(?:["/]|$)/iu);
  assert.ok(!corpus.includes(["Scene", "Runner"].join("")));
  assert.doesNotMatch(corpus, /0\.5\.0-beta\.0/iu);
  assert.doesNotMatch(corpus, /\/chat(?:["')\s]|$)/iu);
  assert.ok(pages.every(({ meta }) => !(meta.internal || meta.archive ) && meta.audience !== "maintainers"));
  assert.ok(search.every((document) => pages.some(({ meta }) => meta.url === document.url)));
  assert.equal(await getPageMetaBySlug(["archive"]), null);
  assert.equal(await getPageMetaBySlug(["runtime", "governance-and-invariants"]), null);
});

test("docs chrome and README identify Lumi maintenance and support", async () => {
  const docsRoot = resolveDocsAppRoot();
  const [chrome, shell, readme] = await Promise.all([
    fs.readFile(path.join(docsRoot, "components", "SiteChrome.tsx"), "utf8"),
    fs.readFile(path.join(docsRoot, "components", "DocsShell.tsx"), "utf8"),
    fs.readFile(path.join(resolveRepoRoot(), "README.md"), "utf8"),
  ]);

  assert.equal((chrome.match(/https:\/\/www\.lumicorp\.ai/gu) ?? []).length, 2);
  assert.match(shell, /Kestrel is maintained and supported by/u);
  assert.match(shell, /https:\/\/www\.lumicorp\.ai/u);
  assert.match(readme, /Kestrel is maintained and supported by/u);
  assert.match(readme, /https:\/\/www\.lumicorp\.ai/u);
  assert.match(readme, /Desktop 0\.8\.6/u);
  assert.match(readme, /Runtime and CLI\/TUI 0\.8\.7/u);
  assert.match(readme, /updates\.lumicorp\.ai\/desktop\/releases\/0\.8\.6\/arm64\/Kestrel-0\.8\.6-mac-arm64\.dmg/u);
  assert.doesNotMatch(readme, /one coordinated release across Desktop/iu);
});

test("docs homepage grids share one responsive column contract", async () => {
  const css = await fs.readFile(path.join(resolveDocsAppRoot(), "app", "globals.css"), "utf8");

  assert.equal((css.match(/grid-template-columns: var\(--home-grid-columns\)/gu) ?? []).length, 2);
  assert.match(css, /\.home-flow \{ --home-grid-columns: repeat\(4, minmax\(0, 1fr\)\)/u);
  assert.match(
    css,
    /@media \(max-width: 1199px\)[\s\S]*?\.home-flow \{ --home-grid-columns: repeat\(2, minmax\(0, 1fr\)\)/u,
  );
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.home-flow \{ --home-grid-columns: 1fr/u);
});

test("superseded product and operations URLs are permanent redirects", async () => {
  assert.equal(typeof nextConfig.redirects, "function");
  const redirects = await nextConfig.redirects!();
  assert.deepEqual(redirects, [
    { source: "/apps/desktop", destination: "/desktop", permanent: true },
    { source: "/apps/web", destination: "/kestrel-one", permanent: true },
    { source: "/docs", destination: "/start", permanent: true },
    { source: "/docs/quickstart", destination: "/start/quickstart", permanent: true },
    { source: "/docs/core-concepts", destination: "/start/concepts", permanent: true },
    { source: "/docs/architecture-overview", destination: "/start/architecture", permanent: true },
    { source: "/docs/faq", destination: "/start/faq", permanent: true },
    { source: "/deploy", destination: "/operate", permanent: true },
    { source: "/deploy/running-the-runner-service", destination: "/operate/runner-service", permanent: true },
    { source: "/deploy/environment-and-auth", destination: "/operate/environment-and-auth", permanent: true },
    { source: "/deploy/deployment-troubleshooting", destination: "/operate/troubleshooting", permanent: true },
    { source: "/operations/:path*", destination: "/operate/:path*", permanent: true },
    { source: "/build/workspace-copilot-demo", destination: "/build/building-your-first-agent", permanent: true },
    { source: "/build/workspaces-and-automation", destination: "/cli/workspace-workflows", permanent: true },
    { source: "/build/automating-common-tasks", destination: "/cli/kcron", permanent: true },
    { source: "/desktop/automation", destination: "/cli/kcron", permanent: true },
  ]);
});

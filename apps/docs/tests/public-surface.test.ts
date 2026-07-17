import assert from "node:assert/strict";
import test from "node:test";

import nextConfig from "../next.config";
import { getNavigation, getPageMetaBySlug, getPublicPages, getSearchDocuments } from "@/lib/content";

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
  ]);
});

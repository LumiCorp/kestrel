import assert from "node:assert/strict";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { getPublicPages } from "@/lib/content";
import { pageRegistry } from "@/lib/content-registry";
import { siteMetadata } from "@/lib/metadata";
import { resolveDocsAppRootFrom, SITE_ORIGIN, SITE_URL } from "@/lib/site";

import nextConfig from "../next.config";
import { contractTest } from "../../../tests/helpers/contract-test.js";


contractTest("docs.hermetic", "production metadata uses the canonical docs origin", () => {
  assert.equal(siteMetadata.metadataBase?.toString(), `${SITE_ORIGIN}/`);
  assert.equal(siteMetadata.metadataBase?.toString(), SITE_URL.toString());
  assert.deepEqual(siteMetadata.alternates, { canonical: "/" });
});

contractTest("docs.hermetic", "content root resolution supports repository and app-root build environments", () => {
  assert.equal(
    resolveDocsAppRootFrom("/workspace", (candidate) => candidate === "/workspace/apps/docs"),
    "/workspace/apps/docs",
  );
  assert.equal(
    resolveDocsAppRootFrom("/vercel/path0", (candidate) => candidate === "/vercel/path0"),
    "/vercel/path0",
  );
});

contractTest("docs.hermetic", "public builds do not require internal or archived source files", async () => {
  const publicPages = await getPublicPages();
  const publicUrls = new Set(publicPages.map(({ meta }) => meta.url));
  for (const spec of pageRegistry.filter((candidate) => candidate.internal || candidate.archive)) {
    const url = `/${spec.slug.join("/")}`;
    assert.ok(!publicUrls.has(url), `${url} leaked into the public build`);
  }
});

contractTest("docs.hermetic", "sitemap contains every eligible public page and no excluded routes", async () => {
  const [entries, pages] = await Promise.all([sitemap(), getPublicPages()]);
  assert.deepEqual(
    entries.map((entry) => new URL(entry.url).pathname).sort(),
    pages.map(({ meta }) => meta.url).sort(),
  );
  const corpus = JSON.stringify(entries);
  assert.doesNotMatch(corpus, /\/studio|\/archive|\/internal/iu);
});

contractTest("docs.hermetic", "robots advertises the canonical sitemap and excludes non-content routes", () => {
  const value = robots();
  assert.equal(value.sitemap, `${SITE_ORIGIN}/sitemap.xml`);
  assert.equal(value.host, SITE_ORIGIN);
  assert.deepEqual(value.rules, {
    userAgent: "*",
    allow: "/",
    disallow: ["/search", "/archive", "/internal"],
  });
});

contractTest("docs.hermetic", "deployment responses receive baseline security and search-cache headers", async () => {
  assert.equal(typeof nextConfig.headers, "function");
  const rules = await nextConfig.headers!();
  const allHeaders = rules.flatMap((rule) => rule.headers);
  const names = new Set(allHeaders.map((header) => header.key));
  for (const name of ["X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy", "Cache-Control"]) {
    assert.ok(names.has(name), `missing ${name}`);
  }
});

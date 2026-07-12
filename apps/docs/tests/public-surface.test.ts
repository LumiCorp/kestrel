import assert from "node:assert/strict";
import test from "node:test";

import {
  getNavigation,
  getPageMetaBySlug,
  getPublicPages,
  getRenderedPageBySlug,
  getSearchDocuments,
} from "@/lib/content";

test("public docs surfaces exclude internal, maintainer, archive, and removed app pages", async () => {
  const [pages, navigation, searchDocuments] = await Promise.all([
    getPublicPages(),
    getNavigation(),
    getSearchDocuments(),
  ]);
  const publicUrls = new Set(pages.map((page) => page.meta.url));

  assert.ok(pages.length > 0);
  assert.ok(
    pages.every(
      (page) =>
        !page.meta.internal &&
        !page.meta.archive &&
        page.meta.section !== "archive" &&
        page.meta.audience !== "maintainers"
    )
  );
  assert.equal(publicUrls.has("/apps/scenerunner"), false);

  for (const section of navigation) {
    assert.ok(section.landing);
    assert.ok(publicUrls.has(section.landing.url));
    for (const group of section.groups) {
      for (const entry of group.entries) {
        assert.ok(publicUrls.has(entry.url), entry.url);
      }
    }
  }

  assert.ok(
    searchDocuments.every((document) => publicUrls.has(document.url))
  );
});

test("public article rendering includes source metadata without exposing archive pages", async () => {
  const page = await getRenderedPageBySlug(["docs", "core-concepts"]);
  const archived = await getPageMetaBySlug([
    "archive",
    "plans",
    "2026-02-21-kestrel-v3-architecture",
  ]);

  assert.ok(page);
  assert.match(page.meta.sourceUrl, /github\.com\/LumiCorp\/kestrel\/blob\/main/u);
  assert.equal(archived, null);
});

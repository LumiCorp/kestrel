import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  getNavigation,
  getPublicPages,
  getRenderedPageBySlug,
} from "@/lib/content";
import { resolveDocsAppRoot } from "@/lib/site";
import { DOCS_RELEASE } from "@/lib/release";
import { CONTENT_ARCHETYPES, DOCS_NAV_SECTIONS, PRODUCT_SURFACES } from "@/lib/types";

const VERSION = "0.6.0-beta.0";

test("navigation exposes exactly six ordered public journeys", async () => {
  const navigation = await getNavigation();
  assert.deepEqual(navigation.map((group) => group.section), [...DOCS_NAV_SECTIONS]);
  assert.deepEqual(navigation.map((group) => group.title), [
    "Start",
    "Desktop",
    "Kestrel One",
    "Build",
    "Operate",
    "Reference",
  ]);
});

test("every navigation, related, and Markdown link resolves to a public docs page", async () => {
  const [pages, navigation] = await Promise.all([getPublicPages(), getNavigation()]);
  const publicUrls = new Set(pages.map(({ meta }) => meta.url));
  const redirectOnlyUrls = new Set(["/apps/desktop", "/apps/web", "/docs", "/deploy"]);

  for (const section of navigation) {
    assert.ok(section.landing && publicUrls.has(section.landing.url));
    for (const group of section.groups) {
      for (const entry of group.entries) assert.ok(publicUrls.has(entry.url), entry.url);
    }
  }

  for (const page of pages) {
    for (const related of page.meta.related) {
      const url = related.startsWith("/") ? related : `/${related}`;
      assert.ok(publicUrls.has(url), `${page.meta.url} has unresolved related page ${url}`);
    }
    const links = [...page.rawContent.matchAll(/\]\((\/[a-z0-9][^\s)#?]*)/giu)].map((match) => match[1]);
    for (const url of links) {
      if (url.startsWith("/product/")) continue;
      assert.ok(publicUrls.has(url) || redirectOnlyUrls.has(url), `${page.meta.url} links to missing ${url}`);
    }
  }
});

test("the complete 0.6 public baseline is represented", async () => {
  const required = [
    "start/quickstart",
    "desktop/providers",
    "desktop/workspaces-and-sessions",
    "kestrel-one/threads",
    "kestrel-one/projects",
    "kestrel-one/knowledge",
    "kestrel-one/managed-model-deployments",
    "build/protocol-and-results",
    "build/runner-events",
    "build/waiting-resume-and-cancellation",
    "operate/credential-leases",
    "operate/model-authority",
    "operate/evaluations",
    "reference/protocol",
    "reference/terminal-results",
    "reference/compatibility",
  ];
  for (const slug of required) {
    assert.ok(await getRenderedPageBySlug(slug.split("/")), `missing /${slug}`);
  }
});

test("every public page has an explicit consumer content model", async () => {
  const pages = await getPublicPages();
  for (const { meta } of pages) {
    assert.ok(CONTENT_ARCHETYPES.includes(meta.archetype), `${meta.url} has no valid archetype`);
    assert.ok(PRODUCT_SURFACES.includes(meta.surface), `${meta.url} has no valid surface`);
    assert.ok(["beginner", "intermediate", "advanced"].includes(meta.experienceLevel), `${meta.url} has no experience level`);
    assert.ok(["none", "auto", "full"].includes(meta.tocMode), `${meta.url} has no TOC mode`);
    if (meta.archetype === "gateway") assert.deepEqual(meta.toc, [], `${meta.url} gateway should not show a TOC`);
  }
});

test("journey progress resolves in order without skipping public pages", async () => {
  const pages = await getPublicPages();
  const journeyPages = pages.filter(({ meta }) => meta.journey);
  assert.ok(journeyPages.length > 0);
  for (const { meta } of journeyPages) {
    const journey = meta.journey!;
    assert.ok(journey.step >= 1 && journey.step <= journey.total, meta.url);
    if (journey.previous) assert.ok(pages.some(({ meta: candidate }) => candidate.url === journey.previous!.url));
    if (journey.next) assert.ok(pages.some(({ meta: candidate }) => candidate.url === journey.next!.url));
  }
});

test("Kestrel One documentation uses the owned product routes", async () => {
  const pages = await Promise.all([
    getRenderedPageBySlug(["kestrel-one", "threads"]),
    getRenderedPageBySlug(["kestrel-one", "projects"]),
    getRenderedPageBySlug(["kestrel-one", "knowledge"]),
    getRenderedPageBySlug(["kestrel-one", "managed-model-deployments"]),
  ]);
  assert.match(pages[0]?.rawContent ?? "", /\/threads/u);
  assert.match(pages[1]?.rawContent ?? "", /\/projects/u);
  assert.match(pages[2]?.rawContent ?? "", /\/knowledge/u);
  assert.match(pages[3]?.rawContent ?? "", /\/model-deployments/u);
});

test("released packages and compatibility are first-class public reference pages", async () => {
  const routes = ["protocol", "sdk", "nextjs", "observability"];
  for (const route of routes) assert.ok(await getRenderedPageBySlug(["reference", route]), route);
  assert.ok(await getRenderedPageBySlug(["reference", "compatibility"]));
  assert.deepEqual(
    DOCS_RELEASE.compatibility.map(([component]) => component),
    ["Runtime", "Protocol", "SDK", "Next.js", "Observability", "CLI", "Desktop", "Kestrel One"],
  );
});

test("release-sensitive public copy uses the 0.6 beta version", async () => {
  const pages = await getPublicPages();
  const versions = pages.flatMap(({ rawContent }) => rawContent.match(/\b\d+\.\d+\.\d+-beta\.\d+\b/gu) ?? []);
  assert.ok(versions.length > 0);
  assert.deepEqual([...new Set(versions)], [VERSION]);
});

test("all seven product screenshots exist and have descriptive alt text and captions", async () => {
  const pages = await getPublicPages();
  const images = pages.flatMap(({ meta, rawContent }) =>
    [...rawContent.matchAll(/<ProductFigure\s+src="(\/product\/[^"]+)"\s+alt="([^"]+)"\s+caption="([^"]+)"\s*\/>/gu)].map((match) => ({
      page: meta.url,
      src: match[1],
      alt: match[2],
      caption: match[3],
    })),
  );
  assert.ok(images.length >= 7);
  assert.equal(new Set(images.map((image) => image.src)).size, 7);
  for (const image of images) {
    assert.ok(image.alt.trim().split(/\s+/u).length >= 4, `${image.page} needs descriptive alt text`);
    assert.ok(image.caption.trim().split(/\s+/u).length >= 4, `${image.page} needs a useful caption`);
    await fs.access(path.join(resolveDocsAppRoot(), "public", image.src));
  }
});

test("public code fences name their language and package installs pin the Beta version", async () => {
  const pages = await getPublicPages();
  for (const page of pages) {
    let insideFence = false;
    for (const line of page.rawContent.split("\n")) {
      if (!line.startsWith("```")) continue;
      if (insideFence) {
        assert.equal(line.trim(), "```", `${page.meta.url} has an invalid closing fence`);
        insideFence = false;
      } else {
        assert.match(line.trim(), /^```[a-z0-9-]+$/u, `${page.meta.url} has an unlabeled code fence`);
        insideFence = true;
      }
    }
    assert.equal(insideFence, false, `${page.meta.url} has an unclosed code fence`);

    for (const line of page.rawContent.split("\n").filter((candidate) => candidate.includes("pnpm add @kestrel-agents/"))) {
      for (const packageName of line.match(/@kestrel-agents\/[a-z-]+(?:@[^\s\\]+)?/gu) ?? []) {
        assert.match(packageName, /@0\.6\.0-beta\.0$/u, `${page.meta.url} has an unpinned package install`);
      }
    }
  }
});

test("public copy does not reuse the retired universal template headings", async () => {
  const pages = await getPublicPages();
  const corpus = pages.map(({ rawContent }) => rawContent).join("\n");
  assert.doesNotMatch(corpus, /^## Why this exists$/gmu);
  assert.doesNotMatch(corpus, /^## What To Read Next$/gmu);
});

test("public copy does not expose documentation planning or repository validation commentary", async () => {
  const pages = await getPublicPages();
  const banned = [
    /canonical (?:demo|example)/iu,
    /fixed contract for the rest of the docs/iu,
    /local docs validation/iu,
    /publish-time gate/iu,
    /repo(?:sitory)? tests (?:show|prove|confirm)/iu,
    /this page is intentionally/iu,
    /the point of the example/iu,
    /the demo now has/iu,
    /mechanical contract/iu,
    /^## What changes in this step$/imu,
  ];

  for (const page of pages) {
    for (const pattern of banned) {
      assert.doesNotMatch(page.rawContent, pattern, `${page.meta.url} exposes internal editorial or validation language`);
    }
  }
});

test("consumer onboarding excludes repository contributor setup", async () => {
  const pages = await getPublicPages();
  const onboarding = pages
    .filter(({ meta }) => ["start", "desktop", "kestrel-one"].includes(meta.section))
    .map(({ rawContent }) => rawContent)
    .join("\n");
  assert.doesNotMatch(onboarding, /pnpm install|desktop:dev|web:dev|contributor development/iu);
  assert.match(onboarding, /<DesktopDownload\s*\/>/u);
  assert.match(onboarding, /invitation/iu);
});

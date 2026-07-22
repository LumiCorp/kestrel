import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMetadata, resolveSocialImages } from "./metadata";

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const retiredPaths = [
  "app/favicon.ico",
  "components/ascii-hero-solid.tsx",
  "components/chatbot/app-sidebar.tsx",
  "components/logo.tsx",
  "hawk",
  "lib/ascii-renderer",
  "public/__og.png",
  "public/_og.png",
  "public/favicon",
  "public/hawk",
  "public/logo.svg",
  "public/og.png",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === ".next"
        ? []
        : sourceFiles(absolute);
    }
    return /\.(?:css|js|json|mjs|ts|tsx)$/u.test(entry.name) ? [absolute] : [];
  });
}

test("retired Kestrel One artwork and hawk sources stay removed", () => {
  for (const relative of retiredPaths) {
    assert.equal(existsSync(path.join(WEB_ROOT, relative)), false, relative);
  }

  const residue = /SharpShinnedHawk|AsciiHeroSolid|hawk-ascii|["']\/hawk(?:\/|["'])|["']\/logo\.svg["']|["']\/favicon\//u;
  for (const filename of sourceFiles(WEB_ROOT)) {
    if (filename === fileURLToPath(import.meta.url)) continue;
    assert.doesNotMatch(readFileSync(filename, "utf8"), residue, filename);
  }
});

test("social metadata defaults to the approved card and honors deployment precedence", () => {
  assert.equal(
    resolveSocialImages(undefined, null),
    "/brand/kestrel-one-social-card.png"
  );
  assert.equal(resolveSocialImages("/route.png", null), "/route.png");
  assert.equal(
    resolveSocialImages("/route.png", "https://cdn.example.com/brand.png"),
    "https://cdn.example.com/brand.png"
  );

  const metadata = createMetadata({ title: "Kestrel One" });
  if (!process.env.NEXT_PUBLIC_OG_IMAGE_URL) {
    assert.equal(
      metadata.openGraph?.images,
      "/brand/kestrel-one-social-card.png"
    );
    assert.equal(
      metadata.twitter?.images,
      "/brand/kestrel-one-social-card.png"
    );
  }
});

import assert from "node:assert/strict";

const baseUrlArgument = process.argv.slice(2).find((argument) => argument !== "--") ?? process.env.DOCS_BASE_URL;

if (!baseUrlArgument) {
  throw new Error("Pass a deployment URL: pnpm run docs:smoke -- https://example.vercel.app");
}

const baseUrl = new URL(baseUrlArgument);
const protectionBypass = process.env.VERCEL_PROTECTION_BYPASS;

async function fetchPage(pathname: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (protectionBypass) {
    headers.set("x-vercel-protection-bypass", protectionBypass);
  }
  const response = await fetch(new URL(pathname, baseUrl), { ...init, headers });
  return response;
}

const publicRoutes = [
  "/",
  "/start",
  "/desktop",
  "/kestrel-one",
  "/build",
  "/operate",
  "/reference",
  "/sitemap.xml",
  "/robots.txt",
  "/search-index.json",
  "/brand/kestrel-mark.png",
];

for (const pathname of publicRoutes) {
  const response = await fetchPage(pathname);
  assert.equal(response.status, 200, `${pathname} returned ${response.status}`);
}

const homeHtml = await (await fetchPage("/")).text();
if (homeHtml.includes("Vercel Security Checkpoint")) {
  throw new Error("The preview is protected. Set VERCEL_PROTECTION_BYPASS or verify it with `vercel curl`.");
}
assert.match(homeHtml, /Kestrel Docs/u);
assert.doesNotMatch(homeHtml, /Kestrel Studio|\/studio(?:["/]|$)/iu);

const searchIndex = await (await fetchPage("/search-index.json")).json() as {
  initialResults?: Array<{ url?: string }>;
};
assert.ok(Array.isArray(searchIndex.initialResults), "search-index.json has no initialResults array");

const redirects = [
  ["/apps/desktop", "/desktop"],
  ["/apps/web", "/kestrel-one"],
  ["/deploy", "/operate"],
] as const;

for (const [source, destination] of redirects) {
  const response = await fetchPage(source, { redirect: "manual" });
  assert.ok([301, 308].includes(response.status), `${source} returned ${response.status}`);
  assert.equal(new URL(response.headers.get("location") ?? "", baseUrl).pathname, destination);
}

for (const pathname of ["/studio", "/archive", "/internal"]) {
  const response = await fetchPage(pathname, { redirect: "manual" });
  assert.equal(response.status, 404, `${pathname} should not be public`);
}

console.log(`Verified Kestrel Docs deployment at ${baseUrl.origin}`);

import fs from "node:fs";
import path from "node:path";

export const REPO_NAME = "kestrel";
export const REPO_HTTP_URL = "https://github.com/LumiCorp/kestrel";
export const REPO_BLOB_BASE_URL = `${REPO_HTTP_URL}/blob/main`;
export const REPO_TREE_BASE_URL = `${REPO_HTTP_URL}/tree/main`;

export const SITE_TITLE = "Kestrel Docs";
export const SITE_DESCRIPTION =
  "Use Kestrel Desktop or build durable agents you can inspect, steer, and replay.";
export const SITE_ORIGIN = "https://docs.kestrelagents.dev";
export const SITE_URL = new URL(SITE_ORIGIN);

export function resolveDocsAppRootFrom(cwd: string, hasContent = (candidate: string) => fs.existsSync(path.join(candidate, "content"))) {
  if (hasContent(cwd)) {
    return cwd;
  }

  const nestedDocsRoot = path.join(cwd, "apps", "docs");
  if (hasContent(nestedDocsRoot)) {
    return nestedDocsRoot;
  }

  const docsSuffix = path.join("apps", "docs");
  return cwd.endsWith(docsSuffix) ? cwd : nestedDocsRoot;
}

export function resolveDocsAppRoot() {
  return resolveDocsAppRootFrom(process.cwd());
}

export function resolveRepoRoot() {
  const docsRoot = resolveDocsAppRoot();
  return path.resolve(docsRoot, "..", "..");
}

export function normalizePathForUrl(value: string) {
  return value.split(path.sep).join(path.posix.sep);
}

export function createPageUrl(slug: string[]) {
  return slug.length === 0 ? "/" : `/${slug.join("/")}`;
}

export function getSectionTitle(section: string) {
  switch (section) {
    case "home":
      return "Home";
    case "docs":
      return "Docs";
    case "build":
      return "Build";
    case "deploy":
      return "Deploy";
    case "apps":
      return "Apps";
    case "packages":
      return "Packages";
    case "cli":
      return "CLI";
    case "runtime":
      return "Runtime";
    case "operations":
      return "Operations";
    case "reference":
      return "Reference";
    case "archive":
      return "Archive";
    default:
      return section;
  }
}

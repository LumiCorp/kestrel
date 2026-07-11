import path from "node:path";

export const REPO_NAME = "kestrel";
export const REPO_HTTP_URL = "https://github.com/LumiCorp/kestrel";
export const REPO_BLOB_BASE_URL = `${REPO_HTTP_URL}/blob/main`;
export const REPO_TREE_BASE_URL = `${REPO_HTTP_URL}/tree/main`;

export const SITE_TITLE = "Kestrel Docs";
export const SITE_DESCRIPTION =
  "Editorial documentation for the Kestrel Suite, led by Kestrel Desktop and supported by companion surfaces, packages, and runtime operations.";

export function resolveDocsAppRoot() {
  const cwd = process.cwd();
  const docsSuffix = path.join("apps", "docs");
  return cwd.endsWith(docsSuffix) ? cwd : path.join(cwd, docsSuffix);
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

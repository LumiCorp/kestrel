import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST,
  PRIMARY_KESTREL_ONE_NAVIGATION_ROUTES,
} from "../route-ownership.manifest";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(testRoot, "..");
const packageRoot = path.resolve(appRoot, "..");

function listRouteFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listRouteFiles(absolutePath));
      continue;
    }

    if (
      entry.isFile() &&
      (entry.name === "page.tsx" || entry.name === "route.ts")
    ) {
      files.push(
        path.relative(packageRoot, absolutePath).replaceAll(path.sep, "/")
      );
    }
  }
  return files.sort();
}

function readAppFile(file: string) {
  return fs.readFileSync(path.join(packageRoot, file), "utf8");
}

function readRouteGuardSource(file: string) {
  const source = readAppFile(file);
  const sharedRoute = source.match(/from "@\/(app\/api\/mobile\/v1\/.+\/route)"/u)?.[1];
  return sharedRoute ? `${source}\n${readAppFile(`${sharedRoute}.ts`)}` : source;
}

test("Kestrel-One route ownership manifest classifies every page and API route", () => {
  const actualFiles = listRouteFiles(appRoot);
  const manifestFiles = KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST.map(
    (entry) => entry.file
  ).sort();

  assert.deepEqual(manifestFiles, actualFiles);
  assert.equal(new Set(manifestFiles).size, manifestFiles.length);
});

test("Kestrel-One route ownership manifest assigns one owner per route", () => {
  const routeOwners = KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST.map(
    (entry) => `${entry.kind}:${entry.route}`
  );

  assert.equal(new Set(routeOwners).size, routeOwners.length);
});

test("Kestrel-One primary navigation routes require an authenticated shell", () => {
  assert.deepEqual(
    PRIMARY_KESTREL_ONE_NAVIGATION_ROUTES.map((entry) => entry.route).sort(),
    ["/", "/admin", "/apps", "/dashboard", "/knowledge"]
  );

  for (const entry of PRIMARY_KESTREL_ONE_NAVIGATION_ROUTES) {
    assert.notEqual(entry.access, "public");
    assert.notEqual(entry.unauthorized, "public");
  }
});

test("Kestrel-One manifest keeps all required route classes visible", () => {
  const classes = new Set(
    KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST.map((entry) => entry.access)
  );

  assert.deepEqual([...classes].sort(), [
    "admin",
    "authenticated",
    "dev-only",
    "public",
    "service-boundary",
    "tool-boundary",
    "webhook",
  ]);
});

test("Kestrel-One API route classes have matching app-boundary guards", () => {
  for (const entry of KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST) {
    if (entry.kind !== "api") {
      continue;
    }

    const source = readRouteGuardSource(entry.file);

    if (entry.access === "admin") {
      assert.match(
        source,
        /\brequire(?:Admin(?:Organization)?|OrganizationAdmin)\b/,
        `${entry.file} must reject non-admin users`
      );
      continue;
    }

    if (entry.access === "authenticated") {
      assert.match(
        source,
        /\brequire(?:ActiveOrganization|Session)\b/,
        `${entry.file} must reject unauthenticated callers`
      );
      continue;
    }

    if (entry.access === "dev-only") {
      assert.match(
        source,
        /\bisLocalDevAuthBypassEnabled\b/,
        `${entry.file} must stay unavailable outside local dev bypass`
      );
      continue;
    }

    if (entry.access === "tool-boundary") {
      assert.match(
        source,
        /\bparseRunnerKnowledgeCapabilityRequest\b/,
        `${entry.file} must validate runner bearer capability calls`
      );
      assert.match(
        source,
        /\brequireActiveOrganization\b/,
        `${entry.file} must preserve session-backed app calls`
      );
      continue;
    }

    if (entry.access === "service-boundary") {
      assert.match(
        source,
        /\b(?:authorizeEnvironmentReconcileCron|authorizeWorkspaceIdleNotification|authorizeGatewayCredentialBroker|verifyEnvironmentExecutionTicket|verifyEnvironmentToolCredential|handleAppRuntimeRequest)\b/,
        `${entry.file} must validate its service credential`
      );
      continue;
    }

    if (entry.access === "webhook") {
      assert.match(
        source,
        /\bparamsSchema\b/,
        `${entry.file} must validate platform`
      );
      assert.match(source, /\bhandle(?:Discord|GitHub)Webhook\b/);
    }
  }
});

test("Kestrel-One protected page classes are covered by guarded layouts", () => {
  const workspaceLayout = readAppFile("app/(workspace)/layout.tsx");
  const dashboardLayout = readAppFile("app/dashboard/layout.tsx");
  const knowledgeLayout = readAppFile("app/knowledge/layout.tsx");
  const adminLayout = readAppFile("app/admin/layout.tsx");
  const debugLayout = readAppFile("app/debug/layout.tsx");

  assert.match(workspaceLayout, /redirect\("\/sign-in"\)/);
  assert.match(dashboardLayout, /\brequireAuthenticatedShell\b/);
  assert.match(knowledgeLayout, /\brequireActiveOrganization:\s*true\b/);
  assert.match(adminLayout, /\brequireAdmin:\s*true\b/);
  assert.match(debugLayout, /\brequireAdmin:\s*true\b/);

  const protectedPages = KESTREL_ONE_ROUTE_OWNERSHIP_MANIFEST.filter(
    (entry) => entry.kind === "page" && entry.access !== "public"
  );

  for (const entry of protectedPages) {
    assert.notEqual(entry.unauthorized, "public", entry.file);
  }
});

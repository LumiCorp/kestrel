import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contractTest } from "../../../../tests/helpers/contract-test.js";


const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const workspaceRuntimeRoot = path.resolve(webRoot, "../workspace-runtime");

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (![".next", "dist", "node_modules"].includes(entry.name)) {
        files.push(...listTypeScriptFiles(absolute));
      }
    } else if (entry.isFile() && /\.(ts|tsx)$/u.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files.sort();
}

contractTest("web.hermetic", "Better Auth encrypts linked GitHub OAuth tokens at rest", () => {
  const authSource = fs.readFileSync(path.join(webRoot, "lib/auth.ts"), "utf8");
  assert.match(authSource, /account:\s*\{[\s\S]*encryptOAuthTokens:\s*true/u);
  assert.match(authSource, /disableImplicitLinking:\s*true/u);
  assert.match(authSource, /github:[\s\S]*disableImplicitSignUp:\s*true/u);
});

contractTest("web.hermetic", "linked App OAuth tokens remain inside Kestrel One broker routes", () => {
  const accessTokenConsumers = listTypeScriptFiles(webRoot)
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) =>
      fs.readFileSync(file, "utf8").includes("auth.api.getAccessToken")
    )
    .map((file) => path.relative(webRoot, file).replaceAll(path.sep, "/"));
  assert.deepEqual(accessTokenConsumers, [
    "app/api/apps/github/sync/route.ts",
    "app/api/projects/[id]/apps/google/sync/route.ts",
    "app/api/runtime/github/action/route.ts",
    "app/api/runtime/github/git/[resourceId]/[...gitPath]/route.ts",
    "app/api/runtime/github/push/route.ts",
    "app/api/runtime/google-calendar/action/route.ts",
    "app/api/runtime/microsoft-365/action/route.ts",
  ]);

  const workspaceRuntimeSource = listTypeScriptFiles(workspaceRuntimeRoot)
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(workspaceRuntimeSource, /accessToken/u);
  assert.doesNotMatch(workspaceRuntimeSource, /KESTREL_GITHUB_TOKEN/u);
});

contractTest("web.hermetic", "Workspace Git traffic exchanges the broad execution ticket before use", () => {
  const source = fs.readFileSync(
    path.join(workspaceRuntimeRoot, "src/server.ts"),
    "utf8"
  );
  assert.match(source, /requestGitHubToolCredential/u);
  assert.match(source, /operation:\s*"git\.upload_pack"/u);
  assert.match(source, /operation:\s*"repository\.push_agent_branch"/u);
  assert.doesNotMatch(
    source,
    /GIT_CONFIG_VALUE_0:\s*`Authorization:\s*\$\{authorization\}`/u
  );

  for (const route of [
    "app/api/runtime/github/git/[resourceId]/[...gitPath]/route.ts",
    "app/api/runtime/github/push/route.ts",
  ]) {
    const routeSource = fs.readFileSync(path.join(webRoot, route), "utf8");
    assert.match(routeSource, /verifyEnvironmentToolCredential/u);
    assert.doesNotMatch(routeSource, /verifyEnvironmentExecutionTicket/u);
  }

  const exchangeSource = fs.readFileSync(
    path.join(webRoot, "app/api/runtime/github/credentials/route.ts"),
    "utf8"
  );
  assert.match(exchangeSource, /verifyEnvironmentExecutionTicket/u);
  assert.doesNotMatch(exchangeSource, /auth\.api\.getAccessToken/u);
});

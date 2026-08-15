import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function read(relativePath: string) {
  return fs.readFileSync(path.join(webRoot, relativePath), "utf8");
}

test("Platform Runtime and Billing lead with the next operational decision", () => {
  const runtime = read(
    "app/(workspace)/platform/runtime/runtime-channel-client.tsx",
  );
  const billing = read("app/(workspace)/platform/billing/page.tsx");

  assert.match(runtime, /title="Production channel"/u);
  assert.match(runtime, /Pointer promotion changes the default/u);
  assert.match(runtime, /Current version/u);
  assert.match(runtime, /Previous version/u);
  assert.doesNotMatch(runtime, /\bCard\b/u);

  assert.match(billing, /Billing integration is ready/u);
  assert.match(billing, /Required action/u);
  assert.match(billing, /title="Technical details"/u);
  assert.doesNotMatch(billing, /\bCard\b/u);
});

test("Platform Docs use grouped navigation and a readable anchored document", () => {
  const index = read("app/(workspace)/platform/docs/page.tsx");
  const detail = read("app/(workspace)/platform/docs/[slug]/page.tsx");
  const renderer = read("components/admin/admin-doc-content.tsx");
  const docs = read("lib/admin/docs.ts");

  assert.match(index, /\["Start", "Operate", "Integrate"\]/u);
  assert.doesNotMatch(index, /\bCard\b/u);
  assert.match(detail, /max-w-\[75ch\]/u);
  assert.match(detail, /aria-label="Breadcrumb"/u);
  assert.match(renderer, /href=\{`#\$\{id\}`\}/u);
  assert.match(docs, /replace\(\/\^#\\s\+/u);
});

test("Dashboard prioritizes four decision metrics and one compact range control", () => {
  const dashboard = read("app/dashboard/page.tsx");
  const range = read("app/dashboard/dashboard-range-select.tsx");

  assert.match(dashboard, /label="Attributed operating cost"/u);
  assert.match(dashboard, /label="Runs"/u);
  assert.match(dashboard, /label="Failed"/u);
  assert.match(dashboard, /label="Active members"/u);
  assert.doesNotMatch(dashboard, /label="Completed"/u);
  assert.doesNotMatch(dashboard, /label="Model tokens"/u);
  assert.match(range, /aria-label="Reporting range"/u);
  assert.match(dashboard, /Review pricing/u);
});

test("Public and focused flows use quiet narrow decision frames", () => {
  const shared = read("app/shared/[token]/page.tsx");
  const welcome = read("app/(workspace)/welcome/page.tsx");
  const invitation = read("app/accept-invitation/[id]/page.tsx");
  const desktop = read(
    "app/desktop/enroll/[id]/desktop-enrollment-approval.tsx",
  );
  const workspaceSetup = read(
    "app/(workspace)/threads/[id]/workspace/standalone-workspace-setup.tsx",
  );

  assert.match(shared, /max-w-3xl/u);
  assert.match(shared, /SharedTranscriptMessage/u);
  assert.doesNotMatch(shared, /\bCard\b/u);
  assert.doesNotMatch(welcome, /WelcomeWorkspaceSwitcher/u);
  assert.doesNotMatch(welcome, /\bCard\b/u);
  assert.doesNotMatch(invitation, /radial-gradient/u);
  assert.match(invitation, /<InvitationFact/u);
  assert.match(invitation, /<h1/u);
  assert.match(desktop, /Show full/u);
  assert.match(desktop, /copyFingerprint/u);
  assert.match(workspaceSetup, /max-w-xl/u);
  assert.doesNotMatch(workspaceSetup, /\bCard\b/u);
});

test("Immersive Thread and Workspace controls remain compact and responsive", () => {
  const header = read("components/chatbot/chat-header.tsx");
  const workspace = read(
    "app/(workspace)/threads/[id]/workspace/workspace-client.tsx",
  );

  assert.match(header, /aria-label="Thread actions"/u);
  assert.match(header, /aria-label="Open Thread workspace"/u);
  assert.match(header, /VisibilityMenuSub/u);
  assert.doesNotMatch(header, /VisibilitySelector/u);
  assert.match(workspace, /mobilePane/u);
  assert.match(workspace, /<h1 className="font-medium">Workspace<\/h1>/u);
  assert.match(workspace, /aria-pressed=\{filesOpen\}/u);
  assert.match(workspace, /aria-pressed=\{candidatesOpen\}/u);
  assert.match(workspace, /aria-pressed=\{terminalPanelOpen\}/u);
  assert.match(workspace, /Add application/u);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readAppSource(relativePath: string) {
  return fs.readFileSync(path.join(appRoot, relativePath), "utf8");
}

function sourceBetween(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.ok(startIndex >= 0, `Missing source boundary: ${start}`);
  assert.ok(endIndex > startIndex, `Missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("retained reasoning requires confirmation and preserves failed deletion state", () => {
  const source = readAppSource(
    "app/(workspace)/settings/environments/[id]/activity/retained-reasoning-inspector.tsx",
  );
  const removeAction = sourceBetween(
    source,
    "async function remove()",
    "return (",
  );
  const trigger = sourceBetween(
    source,
    "{entries && entries.length > 0 ? (",
    "{status ?",
  );

  assert.match(trigger, /setDeleteDialogOpen\(true\)/u);
  assert.doesNotMatch(trigger, /onClick=\{remove\}/u);
  assert.match(source, /<AlertDialog[\s\S]*open=\{deleteDialogOpen\}/u);
  assert.match(source, /Delete retained reasoning for this run\?/u);
  assert.match(source, /<AlertDialogCancel disabled=\{deleteBusy\}>/u);
  assert.match(source, /role="alert"[\s\S]*\{deleteError\}/u);

  assert.match(removeAction, /setDeleteBusy\(true\)/u);
  assert.match(
    removeAction,
    /if \(!response\.ok\) \{[\s\S]*setDeleteError\([\s\S]*return;[\s\S]*\}[\s\S]*setEntries\(\[\]\)/u,
  );
  assert.match(removeAction, /catch \{[\s\S]*setDeleteError/u);
  assert.match(removeAction, /finally \{[\s\S]*setDeleteBusy\(false\)/u);
  assert.match(removeAction, /setDeleteDialogOpen\(false\)/u);
});

test("Project member removal requires confirmation and keeps failures actionable", () => {
  const source = readAppSource(
    "components/projects/project-home-client.tsx",
  );
  const removeAction = sourceBetween(
    source,
    "async function removeMember()",
    "async function setArchived",
  );
  const memberRow = sourceBetween(
    source,
    "aria-label={`Remove ${member.name}`}",
    "</Button>",
  );

  assert.match(memberRow, /setMemberRemoval\(member\)/u);
  assert.match(
    memberRow,
    /memberRemovalTriggerRef\.current\s*=\s*event\.currentTarget/u,
  );
  assert.doesNotMatch(memberRow, /removeMember\(/u);
  assert.match(source, /open=\{Boolean\(memberRemoval\)\}/u);
  assert.match(source, /onCloseAutoFocus=\{\(event\) =>/u);
  assert.match(source, /trigger\?\.isConnected/u);
  assert.match(source, /membersFallbackFocusRef\.current/u);
  assert.match(source, /Remove \{memberRemoval\?\.name\} from this Project\?/u);
  assert.match(source, /<AlertDialogCancel disabled=\{memberRemovalBusy\}>/u);
  assert.match(source, /role="alert"[\s\S]*\{memberRemovalError\}/u);

  assert.match(removeAction, /setMemberRemovalBusy\(true\)/u);
  assert.match(
    removeAction,
    /if \(!response\.ok\) \{[\s\S]*setMemberRemovalError\([\s\S]*return;[\s\S]*\}[\s\S]*setMembers/u,
  );
  assert.match(removeAction, /catch \{[\s\S]*setMemberRemovalError/u);
  assert.match(
    removeAction,
    /finally \{[\s\S]*setMemberRemovalBusy\(false\)/u,
  );
  assert.match(removeAction, /setMemberRemoval\(null\)/u);
});

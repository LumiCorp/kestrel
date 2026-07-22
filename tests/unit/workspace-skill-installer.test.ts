import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { contractTest } from "../helpers/contract-test.js";
import {
  parseSkillManifest,
  materializeWorkspaceSkillSnapshot,
  validateWorkspaceSkillPackage,
  validateWorkspaceSkillSource,
  WorkspaceSkillInstaller,
  WorkspaceSkillManager,
} from "../../src/skills/index.js";

const execFileAsync = promisify(execFile);

contractTest("runtime.hermetic", "workspace skill source accepts only public credential-free HTTPS Git URLs", async () => {
  assert.deepEqual(
    await validateWorkspaceSkillSource(
      { gitUrl: "https://git.example/acme/skills.git", branch: "main", path: "skills/review" },
      async () => ["93.184.216.34"],
    ),
    {
      gitUrl: "https://git.example/acme/skills.git",
      branch: "main",
      path: "skills/review",
      resolution: { hostname: "git.example", address: "93.184.216.34" },
    },
  );
  assert.deepEqual(
    await validateWorkspaceSkillSource(
      { gitUrl: "https://[2606:4700:4700::1111]/acme/skills.git", branch: "main" },
      async (hostname) => hostname === "2606:4700:4700::1111" ? [hostname] : [],
    ),
    {
      gitUrl: "https://[2606:4700:4700::1111]/acme/skills.git",
      branch: "main",
      resolution: { hostname: "2606:4700:4700::1111", address: "2606:4700:4700::1111" },
    },
  );
  await assert.rejects(
    validateWorkspaceSkillSource(
      { gitUrl: "https://user:secret@git.example/acme/skills.git", branch: "main" },
      async () => ["93.184.216.34"],
    ),
    /without credentials/u,
  );
  await assert.rejects(
    validateWorkspaceSkillSource(
      { gitUrl: "https://git.example/acme/skills.git", branch: "main" },
      async () => ["127.0.0.1"],
    ),
    /public network/u,
  );
  for (const address of ["192.0.2.10", "198.51.100.20", "203.0.113.30", "::ffff:127.0.0.1", "2001:db8::1"]) {
    await assert.rejects(
      validateWorkspaceSkillSource(
        { gitUrl: "https://git.example/acme/skills.git", branch: "main" },
        async () => [address],
      ),
      /public network/u,
    );
  }
  await assert.rejects(
    validateWorkspaceSkillSource(
      { gitUrl: "https://git.example/acme/skills.git", branch: "main", path: "../escape" },
      async () => ["93.184.216.34"],
    ),
    /repository-relative/u,
  );
});

contractTest("runtime.hermetic", "workspace skill manifest uses standard YAML frontmatter", () => {
  assert.deepEqual(parseSkillManifest("---\nname: code-review\ndescription: |\n  Review changes carefully.\n---\n\n# Review\n"), {
    name: "code-review",
    description: "Review changes carefully.",
  });
  assert.throws(() => parseSkillManifest("# Missing frontmatter\n"), /YAML frontmatter/u);
  assert.throws(() => parseSkillManifest("---\nname: Bad Name\ndescription: nope\n---\n"), /lowercase hyphenated/u);
});

contractTest("runtime.hermetic", "workspace skill package rejects symbolic links", async () => {
  const root = await fixtureRoot("skill-links-");
  await writeFile(path.join(root, "SKILL.md"), skillFile("linked"));
  await writeFile(path.join(root, "target.txt"), "target");
  await symlink(path.join(root, "target.txt"), path.join(root, "linked.txt"));
  await assert.rejects(validateWorkspaceSkillPackage(root), /symbolic links/u);
});

contractTest("runtime.hermetic", "workspace skill sync publishes immutable revisions and retains last good content", async () => {
  const workspaceRoot = await fixtureRoot("skill-workspace-");
  let commit = "a".repeat(40);
  let fail = false;
  let fetchResolution: { hostname: string; address: string } | undefined;
  const installer = new WorkspaceSkillInstaller({
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    resolveHost: async () => ["93.184.216.34"],
    runGit: async ({ args, cwd, resolve }) => {
      if (fail) throw new Error("remote unavailable\nwith noisy details");
      if (args[0] === "fetch") fetchResolution = resolve;
      if (args[0] === "rev-parse") return `${commit}\n`;
      if (args[0] === "checkout") {
        await writeFile(path.join(cwd!, "SKILL.md"), skillFile("workspace-review"));
        await mkdir(path.join(cwd!, "scripts"));
        await writeFile(path.join(cwd!, "scripts", "review.sh"), "#!/bin/sh\nexit 0\n");
        await chmod(path.join(cwd!, "scripts", "review.sh"), 0o755);
      }
      return "";
    },
  });
  const source = { gitUrl: "https://git.example/acme/skills.git", branch: "main" };
  const first = await installer.sync({ workspaceRoot, installationId: "review", source });
  assert.equal(first.status, "ready");
  assert.equal(first.changed, true);
  assert.equal(first.revision?.commitSha, commit);
  assert.deepEqual(fetchResolution, { hostname: "git.example", address: "93.184.216.34" });
  assert.match(first.revision?.contentDigest ?? "", /^sha256:/u);
  assert.equal(await readFile(path.join(workspaceRoot, first.revision!.skillFile), "utf8"), skillFile("workspace-review"));

  fail = true;
  const stale = await installer.sync({ workspaceRoot, installationId: "review", source });
  assert.equal(stale.status, "stale");
  assert.equal(stale.revision?.commitSha, commit);
  assert.equal(stale.error, "remote unavailable with noisy details");
  assert.deepEqual(await installer.readCatalog(workspaceRoot, ["review"]), [{
    installationId: "review",
    name: "workspace-review",
    description: "Test workspace skill.",
    commitSha: commit,
    contentDigest: first.revision?.contentDigest,
    skillFile: first.revision?.skillFile,
  }]);
  assert.equal((await installer.readWorkspaceCatalog(workspaceRoot))[0]?.name, "workspace-review");
});

contractTest("runtime.hermetic", "workspace skill sync repairs a tampered immutable revision before reuse", async () => {
  const workspaceRoot = await fixtureRoot("skill-integrity-");
  let checkoutCount = 0;
  const commit = "c".repeat(40);
  const installer = new WorkspaceSkillInstaller({
    resolveHost: async () => ["93.184.216.34"],
    runGit: async ({ args, cwd }) => {
      if (args[0] === "rev-parse") return `${commit}\n`;
      if (args[0] === "checkout") {
        checkoutCount += 1;
        await writeFile(path.join(cwd!, "SKILL.md"), skillFile("integrity-skill"));
      }
      return "";
    },
  });
  const source = { gitUrl: "https://git.example/acme/integrity.git", branch: "main" };
  const first = await installer.sync({ workspaceRoot, installationId: "integrity", source });
  await writeFile(path.join(workspaceRoot, first.revision!.skillFile), `${skillFile("integrity-skill")}\nTampered.\n`);
  await assert.rejects(installer.readCatalog(workspaceRoot, ["integrity"]), /integrity validation/u);
  const repaired = await installer.sync({ workspaceRoot, installationId: "integrity", source });
  assert.equal(repaired.status, "ready");
  assert.equal(repaired.changed, true);
  assert.equal(checkoutCount, 2);
  assert.equal(await readFile(path.join(workspaceRoot, repaired.revision!.skillFile), "utf8"), skillFile("integrity-skill"));
});

contractTest("runtime.hermetic", "workspace skill manager persists authoritative installation readiness", async () => {
  const workspaceRoot = await fixtureRoot("skill-manager-");
  const installer = new WorkspaceSkillInstaller({
    now: () => new Date("2026-07-21T12:00:00.000Z"),
    resolveHost: async () => ["93.184.216.34"],
    runGit: async ({ args, cwd }) => {
      if (args[0] === "rev-parse") return `${"b".repeat(40)}\n`;
      if (args[0] === "checkout") await writeFile(path.join(cwd!, "SKILL.md"), skillFile("managed-skill"));
      return "";
    },
  });
  const manager = new WorkspaceSkillManager(
    { workspaceId: "workspace-1", workspaceRoot },
    { installer, now: () => new Date("2026-07-21T12:00:00.000Z") },
  );
  const installed = await manager.install({ gitUrl: "https://git.example/acme/skill.git", branch: "main" });
  assert.equal(installed.status, "ready");
  assert.equal(installed.revision?.name, "managed-skill");
  assert.equal((await manager.list())[0]?.installationId, installed.installationId);

  await manager.updateSource(installed.installationId, {
    gitUrl: "https://git.example/acme/skill.git",
    branch: "next",
  });
  assert.equal((await manager.list())[0]?.status, "ready");
  assert.equal((await manager.syncAll())[0]?.status, "ready");
  await manager.remove(installed.installationId);
  assert.deepEqual(await manager.list(), []);
});

contractTest("runtime.hermetic", "workspace skill changes remain pending until the workspace is idle", async () => {
  const workspaceRoot = await fixtureRoot("skill-idle-");
  let idle = false;
  let gitCalls = 0;
  const installer = new WorkspaceSkillInstaller({
    resolveHost: async () => ["93.184.216.34"],
    runGit: async () => { gitCalls += 1; return ""; },
  });
  const manager = new WorkspaceSkillManager(
    { workspaceId: "workspace-idle", workspaceRoot },
    { installer, isWorkspaceIdle: async () => idle },
  );
  const pending = await manager.install({ gitUrl: "https://git.example/acme/pending.git", branch: "main" });
  assert.equal(pending.status, "pending");
  assert.equal(gitCalls, 0);
  await manager.remove(pending.installationId);
  assert.equal((await manager.list())[0]?.status, "removal_pending");
  idle = true;
  assert.deepEqual(await manager.syncAll(), []);
  assert.deepEqual(await manager.list(), []);
});

contractTest("runtime.hermetic", "managed worktree skill snapshots stay outside source-control evidence", async () => {
  const sourceWorkspaceRoot = await fixtureRoot("skill-source-");
  const targetWorkspaceRoot = await fixtureRoot("skill-target-");
  const commit = "d".repeat(40);
  const installer = new WorkspaceSkillInstaller({
    resolveHost: async () => ["93.184.216.34"],
    runGit: async ({ args, cwd }) => {
      if (args[0] === "rev-parse") return `${commit}\n`;
      if (args[0] === "checkout") await writeFile(path.join(cwd!, "SKILL.md"), skillFile("snapshot-skill"));
      return "";
    },
  });
  const synced = await installer.sync({
    workspaceRoot: sourceWorkspaceRoot,
    installationId: "snapshot",
    source: { gitUrl: "https://git.example/acme/snapshot.git", branch: "main" },
  });
  const catalog = await installer.readCatalog(sourceWorkspaceRoot, ["snapshot"]);
  await execFileAsync("git", ["init", "--quiet"], { cwd: targetWorkspaceRoot });
  await writeFile(path.join(targetWorkspaceRoot, ".gitignore"), ".kestrel/\n");
  await execFileAsync("git", ["add", ".gitignore"], { cwd: targetWorkspaceRoot });
  await execFileAsync("git", ["-c", "user.name=Kestrel Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: targetWorkspaceRoot });
  await materializeWorkspaceSkillSnapshot({ sourceWorkspaceRoot, targetWorkspaceRoot, catalog });
  assert.equal(await readFile(path.join(targetWorkspaceRoot, synced.revision!.skillFile), "utf8"), skillFile("snapshot-skill"));
  assert.deepEqual(await installer.readWorkspaceCatalog(targetWorkspaceRoot), catalog);
  assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: targetWorkspaceRoot })).stdout, "");
});

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: Test workspace skill.\n---\n\n# Instructions\n\nWork from evidence.\n`;
}

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), prefix)));
  return root;
}

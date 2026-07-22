---
id: workspace-skills
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-22
depends_on: [../packages/workspace-skills/src/index.ts, ../src/runtime/agent-context/runtimeContext.ts]
---

# Workspace skills

Workspace skills are portable instruction packages installed from a public,
credential-free HTTPS Git repository. A source selects a branch and may select
a repository-relative subdirectory. The selected directory must contain a
`SKILL.md` with YAML frontmatter fields `name` and `description`.

Desktop continues to manage skills in a project's **Agent skills** panel.
Kestrel One instead owns a canonical skill catalog for each Project. Members can
always view this catalog, and Project owners and editors can add, edit, remove,
or manually synchronize entries from the Project's **Skills** tab even when no
Workspace is available. Saved entries remain pending until they have a verified
revision; a failed refresh retains the previous verified revision as stale.

When a hosted Workspace is ready, Kestrel One reconciles its complete desired
catalog before the next eligible Project run. The reconciliation installs new
entries, updates changed sources, and removes entries no longer present. A busy
or temporarily unavailable Workspace defers activation without blocking chat;
new runs continue with the last verified canonical revisions, while removed
entries are omitted immediately. Manual **Sync** is an optional immediate retry.
The first successful Workspace connection imports legacy Workspace-local
installations before canonical reconciliation, so rollout does not erase
existing skills.

An installed revision is identified by its Git commit and SHA-256 content
digest. Save-time validation rejects non-HTTPS sources, credentials, custom
ports, invalid branches, and unsafe repository paths without contacting a
Workspace. The Workspace installer performs full DNS, public-address, Git,
package-shape, and `SKILL.md` validation. It also rejects redirects, links,
nested Git metadata, submodules, and non-public network targets, then publishes
the revision atomically under `.kestrel/skills`. Repository hooks are never run.
Workspace backups include the synchronized state.

At run start, Kestrel snapshots the verified skill catalog into runtime
metadata and agent context. The catalog is guidance, not authority: a skill
cannot add tools, widen filesystem access, grant credentials, or override
runtime policy. The agent must read the complete `SKILL.md`; Kestrel records
loaded provenance only after every page has been read contiguously at one file
revision and the installed package still matches the run's commit and digest.

Managed task worktrees receive the exact verified revisions from the source
workspace under their ignored `.kestrel` state. Skill files are never counted
as source changes or promotion evidence, and ordinary filesystem write tools
cannot mutate Kestrel-owned skill state.

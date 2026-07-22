---
id: workspace-skills
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-21
depends_on: [../packages/workspace-skills/src/index.ts, ../src/runtime/agent-context/runtimeContext.ts]
---

# Workspace skills

Workspace skills are portable instruction packages installed into one Kestrel
workspace from a public, credential-free HTTPS Git repository. A source selects
a branch and may select a repository-relative subdirectory. The selected
directory must contain a `SKILL.md` with YAML frontmatter fields `name` and
`description`.

Desktop exposes skill management in a project's **Agent skills** panel. Kestrel
One exposes the same controls in a running Project Workspace. Installations and
updates made during an active run remain pending until the workspace is idle.
Kestrel also checks configured branches at Desktop activation and hosted
workspace startup.

An installed revision is identified by its Git commit and SHA-256 content
digest. Kestrel validates package size and shape, rejects links, nested Git
metadata, submodules, credentials, redirects, and non-public network targets,
then publishes the revision atomically under `.kestrel/skills`. Failed refreshes
retain the last verified revision. Workspace backups include this state.

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

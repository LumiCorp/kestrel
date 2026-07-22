# @kestrel-agents/workspace-skills

Secure workspace-scoped installation and provenance for portable `SKILL.md`
packages used by Kestrel agents.

The package validates public HTTPS Git sources, publishes immutable revisions,
retains the last verified revision when refresh fails, and exposes the exact
commit and content digest used in a runtime turn. Installation does not execute
repository hooks or package code.

```bash
pnpm add @kestrel-agents/workspace-skills@0.6.0
```

```ts
import { WorkspaceSkillManager } from "@kestrel-agents/workspace-skills";

const skills = new WorkspaceSkillManager({
  workspaceId: "project-1",
  workspaceRoot: "/workspace/project-1",
});

await skills.install({
  gitUrl: "https://github.com/example/agent-skills.git",
  branch: "main",
  path: "skills/review",
});
```

Applications should provide `isWorkspaceIdle` when active runs can overlap
management requests. Kestrel treats installed skill text as guidance only; the
package does not grant tools, credentials, or filesystem authority.

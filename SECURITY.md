---
id: security-root
domain: ops
status: active
owner: kestrel-security
last_verified_at: 2026-06-30
depends_on:
  - ARCHITECTURE.md
  - docs/references/lint-invariants.md
  - docs/references/architecture-rules.json
---

# Security

Kestrel security is expressed as hard runtime and boundary constraints, then reinforced by contributor discipline and operator review. The repo is designed to make risky actions explicit rather than implicit.

## Reporting A Vulnerability

For the public open-source repo, use GitHub Security Advisories for private vulnerability disclosure.

- Do not file vulnerabilities as public GitHub Issues.
- Include reproduction details, affected surfaces, and any known impact boundaries.
- If the report involves Desktop, runner-service, workspace mutation, or tool execution, note that explicitly so triage starts at the right trust boundary.

Normal bugs, usage questions, and feature requests should go through the public support paths in [SUPPORT.md](https://github.com/LumiCorp/kestrel/blob/main/SUPPORT.md).

## Hard Constraints

- Unknown external input must be parsed or validated at boundaries before use.
- Architecture edges are constrained by the approved dependency rules in [docs/references/architecture-rules.json](https://github.com/LumiCorp/kestrel/blob/main/docs/references/architecture-rules.json).
- Tool execution is exposed through shared tool contracts rather than ad hoc capability access.
- High-risk policy, migration, or heuristic changes require explicit escalation under [AGENTS.md](https://github.com/LumiCorp/kestrel/blob/main/AGENTS.md).
- Runtime failures and operator-relevant events should use normalized machine-readable error shapes.

## Security-Critical Boundaries

### Runner service and app servers

Browsers should talk to an application server or controlled client surface, not hold runner credentials directly. The runner service is the authenticated boundary between external requests and runtime execution.

### Tool execution and workspace access

Filesystem, dev shell, internet, and code-execution capabilities must stay behind explicit tool definitions, allowlists, and policy-aware runtime handling. Workspace mutation should remain inspectable through logs, artifacts, and checkpoints.

### Provider credentials

Model-provider keys and runner-service credentials belong in server-side environment configuration. They should not be embedded in browser code, examples that imply browser ownership, or machine-global defaults without clear intent.

### Replay and audit data

Run logs, replay artifacts, checkpoints, and operator evidence are part of the security posture because they support incident reconstruction and accountability.

## Operator Responsibilities

- Use the documented runner-service and deploy/auth flows instead of inventing bypass paths.
- Treat new heuristics, fallback ranking, or policy shortcuts as security-relevant behavior changes that require explicit review.
- Validate docs and contract changes with `pnpm run governance:check` before merging.
- Review workspace and tool-surface changes for unintended write, network, or credential exposure.

## Source-of-Truth References

- Invariant index: [docs/references/lint-invariants.md](https://github.com/LumiCorp/kestrel/blob/main/docs/references/lint-invariants.md)
- Architecture rules: [docs/references/architecture-rules.json](https://github.com/LumiCorp/kestrel/blob/main/docs/references/architecture-rules.json)
- Operations security page: [apps/docs/content/operations/security.mdx](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/operations/security.mdx)
- Deploy auth guidance: [apps/docs/content/deploy/environment-and-auth.mdx](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/deploy/environment-and-auth.mdx)
- Contributor guidance: [CONTRIBUTING.md](https://github.com/LumiCorp/kestrel/blob/main/CONTRIBUTING.md)

## Read Next

- [ARCHITECTURE.md](https://github.com/LumiCorp/kestrel/blob/main/ARCHITECTURE.md)
- [docs/references/lint-invariants.md](https://github.com/LumiCorp/kestrel/blob/main/docs/references/lint-invariants.md)
- [apps/docs/content/operations/security.mdx](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/content/operations/security.mdx)

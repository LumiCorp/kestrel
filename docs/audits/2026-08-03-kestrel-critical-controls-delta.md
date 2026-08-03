# Kestrel Critical-Controls Delta Review

## Review status

This is a focused implementation delta dated 2026-08-03. It reviews only the
Docker code-execution isolation, external-effect approval integrity, bounded
storage, and critical-proof controls changed in this wave.

The [2026-07-30 200-point inspection](./2026-07-30-kestrel-agent-harness-200-point-inspection.md)
remains the historical audit record. This review does not rescore that audit,
change its `132.5 / 200` result, or claim a new overall readiness band.

## Delta conclusion

The code-mode Docker boundary no longer exposes a bind-mounted host workspace.
Each execution uses a named, non-root, read-only-root container with separately
bounded `/workspace` and `/tmp` tmpfs filesystems. Inputs enter through a
temporary staging copy, output is frozen with `docker pause`, and artifacts are
read only from a copied host snapshot. Because Docker's archive API cannot read
tmpfs mounts, staged inputs and eligible regular artifact files are streamed
through fixed-UID container processes. Cleanup owns every terminal path.

Executable external-effect approvals now use one strict protocol binding. The
binding fixes the approval, Thread, run, action, canonical payload hash,
contract-derived capability, authority kind and revision, request time, and
expiry. Runtime callers cannot choose grant capabilities. Hosted MCP execution
atomically consumes the exact action-bound grant once; hosted App execution
retains its tenant and resource checks and additionally recomputes the effective
App-policy digest before consumption.

The affected migration paths fail closed. Legacy active Runtime grants without
a valid binding are expired. Legacy pending or approved hosted App operations
without an authority revision are expired, while historical denied, expired,
and consumed records are retained.

## Control delta

| Area | Prior observed gap | Implemented control | Evidence |
|---|---|---|---|
| Docker filesystem isolation | Code execution used a host bind mount and root-equivalent container defaults. | Fixed UID/GID `65532:65532`, read-only root, dropped capabilities, `no-new-privileges`, no host bind mount, non-root input streaming, freezer barrier and quiesced snapshot, unconditional removal. | [`src/code/DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts), [`tests/process/docker-sandbox.process.test.ts`](../../tests/process/docker-sandbox.process.test.ts) |
| Storage bounds | Memory and PID controls did not bound workspace or temporary-file bytes and inodes. | Required applied quotas with defaults of 64 MB/8,192 inodes for `/workspace` and 32 MB/2,048 inodes for `/tmp`; profile values are positive integers and sizes cannot exceed effective container memory. | [`src/code/contracts.ts`](../../src/code/contracts.ts), [`src/code/PolicyEngine.ts`](../../src/code/PolicyEngine.ts), [`cli/config/ProfileStore.ts`](../../cli/config/ProfileStore.ts), [`tests/unit/code-policy-engine.test.ts`](../../tests/unit/code-policy-engine.test.ts) |
| Timeout and cancellation | One-shot execution could not freeze artifact writers before collection. | Timeout attempts pause and snapshot before removal; cancellation removes immediately and returns no partial result; artifacts ignore symlinks and non-regular files. | [`src/code/DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts), [`tests/process/docker-sandbox.process.test.ts`](../../tests/process/docker-sandbox.process.test.ts) |
| Approval contract | Local and hosted approval records did not share exact action, payload, actor, expiry, and authority-revision semantics. | `RunnerExternalApprovalBindingV1` provides strict parsing and canonical payload serialization. Reference-agent waits preserve the exact validated tool action and immutable authority revision. | [`packages/protocol/src/approvals.ts`](../../packages/protocol/src/approvals.ts), [`agents/reference-react/src/steps/acter/policyGates.ts`](../../agents/reference-react/src/steps/acter/policyGates.ts), [`src/orchestration/InteractionManager.ts`](../../src/orchestration/InteractionManager.ts) |
| Caller authority | Operator replies could select allowed tool classes or capabilities. | Legacy fields are rejected at the Runner protocol boundary and removed from CLI, Runtime, Web, and Desktop-facing contracts. Grant projections are derived only from the pending tool contract. | [`packages/protocol/src/execution.ts`](../../packages/protocol/src/execution.ts), [`cli/runner/CommandRouter.ts`](../../cli/runner/CommandRouter.ts), [`tests/unit/runtime-shell-seams.test.ts`](../../tests/unit/runtime-shell-seams.test.ts) |
| MCP single use | Approval lookup was Thread-wide and reusable. | One atomic update matches Thread, action key, canonical arguments hash, `mcp.invoke`, hosted grant revision, active state, and expiry, then changes the winner to `CONSUMED`. | [`apps/mcp-service/src/approval-authorizer.ts`](../../apps/mcp-service/src/approval-authorizer.ts), [`apps/mcp-service/tests/approval-authorizer.postgres.test.ts`](../../apps/mcp-service/tests/approval-authorizer.postgres.test.ts) |
| Hosted App policy binding | Resource-bound approvals did not invalidate when the effective App policy changed. | Request records carry the shared binding and effective policy digest; consumption recomputes policy while retaining organization, environment, workspace, actor, connection, resource, operation, and payload checks. | [`apps/web/lib/apps/app-operation-approvals.ts`](../../apps/web/lib/apps/app-operation-approvals.ts), [`apps/web/lib/apps/service.postgres.test.ts`](../../apps/web/lib/apps/service.postgres.test.ts) |
| Fail-closed persistence | Pre-wave executable authority could remain active without the new binding fields. | Root migration 030 and Web migration 0056 expire unbound live authority without a compatibility period. | [`db/migrations/030_action_bound_approval_grants.sql`](../../db/migrations/030_action_bound_approval_grants.sql), [`apps/web/lib/db/migrations/0056_external_approval_bindings.sql`](../../apps/web/lib/db/migrations/0056_external_approval_bindings.sql) |

## Boundaries unchanged by this review

- Model-visible development-shell execution and other non-code-mode execution
  surfaces are not reclassified by the Docker change.
- Full networking remains intentional for user-enabled OCI MCP servers; `none`
  remains the explicit offline option.
- Default-deny egress remains accepted risk. No allowlist or egress broker was
  introduced.
- Descriptor-relative filesystem TOCTOU hardening remains deferred until
  mutually untrusted workspace writers enter the supported threat model.
- Recovery ladders, unified memory architecture, hierarchical budgets, and
  eval-driven control flow remain outside this wave.

## Verification record

Observed validation outcomes:

- `pnpm validate`: passed in 98.7 seconds after the new migration was added to
  the immutable history lock.
- `pnpm run validate:process`: passed in 314.2 seconds, including clean
  prerequisite builds, all 13 Docker process proofs, the packed SDK consumer,
  and the real macOS disposable-keychain proof. Earlier sandboxed attempts
  denied the `security` process access with exit 50; rerunning the unchanged
  gate with its required Keychain access passed without weakening product or
  test behavior.
- `pnpm run validate:postgres`: passed in 50.6 seconds, including both
  fail-closed migrations and exact single-use MCP and App approval evidence.
- `pnpm run validate:audit`: passed in 74.5 seconds with `23/23 killed`.

The mutation specification remains unchanged from the historical baseline.
`validate:audit` remains a read-only live-mutation gate and is not made
Docker-dependent by this review.

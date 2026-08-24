---
id: sandbox-capability-qualification
domain: operations
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-23
depends_on:
  - ../../scripts/qualify-sandbox-capability.ts
  - ../../cli/runner/qualification-service.ts
  - ../../cli/runner/service.ts
---

# Sandbox capability black-box qualification

This operator-run qualification exercises the production hosted runner on a
disposable Ubuntu 24.04 host with Docker. It is informational and does not gate
pull requests or releases.

It proves the hosted runner, Docker sandbox, capability broker, provider
adapter, durable store, public audit projection, exact-result read, restart,
and cleanup as one black-box journey. It does **not** prove the Kestrel One Fly
Workspace Runtime topology: that image currently has no Docker daemon or
remote sandbox execution backend.

## Host requirements

Supply a new disposable Ubuntu 24.04 VM with:

- SSH host-key verification already configured in the operator's `known_hosts`
- a non-root SSH user with passwordless `sudo` for creating and deleting the
  qualification root
- Node.js 22, Corepack, and a running Docker daemon
- no existing path at `KESTREL_QUALIFICATION_REMOTE_ROOT`

The command checks these conditions before uploading the exact clean Git
commit. It does not provision cloud infrastructure.

## Required environment

```bash
export KESTREL_QUALIFICATION_SSH_TARGET=operator@qualification-host
export KESTREL_QUALIFICATION_SSH_KEY=/absolute/path/to/private-key
export KESTREL_QUALIFICATION_TENANT_ID=qualification-tenant
export KESTREL_QUALIFICATION_ENVIRONMENT_ID=qualification-environment
export KESTREL_QUALIFICATION_RUNNER_TOKEN="$(openssl rand -hex 32)"
export KESTREL_QUALIFICATION_CONTROL_TOKEN="$(openssl rand -hex 32)"

# Dedicated, low-quota credentials. Values are streamed into a mode-0600
# remote environment file and are never placed in SSH command arguments.
export KESTREL_QUALIFICATION_TAVILY_KEY=...
export KESTREL_QUALIFICATION_MODEL_PROVIDER=openrouter
export KESTREL_QUALIFICATION_MODEL='openai/gpt-5.6-luna'
export KESTREL_QUALIFICATION_MODEL_CREDENTIAL_NAME=OPENROUTER_API_KEY
export KESTREL_QUALIFICATION_MODEL_CREDENTIAL=...
```

Run both evidence classes:

```bash
KESTREL_QUALIFICATION_MODE=all pnpm qualification:sandbox-capability
```

Use `controlled` while iterating on deterministic lifecycle behavior or `live`
for the paid-provider smoke only. Missing authority is a failed qualification,
not a skipped scenario.

## Security boundary

The ordinary `cli/runner/service.ts` entrypoint never installs qualification
controls. Controlled runs use the separate
`cli/runner/qualification-service.ts` entrypoint, which refuses to start
without all of:

- `KESTREL_QUALIFICATION_MODE=controlled`
- a private control directory
- a random control token of at least 32 characters
- an explicit evidence destination

Lifecycle barriers are files in the private control directory and are operated
only through SSH. They are not runner commands, profile fields, tool inputs, or
public HTTP endpoints. The controlled provider still accepts only the fixed
Tavily adapter resource; model-authored destinations and redirects remain
unavailable.

## Evidence and interpretation

Bundles are written under the gitignored path:

```text
artifacts/qualification/sandbox-capability/<timestamp>/
  qualification.json
  manifest.json
  manifest.sha256
```

The manifest provides SHA-256 integrity only. It is not a signature and does
not establish operator identity.

Evidence labels remain separate:

- `live_provider` proves real model, credential, adapter, and Tavily behavior.
- `controlled_provider` proves deterministic cancellation, timeout, expiry,
  reflection, concurrency, crash, and replay behavior.
- `hosted_runner_black_box` proves that the probe used only public runner
  commands across an SSH tunnel.

Live Tavily request counts are recorded as unavailable unless the provider
supplies authoritative usage. The harness never estimates provider spend.

The qualification fails if any scenario fails, a credential appears in public
or stored evidence, an uncommitted result replays, a committed result changes
after restart, direct sandbox egress succeeds, or any Kestrel container remains
after cleanup. The remote source, store, control files, credential environment,
and processes are deleted during cleanup. Retain the VM only long enough to
investigate a reported cleanup failure, then destroy it through its provider.

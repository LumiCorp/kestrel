---
id: reliability-root
domain: ops
status: active
owner: kestrel-ops
last_verified_at: 2026-07-20
depends_on:
  - ARCHITECTURE.md
  - docs/generated/quality-scorecard.json
  - apps/docs/content/operations/quality-gates.mdx
---

# Kestrel Reliability

Kestrel treats reliability as preserving valid work, making unhealthy states
visible, and recovering without discarding evidence or creating a disconnected
replacement run. This model applies to the Runtime, Local Core, the runner
service, Desktop, the CLI and TUI, Kestrel One, and public packages.

## What a reliable run provides

A reliable Kestrel run has:

- stable run and session identities
- validated state transitions and an explicit terminal state
- request-scoped live events backed by durable recorded events
- separate human-facing and structured output
- typed tool and effect outcomes
- visible waiting, steering, cancellation, retry, and recovery actions
- enough logs, artifacts, and checkpoints to explain what happened

An HTTP success response means the request reached a service. The run's
terminal result determines whether the requested agent work completed.

## Live connections and durable state

Live streams follow an active request and may disconnect. The session, run,
recorded events, artifacts, checkpoints, and terminal result are persisted
independently of that connection. Reconnecting therefore does not require
inventing a new run.

Durable subscriptions and replay read persisted evidence. They are different
from a live stream and remain useful after the original caller is gone.

## Failure states

Kestrel distinguishes several conditions that can otherwise look alike in a
user interface:

| Condition | Meaning | Available response |
| --- | --- | --- |
| Waiting | Work needs a person or external condition | Supply the requested input to the existing session |
| Cancelled | A caller or operator stopped the run | Inspect the recorded reason and start new work only if needed |
| Failed | The run reached an unrecoverable error | Inspect events and retry or recover through the supported action |
| Disconnected | A live client lost its connection | Reconnect and read durable state |
| Degraded | A product dependency is unhealthy | Preserve diagnostics and follow the product recovery guide |

## Recovery and diagnosis

Run and session identifiers connect the user-visible state to logs, events,
artifacts, and checkpoints. Recovery operates on that recorded work when the
contract permits it. Cancellation, retry, and resume remain attributable to the
person or service that requested them.

Non-destructive inspection comes before reset or state deletion. Desktop can
produce diagnostics for Local Core, provider, persistence, and IPC failures;
hosted deployments expose health, events, and service logs for the runner
boundary.

## Compatible releases

The Runtime, Protocol, SDK, Next.js adapter, AI SDK adapter, Observability
package, CLI, Desktop resources, and Kestrel One use the compatible `0.6`
release line. Mixing incompatible lines can change event or terminal-result
shapes.

See the [compatibility guide](apps/docs/content/reference/compatibility.mdx) for
the current supported versions.

## Verification and evidence

Kestrel uses registered executable contracts and one bounded validation graph
to detect regressions before release. Every retained automated test names a
contract and exactly one hermetic, process, PostgreSQL, or Chromium boundary.
Critical contracts carry current targeted killed-mutation evidence. Shared
artifacts, PostgreSQL, and Chromium are each provisioned once per validation.
Run `pnpm validate` locally before opening or updating a pull request. GitHub
Actions runs that exact complete portable suite without file-based selection.

macOS package validation is an explicit release-preparation step:
`pnpm run validate:release:macos`.

Ruhroh owns model-quality evaluation. Kestrel's `pnpm run ruhroh:validate`
command validates evaluation configuration only; it does not claim to execute
an evaluation. The generated
[quality scorecard](docs/generated/quality-scorecard.json) summarizes
accumulating risk, while direct contract proofs determine whether a particular
revision is ready.

## Read Next

- [Operations overview](apps/docs/content/operations/index.mdx)
- [Reliability guide](apps/docs/content/operations/reliability.mdx)
- [Artifact inspection](apps/docs/content/operations/artifact-inspection.mdx)
- [Deployment troubleshooting](apps/docs/content/deploy/deployment-troubleshooting.mdx)
- [Quality score](QUALITY_SCORE.md)
- [Security](SECURITY.md)

# Changelog

All notable Kestrel changes are recorded here for users and integrators.

Kestrel's Runtime and CLI, public packages, Desktop, Kestrel One, and hosted
infrastructure can release independently. Each entry names the surface it
changes. Dates use `YYYY-MM-DD`, and empty categories are omitted.

This format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Kestrel packages use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- Kestrel One now extracts ordinary and CMap-backed PDF text consistently in
  uploads and Knowledge while keeping empty or scanned originals available as
  read-only files instead of indexing generated page markers.
- Kestrel One production rollouts now preserve active and stopped Fly Machine
  state and avoid false retries while health-checking stopped Workspaces.

## Kestrel One production - 2026-08-25

### Fixed

- Kestrel Runtime and Kestrel One can resume an approved built-in tool after a
  runtime rebuild when the original static tool scope is preserved. Older
  requests without that evidence remain fail-closed and must be resubmitted.
- Kestrel One now carries explicit retry evidence for failures that occur
  before provider execution starts across Web and Mobile, instead of
  presenting a recorded approval as an executed action.

### Security

- Kestrel One now requires one exact transaction chain from the runner approval
  request through the user's decision, App grant, resumed turn, and consuming
  execution before a hosted provider action can run.

## Runtime and CLI 0.8.8 - 2026-08-24

### Added

- Added `job preflight` so clients can verify the requested preset, approval
  policy, tools, execution profile, and policy revision before creating work.

### Changed

- New `job_input_v2` jobs bind execution to immutable preflight evidence and
  reject missing, stale, or changed bindings before dispatch.
- Existing direct clients can continue using `job_input_v1`.

## Runtime and CLI 0.8.7 - 2026-08-24

### Fixed

- Restored clean npm installation after Runtime 0.8.6 referred to private or
  unpublished dependencies.
- Published Files 0.8.5 and removed compiled tests from the Runtime package.
- Made the release check install and smoke-test the same packed artifact that
  users receive.

## Runtime and CLI 0.8.6 - 2026-08-24 [DEPRECATED]

### Deprecated

- This npm release is deprecated and not installable from a clean environment
  because its dependency graph refers to packages users cannot resolve.
  Install Runtime 0.8.7 or newer instead.

## Desktop 0.8.6 - 2026-08-20

### Fixed

- A stale queued conversation message now pauses and reports its route failure
  instead of aborting Local Core during detached follow-up processing.
- Running conversations and the Desktop process remain available for recovery
  after this failure.

## [Kestrel 0.8.5] - 2026-08-18

### Added

- Added executable plugin manifests with explicit installation,
  configuration, enablement, driver, and capability state.
- Added titles, selected models, Chat or Build mode, manual tests, and stable
  trigger identity to scheduled runs.
- Added a public Conversation package shared by Runtime, CLI/TUI, Desktop, and
  Kestrel One.

### Changed

- Made Mission Control the authoritative surface for live work, review, and
  acceptance state.
- Bound approval grants to the exact external action being approved.
- Strengthened hosted Workspace provisioning, persistence, backup, recovery,
  retirement, and shutdown behavior.
- Migrated Desktop Apps to the shared plugin lifecycle while preserving
  credentials in Keychain and writing a one-time pre-migration settings backup.
- Expanded release checks for clean Runtime installs, terminal recovery,
  signed Desktop launch and relaunch, persistence, offline turns, and updater
  cleanup.

### Removed

- Removed retired workflow-App selections during the Desktop settings
  migration.

## Runtime and CLI 0.8.4 - 2026-08-18 [NOT PROMOTED]

### Changed

- This version was staged for release validation but was not promoted to npm
  `latest`, GitHub Latest, Desktop stable, or production. Kestrel 0.8.5
  superseded it.

## Runtime and CLI 0.8.2 - 2026-08-05

### Fixed

- Corrected a clean global-install failure caused by a transitive optional
  dependency while retaining the Kestrel 0.8.0 runtime contracts.

## Runtime and CLI 0.8.1 - 2026-08-05

### Fixed

- Restored required MCP Security runtime files that were missing from the
  immutable Runtime 0.8.0 npm package.

## [Kestrel 0.8.0] - 2026-08-05

### Added

- Established one shared 0.8 contract across Runtime, Protocol, SDK, adapters,
  CLI/TUI, Desktop, Kestrel One, Memory, Observability, and Workspace Skills.
- Added durable conversation recovery, stable cursors, governed Memory, trace
  correlation, and action-bound approvals.
- Published Kestrel One source under the release tag while keeping the hosted
  service invitation-only.

### Changed

- Replaced the legacy Board and Task action model with Mission Control
  projects, work items, attempts, evidence, review, and acceptance.

### Removed

- Removed legacy Board and Task project actions.
- Removed `project.snapshot.update` and the SDK's `updateProjectSnapshot`.

## Desktop 0.7.0 - 2026-08-04

### Added

- Shipped the first signed, notarized, and Gatekeeper-verified stable Desktop
  release for macOS on Apple silicon.
- Added manual update checks with guarded restart and installation behavior.

## Kestrel packages 0.7.0 - 2026-07-28

### Added

- Published the coordinated 0.7.0 Runtime, Protocol, SDK, adapters,
  Observability, and Workspace Skills package line.
- Added the prior terminal-result contract and public package installation
  guidance.

[Kestrel 0.8.5]: https://github.com/LumiCorp/kestrel/releases/tag/v0.8.5
[Kestrel 0.8.0]: https://github.com/LumiCorp/kestrel/releases/tag/v0.8.0

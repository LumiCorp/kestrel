---
id: unified-suite-version-and-release-channels
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-18
depends_on:
  - ../../package.json
  - ../../apps/docs/lib/release.ts
  - ../plans/2026-08-18-kestrel-0.8.4-release-and-production-promotion.md
---

# Unified Suite Version and Distinct Release Channels

## Decision

Kestrel uses one numeric suite version across the root package and every first-party workspace manifest. The root [`package.json`](../../package.json) is canonical. Public package tarballs must resolve first-party workspace dependencies to that exact version, and product/documentation compatibility records must match it.

A shared version does not imply one distribution mechanism or one access policy:

| Surface | 0.8.4 distribution and access |
| --- | --- |
| Runtime and CLI | Public npm package; macOS arm64 archive is secondary |
| Protocol, Conversation, SDK, Memory, Next, AI SDK, Observability, and Workspace Skills | Public npm packages |
| Desktop | Signed and notarized download; Beta; stable OTA supports signed 0.7.0 and 0.8.0 clients |
| Kestrel One | Public source at `v0.8.4`; Beta; Lumi-hosted deployment is invitation-only |
| Internal services | Versioned with the suite; not independently published |

The ordinary `v0.8.4` Git tag and GitHub release identify the release. There is
no separate Desktop tag. Public package versions, product versions, release
metadata, and exact first-party dependencies must not diverge from the suite
version. An immutable bad publication is corrected by advancing the entire
suite to a new patch version rather than creating a package-only release line.

## Consequences

- Mixed first-party release lines fail the version or packed-consumer gates.
- A private package manifest means “not published to npm,” not “unversioned.”
- A unified product version does not create one hosted distribution unit;
  database, Vercel, Fly components, and the managed RunPod worker advance and
  roll back through independent production delivery channels.
- Desktop candidate artifacts may exist while stable remains unchanged. Release
  closeout requires Desktop stable to report the suite version and both required
  upgrade paths to pass.
- Hosted access restrictions do not restrict repository cloning or tagged source availability.
- Release evidence uses versions, artifact checksums, signatures, notarization,
  dist-tags, migrations, health, and canary results. It does not require source
  commit identities to match provider revisions or package metadata.

## Release control

The current implementation and cutover sequence is recorded in the [Kestrel
0.8.4 release and production promotion
plan](../plans/2026-08-18-kestrel-0.8.4-release-and-production-promotion.md).

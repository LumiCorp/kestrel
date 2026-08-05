---
id: unified-suite-version-and-release-channels
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-04
depends_on:
  - ../../package.json
  - ../../apps/docs/lib/release.ts
  - ../plans/2026-08-04-kestrel-0.8.0-unified-integration-release.md
---

# Unified Suite Version and Distinct Release Channels

## Decision

Kestrel uses one numeric suite version across the root package and every first-party workspace manifest. The root [`package.json`](../../package.json) is canonical. Public package tarballs must resolve first-party workspace dependencies to that exact version, and product/documentation compatibility records must match it.

A shared version does not imply one distribution mechanism or one access policy:

| Surface | 0.8 distribution and access |
| --- | --- |
| Runtime and CLI | Public npm package; macOS arm64 archive is secondary |
| Protocol, SDK, Memory, and adapters | Public npm packages |
| Desktop | Signed and notarized manual download; Beta; stable OTA remains on 0.7.0 |
| Kestrel One | Public source at `v0.8.0`; Beta; Lumi-hosted deployment is invitation-only |
| Internal services | Versioned with the suite; not independently published |

The unified annotated `v0.8.0` tag identifies the source for every artifact and deployment. There is no separate Desktop tag.

A published distribution may receive a packaging-only patch without changing the suite contract version. That exception must be explicit in release metadata and evidence, keep first-party dependencies pinned to the canonical suite version, and must not imply a product-wide bump. For this release, `@kestrel-agents/kestrel@0.8.2` corrects the immutable earlier npm artifacts while the suite contracts and products remain 0.8.0.

## Consequences

- Mixed first-party release lines fail the version or packed-consumer gates.
- A private package manifest means “not published to npm,” not “unversioned.”
- Candidates are built from one frozen revision before any stable channel changes.
- Desktop OTA promotion is a separate proof and may remain behind the suite version.
- Hosted access restrictions do not restrict repository cloning or tagged source availability.
- Release evidence records a packaging-only distribution patch separately from the suite version.

## Release control

The implementation and cutover sequence is recorded in the [Kestrel 0.8.0 unified integration release plan](../plans/2026-08-04-kestrel-0.8.0-unified-integration-release.md).

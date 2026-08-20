---
id: independent-artifact-versioning-and-release-channels
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-20
depends_on:
  - ../../package.json
  - ../../apps/docs/lib/release.ts
---

# Independent Artifact Versioning and Release Channels

## Decision

Kestrel versions each published artifact independently. A release advances only the
artifact being published: Desktop, a public npm package, CLI archive, Kestrel One
source, Docs, or an internal service image. Repository source state is not an
artifact and does not require a matching version bump.

Every workspace manifest must have a numeric version. A first-party dependency
declared with an exact numeric pin must match the dependency's manifest version.
This explicit pin is the compatibility contract; a shared repository-wide number
is not.

Independent versions do not imply one distribution mechanism or one access policy:

| Surface | Distribution and access |
| --- | --- |
| Runtime and CLI | Public npm package; macOS arm64 archive is secondary |
| Protocol, Conversation, SDK, Memory, Next, AI SDK, Observability, and Workspace Skills | Public npm packages |
| Desktop | Signed and notarized download; Beta; own patch line and stable OTA channel |
| Kestrel One | Versioned source tag; Beta; Lumi-hosted deployment is invitation-only |
| Internal services | Independently versioned image or deployment revision; not npm releases |

Coordinated source releases use an ordinary `v<version>` tag. A Desktop-only
release uses `desktop-v<version>` and contains only signed Desktop artifacts and
their checksums. Its updater objects remain immutable at their versioned keys;
stable-channel promotion remains a separate operation. An immutable bad
publication is corrected by advancing that artifact's patch version, never by
overwriting it.

## Consequences

- Independent release lines are valid when their declared dependency pins and
  compatibility records are valid.
- A private package manifest means “not published to npm,” not “unversioned.”
- Desktop candidate artifacts may exist while stable remains unchanged. Desktop
  closeout requires only that Desktop's versioned artifacts and required upgrade
  paths pass; it does not imply a new npm, Docs, hosted, or image release.
- A full coordinated release remains available when multiple artifacts genuinely
  need to advance together, but it is an explicit release choice rather than a
  versioning rule.
- Hosted access restrictions do not restrict repository cloning or tagged source availability.
- Release evidence uses versions, artifact checksums, signatures, notarization,
  dist-tags, migrations, health, and canary results. It does not require source
  commit identities to match provider revisions or package metadata.

## Release control

The version gate validates every manifest, exact first-party dependency pin,
Docs release record, and the artifact owner for each compatibility entry.

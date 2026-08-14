# Kestrel operations glossary

## Stable Runtime Bundle

The signed stable release manifest stored in Postgres whose exact public GHCR
Environment Router and Workspace Runtime digests are authoritative for ordinary
tenant provisioning, recovery, and reconciliation.

## Fleetless Release

A coordinated release promoted while no non-archived Fly Environment exists in
a status other than `deleted`. It requires no tenant canary. Creation of the
first Fly Environment is blocked while the release is approved or deploying.

## Process Configuration Contract

The declarative, role-specific set of required, optional, and forbidden process
configuration names. Its deterministic shape has a SHA-256 fingerprint used as
release evidence; secret values are never part of the fingerprint.

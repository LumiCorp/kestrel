# Kestrel operations glossary

## Environment Runtime Version

An immutable record containing one exact public GHCR Environment Router image
and one exact public GHCR Workspace Runtime image, plus the operator-selected
tag and provider records used to diagnose the rollout.

## Environment Runtime Channel

The atomic production pointer to the current and previous Environment Runtime
Versions. New Environments snapshot the current pair; changing the pointer does
not mutate existing Environments.

## Production Delivery Channel

One independently triggered and rolled-back provider lane: database migrations,
native Vercel deployment, a catalog-selected Fly component, or the managed
RunPod worker.

## Process Configuration Contract

The declarative, role-specific set of required, optional, and forbidden process
configuration names. Its deterministic shape has a SHA-256 fingerprint exposed
by private worker health; secret values are never part of the fingerprint.

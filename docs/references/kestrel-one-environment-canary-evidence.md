---
id: kestrel-one-environment-canary-evidence
domain: apps
status: active
owner: kestrel-one
last_verified_at: 2026-07-13
depends_on:
  - ../../apps/web/scripts/environment-fly-canary.ts
  - ../../apps/environment-router/Dockerfile
  - ../../apps/workspace-runtime/Dockerfile
---

# Kestrel One Environment Canary Evidence

This note records live Fly infrastructure evidence from the
[Environment canary harness](../../apps/web/scripts/environment-fly-canary.ts)
for the organization-owned Environment control plane. It does not claim that
the current Kestrel One web deployment or GitHub OAuth canary has completed.

## Verified Artifact Set

- Source commit: `cc1add10`
- Region: `iad`
- Fly organization: `personal`
- [Environment router](../../apps/environment-router/Dockerfile):
  `registry.fly.io/kestrel-one-runner@sha256:88b5c69878bb5a2dd9becfbfa0f817e3486450d2d8b68e8daae30dd50cf42df3`
- [Workspace runtime](../../apps/workspace-runtime/Dockerfile):
  `registry.fly.io/kestrel-one-runner@sha256:f59f7a1ef705da16e3a36071b99432248c6a85c6d8c2e92c1d147f7770799ef7`

Both images were built from the source commit for `linux/amd64`, exported to
the private Fly registry, and resolved to immutable manifest digests before the
canary ran.

## Live Canary Result

At `2026-07-13T14:30:07Z`,
`pnpm --filter @kestrel/kestrel-one canary:environment:fly` completed with exit
code `0`. The harness provisioned two independent Environment Apps, gateways,
private Workspace Machines, and encrypted volumes, then proved:

- dedicated custom Fly networks;
- gateway-only public ingress;
- signed private routing from the Environment gateway to its Workspace;
- cross-Environment private DNS isolation;
- file persistence across Workspace Machine stop and start;
- backup export and restore into a replacement encrypted volume; and
- idempotent provider ensure operations.

The two temporary Apps were `kestrel-env-392d21505e8240318327` and
`kestrel-env-e3eff9e9fd084fd1ab4c`. The harness deleted both Apps after the
proofs completed and verified each deletion with the Fly API. A subsequent
`fly apps list --json` returned only the pre-existing `kestrel-one-runner` App,
confirming that the canary left no temporary Fly App behind.

## Remaining Deployment Evidence

The production aliases currently resolve to a deployment created before the
Environment routes landed. Completion still requires a current Kestrel One
deployment, the signed-in GitHub OAuth and broker canary, hosted cutover
preflight against the target database, and explicit authorization before the
legacy production runner configuration is removed.

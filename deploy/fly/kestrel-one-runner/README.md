# Kestrel One runner on Fly.io

This image is built from the checked-out Kestrel source rather than an npm release. The final image contains only the production deployment created by `pnpm deploy`; it does not contain the source workspace, local environment files, or build dependencies.

From the repository root:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
IMAGE="kestrel-one-runner:${RELEASE_SHA}"

docker build \
  --file deploy/fly/kestrel-one-runner/Dockerfile \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}" \
  --tag "$IMAGE" \
  --progress plain \
  .

EXPECTED_GIT_SHA="$RELEASE_SHA" \
  deploy/fly/kestrel-one-runner/smoke.sh "$IMAGE"
```

Production deployment must follow the gateway-only rollout runbook. In particular, pass this directory's `Dockerfile.dockerignore` explicitly and record the resulting Fly image digest before changing the Vercel alias.

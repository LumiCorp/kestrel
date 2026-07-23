# Preview Edge image release boundary

This app is the public HTTP and WebSocket ingress for exact active preview
hostnames. It resolves each hostname through Kestrel One and forwards traffic to
the authorized Environment Router. The image can be built before the Fly App,
wildcard certificate, and DNS are created.

## Build and verify the immutable image

From a clean committed revision at the repository root:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
PREVIEW_EDGE_IMAGE="kestrel-preview-edge:${RELEASE_SHA}"

docker build \
  --file apps/preview-edge/Dockerfile \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}" \
  --tag "${PREVIEW_EDGE_IMAGE}" \
  --progress plain \
  .

EXPECTED_GIT_SHA="${RELEASE_SHA}" \
  apps/preview-edge/scripts/image-smoke.sh "${PREVIEW_EDGE_IMAGE}"
```

The approved Fly builder may publish the image without deploying it:

```bash
fly deploy . \
  --config apps/preview-edge/fly.build.toml \
  --build-only \
  --push \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}"
```

Record the immutable `registry.fly.io/...@sha256:...` digest. Do not attach DNS,
create certificates, or route production preview traffic as part of the image
build.

## Later infrastructure boundary

The infrastructure rollout creates the dedicated Fly App from
`fly.toml.example`, provisions `KESTREL_CONTROL_PLANE_URL` and
`KESTREL_PREVIEW_EDGE_SERVICE_TOKEN`, attaches the wildcard certificate, and
runs an isolated canary hostname. Existing ngrok preview publication remains
authoritative until a later lifecycle rollout emits `kestrel_edge` routes.

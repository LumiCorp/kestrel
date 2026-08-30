# Hosted Browser runtime staging

The hosted Browser image build expects these two exact release inputs here:

- `agent-browser-linux-x64`
- `chrome-linux64.zip`

Stage them from the repository root with:

```sh
pnpm run browser:runtime:stage:hosted
```

The staging command downloads only the exact upstream HTTPS URLs in
`src/browser/runtimeReleaseManifest.ts`, verifies their checked-in SHA-256
digests, and atomically installs verified bytes here. A missing download or wrong
digest fails the command without replacing a previously verified asset.

The staged binaries are ignored and must not be committed. The Docker build
independently verifies both pinned SHA-256 values before copying either
executable into the runtime image. The final image then uses Kestrel's normal
image smoke and immutable repository-digest release evidence; there is no
separate upstream asset-signature receipt in v1.

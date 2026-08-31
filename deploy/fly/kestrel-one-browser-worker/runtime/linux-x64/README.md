# Hosted Browser runtime staging

The hosted Browser image build expects these two exact release inputs here:

- `agent-browser-linux-x64`
- `chrome-linux64.zip`

Stage them from the repository root with:

```sh
pnpm run browser:runtime:stage:hosted
```

The staging command copies the exact repository-owned patched agent-browser
binary and downloads the exact Chrome-for-Testing HTTPS asset named in
`src/browser/runtimeReleaseManifest.ts`. It verifies both checked-in SHA-256
digests and atomically installs only verified bytes here. A missing source or
wrong digest fails without replacing a previously verified asset.

The staged runtime directory is generated and ignored; the repository-owned
agent-browser source binary lives under `third_party/agent-browser/`. The Docker
build independently verifies both pinned SHA-256 values before copying either
executable into the runtime image. The final image then uses Kestrel's normal
image smoke and immutable repository-digest release evidence; there is no
separate patch-specific signature receipt in v1.

# Kestrel agent-browser v0.35.0-kestrel.1

This directory contains the exact agent-browser binaries packaged by Kestrel
Browser v1 and the small source patch used to build them.

- Upstream repository: `https://github.com/vercel-labs/agent-browser`
- Upstream commit: `585e740fcef069d74e21f0e88e8bf4ea7df34385` (tag `v0.35.0`)
- Patch: `local-name.patch`
- Patch behavior: adds the read-only
  `get local-name <selector-or-ref>` command. It resolves through
  agent-browser's private reference map, then reads the browser-owned
  `DOM.describeNode` local name and `type` attribute for that exact CDP object
  in one response. Parsed refs require their cached backend-node identity;
  stale refs fail instead of falling back to role/name matching. The same
  exact-ref rule protects upload. Page JavaScript cannot shadow either value.
- Kestrel version: `0.35.0-kestrel.1`
- License: Apache-2.0; the upstream license is included as `LICENSE`.

The runtime release manifest pins each binary by SHA-256. Desktop and hosted
staging copy only these repository-owned bytes and verify the digest before
packaging. The containing Desktop app or hosted worker image supplies the
release signature; there is no separate patch-specific signature or receipt.

The patch applies cleanly with:

```sh
git checkout 585e740fcef069d74e21f0e88e8bf4ea7df34385
git apply /path/to/local-name.patch
```

The checked-in binaries were rebuilt with Rust 1.88.0. Darwin arm64 uses the
native release target:

```sh
cargo build --release --manifest-path cli/Cargo.toml \
  --target aarch64-apple-darwin
cp cli/target/aarch64-apple-darwin/release/agent-browser \
  agent-browser-darwin-arm64
codesign --force --sign - agent-browser-darwin-arm64
```

The deterministic ad-hoc signature makes the repository asset directly
executable for local verification. A signed Desktop release replaces it with
the package's Developer ID signature; the signed-release receipt permits only
that signature-verified native change.

Linux x64 follows the upstream release matrix with cargo-zigbuild 0.23.2,
Zig 0.13.0, and the glibc 2.28 target:

```sh
rustup target add x86_64-unknown-linux-gnu
cargo zigbuild --release --manifest-path cli/Cargo.toml \
  --target x86_64-unknown-linux-gnu.2.28
cp cli/target/x86_64-unknown-linux-gnu/release/agent-browser \
  agent-browser-linux-x64
```

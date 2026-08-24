<p align="center">
  <img src="apps/docs/public/brand/kestrel-mark.png" alt="Kestrel" width="104" />
</p>

<h1 align="center">Kestrel</h1>

<p align="center">
  <strong>One Kestrel everywhere.</strong>
</p>

<p align="center">
  Kestrel is an open-source agent platform for building software, researching
  questions, analyzing data, and producing reports, spreadsheets,
  presentations, and other files.
</p>

<p align="center">
  Kestrel artifacts release independently. The current public lines are
  Desktop 0.8.6, Runtime and CLI/TUI 0.8.8, the remaining public packages
  0.8.5, and Kestrel One source 0.8.5.
  Each surface keeps explicit compatibility, execution, Mission Control,
  recovery, approval, memory, and evidence contracts.
</p>

<p align="center">
  Kestrel is maintained and supported by <a href="https://www.lumicorp.ai">Lumi</a>.
</p>

<p align="center">
  <a href="https://updates.lumicorp.ai/desktop/releases/0.8.6/arm64/Kestrel-0.8.6-mac-arm64.dmg">Download Desktop 0.8.6</a> ·
  <a href="https://docs.kestrelagents.dev">Read the docs</a> ·
  <a href="https://github.com/LumiCorp/kestrel/tree/v0.8.5/apps/web">View Kestrel One source</a>
</p>

<p align="center">
  <a href="https://github.com/LumiCorp/kestrel/actions/workflows/ci.yml"><img src="https://github.com/LumiCorp/kestrel/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f6f5f.svg" alt="MIT license" /></a>
  <a href="https://docs.kestrelagents.dev/start/release-status"><img src="https://img.shields.io/badge/Desktop-0.8.6-2f7d32.svg" alt="Kestrel Desktop 0.8.6" /></a>
  <a href="https://docs.kestrelagents.dev/start/release-status"><img src="https://img.shields.io/badge/Runtime-0.8.8-245b78.svg" alt="Kestrel Runtime 0.8.8" /></a>
  <a href="https://docs.kestrelagents.dev/start/release-status"><img src="https://img.shields.io/badge/status-Beta-245b78.svg" alt="Kestrel Beta" /></a>
</p>

<p align="center">
  <img src=".github/assets/kestrel-tui-reds-demo.gif" alt="Kestrel TUI researching Cincinnati Reds news and building a static fan site." width="1000" />
</p>

## Kestrel Desktop

<p align="center">
  <img src=".github/assets/kestrel-desktop-night-flight.gif" alt="Kestrel Desktop creating a launch codename and rally cry in a completed conversation." width="1000" />
</p>

Kestrel Desktop 0.8.6 is the signed and notarized macOS application for local
project work. Give it a folder, connect a compatible provider/model, and work
through one durable conversation while Local Core owns execution, credentials,
sessions, recovery, and project evidence. Mission Control keeps work items,
attempts, validation, review, and acceptance visible without turning the
conversation into a status database.

Desktop 0.8.6 supports macOS 13 or newer on Apple silicon. Install the signed
DMG directly or update through the stable channel from an earlier signed Desktop.
The upgrade preserves settings, credentials, projects, conversations, Mission
Control, and Local Core state while migrating Apps to executable plugin records.

[Learn about Desktop](https://docs.kestrelagents.dev/desktop) ·
[Install Desktop 0.8.6](https://docs.kestrelagents.dev/desktop/install) ·
[Desktop updates](https://docs.kestrelagents.dev/desktop/updates)

## Kestrel One

Kestrel One is a real versioned product at 0.8.5. Its source is available in
this repository and from the `v0.8.5` tag. You can inspect it, clone it, and run
the documented local-development setup without joining the hosted service.

Kestrel One adds organizations, shared Projects and Threads, context revisions,
Knowledge, Apps, Environments, Mission Control, governed model access, workers,
and operator evidence. Lumi-hosted Kestrel One is an invitation-only deployment
of the same 0.8.5 source/product line. Invitation-only describes hosted access;
it is not Kestrel One's version or the only way its source exists.

[Learn about Kestrel One](https://docs.kestrelagents.dev/kestrel-one) ·
[Source and hosting](https://docs.kestrelagents.dev/kestrel-one/source-and-hosting) ·
[View the 0.8.5 source](https://github.com/LumiCorp/kestrel/tree/v0.8.5/apps/web) ·
[Hosted getting started](https://docs.kestrelagents.dev/kestrel-one/getting-started)

## Install the CLI/TUI

The CLI/TUI is a first-class 0.8 surface for local sessions, terminal work,
operator control, Mission Control, profiles, tools, jobs, and Local Core.

Requirements: Node.js 22 on macOS arm64 or Linux x64.

```bash
npm install -g @kestrel-agents/kestrel@0.8.8
kestrel --version
kestrel
```

The checksum-bearing macOS arm64 standalone archive remains available from the
Runtime/CLI `v0.8.5` GitHub release and reports product version `0.8.5`. npm is
the canonical distribution for Runtime/CLI 0.8.8.

[CLI installation](https://docs.kestrelagents.dev/cli/install) ·
[Command suite](https://docs.kestrelagents.dev/cli/command-suite) ·
[TUI guide](https://docs.kestrelagents.dev/cli/kchat)

## Build with Kestrel

Install the exact package versions shown in the compatibility matrix. Runtime
is 0.8.8 and its nine public dependencies are 0.8.5; independently versioned
products such as Desktop do not need to share either number. Kestrel does not
provide a 0.7 wire/API compatibility shim around the current Runtime, Protocol, SDK,
adapters, or clients.

```bash
pnpm add @kestrel-agents/sdk@0.8.5 @kestrel-agents/protocol@0.8.5
```

The ten public artifacts are:

- `@kestrel-agents/kestrel` — Runtime and CLI/TUI
- `@kestrel-agents/protocol` — commands, events, health, and results
- `@kestrel-agents/conversation` — durable conversation projection and presentation
- `@kestrel-agents/files` — bounded extraction and classification for uploaded files
- `@kestrel-agents/sdk` — server-side Agent and runner clients
- `@kestrel-agents/memory` — governed memory contracts and retrieval
- `@kestrel-agents/next` — Next.js route helpers
- `@kestrel-agents/ai-sdk` — AI SDK presentation mapping
- `@kestrel-agents/observability` — tracing and correlation
- `@kestrel-agents/workspace-skills` — secure project-owned skills

[Build your first agent](https://docs.kestrelagents.dev/build/building-your-first-agent) ·
[Upgrade to 0.8](https://docs.kestrelagents.dev/build/upgrading-to-0-8) ·
[Compatibility](https://docs.kestrelagents.dev/reference/compatibility)

## Develop Kestrel

Kestrel is a TypeScript monorepo built with Node.js and pnpm.

```bash
git clone https://github.com/LumiCorp/kestrel.git
cd kestrel
corepack enable
pnpm install --frozen-lockfile
```

Run the surface you are working on:

```bash
pnpm run desktop:dev
pnpm run web:dev
pnpm run tui
pnpm run docs:dev
```

| Path | Contains |
| --- | --- |
| [`apps/desktop/`](apps/desktop) | Kestrel Desktop |
| [`apps/web/`](apps/web) | Kestrel One and the public landing page |
| [`cli/`](cli) | CLI/TUI and Local Core clients |
| [`src/`](src) | Shared Runtime and Mission Control implementation |
| [`packages/`](packages) | Protocol, SDK, Memory, adapters, observability, and Workspace Skills |
| [`apps/docs/`](apps/docs) | Public documentation site |

## Quality gates

Before a pull request is ready, run the portable validation contract used by
GitHub Actions:

```bash
pnpm validate
```

Run `validate:process`, `validate:postgres`, `validate:chromium`,
`validate:audit`, focused mutation proofs, and product/release checks when you
change the boundary they own. Gate evidence should identify the first component
that made behavior wrong; downstream rejection alone does not establish
ownership.

## Learn more

- [Release status](https://docs.kestrelagents.dev/start/release-status)
- [Kestrel 0.8 release notes](https://docs.kestrelagents.dev/reference/releases)
- [Runtime model](https://docs.kestrelagents.dev/start/runtime-model)
- [Kestrel One source and hosting](https://docs.kestrelagents.dev/kestrel-one/source-and-hosting)
- [Upgrade from 0.7 to 0.8](https://docs.kestrelagents.dev/build/upgrading-to-0-8)
- [Compatibility matrix](https://docs.kestrelagents.dev/reference/compatibility)
- [Lumi](https://www.lumicorp.ai)
- [Architecture](ARCHITECTURE.md)
- [Developer onboarding reader](docs/developer-onboarding/README.md)
- [Security](SECURITY.md)
- [Support](SUPPORT.md)

Use [GitHub Issues](https://github.com/LumiCorp/kestrel/issues) for reproducible
bugs and feature requests. Report security concerns through the private process
in [SECURITY.md](SECURITY.md), not in a public issue.

Kestrel is available under the [MIT License](LICENSE).

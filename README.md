<p align="center">
  <img src="apps/docs/public/brand/kestrel-mark.png" alt="Kestrel" width="168" />
</p>

<h1 align="center">Kestrel</h1>

<p align="center">
  <strong>Build with Kestrel.</strong>
</p>

<p align="center">
  Kestrel is an open agent platform led by Kestrel Desktop. Choose your model
  and use it to build software, conduct research, work with data, and create
  reports, spreadsheets, presentations, and more.
</p>

<p align="center">
  <a href="apps/docs/content/desktop/install.mdx">Download Kestrel Desktop</a> ·
  <a href="https://docs.kestrelagents.dev">Explore the docs</a> ·
  <a href="CONTRIBUTING.md">Contribute</a>
</p>

<p align="center">
  <a href="https://github.com/LumiCorp/kestrel/actions/workflows/ci.yml"><img src="https://github.com/LumiCorp/kestrel/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1f6f5f.svg" alt="MIT license" /></a>
  <a href="apps/docs/content/start/release-status.mdx"><img src="https://img.shields.io/badge/release-0.6.0-2f7d32.svg" alt="Kestrel 0.6.0" /></a>
</p>

## Kestrel Desktop

Start with a folder, a repository, a collection of research, or a blank
project. Choose the model you want to use and describe what you are trying to
make.

Kestrel can explore the material, develop a plan, work across files, use the
necessary tools, and produce the result with you. That might mean implementing
a feature, investigating a question, analyzing a spreadsheet, writing a report,
or assembling a presentation.

You can follow along, review changes, answer questions, and redirect the work
without leaving the project.

[Learn about Kestrel Desktop](apps/docs/content/apps/desktop.mdx) ·
[Download Kestrel Desktop](apps/docs/content/desktop/install.mdx)

## Kestrel One

### Shared projects, distributed environments, and private models.

Kestrel One is where organizations run Kestrel across people and
infrastructure. Teams can create shared Projects, continue work through
Threads, bring in organizational Knowledge, and control who can access each
part of the workspace.

Environments determine where the work runs and what it can use. Connect cloud
or distributed infrastructure, deploy private hosted models, and make approved
tools, Apps, files, and data available to the projects that need them.

[Learn about Kestrel One](apps/docs/content/apps/web.mdx) ·
[Join Kestrel One](apps/docs/content/kestrel-one/getting-started.mdx)

## Go further with Kestrel

Desktop and Kestrel One provide the complete product experiences. The terminal
and SDK give advanced users direct access to the same Kestrel platform.

Use the CLI and TUI for local projects, interactive terminal work, scripts, and
automation. Use the TypeScript SDK to run Kestrel inside your own product
through local or hosted environments.

[Explore the terminal](apps/docs/content/cli/index.mdx) ·
[Build with the SDK](apps/docs/content/build/building-your-first-agent.mdx)

## Get started with Kestrel Desktop

Kestrel Desktop 0.6.0 is available for Macs with Apple silicon. Download the
application, connect the model you want to use, and open your first project.

[Download Kestrel Desktop](apps/docs/content/desktop/install.mdx)

Kestrel One is currently available by organization invitation. Developers can
also install the Kestrel SDK or work with the terminal from this repository.

[Join Kestrel One](apps/docs/content/kestrel-one/getting-started.mdx) ·
[Build with the SDK](apps/docs/content/build/building-your-first-agent.mdx) ·
[Use the terminal](apps/docs/content/cli/index.mdx)

## Build Kestrel

Kestrel is an open TypeScript monorepo built with Node.js and pnpm.

```bash
git clone https://github.com/LumiCorp/kestrel.git
cd kestrel
corepack enable
pnpm install
```

Run the part of Kestrel you are working on:

```bash
pnpm run desktop:dev
pnpm run web:dev
pnpm run tui
pnpm run docs:dev
```

| Path | Contains |
| --- | --- |
| [`apps/desktop/`](apps/desktop) | Kestrel Desktop |
| [`apps/web/`](apps/web) | Kestrel One |
| [`cli/`](cli) | CLI and terminal interface |
| [`src/`](src) | Shared Kestrel execution system |
| [`packages/`](packages) | Protocol, SDK, Next.js, AI SDK, and observability packages |
| [`apps/docs/`](apps/docs) | Documentation site |

Before submitting a change:

```bash
pnpm run governance:check
pnpm run test
pnpm run test-proofs:check
```

Read the [contributing guide](CONTRIBUTING.md) for the complete development and
review process.

## Learn more

- [Documentation](https://docs.kestrelagents.dev)
- [Kestrel Desktop](apps/docs/content/apps/desktop.mdx)
- [Kestrel One](apps/docs/content/apps/web.mdx)
- [CLI and TUI](apps/docs/content/cli/index.mdx)
- [SDK](packages/sdk/README.md)
- [Architecture](ARCHITECTURE.md)
- [Security](SECURITY.md)
- [Support](SUPPORT.md)

Use [GitHub Issues](https://github.com/LumiCorp/kestrel/issues) for reproducible
bugs and feature requests. Please report security concerns through the private
process described in [SECURITY.md](SECURITY.md), not in a public issue.

Kestrel is available under the [MIT License](LICENSE).

# Kestrel

Kestrel is an open runtime platform for building and operating durable AI
agents. This monorepo contains the runtime kernel, Local Core, CLI/TUI,
self-contained Desktop application, Kestrel One hosted web product, public
TypeScript packages, documentation, integrations, and declarative evaluation
specifications.

## Product Boundaries

- **Kestrel** owns the runtime, local services, public clients, packages, and
  product surfaces in this repository.
- **Kestrel CLI** is a Local Core client. Interactive, job, operator, web-proxy,
  and evidence commands do not launch or reconstruct a second local runtime.
- **Kestrel One** is the canonical hosted web product under `apps/web`.
- **Kestrel Desktop** is the independent local UI surface. The target
  architecture makes it a Local Core client; its current compatibility path
  still starts Local Core with the bundled managed database until the client
  cutover and packaging migration land.
- **Kestrel Studio** is a separate private commercial product that consumes
  exact released Kestrel packages. Studio source does not belong here.
- **Ruhroh** is a separate project that owns evaluation execution, reporting,
  comparison, and the maintained Kestrel adapter. Kestrel owns only the
  declarative specifications and ownership evidence under `evals/`.

## Repository Layout

- `src/`: runtime, orchestration, persistence, replay, governance, Local Core,
  and shared adapters
- `cli/`: `kestrel`, `ks`, `kcron`, the TUI, and runner-service commands
- `apps/desktop/`: self-contained Electron application and bundled local data
  runtime
- `apps/web/`: Kestrel One, including auth, streaming, artifacts, knowledge,
  bots, administration, and billing
- `apps/docs/`: public documentation site
- `packages/protocol/`: public runner protocol contracts
- `packages/sdk/`: public TypeScript SDK
- `packages/next/`: Next.js integration helpers
- `packages/observability/`: observability integrations
- `evals/`: declarative Ruhroh scenarios, suites, targets, and migration
  evidence
- `agents/reference-react/`: canonical bundled reference agent
- `tools/`: typed tool contracts and handlers
- `db/migrations/`: persistent runtime and orchestration schema

## Local Setup

Prerequisites: Node.js 22 and pnpm 9.

```bash
cp .env.example .env
pnpm install
```

Start one product surface:

```bash
pnpm run desktop:dev
pnpm run web:dev
pnpm run tui
```

Model-backed flows require `OPENROUTER_API_KEY`. Internet-backed flows require
`TAVILY_API_KEY`. Kestrel One also requires its hosted service configuration;
see `apps/web/.env.example`.

The CLI starts or attaches to Local Core and uses its authenticated Unix socket
for execution and evidence. Desktop still uses the transitional managed-runner
path. Local Core's 0.6 default is embedded PGlite; external PostgreSQL remains
an explicit advanced deployment choice. Desktop cutover and removal of
compatibility packaging are tracked in the local platform architecture plan.

## Registry Install

Install the released runtime and CLI package globally:

```bash
npm install --global @kestrel-agents/kestrel@0.5.1
kestrel --help
```

The package installs the `kestrel`, `ks`, and `kcron` commands.

## Common Commands

- `pnpm run build`: build the public runtime
- `pnpm run web:build`: build canonical Kestrel One
- `pnpm run desktop:build`: build Desktop
- `pnpm run desktop:package`: package Desktop
- `pnpm run docs:build`: build the docs site
- `pnpm run cli:package`: package the CLI/TUI distribution
- `pnpm run runner:service`: start the runner service
- `pnpm run install:cli`: install commands from the current checkout

## Validation Gates

Run focused checks first, then the repository gates:

```bash
pnpm run governance:check
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```

`evals:release-check` executes the exact released Ruhroh version pinned by the
workspace. It rejects source checkouts, copied adapters, and binary overrides.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Reliability](RELIABILITY.md)
- [Security](SECURITY.md)
- [Quality score](QUALITY_SCORE.md)
- [Contributing](CONTRIBUTING.md)
- [Documentation index](docs/index.md)
- [Desktop](apps/desktop/README.md)
- [Kestrel One](apps/web/README.md)
- [SDK](packages/sdk/README.md)
- [Evaluations](evals/README.md)

## Support

Use GitHub Issues for reproducible defects and feature requests. Do not file
security vulnerabilities publicly; follow [SECURITY.md](SECURITY.md).

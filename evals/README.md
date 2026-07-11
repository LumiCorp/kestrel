# Kestrel Evaluations

Kestrel owns the declarative scenarios, suites, target metadata, and behavior
ownership ledger in this directory. Ruhroh owns evaluation execution,
reporting, comparison, and the maintained `kestrel-cli` adapter.

No adapter implementation or copied runner protocol belongs under `evals/`.
The root workspace pins `@kestrel-agents/ruhroh@0.6.0-beta.0` exactly, and the
validator executes only that installed release. Source-checkout and binary
overrides are rejected.

```bash
pnpm install --frozen-lockfile
pnpm run evals:validate
pnpm run evals:release-check
pnpm run check:evals
```

The gate is credential-free. It verifies:

- complete behavior coverage in `migration/ownership-ledger.json`
- concrete test evidence for every runtime-owned replacement
- scenario and suite integrity for every Ruhroh-owned behavior
- exact scenario, instruction, package-version, and package-hash evidence
- Ruhroh scenario, suite, target, and maintained-adapter validation

The records under `migration/parity/` are immutable cutover evidence produced
from the published Ruhroh package. They are not an executable fallback and do
not authorize a copied evaluator to return to this repository.

New behavior belongs either in a maintained Ruhroh scenario or in a concrete
Kestrel runtime test, with that ownership recorded in the ledger.

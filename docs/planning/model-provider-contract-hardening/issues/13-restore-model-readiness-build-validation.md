# Restore model readiness build validation

## Failed behavior

The production web build cannot complete after the shared hosted-readiness path makes the NodeNext model adapters part of the compiled web graph. The resolver must map the adapters' runtime `.js` specifiers to their TypeScript source, but that compilation also exposes a fixed set of type-contract failures in the shared Local Core and test surfaces. This prevents the required browser and full validation gates from proving the hosted-readiness outcome.

## Affected work

[Show truthful hosted model readiness by role](11-show-truthful-hosted-model-readiness.md) adds the shared readiness path. The affected build path starts in `apps/web/next.config.ts`, crosses the model adapters and Local Core contracts, and fails in the exact TypeScript diagnostics recorded by `pnpm --dir apps/web exec tsc --noEmit` on August 26, 2026.

## Repair requirements

Restore a production web build that can compile shared NodeNext adapter sources without relying on emitted JavaScript beside source files. Correct only the reported type-contract mismatches in that compiled path. Preserve runtime behavior, provider routing, provider credentials, and model admission policy.

## Done when

- The Webpack resolver compiles shared NodeNext adapter source using its runtime specifiers.
- The recorded web TypeScript diagnostics are resolved without suppressing type checking or excluding the affected source files.
- `pnpm validate:chromium` and `pnpm validate` pass.
- Hosted-readiness behavior and its focused tests continue to pass.

## Depends on

- [Show truthful hosted model readiness by role](11-show-truthful-hosted-model-readiness.md) (implementation in progress)

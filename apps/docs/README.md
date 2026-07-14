# Kestrel Docs

This Next.js app publishes the consumer documentation for Kestrel at `docs.kestrelagents.dev`. It includes the editorial site shell, curated MDX content, public navigation, and local search.

## Local development

From the repository root:

```bash
pnpm run docs:dev
```

Before opening a deployment preview, run:

```bash
pnpm run docs:test
pnpm run docs:build
pnpm run docs:drift
pnpm run governance:check
```

The docs app does not need Kestrel runtime, database, provider, or authentication secrets. Examples may describe environment variables used by Kestrel applications, but those values are not read by this site.

## Vercel project

Use a dedicated Vercel project named `kestrel-docs` with these settings:

- Framework preset: Next.js
- Root directory: `apps/docs`
- Install command: use the repository default (`pnpm install`)
- Build command: use the app default (`pnpm build`)
- Output directory: leave unset
- Node.js: the repository-supported Vercel version
- Production branch: the repository's release branch

The dedicated project keeps docs previews, production promotion, and rollback independent from Kestrel One.

## Preview and verification

Create a preview deployment from the exact revision intended for review. Do not attach `docs.kestrelagents.dev` or use `--prod` during preview validation.

Run the deployment smoke suite against its immutable URL:

```bash
pnpm run docs:smoke -- https://kestrel-docs-example.vercel.app
```

The smoke suite checks the six public journeys, search index, sitemap, robots file, brand asset, permanent redirects, and excluded routes. Complete responsive and interaction QA in the browser before promotion.

Team previews remain protected. For automated checks, provide a scoped Vercel automation bypass secret without committing it:

```bash
VERCEL_PROTECTION_BYPASS=your-scoped-secret pnpm run docs:smoke -- https://kestrel-docs-example.vercel.app
```

For manual authenticated inspection, `vercel curl` can generate and use a temporary bypass for the linked project while leaving preview protection enabled.

## Production promotion and DNS

After the preview and required checks pass, promote that verified deployment rather than rebuilding a different revision. Attach `docs.kestrelagents.dev` to the project only during the production cutover. DNS changes remain a separate, explicitly approved operation.

After cutover, rerun the smoke suite against `https://docs.kestrelagents.dev` and verify canonical metadata, TLS, search, redirects, and a representative product image.

## Rollback

If production verification fails, use Vercel's deployment history to restore the last known-good production deployment. Rerun the smoke suite against the public domain after rollback. Content corrections should ship through a new preview; do not patch the production deployment in place.

## Source map

- Site metadata and canonical origin: `lib/site.ts`
- Public page registry: `lib/content-registry.ts`
- Public-content boundary: `lib/content.ts`
- Release metadata: `lib/release.ts`
- Deployment smoke suite: `scripts/smoke-deployment.ts`

# Kestrel brand assets

Status: **approved on July 22, 2026**.

This directory is the proposed repository-level source of truth for the monochrome Kestrel identity. The current review gate covers the standalone kestrel-head, the outlined Geist Sans Semibold “Kestrel One” lockup, black and white treatments, favicon reductions, and the logo-only social card.

## Source and construction

- The mark geometry is traced from `apps/desktop/assets/kestrel-head.png` using its alpha silhouette. The bird remains transparent negative space.
- The wordmark is title-case `Kestrel One`, set in Geist Sans Semibold and converted to glyph outlines.
- Canonical colors are `#111111` and `#ffffff` only.
- Regenerate intentionally with `pnpm brand:build`. Regeneration changes the approval hashes and requires a new visual approval.
- Copy the approved web subset with `pnpm brand:sync:web`.
- Copy the approved black-on-white Desktop icon set with `pnpm brand:sync:desktop`.
- Validate canonical and checked-in web assets with `pnpm brand:check`.

The approved review sheet is `brand/review/kestrel-one-brand-review.png`. `brand/approval.json` freezes the review and canonical master hashes.

## Clear space

Keep empty space equal to at least one quarter of the standalone mark’s rendered width on every side of a mark or lockup.

## Deprecated compatibility assets

The following red assets are deprecated and are not part of the future canonical identity:

- `apps/desktop/assets/kestrel-head.png`
- `apps/desktop/assets/kestrel-head.icns`
- `apps/desktop/assets/kestrel-head.ico`
- `apps/desktop/static/kestrel-full-horz-dark-mode.png`
- `apps/docs/public/brand/kestrel-mark.png`

The Desktop app icon now consumes the approved `kestrel-app-icon-light` exports. The
old Desktop PNG remains the geometry trace input for the canonical masters, while
the old native icon files are retained only as compatibility residue. Remove the
remaining red assets after the trace input and docs consumer have migrated.

# Kestrel Docs 0.6 Beta design QA

Source visual truth: `/Users/gregasher/.codex/generated_images/019f4d03-cd95-7fe2-900b-df22d8b83a02/exec-b3c183bb-c444-40b3-be75-b6d959d1b294.png`

Implementation: `http://127.0.0.1:43102/`

Browser-rendered evidence: `/Users/gregasher/.codex/visualizations/2026/07/10/019f4d03-cd95-7fe2-900b-df22d8b83a02/kestrel-docs-qa/`

State: production Next.js build, public unauthenticated docs, light theme, Kestrel 0.6.0-beta.0 Beta.

## Full-view comparison evidence

The reference and the 1440 x 1000 homepage implementation were placed into one normalized vertical comparison image at `kestrel-docs-reference-comparison.png`. The implementation preserves the reference's warm ivory field, Kestrel mark, Fraunces display type, Instrument Sans body type, restrained red accent, fine rules, flat three-column suite map, and quiet two-column secondary row. The consumer headline and longer introduction intentionally replace the earlier engineering-led reference copy without changing its composition.

The final homepage capture is `kestrel-docs-home-1440-final.jpg`. No actionable P0, P1, or P2 difference remains in composition, hierarchy, density, or above-the-fold pathway access.

## Focused-region comparison evidence

- `kestrel-docs-build-1440-final.jpg` checks the article shell, local navigation, article metadata, syntax-highlighted TypeScript, copy control, and a non-empty two-item TOC.
- `kestrel-docs-home-1024-viewport.jpg` checks the collapsed global navigation and retained three-column pathway map at 1024 x 768.
- `kestrel-docs-home-390-viewport.jpg` checks immediate mobile hero and first-pathway access at 390 x 844.
- `kestrel-docs-projects-390.jpg` checks responsive product media and readable article copy at 390 x 844.

Focused captures were necessary because the full-page reference comparison cannot show code-token color, mobile wrapping, screenshot captions, or interaction focus clearly enough.

## Required fidelity surfaces

- Fonts and typography: Fraunces and Instrument Sans load from the Next.js build; display hierarchy, body measure, line height, label tracking, and mobile wrapping remain legible at all reviewed sizes. Package labels preserve product casing such as `SDK`, `CLI`, and `Next.js`.
- Spacing and layout rhythm: the 1440 article shell resolves to 240 / 752 / 224 px columns; tablet and mobile show no horizontal overflow. Flat rules and aligned editorial columns replace card elevation and dashboard-style grouping.
- Colors and tokens: warm ivory surfaces, near-black typography, muted gray support text, and restrained Kestrel red match the selected direction. Code uses the intentional dark GitHub token theme with differentiated TypeScript and shell syntax.
- Image quality and asset fidelity: the supplied Kestrel brand mark and seven real product captures are used without replacement art. Product images retain aspect ratio, load at natural width, and include descriptive alt text plus contextual captions.
- Copy and content: homepage and product journeys lead with reader outcomes. Desktop, Kestrel One, Build, Operate, troubleshooting, reference, and migration pages use distinct narrative archetypes instead of one repeated template.

## Interaction and accessibility checks

- Search opens with representative results for all six sections, ranks “Waiting, resume, and cancellation” first for a matching task query, and opens the selected result with Enter.
- The mobile drawer exposes all six public sections plus `lumicorp.ai` and GitHub, closes successfully, and restores focus to its Menu trigger.
- Code copy writes the complete TypeScript example to the clipboard.
- The skip link is the first semantic control and transfers focus to the explicitly focusable `#app-main` target.
- The Desktop, Kestrel One, and Build pathway links resolve to the expected public journeys.
- Product media at 390 px retains its caption and meaning without horizontal overflow.
- Browser console inspection returned no warnings or errors on the homepage and representative article routes.
- Representative legacy URLs returned HTTP 308 redirects; Studio, archive, maintainer-only, and legacy chat routes returned 404.

## Comparison history

### Iteration 1

- P2, Desktop landing image claim: the reused Mission Control capture showed an empty/error state rather than the successful workspace session described by the caption. Fix: removed the image from the Desktop landing page and retained it only where a revised alt description and caption accurately explain the visible setup-blocked state.
- P2, product metadata casing: article facts rendered `Sdk`, which weakened package-name fidelity. Fix: added explicit `SDK`, `CLI`, `Next.js`, and `Kestrel One` display labels.
- P2, skip destination focus: `#app-main` was not an explicit programmatic focus target. Fix: added `tabIndex={-1}` and a client skip-link handler that focuses the main region.

### Iteration 2

Post-fix evidence is captured in `kestrel-docs-home-1440-final.jpg` and `kestrel-docs-build-1440-final.jpg`. Browser inspection confirmed `SDK` casing, a non-empty TOC, no overflow, no console errors, and successful focus transfer to `app-main`. No earlier P2 finding remains.

## Findings

No actionable P0, P1, or P2 findings remain.

## Follow-up polish

- P3: replace setup and empty-state product captures with populated release-quality states when signed Beta fixtures are available. Current captions accurately describe the visible states and do not make unsupported claims.

final result: passed

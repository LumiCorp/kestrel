# Kestrel Docs 0.6 Beta design QA

Source visual truth: local Codex-generated reference image (not committed).

Implementation: `http://127.0.0.1:43102/`

Browser-rendered evidence: local Codex visualization artifacts (not committed).

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

---

# Apps platform implementation QA

Source visual truth: `/var/folders/cl/_t5qmxn134j19nhj0pj1zqj40000gn/T/codex-clipboard-16d56551-24cb-4055-a476-ea247953e50c.png`

Implementation: `http://localhost:43104/apps` and the Apps tab of the local Release readiness Project.

Implementation screenshot: blocked; neither the in-app browser nor the supported Chrome fallback can attach to the current Codex browser-control session, so no current browser-rendered screenshot is available for this implementation revision.

Viewport: intended desktop comparison at 1492 x 1058.

State: Apps gallery plus the Google Calendar Project sheet with personal Calendar access and teammate free/busy sharing.

## Full-view comparison evidence

Blocked. The selected in-app browser control surface and the supported Chrome fallback both fail during browser-control initialization with `Cannot redefine property: process` before either can attach to the local page. The current gallery and Project sheet therefore cannot be captured at the matching viewport. HTTP health, typechecking, and automated service tests are not substitutes for rendered evidence.

## Focused-region comparison evidence

Blocked for the same reason. The Google Calendar sheet has not yet been captured and placed beside the selected reference in one comparison input for this implementation revision.

## Findings

- P0 verification blocker: current browser-rendered evidence, interaction checks, console inspection, and the required source-versus-implementation comparison are unavailable because both supported browser connections fail before page attachment.

## Comparison history

No valid visual iteration has been completed for the current Apps platform revision. The earlier Project Connections report above describes a prior prototype state and does not prove the current implementation. The implementation is reachable at the local URL and the full automated release gates pass, but those facts do not satisfy this visual gate.

## Implementation checklist

- Capture the Apps gallery and Google Calendar Project sheet at 1492 x 1058.
- Test gallery search and filters, App detail navigation, Google connect/remove controls, free/busy sharing, shared connection defaults, and capability policy controls.
- Inspect browser console output and responsive behavior.
- Place the reference and current implementation captures together, resolve all P0/P1/P2 findings, and update this report.

final result: blocked

---

# Project Connections design QA

Source visual truth: `/var/folders/cl/_t5qmxn134j19nhj0pj1zqj40000gn/T/codex-clipboard-16d56551-24cb-4055-a476-ea247953e50c.png`

Implementation: `http://localhost:43103/projects/docs-release-readiness`

Browser-rendered evidence: `.artifacts/` (local and not committed).

Viewport and state: 1492 x 1058, Release readiness project, Connections tab, Google Workspace panel open, Calendar included, Gmail and Drive not included, teammate calendar availability off. The selected reference is light; the user's in-app browser was in its system-dark preference, so the implementation evidence uses the same semantic layout in dark mode.

## Full-view comparison evidence

The reference and final browser render were normalized to the same viewport and placed together in `project-connections-comparison.png`. The project shell, 520 px provider list, selected Google row, 584 px consent panel, service rows, privacy-sharing section, and bottom consent actions align with the selected composition. The app's existing Activity tab remains present because it is established project functionality outside this feature.

## Focused-region comparison evidence

`project-connections-panel-comparison.png` places the reference and implementation Google panels side by side at the same 584 x 1058 crop. It confirms the header, three personal services, free/busy-only teammate capability, privacy note, consent assurance, and primary/secondary action order.

## Interaction and accessibility checks

- Provider rows are semantic buttons with visible keyboard focus treatment.
- Opening Google Workspace exposes a named dialog with a named close button.
- Gmail and Drive Add controls switch to Included; Included switches back to Add.
- The teammate calendar-availability switch changes between checked and unchecked states and has an explicit accessible name.
- Cancel and close dismiss the panel without mutating the connection state.
- Continue is disabled only when no personal Google service is selected; the prototype completion path updates the provider status and reports success locally without claiming that OAuth ran.
- Provider and service logos use real brand assets with descriptive alt text.
- Browser console inspection returned no errors.

## Comparison history

### Iteration 1

- P1, provider asset legibility: the first Microsoft and Slack assets were full wordmarks compressed into square icon slots, and ICO files were not rendered reliably through the Next image optimizer. Fix: replaced them with icon-only brand assets, converted the Tavily and Exa favicons to PNG, and served the small local assets unoptimized.
- P1, provider-list clipping: the initial 672 px list extended under the consent panel and partially hid the Google connection badge. Fix: matched the reference's 520 px content width.
- P2, consent-panel geometry: the initial panel was 24 px wider than the reference. Fix: matched the 584 px panel width.
- P2, consent action order: the initial desktop actions placed Cancel before Continue to Google. Fix: matched the reference's primary-then-secondary order.

### Iteration 2

Post-fix full-view and focused-panel comparisons confirm that all listed P1 and P2 differences are resolved. No actionable P0, P1, or P2 visual finding remains.

## Findings

No actionable P0, P1, or P2 findings remain in the selected Connections and Google consent-panel state.

final result: passed

---

The Project Connections report above is historical prototype evidence. The current Apps platform implementation QA is the controlling report for this feature and remains blocked until a current browser capture and comparison are completed.

final result: blocked

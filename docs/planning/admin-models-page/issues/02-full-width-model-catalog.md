# Show every provider model column at wide desktop widths

## Useful outcome

An organization admin can inspect a complete model row without horizontal scrolling when the desktop viewport is wide enough. Smaller and zoomed views retain access to every column through one semantic, horizontally scrollable table.

This slice completes the inspection scenario on the dedicated Models page created by Issue 01.

## What changes

- Render the selected provider's catalog as a full-width Models page region. Do not place it in the two-column `SettingsSection` layout that reserves a label column.
- Give Models an explicit wide-page capability in the organization shell. Keep the existing content measure for Connections, People, Billing, Email, Audit, and every other unrelated organization page.
- Preserve the table's seven columns: Model, Alias, Modality, Protocol, Status, Default, and Actions.
- At a sufficiently wide desktop viewport, leave at least 1,180 pixels for the table after organization navigation, layout gaps, and page padding.
- Retain horizontal scrolling below the width threshold and under browser zoom or enlarged text.
- Keep one semantic table with structural header and data cells. Do not hide columns, convert model rows to cards, or introduce a second compact row contract.
- Keep the add-model form, search, modality filter, approval filter, result count, provider selector, counts, and sync control usable at both wide and narrow widths.
- Add browser coverage for the complete wide-table view and the responsive fallback.

## Requirements and delivery context

The shared `PageContainer` in `apps/web/components/app-page.tsx` currently caps content at `max-w-7xl`. The organization layout in `apps/web/app/(workspace)/organization/layout.tsx` then consumes a 224-pixel navigation lane and a 32-pixel desktop gap.

The current catalog in `apps/web/components/settings/ai-providers-client.tsx` declares `min-w-[1180px]` but sits inside `SettingsSection`. That component, defined in `apps/web/components/settings/settings-section.tsx`, reserves another 12-to-17-rem label column and a large gap. Both constraints must be addressed. Removing only the inner section label does not create enough width.

The width capability must be explicit to Models. Do not widen every organization page as a side effect. Keep the table's `overflow-x-auto` behavior as the fallback rather than treating any horizontal scroll as a failure.

Acceptance must inspect rendered behavior, not only class names. Browser coverage must include:

- A wide desktop viewport with a provider whose rows populate all seven columns.
- The threshold below which horizontal scrolling begins.
- A mobile viewport and mobile organization navigation.
- The no-provider empty state delivered by Issue 01.
- Controls and row actions remaining reachable without clipped page content.

Update the relevant layout and settings-surface contract tests. Run `pnpm validate`, including the portable public-boundary, build, typecheck, and hermetic test gates. Run the Chromium validation boundary because this issue changes browser layout behavior.

## Done when

- At a wide desktop viewport that can satisfy the requirement, all seven headers and all row controls are visible at once without scrolling the catalog horizontally.
- The table uses at least its declared 1,180-pixel content lane after navigation, gaps, and padding.
- At narrower widths and under zoom, the catalog scrolls horizontally and every column remains reachable.
- Model rows remain semantic table rows with associated column headers.
- Provider selection, synchronization, add-model, filters, counts, editing, validation, and row actions remain usable at tested widths.
- Unrelated organization pages retain their current content measure.
- Automated contract and browser coverage proves the wide, threshold, mobile, and empty-provider states.
- `pnpm validate` and the Chromium validation boundary pass.

## Depends on

- [Give organization admins a dedicated Models page](01-dedicated-models-page.md) must reach `Done` because this issue applies the width contract and browser verification to that stable route and component boundary.

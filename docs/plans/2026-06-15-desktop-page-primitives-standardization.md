---
id: desktop-page-primitives-standardization
domain: web
status: finalized-plan
owner: kestrel-desktop
last_verified_at: 2026-06-15
depends_on:
  - apps/web/app/_components/KDesktopAppFrame.tsx
  - apps/web/app/_components/KDesktopConversationRail.tsx
  - apps/web/app/_components/KDesktopSettingsFrame.tsx
  - apps/web/app/globals.css
  - output/mockups/kestrel-desktop-single-sidebar-screens/
---

# Desktop Page Primitives Standardization

This plan inventories the current Kestrel Desktop page surfaces and projects the minimal page primitives the application should converge on. The goal is an ultra-minimal, flat app: one chrome, one page rhythm, one section model, and explicit opt-in for any visual weight.

## Hard Rule

The default screen should look like a calm desktop workspace, not a stack of panels. New primitives must reduce visible chrome. If a primitive mostly renames an existing wrapper without deleting borders, shadows, duplicated padding, or nested containers, it is not part of this pass.

## Final Design Direction

The final target is the corrected single-sidebar mockup set in [output/mockups/kestrel-desktop-single-sidebar-screens/](https://github.com/LumiCorp/kestrel/blob/main/output/mockups/kestrel-desktop-single-sidebar-screens/). The implementation anchors on [KDesktopAppFrame.tsx](https://github.com/LumiCorp/kestrel/blob/main/apps/web/app/_components/KDesktopAppFrame.tsx), [KDesktopSettingsFrame.tsx](https://github.com/LumiCorp/kestrel/blob/main/apps/web/app/_components/KDesktopSettingsFrame.tsx), and [globals.css](https://github.com/LumiCorp/kestrel/blob/main/apps/web/app/globals.css).

Kestrel Desktop should render as one continuous app shell:

- One left sidebar component, not a primary-nav column plus a conversation column.
- Sidebar order: brand, primary links, new-chat/actions, thread search, conversations, projects, product footer.
- Main content: a flat route header, then a scrollable page body with minimal wrappers.
- Settings, MCP Servers, and Debug are settings-family pages. They share the settings wrapper and section navigation inside the main page body, not the global sidebar.
- Mission Control remains a dense console page and should not be forced into a settings-shaped side-nav abstraction.
- Chat keeps its transcript and composer domain components, but the app chrome and sidebar placement match every other page.

This means the implementation must canonicalize the current `KDesktopAppFrame` contract first. Page primitives come after the global shell is stable.

## Flatness Rules

- Page bodies default to transparent surfaces.
- Sections default to divider-separated rows, not cards.
- Bordered surfaces are exceptions for modals, drawers, inspectors, selected records, embedded tools, and genuinely repeated peer items.
- Shadows are off by default.
- Nested bordered surfaces are disallowed unless the inner surface is an embedded tool or modal.
- Route-specific card vocabularies should shrink, not be recreated with new names.
- A page should need a clear reason for every border, background tint, radius, and shadow.

## Current Inventory

### Route shells

- `/` uses `app/page.tsx` with a route-level `<main id="app-main" className="kdesktop-route-main">`, then `ChatPageClient`.
- `/mission-control` returns `MissionControlPageClient` directly; the client owns `KDesktopAppFrame`, header, and page body.
- `/settings` uses a route-level `<main>`, then `SettingsPageClient`, which owns `KDesktopSettingsFrame`.
- `/mcp-store` and `/mcp-store/[serverId]` return `McpStorePageClient` directly; the client owns both `<main>` and `KDesktopSettingsFrame`.
- `/ops` uses `ops/layout.tsx` for the route-level `<main>`, then Debug pages own `KDesktopSettingsFrame`.
- `/desktop/editor` uses a route-level `<main>`, then `DesktopFileEditorWindow`.
- `/viewer` and `/workbench` redirect and do not own page chrome.
- `/dev/generative-ui` is a dev-only fixture route and should stay outside the canonical product shell unless promoted.

### Application chrome

- `KDesktopAppFrame` is the top-level desktop chrome. It owns the one-column sidebar, persistent conversation rail, mobile navigation, route header slot, content slot, and optional context pane.
- `KDesktopConversationRail` is the canonical sidebar body for non-chat routes. Chat may provide its own rail body, but it must render inside the same one-column sidebar slots.
- `KDesktopRouteHeader` is the shared route header, but pages still decide independently where it appears and how the body below it is structured.
- `KDesktopSettingsFrame` is currently the only shared sectioned page wrapper. It handles `KDesktopAppFrame`, `KDesktopRouteHeader`, the settings side nav, `app-page-stack`, `app-page-frame`, and a content column.
- `KDesktopContextPane` is the shared inspector shell, but inspector body patterns are still page-specific.
- `KDesktopSubnav` is now a legacy helper after Debug moved under Settings. It should not be used for product pages unless a new non-settings section requires it.
- `KDesktopSettingsLink` is still a useful topbar utility action on Chat and Mission Control.

### Page body vocabularies

- Generic page layout classes: `app-page-stack`, `app-page-frame`, `app-page-frame-lg`, `app-page-frame-xl`, `app-page-flow`.
- Generic bordered surfaces: `app-surface-card`, `app-field-card`, `app-code-panel`, `app-status-note`.
- Settings surfaces: `ksettings-page-shell`, `ksettings-page-body`, `ksettings-page-content`, `kdesktop-settings-nav`, `kdesktop-settings-group`, `kdesktop-settings-field`, `kdesktop-settings-inline-field`.
- Ops surfaces: `ops-card`, `ops-subcard`, `ops-grid`, `ops-table`, `ops-pill`, `ops-card-graph`, and related inspector classes.
- Mission Control surfaces: `kmission-main`, `kmission-shell`, `kmission-layout`, `kmission-grid-panel`, `kmission-table`, and task detail classes.
- Chat surfaces: `kchat-main`, `kchat-center-pane`, `kchat-center-scroll`, `kchat-scroll`, plus many chat-specific message, composer, thread, and context classes.

### Reusable data and detail components

- `CompactDataGrid`, `CompactGridToolbar`, `CompactGridPagination`, `CompactDetailsDrawer`, and `CompactCopyButton` are the strongest existing candidates for canonical dense data primitives.
- `ArtifactCard`, `ConsoleArtifactView`, `HtmlArtifactView`, and `GenerativeUiBlocks` are domain display components, not general page primitives.
- Thread components under `_components/thread` should remain chat-domain primitives.

## Assumption Audit

### Route-level `<main>` ownership is automatically lower risk

Weak assumption: every product route should own `<main id="app-main" className="kdesktop-route-main">` at the route or layout layer.

Skeptical read: the current app already mixes route-owned and client-owned shells. For client-owned pages like MCP Servers, putting `<main>` in the route file may be cleaner, but it also forces every dynamic route to remember the same wrapper. For nested layouts like Debug, layout-level ownership is already better. The actual invariant is not "route files own main"; it is "exactly one skip-link target exists per rendered page."

Constraint: add `KDesktopRouteMain`, then migrate by route family. Use route/layout ownership where a route family has a natural shared layout. Keep client ownership only when the page client is the true route shell and tests assert a single `#app-main`.

### `KDesktopSettingsFrame` can become the universal non-chat frame

Weak assumption: the settings wrapper can generalize cleanly to Settings, MCP Servers, Debug, and Mission Control.

Skeptical read: Settings, MCP Servers, and Debug share a section navigation model. Mission Control is a dense operational console with a grid/detail split, and forcing it into a settings-shaped side-nav frame could make the abstraction worse. The shared part is app chrome, header, scroll frame, width, context pane, and content density, not necessarily the side navigation.

Constraint: extract lower-level recipes first: page, section, and action recipes. Keep section navigation inside the settings frame until Settings, MCP Servers, and Debug prove a shared nav API. Only introduce or widen `KDesktopPageFrame` after those pieces represent both a sectioned settings page and a dense console without page-specific escape hatches.

Final decision: do not make `KDesktopSettingsFrame` the universal non-chat frame in the first implementation batch. Treat it as the settings-family wrapper for Settings, MCP Servers, and Debug. Extract the neutral `KDesktopPageFrame` only after duplicated page body wrappers have been removed and Mission Control proves what it needs.

### One `KDesktopSection` can replace most cards

Weak assumption: `kdesktop-settings-group`, `ops-card`, and `app-surface-card` are equivalent duplication.

Skeptical read: they overlap visually, but they serve different jobs. Settings groups are divider rows. Ops cards are sometimes repeated records or high-signal debug panels. Chat cards include transcript-adjacent artifacts, modals, and context panes. Flattening all of them would harm scanability in places where framed repeated items are useful.

Constraint: make flat sections the default only for page body groupings. Keep bordered surfaces for repeated list items, modal bodies, inspector panels, embedded tools, and selected/detail states. Migrate by use case, not by class name.

### Existing CSS names are acceptable as canonical names

Weak assumption: wrapping `kchat-main`, `app-page-stack`, and `app-page-frame` in a page-content primitive is enough.

Skeptical read: `kchat-main` is now used beyond chat, but the name still leaks old ownership into canonical page layout. If a new primitive permanently depends on chat-named classes, the standardization preserves semantic drift instead of fixing it.

Constraint: a wrapper can temporarily reuse old classes, but the public primitive names should be neutral. Track a later CSS rename only after the component boundary is stable and visual output is unchanged.

### Compact data components are ready to be canonical

Weak assumption: `CompactDataGrid` and related components can become the default table/data stack.

Skeptical read: they are the strongest current candidates, but Mission Control, Debug graph, run detail timelines, and settings tables have different interaction requirements. A premature canonical grid can become a lowest-common-denominator table.

Constraint: promote compact data primitives only for dense tabular data with matching interaction needs. Do not migrate timeline, graph, transcript, or dashboard layouts into them unless the interaction model already fits.

### One action primitive can replace all button styles

Weak assumption: `KDesktopAction` can replace route text buttons, icon buttons, chips, and prompt chips across the app.

Skeptical read: action controls have different semantics in route headers, chat composer controls, mode selectors, command menus, and operational tables. A single visual component can blur affordances if it is too broad.

Constraint: standardize route-level actions first: topbar buttons, settings/debug page actions, and context-pane actions. Leave composer, transcript, and command-menu controls domain-specific until their states and keyboard behavior are inventoried.

### `KDesktopSubnav` and `ops-shell` are safe to delete soon

Weak assumption: no active product page needs these after the settings-wrapper migration.

Skeptical read: source search shows `KDesktopSubnav` is currently unused in product clients, and `ops-shell` is stale CSS after Debug moved to `kdesktop-route-main`. But tests still reference these names as assertions. Deleting them before updating tests would blur whether the migration changed behavior or just removed legacy contracts.

Constraint: treat removal as a final cleanup batch. First add replacement assertions around the new primitives, then remove stale helpers and CSS.

### Chat should stay outside standardization

Weak assumption: excluding chat transcript, composer, and thread rendering means Chat does not participate in this pass.

Skeptical read: Chat is still the most complicated page and uses many generic surface classes. It should not be rewritten as generic page layout, but its context pane, modals, route actions, and generic cards are part of the app-wide visual language.

Constraint: exclude chat-domain rendering, not all Chat surfaces. Route header actions, context inspector bodies, modals, status notes, and non-transcript utility cards can migrate after the non-chat pages establish the primitive boundaries.

### Visual standardization is mostly a component extraction task

Weak assumption: fewer components and class names will automatically flatten the UI.

Skeptical read: the original problem is visual nesting. Component extraction can preserve nested borders if the default variants are wrong. The important decision is which primitive defaults to flat, which primitive opts into a surface, and where spacing/dividers live.

Constraint: every extracted primitive must declare its default visual weight. The default page section should be flat. Bordered surfaces should require an explicit `surface` or equivalent variant.

### More primitives means more consistency

Weak assumption: every repeated pattern deserves a named React primitive.

Skeptical read: a large primitive set makes the app feel systematized on paper while increasing the number of places that can add borders, wrappers, props, and variants. The target is not a complete design system; it is a smaller visual grammar.

Constraint: start with recipes and delete duplicated wrappers before adding React components. Add a component only when it owns structure, accessibility, keyboard behavior, or repeated slots. Otherwise use a recipe.

### A template layer should expose many variants

Weak assumption: variants make the system flexible enough for the whole app.

Skeptical read: variant-heavy primitives are how card-heavy applications reappear under cleaner names. The first version should encode fewer choices, not more.

Constraint: each recipe gets the minimum variants needed for known pages. For sections, start with `flat` and `surface` only. For density, start with `standard` and `dense`. Add variants only after two real call sites need the same behavior.

### Tailwind-like templating means adding another styling system

Weak assumption: adding a templating layer requires introducing a new styling dependency.

Skeptical read: `apps/web` already uses Tailwind v4 through `@import "tailwindcss"` and `@tailwindcss/postcss`. The missing piece is not utility generation; it is a small local recipe layer that names canonical combinations of layout, spacing, density, and surface weight. Pulling in another styling framework would create a second source of truth while the current goal is to reduce surface area.

Constraint: build the templating layer on top of the existing Tailwind and CSS-token stack. It should be local, typed, visual-only, and limited to canonical primitives. Do not use it to encode route classification, runtime behavior, or domain heuristics.

## Template Layer

The canonicalization should include a template layer, but it should be smaller than a design system package. Treat it as "Tailwind recipes for Kestrel Desktop": named class recipes and slot templates that primitives consume. The template layer exists to remove visual decisions from pages, not to create a broad styling API.

### Existing foundation

- `apps/web` already depends on Tailwind v4 and imports it from `apps/web/app/globals.css`.
- The app already has semantic CSS variables for color, radius, shadows, spacing, and surfaces.
- Several components already use Tailwind utility classes directly, but those utilities are mixed with route-specific CSS class names.

### Proposed shape

Add a local recipe module before broad component extraction:

- `apps/web/app/_components/ui/cx.ts` for a small class combiner.
- `apps/web/app/_components/ui/recipes.ts` for canonical class recipes.
- `apps/web/app/_components/ui/primitives.tsx` only for wrappers that need structure, slots, ARIA, or behavior.

Avoid adding dependencies such as `class-variance-authority` until local recipes become painful. The first pass can use plain TypeScript maps and a tiny `cx` helper.

### Recipe categories

- `page`: scroll frame, page stack, width, density.
- `section`: flat default, surface opt-in, divider rules.
- `action`: primary, secondary, ghost, danger, icon.
- `field`: row, label, input, select, toggle.
- `data`: table, metadata list, code block, notice, badge.

### Template rules

- Templates expose intent, not implementation names. Prefer `section({ variant: "flat" })` over exposing `kdesktop-settings-group`.
- Every template has a flat or low-chrome default unless it is explicitly a modal, repeated record, inspector panel, selected record, or embedded tool.
- Templates accept explicit props only. No route-name branching, URL matching, content sniffing, or status inference.
- Recipes may temporarily reuse old CSS class names, but public recipe names must be neutral.
- A component can use raw Tailwind for one-off layout details, but repeated page chrome must go through a recipe or primitive.
- Recipes should delete page-local wrapper classes over time. A recipe is not successful if it simply composes old card classes indefinitely.

### Example API direction

```tsx
<KDesktopSection
  title="Runtime"
  description="Current runner profile and controls."
  actions={<KDesktopAction variant="secondary">Ping</KDesktopAction>}
>
  ...
</KDesktopSection>

<KDesktopSection variant="surface" density="dense">
  ...
</KDesktopSection>
```

The first example should render flat by default. The second opts into a bordered surface intentionally.

## Minimal Primitive Set

The target primitive set is intentionally small. Prefer recipes over components unless structure or accessibility requires React.

### 1. `KDesktopAppFrame`

Keep this as the only app chrome primitive. It should own:

- one-column sidebar state and navigation;
- persistent conversation rail placement;
- route header slot;
- main content slot;
- optional context pane;
- mobile navigation plumbing.

Pages should not recreate these behaviors. The sidebar must remain one component with one visual column. Route-owned rail content can vary, but it renders inside the same sidebar body slot.

### 2. `KDesktopRouteMain`

Add a tiny server-safe wrapper for the repeated route-level main element:

- renders `<main id="app-main" className="kdesktop-route-main">`;
- accepts children only;
- keeps skip-link behavior consistent.

Every product route should use this at the route/layout layer or intentionally let a page frame render it. Pick one ownership rule before migration; the lower-risk rule is route/layout ownership.

### 3. `KDesktopPageFrame`

Add this only after the route shell and recipe layer are stable. It should become the neutral page frame for non-chat product pages, while `KDesktopSettingsFrame` remains a compatibility wrapper during migration. It should support:

- `currentRoute`;
- `title`, `description`, `metadata`, `primaryActions`, `utilityActions`;
- optional section navigation;
- optional context pane;
- width variant: `default`, `wide`, `full`;
- body density: `standard`, `dense`;
- children and optional footer.

Settings, MCP Servers, and Debug should be first consumers through the compatibility wrapper. Mission Control should migrate only if the frame supports its dense grid without adding a fake settings side-nav.

### 4. Template recipes

Add a typed recipe layer that primitives consume. The layer should:

- reuse Tailwind v4 utilities and existing CSS variables;
- make variants explicit;
- keep default page sections flat;
- allow bordered surfaces only through an explicit variant;
- avoid behavior, route ownership, or data interpretation.

### 5. `KDesktopSection`

This is the only standard content grouping primitive. It should replace separate settings groups, most ops cards, and generic page-body cards.

- Default: flat, transparent, no shadow, no border, divider below when stacked.
- `surface`: opt-in border/background for repeated records, selected records, inspectors, embedded tools, modals, and drawers.
- Supports optional title, description, metadata, and actions.
- Does not support decorative variants.
- Does not support nested section surfaces by default.

### 6. `KDesktopAction`

One route/page action primitive:

- `variant`: `primary`, `secondary`, `ghost`, `danger`;
- `shape`: `text` or `icon`;
- supports `button` and `Link`;
- standardizes icon sizing, tooltip labels, disabled state, and focus state.

Do not migrate chat composer, command menu, transcript controls, or mode controls into this until their keyboard and state behavior is inventoried.

### 7. `KDesktopField`

One form row primitive and a few boring controls:

- `KDesktopField`;
- `KDesktopTextInput`;
- `KDesktopSelect`;
- `KDesktopToggle`.

Inline rows, segmented controls, and custom field layouts should start as recipe variants only if needed by two call sites.

### 8. Data recipes

Promote existing compact data components only where they already fit. Use recipes for simple display patterns:

- table;
- metadata list;
- code block;
- notice;
- badge.

Do not create separate `Status` or `Inspector` component families in the first pass. They are data/display recipes unless they need interaction.

## Deferred Or Removed Primitive Candidates

These names are intentionally not first-pass primitives:

- `KDesktopPageContent`: keep as an internal recipe or private helper unless it needs public structure.
- `KDesktopSectionNav`: extract only after the settings frame proves the nav API is stable.
- `KDesktopStatus`: use data recipes first.
- `KDesktopInspectorSection`: use `KDesktopSection variant="surface"` plus data recipes first.
- `KDesktopDefinitionList`: use a metadata-list recipe first.
- `KDesktopSegmentedControl`: keep local until repeated outside Settings or Chat controls.

## Section Navigation

Section navigation is still needed for Settings, MCP Servers, and Debug, but it should not become a large primitive upfront.

When the shared nav API is stable, extract the side navigation inside `KDesktopSettingsFrame` into a standalone primitive:

- supports links, buttons, and dividers;
- owns active state styling and `aria-current`;
- accepts an `ariaLabel`;
- avoids page-specific naming like `kdesktop-settings-nav` once generalized.

Settings, MCP Servers, and Debug can continue sharing the same nav items, but the primitive should not be settings-specific.

## Implementation Batches

### Batch 0: Lock The Shell Contract

Status: in progress.

Scope:

- Keep `KDesktopAppFrame` as the only global app shell.
- Keep `KDesktopUnifiedSidebar` as one visual column.
- Keep Chat, Mission Control, Settings, MCP Servers, Debug, and Desktop Editor aligned with the single-sidebar mockups.
- Add or keep smoke assertions that reject `kdesktop-route-primary-pane`, `kdesktop-route-conversation-pane`, and the old primary-sidebar width variable.

Acceptance:

- `/`, `/mission-control`, `/settings`, `/mcp-store`, `/ops`, `/ops/graph`, and `/desktop/editor` visually match the single-sidebar composition.
- The global sidebar contains primary links and conversation/project controls in one column.
- No page introduces a second sidebar column beside the app rail.

### Batch 1: Route Main And Recipe Layer

Scope:

- Add `KDesktopRouteMain`.
- Add `apps/web/app/_components/ui/cx.ts`.
- Add `apps/web/app/_components/ui/recipes.ts`.
- Start with recipes for page, section, action, field, and data display.
- Do not add third-party styling dependencies.

Acceptance:

- New recipes expose intent and density, not route names.
- Existing CSS variables and Tailwind v4 remain the styling foundation.
- At least one settings-family page uses recipes without changing behavior.

### Batch 2: Flatten Settings-Family Page Bodies

Scope:

- Keep Settings, MCP Servers, and Debug inside `KDesktopSettingsFrame`.
- Remove nested `app-page-frame` usage inside already framed settings-family pages.
- Replace settings groups and page-level cards with flat `KDesktopSection` or section recipes.
- Preserve bordered surfaces only for repeated records, selected/detail states, inspectors, embedded tools, modals, and drawers.

Acceptance:

- Settings-family pages keep one page wrapper and no nested card stack.
- MCP detail and Debug detail pages use the same flat section rhythm.
- Remaining bordered surfaces are explicitly justified by role.

### Batch 3: Neutral Page Frame

Scope:

- Introduce `KDesktopPageFrame` if Batch 2 proves the shared slots are stable.
- Make `KDesktopSettingsFrame` a thin section-navigation wrapper around `KDesktopPageFrame`.
- Keep section navigation optional and local to page bodies.

Acceptance:

- Settings, MCP Servers, and Debug still render through the settings-family wrapper.
- No global sidebar behavior moves into page frames.
- No route-specific behavior or heuristics enter the frame.

### Batch 4: Actions, Fields, And Data Cleanup

Scope:

- Migrate route-level buttons and links to `KDesktopAction`.
- Migrate repeated settings rows to `KDesktopField` and boring form controls.
- Promote compact data components only where interaction already matches.
- Leave Chat composer, command menus, transcript controls, graphs, timelines, and dashboards domain-specific.

Acceptance:

- Route-level actions have one visual grammar.
- Settings forms lose duplicated wrapper styles.
- Dense operational data remains dense and scannable.

### Batch 5: Mission Control And Legacy Cleanup

Scope:

- Evaluate Mission Control against the neutral page frame without forcing section navigation.
- Delete unused `KDesktopSubnav`, stale `ops-shell` CSS, and obsolete card classes after replacement assertions exist.
- Rename old chat-owned generic CSS only after component boundaries are stable and visual output is unchanged.

Acceptance:

- Mission Control keeps its console layout.
- Legacy helper and CSS removal is covered by updated smoke tests.
- No visual regression from CSS renames.

### Implementation Status

- Complete: shell contract, route main, recipe layer, neutral page frame, Settings-family flattening, Debug/Ops page grouping cleanup, and route-level action standardization outside Chat-owned surfaces.
- Complete: `KDesktopSubnav`, `ops-shell`, `ops-card`, `ops-card-graph`, `kdesktop-settings-group`, `kdesktop-settings-field`, and `kdesktop-settings-inline-field` are retired from active app CSS and product components.
- Deferred: Chat transcript, composer, command menus, modal button classes, and `app-surface-card` remain domain-owned until a separate chat surface pass can verify unchanged behavior.

## Original Migration Order

1. Add `KDesktopRouteMain` and choose route/layout ownership for `<main>`.
2. Add `cx` and minimal page, section, action, field, and data recipes.
3. Normalize nested page frames, starting with `McpStorePageClient` detail/fallback sections that currently add `app-page-frame` inside the settings wrapper.
4. Wrap or rename `KDesktopSettingsFrame` as `KDesktopPageFrame` only after nested frames are gone.
5. Replace `kdesktop-settings-group` with flat `KDesktopSection`.
6. Replace common `ops-card` shells with flat sections only where the content is page grouping, not repeated records or embedded tools.
7. Standardize route-level actions with `KDesktopAction`.
8. Move simple form rows to `KDesktopField`; leave specialized settings controls local until repeated.
9. Move Mission Control onto the page frame only if it can keep its dense grid without a settings-shaped wrapper.
10. Extract section navigation after Settings, MCP Servers, and Debug share the same stable nav model.
11. Delete unused `KDesktopSubnav`, stale `ops-shell` CSS, and obsolete card classes after replacement assertions exist.

Keep this order as a dependency checklist, but implement through the batches above.

## Non-Goals

- Do not rewrite chat transcript, composer, or thread rendering as generic page primitives.
- Do not change runtime contracts, data fetching, or Debug behavior during the visual standardization.
- Do not introduce new heuristic UI behavior or route classification.
- Do not collapse domain-specific data displays until the page shell and section primitives are stable.
- Do not add a broad component library.
- Do not add visual variants speculatively.
- Do not preserve nested cards for visual continuity if the content can be represented as flat sections.

## Validation

For each migration batch:

- run `pnpm --filter @kestrel/web test`;
- visually verify `/`, `/mission-control`, `/settings`, `/mcp-store`, `/ops`, and `/ops/graph`;
- visually compare against `output/mockups/kestrel-desktop-single-sidebar-screens/_review-contact-sheet.png`;
- inspect representative pages for nested bordered surfaces and justify any that remain;
- run broader repo gates only for shared runtime or cross-package changes.

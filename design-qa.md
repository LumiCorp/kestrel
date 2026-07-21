# Desktop navigation and title bar design QA

**Source visual truth**

- User-provided cut-and-paste mockup for the Desktop navigation and title bar.

**Implementation evidence**

- Final full-window capture reviewed during implementation.
- Full source-to-implementation comparison reviewed during implementation.
- Focused header and navigation comparison reviewed during implementation.

**Viewport and state**

- Implementation viewport: 1482 x 859.
- Source mockup normalized from 1474 x 852 to 1482 x 859 for comparison.
- Light theme, Git and pull requests surface, preview fixture data, active `New conversation` thread.

**Full-view comparison evidence**

- The surface icons form a vertical rail on the sidebar's inside edge and preserve clear selected, hover, and focus affordances.
- The active thread is the primary title at the left of the content header; the current page remains independently centered in the header.
- The application uses the canonical Kestrel mark rather than the former text glyph.
- Existing Kestrel density, borders, colors, component sizing, and content behavior remain intact. The cut-and-paste mockup proposes structure rather than a new visual system, so existing product tokens remain authoritative.

**Focused comparison evidence**

- The focused crop confirms the brand lockup, thread-title hierarchy, sidebar context, and vertical icon geometry at readable scale.
- The implementation keeps the sidebar narrower than the mockup while retaining equivalent information and a larger working canvas; this is an intentional use of the existing `--rail-width` token, not a fidelity defect.

**Required fidelity surfaces**

- Fonts and typography: existing Inter/system stack is preserved; the 20 px thread title establishes the requested hierarchy without exceeding the compact 50 px title bar.
- Spacing and layout rhythm: the 44 px icon rail aligns to the sidebar's content edge; header and surface boundaries remain on the established grid.
- Colors and visual tokens: existing surface, border, accent, health, and text tokens are preserved in light mode.
- Image quality and asset fidelity: the canonical raster Kestrel mark is bundled by Vite and its transparent padding is cropped in presentation; no placeholder or drawn substitute remains.
- Copy and content: the header exposes both the persisted thread title and the selected surface label. The local/worktree selector and managed setup copy are absent from the composer.

**Findings**

- No actionable P0, P1, or P2 differences remain.

**Comparison history**

- Initial pass: the canonical mark appeared undersized because the source asset contains generous transparent padding, and the thread title was less prominent than the mockup.
- Fix: added a clipped mark container that scales the real asset within its slot and increased the thread title from 17 px to 20 px.
- Post-fix evidence: the final full and focused comparisons show a legible Kestrel icon and stronger thread-title hierarchy with no overlap or clipping.

**Interactions and runtime checks**

- Clicked Git and pull requests from the vertical rail; exactly one target resolved.
- Confirmed the selected navigation state, thread title, and page title updated coherently.
- Browser console errors: none.

**Follow-up polish**

- P3: the mockup's larger sidebar and title-bar proportions could be explored later, but changing those shared tokens is not required for this scoped navigation adjustment.

---

# Kestrel One shared Apps experience design QA

- Source visual truth: browser annotation screenshots supplied for Comment 1 and Comment 2 on `/settings/environments/f98a9276-c2a3-47fe-a2c6-48171856bada/apps`
- Gallery implementation screenshot: `kestrel-one-audit/03-environment-app-gallery.png`
- Detail implementation screenshot: `kestrel-one-audit/04-environment-app-detail.png`
- Top-level gallery screenshot: `kestrel-one-audit/05-global-app-gallery.png`
- Top-level detail screenshot: `kestrel-one-audit/06-global-app-detail.png`
- Projects gallery screenshot: `kestrel-one-audit/07-projects-gallery.png`
- New Project screenshot: `kestrel-one-audit/08-new-project.png`
- New Thread polish screenshot: `kestrel-one-audit/09-new-thread-polish.png`
- Project Apps screenshot: `kestrel-one-audit/10-project-apps-full-width.png`
- Viewport: 1327 x 964, desktop, dark theme
- State: authenticated organization administrator, default Environment, eight ready Apps, Artifacts detail

## Full-view comparison evidence

The annotated source showed each installed App expanded into a full settings card, placing connection state and every capability control in one continuous Apps page. The revised implementation presents the same installed set as a compact five-column icon gallery. Each tile has one icon, name, concise description, and readiness signal, and links to a dedicated Environment App settings route. The resulting gallery keeps all eight installed Apps visible above the custom-app settings without nested App cards.

The source annotation and the gallery/detail captures were reviewed together against the requested IA: selection is now visually separate from configuration, while the existing Environment header, navigation, type scale, dark tokens, and shared page shell remain intact.

The top-level `/apps` route now uses the same shared gallery primitive as Environment and Project Apps. Its discovery tabs, search, category filters, install state, and catalog scope remain intact. Opening a top-level App uses the same shared App settings header and flat, border-separated section language as the Environment detail screen.

The Projects comparison removes the permanently visible creation card from the gallery. A primary New Project affordance now opens a dedicated flat settings form and returns successful desktop creation to the gallery. The annotated new-Thread surface was tightened by aligning the greeting with the composer, reducing suggestion density, and replacing the Shared Project label with an icon and hover label. Project Apps now fills its tab panel and omits the duplicate section introduction.

## Focused region comparison evidence

- Gallery: icon tiles use a flat bordered grid with hover and focus states rather than individual cards.
- Navigation: selecting an App opens `/settings/environments/:id/apps/:appKey`; the Apps tab remains active on nested routes.
- Detail: connection and access-ceiling controls are shown only for the selected App, with a clear return link to the gallery.
- Controls: approval labels and switches are visible after hydration and remain aligned in compact rows.
- Shared use: the same gallery component now renders the Environment gallery, the global Apps catalog, and Project Apps selection.
- Shared detail language: both top-level and Environment App settings use the same icon header, return affordance, status treatment, section rhythm, and compact rows.
- Responsive structure: the gallery moves from two columns to three, four, and five columns without horizontal overflow.

## Required fidelity surfaces

- Fonts and typography: existing Kestrel font family, weights, line heights, and hierarchy are preserved. Tile labels use compact 14 px text and descriptions use readable 12 px supporting text.
- Spacing and layout rhythm: tiles use consistent icon-to-label spacing and a flat grid rhythm; detail settings use border-separated rows rather than nested cards.
- Colors and visual tokens: existing background, foreground, muted, border, primary, emerald readiness, and amber attention tokens are preserved.
- Image quality and asset fidelity: existing integration image assets, Simple Icons, and Lucide icons are reused through the shared `AppIcon`; no placeholder drawings or new custom icon assets were introduced.
- Copy and content: readiness and app descriptions remain catalog-backed. The index copy now directs users to select an App, and detail copy stays scoped to that App's connections and access ceiling.

## Findings and comparison history

- Pass 1 findings: P1 information overload from expanded settings cards; P1 no dedicated App detail destination; P2 inconsistent Apps selection patterns across Environment, global, and Project surfaces.
- Fixes: added the shared compact App gallery, moved Environment App settings into a dynamic detail route, preserved Apps-tab active state for nested routes, and adopted the gallery in all three Apps selection surfaces.
- Pass 2 findings: P2 approval labels were absent in the first immediate detail capture because Radix Select hydration had not completed.
- Fix: verified the hydrated state and recaptured the detail after the controls exposed their `Automatic` labels.
- Pass 3 evidence: the matched gallery and detail captures show no nested App cards, no hidden primary controls, no clipped content, and no horizontal overflow. No actionable P0, P1, or P2 visual issues remain.
- Pass 4 findings: P1 top-level App detail still used card-based, two-column presentation; P2 the Tavily integration image failed through the local image optimizer.
- Fixes: rebuilt top-level App detail with the shared flat settings primitives and served catalog integration icons directly from their public asset paths.
- Pass 5 evidence: top-level gallery and Artifacts detail match the shared IA, all visible image assets load, search reduces the gallery to the requested App, and there is no horizontal overflow.
- Pass 6 findings: P1 Project creation competed with the Project gallery; P2 new-Thread greeting and suggestions did not share the composer's alignment and density; P2 Project Apps was artificially capped at 32.5rem and repeated the tab label.
- Fixes: added a dedicated `/projects/new` route with a compact settings grid, moved the New Project affordance into the Projects header, aligned and muted the new-Thread empty state, reduced the shared-project marker to an icon with hover text, and made Project Apps fill the tab panel.
- Pass 7 evidence: Projects gallery, New Project, new Thread, and Project Apps were captured at the annotated 1327 x 964 viewport. The creation form is isolated, new-Thread edges align, and the Project Apps grid spans the available parent width without redundant copy.

## Verification completed

- Gallery-to-detail navigation and return path rendered successfully in the authenticated in-app browser.
- The global Apps catalog rendered through the same gallery component.
- Project Apps compiled against the same gallery selection contract.
- Browser console contained no warnings or errors in the inspected Environment gallery and detail states.
- A clean top-level gallery/detail browser pass contained no warnings or errors.
- Projects gallery, dedicated creation route, new-Thread empty state, and full-width Project Apps rendered in the authenticated local preview.
- Kestrel One TypeScript and focused Ultracite checks passed.

final result: passed

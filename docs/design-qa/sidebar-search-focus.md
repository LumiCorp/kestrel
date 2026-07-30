# Desktop sidebar search focus design QA

**Comparison Target**

- Source visual truth: `codex-clipboard-c9af5c8f-68f8-4015-b9b5-553aae186b5d.png` (user-provided conversation attachment)
- Rendered implementation: `apps/desktop/out/design-qa/sidebar-search-query-focus.jpg`
- Focused side-by-side comparison: `apps/desktop/out/design-qa/sidebar-search-focus-comparison.png`
- Browser viewport: `1280 x 720` CSS px
- Source pixels: `222 x 166`; normalized comparison crop: `215 x 166`
- Implementation pixels: `215 x 166`
- Density: device scale factor `1`; source width normalized to the implementation crop
- State: light theme, Find Work open, Conversations active, populated search input keyboard-focused

**Findings**

- No actionable P0, P1, or P2 findings remain.
- The reference showed two competing focus borders: the persistent search-shell border and a second outline around the native input. The implementation now puts the focus color on the outer `.explorer-search` shell and suppresses only the input's nested outline.
- Typography, labels, row density, margins, and search-control geometry are unchanged.
- The focus treatment uses the existing `--focus-ring` token in both light and dark themes. Computed light focus color is `rgb(88, 106, 130)`; computed dark focus color is `rgb(135, 147, 163)`.
- Existing Lucide search and clear icons, conversation copy, and active conversation treatment are unchanged.
- Opening Find Work moves keyboard focus to the search input. Empty and populated search states were exercised; browser console error check returned no errors.

**Open Questions**

- None.

**Comparison History**

- Iteration 1 — [P2] The screenshot exposed a nested input outline inside the bordered search shell, making the focused state look doubled and visually noisy.
- Fix — moved the focus indication to `.explorer-search:focus-within` and removed the nested `input:focus-visible` outline.
- Post-fix evidence — `apps/desktop/out/design-qa/sidebar-search-focus-comparison.png` shows a single focus border around the whole search control.

**Implementation Checklist**

- [x] Preserve the search shell's idle border.
- [x] Use one outer focus border for keyboard and pointer focus.
- [x] Remove the nested input focus outline.
- [x] Verify light and dark theme focus tokens.
- [x] Preserve search, clear, grouping, and conversation-selection behavior.

**Follow-up Polish**

- None required.

final result: passed

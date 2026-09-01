# Browser Viewer Presentation Design Notebook

## Current Position

Keep the live Browser viewer inside the conversation, but present it as a
first-class session surface instead of a debug panel. The session card uses the
existing Desktop viewer state and actions. It does not add a new window,
contract, or persisted setting.

## Requested Change

Make the Desktop Browser viewer look professional and production-ready while
preserving live viewing, takeover, return, disconnect, close, loading, and
failure behavior.

## Starting Sources

- User-supplied screenshot from the packaged Desktop smoke.
- `apps/desktop/renderer/src/BrowserViewer.tsx`.
- `apps/desktop/renderer/src/styles/conversation.css`.
- `apps/desktop/tests/browserViewerInteraction.test.tsx`.
- Apple Human Interface Guidelines for toolbars and buttons.
- WCAG 2.2 guidance for target size and visible keyboard focus.

## Relevant Current Behavior

`DesktopApp.tsx` places `BrowserViewer` directly above the conversation
timeline. The viewer renders a plain header, four equally weighted buttons, and
a black frame. Loading and error states are raw text. The component already has
the state needed to distinguish agent control, requested takeover, active human
control, and lost viewer availability.

The screenshot shows the result: the viewer does not read as part of the
Desktop design system, the actions have no hierarchy, and the empty black frame
dominates the conversation.

## Affected Surface

- Browser viewer markup and accessible names.
- Conversation-level Browser viewer styles.
- Packaged Desktop visual smoke evidence.
- Existing viewer interaction tests.

No runtime, IPC, policy, storage, or Browser authority contract changes.

## External Research

[Apple's toolbar guidance](https://developer.apple.com/design/human-interface-guidelines/toolbars)
recommends that a toolbar orient people and group a deliberate, limited set of
actions. [WCAG 2.2 target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
requires pointer targets of at least 24 by 24 CSS pixels unless spacing provides
an equivalent target. [WCAG focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)
requires keyboard focus to remain easy to locate.

These findings support one primary control action, restrained session lifecycle
actions, 28-pixel controls, and an inset two-pixel focus ring on the interactive
viewport.

## Candidate Seams and Options

### Separate Browser window

Rejected. It would add window lifecycle, layout, and authority complexity and
would separate the live result from the run that owns it.

### Floating overlay over the conversation

Rejected. It would obscure transcript content and create resize and focus
problems.

### Structured session card in the current location

Selected. `BrowserViewer` already owns the exact state and actions. The change
can remain local to the component and its CSS.

## Proposed Delta

- Use a compact session header with a Browser icon and explicit control state.
- Show only takeover or return as the primary action.
- Keep disconnect secondary and close as a titled icon action.
- Present the live frame inside a bounded viewport with a small live indicator.
- Replace raw empty space with a designed connecting state.
- Show view-only or active-input guidance below the frame.
- Present failures as a compact alert with a retry action.
- Preserve keyboard and pointer behavior and all existing bridge calls.
- Capture the live component during the packaged smoke before session close.

## Decisions

- Keep the viewer in the conversation. Confidence: high.
- Reuse the existing Desktop visual tokens. Confidence: high.
- Use one primary action at a time. Confidence: high.
- Do not display a fake URL or navigation controls. Confidence: high.
- Do not add animation beyond a reduced-motion-safe loading indicator.
  Confidence: high.

## Active Change Frontier

No product decision blocks implementation. Visual acceptance requires the
packaged component screenshot.

## Decision Map

- Status: not needed
- Path: none
- Destination: none
- Return condition: none

## Best Next Move

Build the packaged Desktop app, run the paused Browser smoke, and inspect the
captured live viewer at its real conversation width.

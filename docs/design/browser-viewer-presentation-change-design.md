# Browser Viewer Presentation Change Design

## Executive Summary

Replace the current debug-style Browser viewer with a structured session card
inside the conversation. The selected seam is the existing `BrowserViewer`
component and its conversation stylesheet. Runtime and authority contracts do
not change.

## Requested Outcome

The viewer must feel like a finished Desktop feature. A person must be able to
understand whether Kestrel or the person controls the Browser, see the live
page, take or return control, disconnect the viewer, and close the session
without parsing a row of equal-looking controls.

## Relevant Current Behavior

`DesktopApp.tsx` renders `BrowserViewer` before the timeline. The component in
`BrowserViewer.tsx` already receives complete viewer state and invokes typed
Desktop bridge actions. Its former markup used a plain title, status text, four
default buttons, and an unframed black image container. The corresponding CSS
in `styles/conversation.css` provided spacing but little hierarchy.

The Browser authority and input paths are already correct and remain outside
this change.

## Affected Surface

The change affects Browser viewer markup, CSS, accessible labels, and packaged
visual smoke output. It does not affect Browser tools, IPC payloads, session
state, policy, artifacts, or cleanup.

## External Findings That Shaped the Design

[Apple's toolbar guidance](https://developer.apple.com/design/human-interface-guidelines/toolbars)
recommends a deliberate set of grouped actions that orients people to the
current view. This supports a status-led header and one primary control action
instead of four equal buttons.

[WCAG 2.2 target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
sets a 24-by-24 CSS pixel minimum for pointer targets in ordinary cases. The
design uses controls of at least 28 pixels. [WCAG focus guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance.html)
supports a visible two-pixel viewport focus ring during human control.

## Options and Candidate Seams

A separate Browser window would add lifecycle and authority complexity. A
floating overlay would obscure the transcript. A structured card in the
existing location preserves ownership and needs no new state. The structured
card is the selected option.

## Proposed Delta

The viewer becomes a session card with four layers:

1. A compact header identifies the Browser session and current controller.
2. A small action group presents takeover or return as the primary action,
   disconnect as secondary, and close as a titled icon.
3. A bounded viewport presents the frame, a live indicator, and a designed
   connecting state.
4. A footer states whether the viewport is view-only or accepting keyboard and
   pointer input.

Errors appear as compact alerts. Viewer unavailability includes a retry action.
The packaged smoke pauses after Browser capture, takes a component screenshot,
and then releases the run to close normally.

## Decisions

- Keep Browser state and behavior unchanged.
- Keep the viewer in the conversation.
- Use existing Desktop colors and typography.
- Use one primary action at a time.
- Never display invented URL or navigation state.
- Preserve visible focus and reduced-motion behavior.

## Remaining Design Questions

None. The packaged screenshot is the visual acceptance gate.

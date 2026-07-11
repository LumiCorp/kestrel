---
id: hermes-desktop-ui-map
domain: docs
status: active
owner: kestrel-agent
last_verified_at: 2026-06-02
depends_on: [../../index.md, ./feature-inventory.md]
---

# Hermes Desktop UI Map

See also: [Docs index](../../index.md).

Source repo: `fathah/hermes-desktop`

Audited commit: `1b16ef33c82a594207e346655da4f35193cb3e43`

Audit mode: code-grounded only. This is a verified screen and interaction map from the renderer and main-process code, not a live usability walkthrough.

## Top-Level App States

### 1. Splash

- Full-screen branded splash screen.
- Fixed-duration transition.
- No operator actions.

### 2. Welcome

- Landing screen when Hermes is missing or install verification fails.
- Primary CTA to start or retry installation.
- Secondary terminal-install fallback with copyable install command.
- Recheck action after manual install.

### 3. Install

- Progress bar.
- step/title/detail readout.
- scrolling install log.
- copy-log affordance.
- success path advances into setup.
- failure path routes back to welcome with error.

### 4. Setup

- Provider cards for first-run configuration.
- API key input for keyed providers.
- Local-model base URL flow with presets for:
  - LM Studio
  - Ollama
  - vLLM
  - llama.cpp
- Optional model name input.
- reveal/hide API key control.
- Continue action writes config and enters the main app.

### 5. Main shell

- Left sidebar navigation.
- Main content panel swaps between screens.
- Sidebar footer shows active profile name and update CTA when applicable.

## Main Navigation

Sidebar order:

1. Chat
2. Sessions
3. Profiles
4. Office
5. Models
6. Skills
7. Persona
8. Memory
9. Tools
10. Schedules
11. Gateway
12. Settings

## Screen-by-Screen Map

## Chat

### Header

- Session title or `New Chat`.
- Token/cost counter when usage exists.
- Fast-mode toggle with explanatory popover.
- New chat icon button.
- Clear chat button once messages exist.

### Empty state

- Large Hermes mark.
- prompt-style welcome text.
- six task suggestion chips:
  - Search the web
  - Set a reminder
  - Summarize emails
  - Write a script
  - Schedule a cron job
  - Analyze data

### Conversation area

- User and agent bubbles.
- Markdown rendering for agent output.
- Typing indicator.
- Tool-progress pill or inline progress text.
- Approval bar with `Approve` and `Deny` when regex matches the latest assistant message.

### Composer

- Multiline textarea with `Shift+Enter` support.
- Send button.
- Stop button while loading.
- `Quick Ask` bubble button when a session already exists and input is non-empty.
- Slash-command menu anchored above the composer.

### Model bar

- Compact current-model trigger at the bottom.
- Dropdown grouped by provider.
- Individual saved-model choices.
- Custom model input field.

### Shortcuts and menu hooks

- `Cmd/Ctrl+N` for new chat.
- Native menu event also opens new chat.

## Sessions

### Header

- Screen title.
- `New Chat` button.
- Integrated search bar with clear button.

### Main states

- Loading spinner.
- Empty state when there are no sessions.
- Search-empty state when no results match.
- Grouped list mode when not searching.

### Session card contents

- Generated or stored title.
- Time or full date.
- source tag.
- message-count tag.
- compact model tag.

### Search result variant

- Same core card fields.
- highlighted snippet with `<< >>` match markers rendered as `<mark>`.

## Profiles

### Header

- Title and subtitle explaining profile isolation.
- `New Agent` button.

### Create panel

- agent name input with normalization to lowercase plus `_` / `-`.
- clone-config checkbox.
- inline error.
- create and cancel actions.

### Profile cards

- Avatar.
- Name.
- Provider.
- Model summary.
- skill count.
- gateway-running status.
- active badge.
- `Chat` button.
- delete affordance with inline `Delete? Yes / No` confirmation.

## Models

### Header

- Title, subtitle, and `Add Model`.

### Search

- Inline search input when models exist.

### Grid

- Card click opens edit modal.
- Provider pill.
- model ID line.
- optional base URL line.
- delete confirmation in-card.

### Modal

- Display name.
- Provider select.
- Model ID input.
- Base URL input.
- error text.
- add/edit actions.

## Skills

### Header

- Title and subtitle.
- `Refresh` button.

### Main controls

- error banner with dismiss.
- installed vs browse tabs.
- search field.
- browse-only category pills.

### Installed tab

- Empty state with prompt to browse skills.
- Skill cards with name, category, description.
- Click opens detail drawer.

### Browse tab

- Search and category-filtered skill cards.
- Install button or Installed badge.

### Detail overlay

- Name and category.
- Uninstall button.
- Close button.
- Markdown-rendered skill body.

## Persona

- Single large editor surface.
- Auto-save behavior after edits.
- Saved indicator.
- Reset confirmation flow.

## Memory

### Top panel

- Stats strip for sessions and messages.
- Capacity bars for memory and user-profile budgets.
- three tabs: Entries, User Profile, Providers.

### Entries tab

- Entry count.
- `Add Memory` button.
- Add-entry form with char counter.
- Entry cards with edit and delete actions.
- Empty state if no entries exist.

### User Profile tab

- Large textarea.
- char counter.
- explicit `Save Profile` action only while dirty.

### Providers tab

- explanatory hint about built-in plus external memory.
- Active-provider label.
- Provider card grid.
- Per-card env-var fields.
- external-link button when a provider URL is known.
- Activate / Deactivate button.

## Tools

- Vertical list of toolset cards.
- label, description, icon, and toggle.
- Screen is focused and minimal compared with Settings/Gateway.

## Schedules

### Header

- Title, error state, and `New Scheduled Task` modal trigger.

### Job list

- Loading state.
- Empty state.
- Job cards with schedule, next run, last run, last status, error state, and deliver tags.
- actions for trigger, pause/resume, and delete.

### Create modal

- Name.
- Frequency pills.
- Frequency-specific inputs.
- Prompt.
- Deliver target select.
- Cancel and Create actions.

## Gateway

### Header section

- gateway running/stopped badge.
- Start / Stop button.
- hint text about supported platforms.

### Platforms section

- Repeating platform cards.
- Label, description, enable toggle.
- Expanded credential fields only when enabled.
- password show/hide support for secret fields.

### Additional credential sections

- Any fields not associated with a platform card render as standard settings sections below.

## Office

### Checking state

- Spinner and status text.

### Not installed / error state

- Setup card.
- `Install Claw3D`.
- `View on GitHub`.
- inline error when present.

### Installing state

- Progress bar.
- step title.
- detail text.
- live setup log.

### Ready state

- Toolbar with:
  - running/stopped indicator
  - Start / Stop
  - Refresh
  - Open in browser
  - Settings toggle
  - Logs toggle
- Embedded `webview` for Claw3D when running.
- Inline settings area for port and websocket URL.
- Log panel.
- Error banner for load/start failures.

## Settings

### Hermes Agent section

- engine metadata tiles.
- update badge when upstream version reports one.
- `Update Engine`
- `Run Doctor`
- `Debug Dump`
- result banner.
- preformatted doctor/dump output.

### Migration banner

- OpenClaw detection banner.
- migration log area.
- Migrate and Skip actions.
- dismiss icon.

### Appearance

- Theme segmented control.

### Network

- Force IPv4 toggle.
- HTTP Proxy input.
- saved badge.

### Model

- Provider select.
- Model input.
- Base URL input when provider is custom.
- debounced auto-save.

### Credential Pool

- provider select.
- API key input.
- optional label input.
- Add button.
- grouped list of saved credential-pool entries.

### Backup and import

- `Create Backup`
- `Import Backup`
- result banner.

### Logs

- Expand/collapse section.
- file selector buttons for three log files.
- path display.
- preformatted log output.

### Environment variable sections

- LLM Providers
- Tool API Keys
- Browser & Automation
- Voice & STT
- Research & Training

Each field supports:

- inline input
- password masking when relevant
- show/hide button
- save-on-blur
- `Saved` chip feedback

## Native/Desktop Affordances

### Menu

- `Chat > New Chat`
- `Chat > Search Sessions`
- Standard edit/view/window items.
- Help links to Hermes GitHub and issue tracker.

### Updater UX

- Auto-update check after launch in packaged builds.
- Sidebar footer CTA changes through:
  - update available
  - downloading %
  - restart to update

### Notifications

- Response-ready notification when the window is unfocused and a response took longer than 10 seconds.
- Error notification when the window is unfocused and chat fails.

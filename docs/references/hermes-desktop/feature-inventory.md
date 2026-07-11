---
id: hermes-desktop-feature-inventory
domain: docs
status: active
owner: kestrel-agent
last_verified_at: 2026-06-02
depends_on: [../../index.md]
---

# Hermes Desktop Feature Inventory

See also: [Docs index](../../index.md).

Source repo: `fathah/hermes-desktop`

Audited commit: `1b16ef33c82a594207e346655da4f35193cb3e43`

Audit mode: code-grounded review of the cloned repo. The live desktop UI was not exercised in this pass, so anything below is limited to implemented code paths and wired UI, not a hands-on runtime walkthrough.

## What The App Actually Is

Hermes Desktop is an Electron shell around an upstream Hermes Agent install in `~/.hermes`. The desktop app owns onboarding, config editing, screen-level UX, IPC wiring, session cache helpers, and desktop affordances such as menus, notifications, and updater hooks. Core agent behavior still comes from the Hermes Python runtime, CLI, config files, and local API server.

## Core App Lifecycle

### First-run and startup gates

- Splash screen with a fixed 4-second animation before the app resolves the next route.
- Install check decides between `welcome`, `installing`, `setup`, and `main`.
- Verification logic distinguishes:
  - not installed
  - installed but broken
  - installed but missing API/provider setup
  - installed and ready
- Guided install runs the upstream Hermes install script with `--skip-setup`.
- Setup screen writes provider/API key config after install instead of delegating setup to the terminal installer.

### Desktop shell

- Single main `BrowserWindow`.
- Native menu entries for `New Chat` and `Search Sessions`.
- Update banner in the sidebar footer when packaged builds report an available update.
- Desktop notifications for long-running or backgrounded chat responses and chat errors.

## Feature Domains

### Chat

- Streaming chat UI with chunked rendering over Hermes SSE / API server.
- CLI fallback path when the local Hermes API server is unavailable.
- Tool progress indicator surfaced inline during streaming.
- Token usage and optional cost display in the header/footer.
- Abort / stop in-flight response.
- Resume existing session context.
- Quick Ask action (`/btw`) once a session exists.
- Empty-state suggestion chips for common tasks.
- Inline approval bar when the latest assistant message matches an approval regex.
- Local slash-command handling for:
  - `/new`
  - `/clear`
  - `/model`
  - `/memory`
  - `/tools`
  - `/skills`
  - `/persona`
  - `/version`
  - `/fast`
  - `/usage`
  - `/help`
- Non-local slash commands are forwarded to Hermes.
- Model picker at the bottom of the composer, backed by the saved model library.
- Custom model entry field in the picker.

### Sessions and history

- Session list grouped by `Today`, `Yesterday`, `This Week`, `Earlier`.
- Search across past sessions via SQLite FTS when the `messages_fts` table exists.
- Resume a selected session back into the chat screen.
- Lightweight desktop-side session cache in `~/.hermes/desktop/sessions.json`.
- Generated fallback titles from first user message when the runtime did not provide one.

### Profiles

- Profile list including:
  - name
  - active state
  - provider
  - model
  - skill count
  - gateway running state
- Create profile with optional clone-from-default behavior.
- Delete named profiles.
- Switch active profile.
- Jump directly into chat with a selected profile.

### Models

- Saved model library persisted in `~/.hermes/models.json`.
- First-run default seeding for only three models:
  - OpenRouter Claude Sonnet 4
  - Anthropic Claude Sonnet 4
  - OpenAI GPT-4.1
- Add, edit, delete, and search saved models.
- Settings auto-adds the current configured model into the library.
- Chat picker reads from this library.

### Skills

- Installed skills tab.
- Bundled skills browse tab.
- Search across installed or bundled skills.
- Category filter pills in browse mode.
- Install bundled skill into the current profile.
- Uninstall installed skill.
- Skill detail side panel that renders `SKILL.md` content as markdown.

### Memory

- Three-tab memory surface:
  - Entries
  - User Profile
  - Providers
- Built-in memory entry CRUD stored in `MEMORY.md`.
- User profile editor stored in `USER.md`.
- Capacity bars with character limits:
  - memory entries: 2200 chars
  - user profile: 1375 chars
- Session and message count stats pulled from `state.db`.
- External memory-provider discovery by scanning Hermes memory plugins.
- Provider activation and deactivation by writing `memory.provider` in config.
- Provider-specific env var inputs for known providers.

### Persona

- Read, edit, auto-save, and reset `SOUL.md`.
- Save confirmation state in the UI.

### Toolsets

- Toolset list read from `config.yaml`.
- Toggle individual toolsets on/off from the desktop UI.
- Hard-coded toolset catalog includes:
  - web
  - browser
  - terminal
  - file
  - code execution
  - vision
  - image generation
  - text-to-speech
  - skills
  - memory
  - session search
  - clarify
  - delegation
  - cron jobs
  - mixture of agents
  - task planning

### Schedules

- Scheduled-task list from `cron/jobs.json`.
- Create, pause, resume, trigger, and delete cron jobs.
- Builder modes for:
  - minutes
  - hourly
  - daily
  - weekly
  - custom cron
- Single deliver-target selector in the create form.
- Deliver targets exposed in the UI:
  - local
  - origin
  - telegram
  - discord
  - slack
  - whatsapp
  - signal
  - matrix
  - mattermost
  - email
  - webhook
  - sms
  - homeassistant
  - dingtalk
  - feishu
  - wecom

### Gateway / messaging

- Start and stop gateway process from the UI.
- Poll gateway running status.
- Credential forms for many messaging integrations.
- Per-platform enable toggle UI cards.
- Supported platform cards include:
  - Telegram
  - Discord
  - Slack
  - WhatsApp
  - Signal
  - Matrix
  - Mattermost
  - Email
  - SMS
  - iMessage / BlueBubbles
  - DingTalk
  - Feishu / Lark
  - WeCom
  - WeChat
  - Webhooks
  - Home Assistant

### Office / Claw3D

- Dedicated `Office` screen for Claw3D setup and runtime management.
- Auto-setup flow with progress log.
- Start/stop controls for dev server + adapter.
- Configurable HTTP port and websocket URL.
- Embedded `webview` for the Office UI.
- External-browser open action.
- Refresh action.
- Built-in log viewer for Claw3D.

### Settings and operations

- Hermes engine info:
  - detected Hermes version
  - release date
  - desktop app version
  - Python version
  - OpenAI SDK version
  - Hermes home path
- Engine actions:
  - update Hermes
  - run doctor
  - debug dump
- OpenClaw migration banner and migration action.
- Theme switcher: system, light, dark.
- Network settings:
  - force IPv4
  - HTTP/SOCKS proxy
- Model config editor.
- Credential pool editor for multiple provider keys.
- Backup and import actions.
- Expandable log viewer for:
  - `gateway.log`
  - `agent.log`
  - `errors.log`
- Large environment-variable settings surface for:
  - LLM providers
  - tool API keys
  - browser / automation
  - voice / STT
  - research / training

## Persistence And Runtime Coupling

- Hermes install root: `~/.hermes`
- Upstream repo checkout: `~/.hermes/hermes-agent`
- Primary runtime files edited directly by the app:
  - `.env`
  - `config.yaml`
  - `MEMORY.md`
  - `USER.md`
  - `SOUL.md`
  - `models.json`
  - `cron/jobs.json`
- Sessions come from `state.db`.
- The desktop app assumes direct local filesystem ownership over the Hermes home directory.

## Important Truths And Limits

### Desktop-owned functionality

- Screen structure and navigation
- install/update/migration orchestration
- config-file editing UX
- session cache and generated titles
- native menu and notification behavior
- auto-updater integration

### Upstream-Hermes-owned functionality

- agent reasoning and tool execution
- actual cron execution
- gateway runtime
- memory plugin implementation
- profile commands
- skill installation semantics
- doctor / dump / backup / import commands

### Notable implementation gaps or constraints

- Gateway platform toggles are not fully symmetric with the UI surface.
  - The UI renders many platform cards.
  - The config helper only supports enable/disable writes for `telegram`, `discord`, `slack`, `whatsapp`, and `signal`.
- Many integrations are represented as forms and labels rather than desktop-owned implementations.
- Several feature catalogs are hard-coded in the desktop repo and may drift from the upstream runtime.
- The approval affordance in chat is regex-triggered from assistant text, not a structured contract from the runtime.

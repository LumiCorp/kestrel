---
id: hermes-desktop-ux-review
domain: docs
status: active
owner: kestrel-agent
last_verified_at: 2026-06-02
depends_on: [../../index.md, ./feature-inventory.md, ./ui-map.md]
---

# Hermes Desktop UX Review

See also: [Docs index](../../index.md).

Source repo: `fathah/hermes-desktop`

Audited commit: `1b16ef33c82a594207e346655da4f35193cb3e43`

Audit mode: code-grounded only. These notes come from implemented UI structure and interaction logic, not from a live usability session.

## Overall Read

Hermes Desktop has a strong product instinct for operator convenience. It tries to make a powerful CLI-driven agent feel approachable by putting install, chat, models, profiles, memory, schedules, messaging, and system operations into one desktop shell. The app feels opinionated, ambitious, and feature-forward.

The tradeoff is that the UI exposes more surface area than the desktop app itself truly owns. That creates several places where the experience may look richer or more complete than the underlying runtime contract actually is.

## What Works Well

### 1. Clear first-run funnel

- The splash, welcome, install, setup, and main-shell path is easy to understand.
- The app gives non-terminal users a plausible way into Hermes without forcing them through manual CLI setup.
- Manual terminal fallback still exists when guided install fails.

### 2. Chat is the strongest operator surface

- Streaming output, tool progress, token usage, stop control, slash commands, and model selection all sit close to the composer.
- The empty state uses concrete task suggestions instead of generic marketing copy.
- Quick Ask is a strong affordance for side questions once a session exists.

### 3. Information architecture is broad but legible

- Sidebar labels are plain and mostly self-explanatory.
- The app separates concerns into sensible sections: chat, sessions, profiles, models, memory, tools, schedules, gateway, settings.
- Settings keeps operational actions together instead of hiding them behind menus.

### 4. Recovery and operator support are built in

- Doctor, dump, backup, import, logs, updater state, and OpenClaw migration all improve operator self-service.
- Desktop notifications for backgrounded chats are useful for long-running tasks.

### 5. Profile isolation is communicated well

- The Profiles screen explains that each profile has its own config, memory, and skills.
- Card-level metadata helps users compare profiles quickly.

## Where The UX Is Weak Or Risky

### 1. The app overpromises relative to the runtime

- Large areas of the interface are catalog UIs over config files and upstream CLI commands.
- The app often presents capabilities as if they are first-class desktop features even when the desktop layer is mainly editing `.env`, `config.yaml`, or calling Hermes subcommands.
- This matters most in Gateway, Memory Providers, Skills, and Schedules.

### 2. Gateway UX is broader than the actual toggle contract

- The Gateway screen renders many platform cards and many credential fields.
- The platform-enable helper in the main process only supports five platform toggles.
- That means the UI suggests a uniform enable/disable experience across all platforms, but the underlying config writer does not back that up.
- For evaluation purposes, this is the biggest code-backed UX mismatch in the repo.

### 3. Heavy reliance on save-on-blur and hidden persistence rules

- Settings and Gateway save many values only when an input loses focus.
- Model config auto-saves on debounce.
- Persona auto-saves.
- User Profile saves explicitly.
- This is workable, but the app mixes several save behaviors instead of teaching one consistent pattern.

### 4. Primary actions are sometimes buried in secondary locations

- Model selection lives at the bottom of chat rather than in the header where users often look first.
- Some operationally important actions are inside Settings rather than next to the relevant feature.
- Office settings and logs are hidden behind toolbar buttons, which keeps the screen cleaner but lowers discoverability.

### 5. Approval UX is heuristic, not contract-backed

- The approve/deny bar appears when assistant text matches a regex.
- That is a brittle pattern for a runtime-control affordance.
- A structured approval state from the runtime would be more reliable than parsing natural language for danger cues.

### 6. The main shell is dense

- Twelve navigation sections plus install/setup states produce a large cognitive map.
- The app still feels coherent, but it is close to the point where grouping or progressive disclosure would help.
- Settings is especially dense because it combines engine operations, appearance, network, model config, credential pools, backup/import, logs, and dozens of provider/tool keys.

## Screen-Specific Notes

### Chat

What is strong:

- Very capable main surface.
- Good use of streaming and live progress.
- Helpful suggestion chips.
- Slash-command menu feels operator-friendly.

What is weak:

- Too much power is encoded in command text rather than visible UI state.
- Fast mode is exposed twice, once as a slash command and once as a header toggle.
- Session title is low-information compared with most modern chat apps because generated titles are simple and the header still falls back to `Session xxxxxx`.

### Sessions

What is strong:

- Grouping by recency is sensible.
- Search feels product-grade on paper because of SQLite FTS and highlighted snippets.

What is weak:

- Session cards are functional but not especially rich.
- The UI does not appear to expose metadata such as profile, tool activity, or outcome summary that might matter in an agentic desktop product.

### Profiles

What is strong:

- Clear card model.
- Good quick comparison fields.
- Creation flow is simple.

What is weak:

- The screen says `New Agent` while the rest of the app mostly talks about profiles, which can blur the mental model.
- There is no deeper profile inspection view; cards are shallow selectors.

### Models

What is strong:

- Dedicated model library is a good idea.
- Reuse from settings into chat picker is clean.

What is weak:

- The default seeded model list is very small.
- Library quality depends on the operator knowing exact model IDs.
- No validation or availability check is visible in the desktop UX.

### Skills

What is strong:

- Installed/browse split is sensible.
- Markdown detail view is useful.

What is weak:

- Browse appears registry-like, but installation behavior still depends on upstream Hermes commands and local runtime state.
- No stronger explanation of provenance, trust, or compatibility is visible.

### Memory

What is strong:

- Best information architecture outside Chat.
- Built-in vs external-provider framing is explicit.
- Capacity bars and stats make the feature legible.

What is weak:

- The provider tab may encourage users to expect plug-and-play behavior from external memory systems that still need runtime support and credentials.
- Character limits are visible, but there is not much guidance for what “good” memory content looks like.

### Gateway

What is strong:

- Strong ambition and broad connector story.
- Card-based layout is readable.

What is weak:

- Most likely place for operator confusion.
- Large credential surface plus incomplete toggle support creates a trust gap.
- Messaging configuration is mixed together with runtime-control semantics in a way that makes “configured” feel too close to “working.”

### Settings

What is strong:

- Puts operational tooling where serious users can find it.
- Doctor, dump, update, logs, backup, and import are exactly the kinds of controls a real operator wants.

What is weak:

- It has become a catch-all.
- The page mixes runtime health, appearance, network, inference config, credential pools, backups, logs, and raw secret management.
- The result is capable but crowded.

## Design-Language Notes

- The product leans toward a practical dev-tool aesthetic rather than a consumer-desktop aesthetic.
- Labels are generally plain and readable.
- The shell seems optimized for density and utility over delight.
- That is a reasonable choice for this category.

## Kestrel-Relevant UX Takeaways

### Worth borrowing

- install/setup funnel
- broad but readable left-nav shell
- session browser with search
- explicit operational controls
- memory page structure
- model library plus inline picker

### Worth avoiding

- regex-driven approval affordances
- broad config-file editors that imply stronger runtime guarantees than they have
- mixed persistence rules with no single save model
- exposing large connector catalogs before the runtime contract is equally solid

## Confidence And Gaps

High confidence:

- top-level screen map
- main interaction model
- persistence model
- desktop-vs-upstream ownership split
- obvious UX mismatches backed by code

Lower confidence until a live run:

- visual polish and spacing quality
- actual responsiveness
- install and updater success paths
- whether some screens degrade better or worse than the code suggests
- how many of the connector flows truly work end-to-end in a fresh install

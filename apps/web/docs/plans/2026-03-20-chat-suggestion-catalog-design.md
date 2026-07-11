# Chat Suggestion Catalog Design

## Summary

Replace the chat empty-state suggestion chips with a typed catalog that can represent both prompt suggestions and richer composer actions. The current implementation is a hardcoded list of four strings. The new system should rotate four suggestions per page load, preserve variety across core capabilities, and stay stable for the life of that page instance.

This change is motivated by product positioning rather than raw randomness. The suggestion row should act as a concise demo surface for the chat experience: reasoning, artifact creation, tool-backed answers, retrieval, and media generation.

## Goals

- Expand the suggestion pool from 4 hardcoded prompts to a curated catalog of 24 entries.
- Rotate visible suggestions on each page load.
- Keep the chosen set stable during a single page session.
- Ensure the four visible chips represent different capability lanes instead of clustering around one use case.
- Support both prompt-submitting chips and action chips that open existing composer flows like image and video generation.
- Avoid surfacing suggestions for capabilities that are unavailable in the current environment.

## Non-Goals

- Personalizing suggestions based on user history in v1.
- Re-ranking suggestions based on model quality or analytics in v1.
- Turning every composer control into a chip.
- Reworking the overall empty-state layout beyond the suggestion row.

## Problem Statement

Today the suggestion row in `components/chatbot/suggested-actions.tsx` is a static array of four plain strings. That creates three issues:

- it understates the actual breadth of the chat surface
- it cannot represent non-text composer actions like image and video generation
- it produces repetitive empty states with no controlled coverage across features

The chat surface already supports a wider set of capabilities through `components/chatbot/multimodal-input.tsx` and the chat route:

- prompt submission
- file attachments
- knowledge promotion and retrieval
- weather tool responses
- document and artifact creation
- image generation dialog
- video generation dialog

The suggestion system should reflect that actual product surface.

## Approaches Considered

### 1. Larger Plain-Text Prompt Pool

Keep suggestions as strings and randomly choose four per load.

Pros:

- smallest implementation
- minimal component changes

Cons:

- cannot represent media actions honestly
- weak control over feature coverage
- likely to repeat bland prompt-only use cases

### 2. Typed Suggestion Catalog With Mixed Actions

Store suggestions as structured objects with an action kind such as `prompt` or `media`.

Pros:

- matches the real composer surface
- allows image and video chips to open existing dialogs with a prefilled prompt
- supports future expansion without rewriting the component again
- makes controlled rotation and capability gating straightforward

Cons:

- slightly more UI plumbing than a string array

### 3. Fixed Feature Bundles

Define a few bundles and rotate bundles per page load.

Pros:

- predictable coverage
- easy to reason about

Cons:

- feels less dynamic
- repeats noticeably faster
- harder to tune at the individual suggestion level

## Recommendation

Use a typed suggestion catalog with mixed actions.

This is the only option that honestly represents the breadth of the composer while still keeping the empty state simple. A prompt-only pool can demonstrate reasoning, artifacts, and some tool use, but it cannot demonstrate first-class media generation without awkwardly pretending those are normal chat messages.

## Suggestion Model

Each suggestion entry should include:

- `id`
- `label`
- `feature`
- `lane`
- `kind`
- `prompt`
- `mediaKind` when applicable

Suggested kinds:

- `prompt`: send a user message exactly as if the user typed it
- `media`: open the existing image or video dialog and prefill the prompt

## Feature Lanes

Use four selection lanes to guarantee breadth in the visible set:

- `thinking`
- `making`
- `grounding`
- `media`

Lane definitions:

- `thinking`: explanation, comparison, planning
- `making`: code, text artifacts, spreadsheet artifacts
- `grounding`: attachments, knowledge, tool-backed live answers
- `media`: image and video generation

## Catalog

The initial catalog should contain 24 entries across 8 feature groups.

### Thinking

- Explain when Next.js is a better fit than a SPA for a B2B dashboard.
- Compare RAG and fine-tuning for an internal support assistant.
- Outline a rollout plan for adding AI to a customer support workflow.

### Code

- Write a TypeScript implementation of Dijkstra's algorithm and explain it step by step.
- Build a React hook for debounced search with example usage.
- Create a Python script that converts CSV rows into SQL insert statements.

### Text Artifact

- Draft a one-page launch brief for an AI meeting notes product.
- Write a calm customer email explaining a two-hour outage.
- Turn rough bullet points into an executive summary for leadership.

### Spreadsheet Artifact

- Create a spreadsheet to compare LLM vendors by cost, latency, and context window.
- Build a hiring scorecard spreadsheet for product design interviews.
- Make a six-month launch budget with categories, totals, and notes.

### Attachments

- Summarize the attached PDF and extract the top five action items.
- Compare the attached files and list where they disagree.
- Turn the attached meeting notes into a project plan with owners and dates.

### Knowledge And Tools

- Search our knowledge base for enterprise onboarding steps and summarize the happy path.
- Find docs about SSO setup and turn them into a checklist.
- What's the weather in San Francisco this weekend, and what should I pack?

### Image

- Generate a landing page hero image for a fintech startup.
- Create an editorial illustration of an AI agent organizing a messy inbox.
- Generate a product concept image for a smart home dashboard.

### Video

- Generate a 12-second teaser video for a new developer tool launch.
- Create a short cinematic product promo for an AI research workspace.
- Generate a looping background video for a modern SaaS homepage.

## Rotation Strategy

Rotate on page load, not on every render.

The selected set should be random per page load but stable during that page session. The simplest reliable way to do that is to derive a deterministic shuffle from the new chat page's generated chat id and compute the visible set once when the suggestion component mounts.

Selection rules:

- choose one suggestion from `thinking`
- choose one suggestion from `making`
- choose one suggestion from `grounding`
- choose one suggestion from `media`

Within each lane, shuffle candidates deterministically using the seed. Then choose the first valid item that has not already been selected.

## Availability Rules

The visible set should adapt to available capabilities:

- if media models are unavailable, replace the `media` lane with another `making` or `thinking` suggestion
- if knowledge search is unavailable, keep attachment and weather suggestions available but skip knowledge-only suggestions
- if a lane has no eligible suggestions, backfill from the remaining non-empty lanes in a stable seeded order

This keeps the empty state aligned with what the UI can actually do.

## UI Behavior

Prompt suggestions should behave exactly like the current chips and call `sendMessage`.

Media suggestions should:

- open the existing media dialog
- set the target kind to image or video
- prefill the prompt textarea

The visual treatment can stay the same in v1. If helpful, a follow-up can add small icons per chip kind, but that is not required for the initial change.

## Implementation Outline

- replace the hardcoded string array in `components/chatbot/suggested-actions.tsx` with a typed catalog
- extend `SuggestedActions` props so it can trigger media flows in addition to `sendMessage`
- pass media action handlers from `components/chatbot/multimodal-input.tsx`
- add seeded selection logic that runs once per page load
- gate suggestions by media model availability and any other readily available capability signals

## Risks

- Over-randomization can make the product feel inconsistent if the lane logic is weak.
- Media chips will feel misleading if the action model is not made explicit in code.
- Knowledge suggestions can become dead ends if surfaced when the organization has not configured knowledge retrieval.

## Mitigations

- enforce lane coverage instead of fully flat random selection
- use typed actions rather than pretending every capability is a text prompt
- filter the catalog using known availability before sampling

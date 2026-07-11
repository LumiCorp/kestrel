# CLI Prompt Smoke Ladder

These prompts are live CLI smoke tests for the build-mode agent. They should read like realistic user requests. Harness metadata may assert broad artifacts, but it must not teach the agent implementation details such as DOM IDs, root element names, or checker-specific behavior.

Run one prompt:

```bash
pnpm run cli:prompt-smoke -- --prompt <prompt-id> --timeout-seconds 420 --keep-runs 20
```

List prompts:

```bash
pnpm run cli:prompt-smoke -- --list
```

## Complexity Order

1. `simple-newsletter`
   - Static local artifact with structured data.
   - Exercises basic file creation, JSON verification, and finalization.

2. `weekend-itinerary`
   - Static app-like artifact with multiple content sections.
   - Exercises coherent presentation of related content without a framework.

3. `recipe-planner`
   - Dependency-free local UI with user-visible app behavior.
   - Exercises self-checking a working app experience rather than only creating separate files.

4. `grocery-budget-planner`
   - Richer dependency-free local UI with stateful interactions.
   - Exercises persistence, totals, categories, and repair after source-level checks.

5. `vite-retro-planner`
   - Scaffolded Vite app.
   - Exercises dependency-aware setup, replacing starter content, build verification, and app-level completion.

6. `vite-sprint-planner`
   - Scaffolded Vite app with multiple local views, richer client state, persistence, and import/export.
   - Exercises generator-based scaffold setup, coordinated state changes across views, and a longer user-style verification loop.

7. `vite-csv-reconciliation`
   - Scaffolded Vite app that reconciles two messy CSV exports from seeded prompt assets.
   - Exercises parsing, normalization, duplicate detection, conflict resolution, missing-record handling, persistence, import/export, and user-style verification against sample data.

8. `vite-shift-coverage-planner`
   - Scaffolded Vite app that repairs a staff schedule from several related seeded asset files.
   - Exercises multi-file parsing, relational joins, constraint validation, suggested replacements, constraint-preserving edits, audit trails, persistence, import/export, and user-style verification against schedule rules.

## Prompt Assets

Prompt asset sets live in `tests/cli-prompts/assets/`. Prompts can use `{{CLI_PROMPT_ASSETS_DIR}}`; the CLI prompt smoke runner copies the asset sets into the isolated workspace under `prompt-assets/` and expands the placeholder to that workspace-local absolute path before submitting the prompt.

See `tests/cli-prompts/assets/README.md` for the asset index.

## Harness Expectations

- Keep assertions light and outcome-focused.
- Prefer broad file and content checks over brittle implementation details.
- Do not add domain-specific verifier tools for a single prompt.
- Do not encode root selectors, exact layout structure, or internal state variable names.
- A failing smoke should drive investigation of the agent loop, prompt contract, tool use, or finalization behavior before tightening assertions.

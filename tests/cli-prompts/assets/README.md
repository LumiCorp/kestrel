# CLI Prompt Smoke Assets

This folder contains named asset sets for prompt-only CLI smoke tests. Prompts can reference the asset root with `{{CLI_PROMPT_ASSETS_DIR}}`; the smoke runner copies these assets into each isolated workspace under `prompt-assets/` and expands the placeholder to that workspace-local absolute path before sending the prompt to the CLI session.

## Asset Sets

- `csv-reconciliation-people/`
  - `source-a.csv`: CRM-style people export with inconsistent casing, duplicate names, and owner data.
  - `source-b.csv`: Support-system people export with overlapping people, alternate names, status conflicts, and missing records.
- `shift-coverage/`
  - `employees.csv`: Cafe staff roster with roles, hour limits, and availability notes.
  - `shift-requirements.csv`: Next-week shift requirements with role and minimum staffing needs.
  - `time-off-requests.csv`: Approved and pending time-off records that should affect scheduling.
  - `existing-schedule.csv`: Current assignments with intentional coverage, role, overlap, and time-off issues.
  - `coverage-rules.json`: Rule settings for rest periods, role eligibility, warnings, and replacement ranking.

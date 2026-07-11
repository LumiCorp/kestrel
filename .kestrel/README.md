# Kestrel Workspace Notes

## Session PLAN.md

Session planning state lives in the session-scoped planning document:

`./.kestrel/sessions/<session-id>/PLAN.md`

Agents should update that file with `planning.write_document` when the tool is available. The tool is intentionally narrow: it writes only session-scoped `PLAN.md` files and does not grant general filesystem mutation.

`PLAN.md` is markdown for humans. It has no required headings, checklist grammar, evidence syntax, or parser-enforced shape. The runtime reads it as informal planning state and gives it to the model for semantic interpretation.

Useful plans are usually short:

```md
# Plan

Goal:
What we are trying to do.

Next:
- First concrete step
- Validation or done condition

Notes:
- Assumptions, findings, or open questions
```

If `PLAN.md` is empty, oddly formatted, or incomplete, the runtime should continue and let the model clarify or rewrite it. The user should never be asked to repair the file for formatting reasons.

# Redact Browser run events before persistence

## Failed behavior

Commit `4e33f46b9` applies the Browser audit projector to explicit Browser audit evidence, but generic `run.tool.started`, `run.tool.completed`, and `run.tool.failed` events still receive raw prepared input and raw output. A `browser.interact` fill value or snapshot page body can therefore enter the durable event stream even though the Browser result and audit projections are secret-safe.

## Affected flow

`src/effects/EffectRunner.ts` emits generic tool activity, `src/engine/RuntimeIO.ts` shapes it, and `src/engine/StepRunner.ts` persists it. The Browser contract projector in `src/browser/contracts.ts` is the existing owner of safe Browser evidence.

## Repair requirements

- Project Browser inputs and outcomes to bounded metadata before any generic run event, trace, log, or failure detail can persist them.
- Never persist form values, page text, DOM/HTML, credentials, cookies, tokens, takeover input, screenshot bytes, upload bytes, download bytes, or untrusted raw Browser output.
- Preserve operation, session, target, status, timing, byte counts, safe artifact references, and pinned failure codes where the Browser projector permits them.
- Preserve existing non-Browser event behavior.

## Done when

- Sentinel tests prove fill/type values and snapshot/page content are absent from started, completed, failed, replay, and trace evidence.
- Browser event evidence remains sufficient to identify the operation, bounded outcome, and pinned failure without secret-bearing raw values.
- Focused event, Browser redaction, replay, and failure suites pass.

## Depends on

None.

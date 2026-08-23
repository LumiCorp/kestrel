# Keep committed result authoritative through cleanup failure

## Failed behavior

An exact DONE result can commit successfully, then lease cleanup persistence can fail. The live path converts the cleanup error into a different tool result while replay retains the committed success, producing contradictory outcomes.

## Repair requirements

Once exact result persistence commits, that result is authoritative for live delivery and replay. Later cleanup failure must remain recoverable operational evidence and must not replace the committed tool outcome.

## Done when

- Save success followed by cleanup failure returns the exact committed result.
- Replay returns the same result.
- Cleanup remains non-cleaned/recoverable and visible for reconciliation.
- No secret or container cleanup ordering regression is introduced.

## Depends on

08 and 10.

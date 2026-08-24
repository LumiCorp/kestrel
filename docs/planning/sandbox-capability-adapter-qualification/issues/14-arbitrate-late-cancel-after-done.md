# Arbitrate late cancellation after exact DONE

Status: repair required

RunnerHost must not emit `run.cancelled` after an exact effect result has durably committed and become readable. A cancellation arriving after DONE persistence but before final response currently creates contradictory terminal evidence.

Completion: use durable completion evidence to arbitrate the terminal mapping and add a deterministic late-cancel race regression.

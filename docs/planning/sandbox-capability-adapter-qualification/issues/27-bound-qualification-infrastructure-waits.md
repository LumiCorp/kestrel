# Bound qualification infrastructure waits

Status: repaired

## Defect

The deployment qualification helpers could wait indefinitely for provider evidence or a wedged HTTP subprocess, leaving the validation lane dependent on its outer job timeout.

## Repair

Bound evidence polling with an infrastructure-only `AbortSignal` and bound curl subprocess execution. These limits classify a broken test fixture; they do not define product correctness or runtime lifecycle outcomes.

## Evidence

The validation contract still rejects wall-clock product gates, while focused qualification helpers terminate with explicit infrastructure failures.


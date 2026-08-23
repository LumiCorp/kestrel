# Dispose sensitive material before container teardown

## Failed behavior

Durable terminalization runs before process-local sensitive disposal. If the store transition throws, Docker can remove containers while token material remains registered until later outer cleanup.

## Affected work

GitHub issue #414, commit `b974371d8`, coordinator teardown settlement, and Docker executor cleanup ordering.

## Repair requirements

Sensitive disposal must run on a mandatory path before workload or broker removal, even when durable lifecycle persistence fails. Durable evidence must honestly remain non-cleaned and recoverable when persistence fails.

## Done when

- Store transition failures cannot reorder container removal ahead of disposal.
- Tests assert disposal precedes both removals on success, cancellation, timeout, and persistence failure.

## Depends on

None.


# Preserve standalone developer-shell store resolution

## Failed behavior

A supported standalone `LocalDevShellService` caller that omits the new explicit binding no longer receives the store selection that the previous bootstrap path provided.

When `settings.json` selects SQLite and the injected environment contains an application `DATABASE_URL`, the compatibility resolver selects Postgres and can run Kestrel migrations against the application database. When settings select Postgres without a URL, it silently selects SQLite instead of returning the existing safe missing-database failure. An invalid `KESTREL_STORE_DRIVER` is also silently treated as automatic selection instead of producing the existing validation failure.

Local Core is not affected because it supplies an explicit binding. Standalone callers are affected only when they rely on the compatibility path promised by issue 01.

## Affected flow

This blocks [Bind the developer shell to Local Core storage authority](01-bind-developer-shell-storage-authority.md), implemented by `fa4d681ce..93362285a`.

The trigger is construction of `LocalDevShellService` without `storeBinding`. The constructor calls `resolveLegacyDevShellStoreBinding`, which currently reads only `KESTREL_STORE_DRIVER` and `DATABASE_URL`. It omits the settings defaults and driver validation previously owned by `createSqlExecutorFromEnv`. The resulting private binding is then authoritative for the detached service, so bootstrap faithfully opens the wrong store or suppresses the expected configuration error.

The repair must cover the standalone compatibility resolver, the existing store-driver precedence and validation owner, constructor failure shaping, and focused tests for the affected configurations.

## Repair requirements

- Resolve an omitted standalone binding once at `LocalDevShellService` construction using the injected environment and the same valid driver precedence as the replaced bootstrap path: explicit environment selection, runtime settings default, then automatic selection.
- Preserve explicit SQLite even when an application `DATABASE_URL` is present.
- Preserve explicit Postgres as Postgres and return the existing safe missing-database prerequisite failure when its URL is absent.
- Preserve the existing invalid-driver rejection rather than silently choosing a store.
- Keep Local Core on the explicit binding path. Do not reintroduce ambient or settings-based selection there.
- Preserve application environment inheritance and the private binding redaction guarantees from issue 01.

## Done when

- A standalone caller with a SQLite settings default and an application `DATABASE_URL` opens the developer-shell SQLite store while the command may still inherit the application URL.
- A standalone caller with a Postgres settings default and no URL fails before spawn with the safe missing-database reason.
- An invalid injected store driver produces the existing invalid-driver failure.
- Focused regression tests cover environment, settings, and automatic precedence without mutating process-global configuration.
- The original issue 01 outcome and constraints still hold.

## Depends on

None.

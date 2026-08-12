# `@kestrel/runtime-profile`

Dependency-clean composition for Kestrel managed Runtime profiles. The package
owns the managed environment presets, deterministic profile construction, and
resolved-profile fingerprints shared by Runner, Local Core, Desktop, and Web.

It intentionally depends only on the public Runner protocol and does not import
product, CLI, or Runtime implementation modules.

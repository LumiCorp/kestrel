---
id: cli-workspaces-guide
domain: cli
status: active
owner: kestrel-cli
last_verified_at: 2026-07-10
depends_on: [../index.md, kchat.md]
---

# Kestrel Workspace Catalog

See also: [Docs index](../index.md).

Kestrel workspaces are machine-local catalog entries in `~/.kestrel/workspaces.json`.
Launching `kestrel` or `ks` from a project directory registers the current workspace root in that catalog.
No project-local `.kestrel` scaffold is created.

## Root Selection

When Kestrel starts from a directory:

1. If the directory is inside a Git repository, the repository root becomes the workspace root.
2. If Git root detection fails, the current directory becomes the workspace root.
3. The original launch directory is stored as launch cwd when it differs from the workspace root.

This keeps project identity stable without writing Kestrel config into the project.

## Commands

- `kestrel workspace status`
- `kestrel workspace list`

Inside the TUI:

- `/workspace status`
- `/workspace list`
- `/workspace use <workspaceId|rootPath|detached>`

`workspace status` resolves the current directory through the catalog and reports the workspace id, root, launch cwd when relevant, automation state, and active session binding.

## Profiles

Workspace catalog entries do not carry runtime profile settings.
Kestrel uses the normal global/default profile flow from `~/.kestrel/profiles.json`.
Session state records the profile used for that session.

## Automation

The catalog field for scheduled automation is `automationEnabled`.
Workspace-backed scheduling is intentionally deferred until the central scheduler model is rebuilt on top of the catalog.
`kcron` reads catalog entries rather than project-local runtime files.

Use the workspace catalog for root identity and global profiles for runtime behavior.

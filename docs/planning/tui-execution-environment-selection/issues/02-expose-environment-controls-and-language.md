# Let users choose and understand the TUI execution environment

## Useful outcome

A TUI user sees one Kestrel agent, understands where commands run, and can choose Developer workspace or Safe sandbox without using an internal preset ID. An old Safe sandbox session offers a direct path to a new Developer workspace session instead of reporting that host package managers are missing.

This slice completes the user-facing environment scenarios in the [TUI Execution Environment Selection Product Brief](../../tui-execution-environment-selection-product-brief.md) on top of the exact session contract from issue 01.

## What changes

- Add one exhaustive presentation mapping for `cli_dev_local`, `workspace_hosted`, and `cli_safe_local`.
- Present `cli_dev_local` as **Developer workspace**, `workspace_hosted` as the hosted placement of **Developer workspace**, and `cli_safe_local` as **Safe sandbox**.
- Add an Environment step to the guided start journey after workspace selection and before confirmation. Preselect Developer workspace for a local workspace and Safe sandbox for a detached session.
- Show the exact target workspace and explain that Developer workspace uses tools installed in that environment, subject to the active execution policy.
- Explain that Safe sandbox runs isolated snippets and cannot install dependencies, build, test, or validate the selected project.
- Add `/environment` to show the current environment and open the chooser. Add `/environment developer` and `/environment safe` as exact keyboard paths. Expose the same actions in the command palette.
- Let an unstarted session change its environment in place through those controls.
- When a started session requests another environment, offer to create a new session with the same workspace and agent. Do not move its transcript, waits, threads, assembly records, or execution history into the new session.
- Give a started Safe sandbox session, including `default-tmp-3`, a direct action that creates a new Developer workspace session in the same workspace.
- Show Agent and Environment as separate values in normal status, session lists, guided journeys, palette actions, and relevant history messages.
- Keep `/profiles` about agent profiles. Remove raw preset output that makes environment bindings look like additional profiles.
- Format normal assembly labels with product language, such as `Kestrel on Developer workspace`.
- Keep raw environment preset, resolved-profile, fingerprint, and assembly IDs in verbose diagnostics and durable evidence.
- Strengthen the model-visible `code.execute` description. State that it runs declared inputs in a fresh isolated scratch container, not inside the project workspace, and cannot establish which tools are installed in the host or hosted workspace.
- Update TUI help and CLI documentation to explain the default, both environments, the post-start new-session boundary, and recovery from a restricted session.

## Requirements and delivery context

Issue 01 owns exact environment identity, persistence, propagation, runtime projection, and legacy consistency. Build these controls on that contract. Do not create another environment state store or reconstruct authority from the visible label.

The existing command inventory and palette are owned by [`TuiCommandInventory`](../../../../cli/app/TuiCommandInventory.ts) and [`PaletteController`](../../../../cli/app/PaletteController.ts). The guided start, profile output, status, background session flow, and session creation surfaces are coordinated in the existing TUI application and session controllers.

Preserve these requirements:

- Developer workspace is the default for a new workspace-bound session. Safe sandbox is the detached default and the explicit restricted choice.
- The environment is changeable only before start. A post-start request creates a new session.
- A user action selects the environment. Model output, task wording, command failure, and heuristic classification cannot widen authority.
- Product labels are derived from the exact preset. They are not persisted as authority.
- Hosted Developer workspace is a presentation alignment only. Do not change hosted Environment or Project policy.
- `code.execute` remains isolated and `dev.shell.run` remains the project install, build, test, inspection, and smoke-check operation.
- Environment selection does not imply automatic command approval.
- Desktop and web environment selection remain unchanged.

Include command, palette, guided-start, status, session-list, profile-output, tool-description, recovery, and documentation coverage in this issue. Do not defer tests, help text, or old-session recovery to separate cleanup work.

## Done when

- A new local workspace journey visibly defaults to Developer workspace and confirms the exact workspace consequence before session creation.
- A detached journey visibly defaults to Safe sandbox, and a workspace-bound user can deliberately select it before the first turn.
- `/environment`, `/environment developer`, `/environment safe`, and the matching palette actions work with the exact persisted environment from issue 01.
- An unstarted session changes in place. A started session creates a separate session in the requested environment and leaves existing runtime evidence unchanged.
- A started Safe sandbox session can create a new Developer workspace session in the same workspace through the environment control.
- Normal TUI output shows one Kestrel agent and a separate Developer workspace or Safe sandbox environment without exposing raw preset IDs.
- `/profiles` no longer presents environment presets as agent profiles.
- Hosted environment identity uses the Developer workspace product concept without changing hosted policy behavior.
- `code.execute` tells the model that its container is not the project workspace and cannot prove what host tools are installed.
- Help and CLI documentation explain when Safe sandbox is useful and why it cannot validate a workspace.
- Focused command, palette, journey, presentation, tool-contract, and recovery tests pass.
- `pnpm validate` passes.

## Depends on

- [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md)

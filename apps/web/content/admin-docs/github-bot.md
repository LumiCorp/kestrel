# GitHub Bot

GitHub bot support is wired into the adapter-backed Kestrel One runtime through
`/api/webhooks/github`. GitHub appears in Apps, while repository sources remain
managed in Knowledge.

GitHub sources still provide the repo-backed retrieval corpus for bot answers.

## Source flow

1. Create a GitHub source in `/knowledge`.
2. Run sync to refresh the source set and build an active snapshot.
3. Configure GitHub App or PAT credentials and the webhook secret in the server environment.
4. Verify the webhook URL in the GitHub App and confirm snapshot status in Knowledge.
5. Point the GitHub App webhook at `/api/webhooks/github`.
6. Confirm the deployment reports the adapter runtime and state backend you expect.

## Operational note

Snapshot status is org-scoped, so each active organization can maintain its own repo-backed retrieval state and sync cadence.

The webhook handler only responds for repositories that are already configured as GitHub knowledge sources.

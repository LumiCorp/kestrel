# Move Teams connections and actions to the Kestrel One broker

## Useful outcome

Kestrel One users can connect a work or school Microsoft account through the Platform-owned Microsoft registration and use Teams chat reads and approved sends without a static Microsoft provider environment configuration.

The slice keeps a missing Microsoft tenant approval for sends distinct from a revoked or unusable Teams read connection.

## What changes

Move the hosted Microsoft connection flow and Teams runtime actions from Better Auth access-token reads to the hosted personal authorization broker. The connection requests only the Teams pack and records actual granted scopes. It rejects consumer Microsoft accounts.

Teams list-chats and chat-history reads retain safe paging and normalized provider errors. Sending remains limited to an existing chat, requires exact approval for target and content, and returns the provider-created message identity or an accurate partial, failed, or unknown outcome. It must not create chats or expose Outlook, SharePoint, or broader Microsoft scopes.

## Requirements and delivery context

- Build on the shared broker from issue 02; do not add Microsoft-specific token storage or a parallel authorization path.
- Preserve the canonical Microsoft operation descriptors, Project attachment boundary, approval policy, safe audit identity, and existing Teams provider result contracts.
- Request `Chat.Read` and `ChatMessage.Send` only. Do not request `Chat.ReadWrite`, Outlook, SharePoint, or OneDrive scopes.
- Treat tenant-admin consent for `ChatMessage.Send` as a distinct send-eligibility state. A missing tenant grant must not make read access appear disconnected.
- Every Teams send requires one exact approval. Kestrel One must not retry an ambiguous send.
- Outlook and all Desktop work remain unchanged and out of scope.

## Done when

- A Kestrel One user can connect or reconnect an eligible work or school Microsoft account through the broker and see actual Teams grants and redacted health.
- Teams list-chats and chat-history reads use broker-resolved hosted tokens and preserve paging safety.
- A Teams send requires exact approval, reaches only the approved existing chat, and returns the provider message identity or normalized partial, failed, or unknown outcome.
- Missing tenant-admin consent is reported as a send-specific recovery state while permitted reads continue.
- Automated tests cover account type, pack and scope enforcement, tenant-consent classification, approval binding, token refresh, paging, and normalized provider failures.
- No hosted Teams connection or runtime action depends on the static Microsoft provider environment configuration after this issue lands.

## Depends on

- [02 — Add Kestrel One hosted personal authorization broker](02-add-hosted-personal-authorization-broker.md)

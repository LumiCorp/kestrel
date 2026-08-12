export function environmentLifecycleLockKey(environmentId: string): string {
  return `kestrel:environment:lifecycle:${environmentId}`;
}

export function workspaceLifecycleLockKey(workspaceId: string): string {
  return `kestrel:workspace:lifecycle:${workspaceId}`;
}

export function threadEnvironmentBindingLockKey(threadId: string): string {
  return `kestrel:thread-environment:${threadId}`;
}

export function organizationEnvironmentDefaultLockKey(
  organizationId: string,
): string {
  return `kestrel:environment:default:${organizationId}`;
}

export function organizationEnvironmentCreateLockKey(
  organizationId: string,
): string {
  return `kestrel:environment:create:${organizationId}`;
}

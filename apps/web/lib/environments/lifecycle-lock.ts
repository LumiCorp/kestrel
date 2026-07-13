export function environmentLifecycleLockKey(environmentId: string): string {
  return `kestrel:environment:lifecycle:${environmentId}`;
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

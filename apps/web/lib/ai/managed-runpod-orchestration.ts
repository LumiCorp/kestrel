export async function ensureManagedRunPodResource<
  T extends { id: string },
>(input: {
  knownResourceId: string | null;
  findExisting: () => Promise<T | undefined>;
  create: () => Promise<T>;
  persistResourceId: (resourceId: string) => Promise<void>;
}) {
  if (input.knownResourceId) {
    return input.knownResourceId;
  }
  const resource = (await input.findExisting()) ?? (await input.create());
  await input.persistResourceId(resource.id);
  return resource.id;
}

export async function deleteManagedRunPodResources(input: {
  endpointId?: string | null;
  templateId?: string | null;
  deleteEndpoint: (endpointId: string) => Promise<void>;
  deleteTemplate: (templateId: string) => Promise<void>;
}) {
  if (input.endpointId) {
    await input.deleteEndpoint(input.endpointId);
  }
  if (input.templateId) {
    await input.deleteTemplate(input.templateId);
  }
}

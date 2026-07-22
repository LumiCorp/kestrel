import { testRunPodProviderConnection } from "@/lib/ai/managed-runpod-connection";
import { hashManagedRunPodProfile } from "@/lib/ai/managed-runpod-contracts";
import {
  createManagedRunPodProfile,
  listManagedRunPodProfiles,
  queueManagedRunPodQualification,
} from "@/lib/ai/managed-runpod-store";
import {
  buildQwen3RunPodProfile,
  QWEN3_8B_RUNPOD_PROFILE_KEY,
  QWEN3_8B_RUNPOD_IMAGE,
} from "@/lib/ai/qwen3-runpod-profile";
import { enqueueManagedRunPodRun } from "@/lib/knowledge/queue";

async function run() {
  const actorUserId = process.env.KESTREL_BOOTSTRAP_ACTOR_USER_ID?.trim();
  const organizationId = process.env.KESTREL_BOOTSTRAP_ORGANIZATION_ID?.trim();
  const imageRef =
    process.env.RUNPOD_WORKER_VLLM_IMAGE_DIGEST?.trim() ||
    QWEN3_8B_RUNPOD_IMAGE;
  if (!(actorUserId && organizationId)) {
    throw new Error("KESTREL_BOOTSTRAP_ACTOR_USER_ID and KESTREL_BOOTSTRAP_ORGANIZATION_ID are required");
  }
  await testRunPodProviderConnection({ organizationId });

  const profileInput = buildQwen3RunPodProfile(imageRef);
  const specHash = hashManagedRunPodProfile(profileInput);
  const profiles = await listManagedRunPodProfiles({ organizationId, includeInactive: true });
  let profile = profiles.find(
    (candidate) =>
      candidate.profileKey === QWEN3_8B_RUNPOD_PROFILE_KEY &&
      candidate.specHash === specHash
  );

  if (!profile) {
    profile = await createManagedRunPodProfile({
      organizationId,
      actorUserId,
      profile: profileInput,
    });
    process.stdout.write(`Created Qwen3 8B profile ${profile.id}.\n`);
  }

  if (profile.status === "draft" && !profile.qualifiedAt) {
    const qualification = await queueManagedRunPodQualification({
      organizationId,
      profileId: profile.id,
    });
    if (!qualification) {
      throw new Error("Failed to queue Qwen3 8B qualification");
    }
    await enqueueManagedRunPodRun(qualification.id);
    process.stdout.write(`Queued qualification run ${qualification.id}.\n`);
  } else {
    process.stdout.write(
      `Qwen3 8B profile is already ${profile.status}; no qualification was queued.\n`
    );
  }
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exit(1);
});

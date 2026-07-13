import { z } from "zod";
import type {
  RunPodEndpointSpec,
  RunPodTemplateSpec,
} from "./managed-runpod-contracts";

const RUNPOD_CONTROL_PLANE_BASE_URL = "https://rest.runpod.io/v1";
const REQUEST_TIMEOUT_MS = 30_000;

const templateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  imageName: z.string().min(1),
  isServerless: z.boolean(),
});

const endpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  templateId: z.string().min(1).optional(),
  template: z.object({ id: z.string().min(1) }).optional(),
  workersMin: z.number().int().optional(),
  workersMax: z.number().int().optional(),
});

const billingRecordSchema = z.object({
  amount: z.number(),
  diskSpaceBilledGb: z.number().int().default(0),
  endpointId: z.string().min(1),
  gpuTypeId: z.string().nullable().optional(),
  time: z.string().datetime(),
  timeBilledMs: z.number().int().default(0),
});

export type RunPodControlFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export class RunPodControlPlaneError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(input: {
    code: string;
    message: string;
    status?: number;
    retryable?: boolean;
  }) {
    super(input.message);
    this.name = "RunPodControlPlaneError";
    this.code = input.code;
    this.status = input.status ?? 502;
    this.retryable = input.retryable ?? false;
  }
}

export class RunPodControlPlaneClient {
  private readonly apiKey: string;
  private readonly fetchImpl: RunPodControlFetch;

  constructor(input: { apiKey: string; fetchImpl?: RunPodControlFetch }) {
    this.apiKey = input.apiKey;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async testConnection() {
    await this.listEndpoints();
  }

  async listTemplates() {
    return z.array(templateSchema).parse(await this.request("/templates"));
  }

  async createTemplate(input: {
    name: string;
    imageRef: string;
    spec: RunPodTemplateSpec;
  }) {
    return templateSchema.parse(
      await this.request("/templates", {
        method: "POST",
        body: JSON.stringify({
          imageName: input.imageRef,
          name: input.name,
          category: "NVIDIA",
          containerDiskInGb: input.spec.containerDiskInGb,
          containerRegistryAuthId:
            input.spec.containerRegistryAuthId ?? undefined,
          dockerEntrypoint: input.spec.dockerEntrypoint,
          dockerStartCmd: input.spec.dockerStartCmd,
          env: {
            ...input.spec.env,
            ...Object.fromEntries(
              Object.entries(input.spec.secretEnv).map(([key, secretName]) => [
                key,
                `{{ RUNPOD_SECRET_${secretName} }}`,
              ])
            ),
          },
          isPublic: false,
          isServerless: true,
          ports: input.spec.ports,
          volumeInGb: input.spec.volumeInGb,
          volumeMountPath: input.spec.volumeMountPath,
        }),
      })
    );
  }

  async deleteTemplate(templateId: string) {
    await this.request(`/templates/${encodeURIComponent(templateId)}`, {
      method: "DELETE",
    });
  }

  async listEndpoints() {
    return z.array(endpointSchema).parse(await this.request("/endpoints"));
  }

  async getEndpoint(endpointId: string) {
    return endpointSchema.parse(
      await this.request(`/endpoints/${encodeURIComponent(endpointId)}`)
    );
  }

  async createEndpoint(input: {
    name: string;
    templateId: string;
    spec: RunPodEndpointSpec;
  }) {
    return endpointSchema.parse(
      await this.request("/endpoints", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          templateId: input.templateId,
          allowedCudaVersions: input.spec.allowedCudaVersions,
          computeType: "GPU",
          dataCenterIds: input.spec.dataCenterIds,
          executionTimeoutMs: input.spec.executionTimeoutMs,
          flashboot: input.spec.flashboot,
          gpuCount: input.spec.gpuCount,
          gpuTypeIds: input.spec.gpuTypeIds,
          idleTimeout: input.spec.idleTimeout,
          minCudaVersion: input.spec.minCudaVersion ?? undefined,
          networkVolumeIds: input.spec.networkVolumeIds,
          scalerType: input.spec.scalerType,
          scalerValue: input.spec.scalerValue,
          workersMax: input.spec.workersMax,
          workersMin: input.spec.workersMin,
        }),
      })
    );
  }

  async deleteEndpoint(endpointId: string) {
    await this.request(`/endpoints/${encodeURIComponent(endpointId)}`, {
      method: "DELETE",
    });
  }

  async listBilling(input: { startTime: Date; endTime: Date }) {
    const search = new URLSearchParams({
      bucketSize: "hour",
      startTime: input.startTime.toISOString(),
      endTime: input.endTime.toISOString(),
    });
    return z
      .array(billingRecordSchema)
      .parse(await this.request(`/billing/endpoints?${search.toString()}`));
  }

  private async request(path: string, init?: RequestInit) {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${RUNPOD_CONTROL_PLANE_BASE_URL}${path}`,
        {
          ...init,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            ...(init?.body ? { "content-type": "application/json" } : {}),
            ...init?.headers,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }
      );
    } catch {
      throw new RunPodControlPlaneError({
        code: "RUNPOD_CONTROL_PLANE_UNAVAILABLE",
        message: "RunPod control plane request failed.",
        retryable: true,
      });
    }
    if (!response.ok) {
      if (response.status === 404 && init?.method === "DELETE") {
        return {};
      }
      throw new RunPodControlPlaneError({
        code: `RUNPOD_CONTROL_PLANE_HTTP_${response.status}`,
        message: `RunPod control plane rejected the request (${response.status}).`,
        status: response.status,
        retryable:
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500,
      });
    }
    if (response.status === 204) {
      return {};
    }
    try {
      return await response.json();
    } catch {
      throw new RunPodControlPlaneError({
        code: "RUNPOD_CONTROL_PLANE_INVALID_RESPONSE",
        message: "RunPod control plane returned an invalid response.",
      });
    }
  }
}

import "server-only";

import { z } from "zod";
import type { FlyProviderAuthority } from "@/lib/environments/fly-connection";

const prometheusResponseSchema = z.object({
  status: z.literal("success"),
  data: z.object({
    resultType: z.literal("vector"),
    result: z.array(
      z.object({
        metric: z.object({
          app: z.string().min(1),
          region: z.string().min(1).optional(),
        }).passthrough(),
        value: z.tuple([z.number(), z.string()]),
      })
    ),
  }),
});

export type FlyPublicEgress = {
  appName: string;
  region: string | null;
  bytes: number;
};

export async function queryFlyPublicEgressHour(input: {
  endedAt: Date;
  token: string;
  organizationSlug: string;
  fetchImpl?: typeof fetch;
}): Promise<FlyPublicEgress[]> {
  const token = input.token.trim();
  const organizationSlug = input.organizationSlug.trim();
  if (!(token && organizationSlug)) {
    throw new Error("Fly metrics connection is not configured.");
  }
  const body = new URLSearchParams({
    query:
      'sum(increase(fly_edge_data_out{app=~"kestrel-env-.*"}[1h])) by (app, region)',
    time: String(input.endedAt.getTime() / 1000),
  });
  const response = await (input.fetchImpl ?? fetch)(
    `https://api.fly.io/prometheus/${encodeURIComponent(organizationSlug)}/api/v1/query`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: token.startsWith("FlyV1 ")
          ? token
          : token.startsWith("FlyV1")
            ? `FlyV1 ${token.slice("FlyV1".length).trim()}`
            : `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    }
  );
  if (!response.ok) {
    throw new Error(`Fly metrics API rejected the request (${response.status}).`);
  }
  const parsed = prometheusResponseSchema.parse(await response.json());
  return parsed.data.result.flatMap((result) => {
    const bytes = Number(result.value[1]);
    return Number.isFinite(bytes) && bytes >= 0
      ? [{
          appName: result.metric.app,
          region: result.metric.region ?? null,
          bytes,
        }]
      : [];
  });
}

export async function queryOrganizationFlyPublicEgressHour(input: {
  organizationId: string;
  endedAt: Date;
  fetchImpl?: typeof fetch;
  resolveAuthority?: (
    organizationId: string
  ) => Promise<FlyProviderAuthority>;
}) {
  const resolveAuthority =
    input.resolveAuthority ??
    (await import("@/lib/environments/fly-connection"))
      .resolveFlyProviderAuthority;
  const authority = await resolveAuthority(input.organizationId);
  return queryFlyPublicEgressHour({
    endedAt: input.endedAt,
    ...authority,
    fetchImpl: input.fetchImpl,
  });
}

export function flyPublicEgressService(region: string | null) {
  if (
    region &&
    ["ams", "arn", "cdg", "dfw", "ewr", "fra", "iad", "lax", "lhr", "ord", "sjc", "yyz"].includes(region)
  ) {
    return "network.public_egress.na_eu";
  }
  if (region && ["gru", "nrt", "sin", "syd"].includes(region)) {
    return "network.public_egress.apac_oceania_sa";
  }
  if (region && ["bom", "jnb"].includes(region)) {
    return "network.public_egress.africa_india";
  }
  return "network.public_egress.unknown";
}

export const DEFAULT_FLY_REGION = "iad" as const;

export const FLY_REGIONS = [
  { code: "ams", name: "Amsterdam, Netherlands" },
  { code: "iad", name: "Ashburn, Virginia (US)" },
  { code: "ord", name: "Chicago, Illinois (US)" },
  { code: "dfw", name: "Dallas, Texas (US)" },
  { code: "fra", name: "Frankfurt, Germany" },
  { code: "jnb", name: "Johannesburg, South Africa" },
  { code: "lhr", name: "London, United Kingdom" },
  { code: "lax", name: "Los Angeles, California (US)" },
  { code: "bom", name: "Mumbai, India", requiresPaidPlan: true },
  { code: "cdg", name: "Paris, France" },
  { code: "sjc", name: "San Jose, California (US)" },
  { code: "gru", name: "Sao Paulo, Brazil" },
  { code: "ewr", name: "Secaucus, New Jersey (US)" },
  { code: "sin", name: "Singapore, Singapore" },
  { code: "arn", name: "Stockholm, Sweden" },
  { code: "syd", name: "Sydney, Australia" },
  { code: "nrt", name: "Tokyo, Japan" },
  { code: "yyz", name: "Toronto, Canada" },
] as const;

export type FlyRegionCode = (typeof FLY_REGIONS)[number]["code"];

const FLY_REGION_CODES = new Set<string>(
  FLY_REGIONS.map((region) => region.code)
);

export function isFlyRegionCode(value: string): value is FlyRegionCode {
  return FLY_REGION_CODES.has(value);
}

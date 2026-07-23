"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { OrganizationDashboardSnapshot } from "@/lib/costs/contracts";

const chartConfig = {
  models: { label: "Models", color: "hsl(var(--chart-1))" },
  environments: { label: "Environments", color: "hsl(var(--chart-2))" },
  managedCompute: { label: "Managed compute", color: "hsl(var(--chart-3))" },
  services: { label: "Services", color: "hsl(var(--chart-4))" },
} satisfies ChartConfig;

export function CostTrendChart({
  data,
}: {
  data: OrganizationDashboardSnapshot["daily"];
}) {
  return (
    <ChartContainer className="h-[280px] w-full" config={chartConfig}>
      <AreaChart accessibilityLayer data={data} margin={{ left: 4, right: 4 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="date"
          minTickGap={24}
          tickFormatter={(value: string) =>
            new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            })
          }
          tickLine={false}
        />
        <YAxis
          axisLine={false}
          tickFormatter={(value: number) => `$${value.toFixed(value < 1 ? 2 : 0)}`}
          tickLine={false}
          width={54}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value: number | string, name: string) => (
                <div className="flex min-w-36 items-center justify-between gap-4">
                  <span>{chartConfig[name as keyof typeof chartConfig]?.label}</span>
                  <span className="font-medium font-mono">
                    {formatUsd(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        {Object.keys(chartConfig).map((key) => (
          <Area
            dataKey={key}
            fill={`var(--color-${key})`}
            fillOpacity={0.4}
            key={key}
            stackId="cost"
            stroke={`var(--color-${key})`}
            type="monotone"
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

function formatUsd(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 1 ? 4 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

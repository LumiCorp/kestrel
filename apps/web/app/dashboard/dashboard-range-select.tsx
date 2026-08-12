"use client";

import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function DashboardRangeSelect({
  value,
}: {
  value: "mtd" | "7d" | "30d" | "90d";
}) {
  const router = useRouter();

  return (
    <Select
      onValueChange={(nextValue) =>
        router.push(`/dashboard?range=${nextValue}`)
      }
      value={value}
    >
      <SelectTrigger aria-label="Reporting range" className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="mtd">Month to date</SelectItem>
        <SelectItem value="7d">Last 7 days</SelectItem>
        <SelectItem value="30d">Last 30 days</SelectItem>
        <SelectItem value="90d">Last 90 days</SelectItem>
      </SelectContent>
    </Select>
  );
}

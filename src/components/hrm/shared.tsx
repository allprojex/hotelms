import type { ReactNode } from "react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listHrmOptions } from "@/lib/hrm/hrm.functions";

export type HrmOption = {
  id: string;
  name?: string;
  title?: string;
  code?: string;
  employee_number?: string;
  first_name?: string;
  last_name?: string;
  department_id?: string | null;
  designation_id?: string | null;
  user_id?: string;
  full_name?: string;
};

export type HrmOptionsData = {
  departments: HrmOption[];
  designations: HrmOption[];
  employees: HrmOption[];
  profiles: HrmOption[];
};

export function HrmPageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {actions}
    </header>
  );
}

export function KpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-3xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

export function useHrmOptions(propertyId: string | null) {
  const fetchOptions = useServerFn(listHrmOptions);
  return useQuery({
    queryKey: ["hrm-options", propertyId],
    enabled: !!propertyId,
    queryFn: async () =>
      (await fetchOptions({ data: { propertyId: propertyId! } })) as HrmOptionsData,
  });
}

export function OptionalSelect({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = "Not assigned",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value || "none"}
        onValueChange={(next) => onChange(next === "none" ? "" : next)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{placeholder}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function useHrmListState() {
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [status, setStatus] = useState("");
  const clear = () => {
    setSearch("");
    setFrom(null);
    setTo(null);
    setPage(1);
    setStatus("");
  };
  return {
    search,
    setSearch: (value: string) => {
      setSearch(value);
      setPage(1);
    },
    from,
    setFrom: (value: string | null) => {
      setFrom(value);
      setPage(1);
    },
    to,
    setTo: (value: string | null) => {
      setTo(value);
      setPage(1);
    },
    page,
    setPage,
    pageSize,
    setPageSize: (value: number) => {
      setPageSize(value);
      setPage(1);
    },
    status,
    setStatus: (value: string) => {
      setStatus(value);
      setPage(1);
    },
    clear,
  };
}

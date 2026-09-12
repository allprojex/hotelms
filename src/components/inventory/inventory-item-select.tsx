import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, PackageSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { inventoryItemSearchText, matchesSearch } from "@/lib/search-filter";
import { cn } from "@/lib/utils";

export type InventoryItemOption = {
  id: string;
  name: string;
  sku?: string | null;
  item_categories?: { name?: string | null } | null;
};

export function InventoryItemSelect({
  items,
  value,
  onValueChange,
  placeholder = "Search by product name or SKU…",
  emptyLabel = "No matching products found.",
  allowNone = false,
  noneLabel = "Not linked",
  disabled = false,
}: {
  items: InventoryItemOption[];
  value?: string | null;
  onValueChange: (value: string) => void;
  placeholder?: string;
  emptyLabel?: string;
  allowNone?: boolean;
  noneLabel?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = items.find((item) => item.id === value);
  const matches = useMemo(
    () => items.filter((item) => matchesSearch(inventoryItemSearchText(item), query)).slice(0, 100),
    [items, query],
  );

  function choose(nextValue: string) {
    onValueChange(nextValue);
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full min-w-0 justify-between font-normal"
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected
              ? `${selected.sku ? `${selected.sku} — ` : ""}${selected.name}`
              : allowNone && !value
                ? noneLabel
                : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search name, SKU or code…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-72 overscroll-contain">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup heading="Products and items">
              {allowNone && matchesSearch(noneLabel, query) && (
                <CommandItem value={noneLabel} onSelect={() => choose("")}>
                  <Check className={cn("h-4 w-4", !value ? "opacity-100" : "opacity-0")} />
                  <span>{noneLabel}</span>
                </CommandItem>
              )}
              {matches.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${inventoryItemSearchText(item)} ${item.id}`}
                  onSelect={() => choose(item.id)}
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      value === item.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <PackageSearch className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[item.sku, item.item_categories?.name].filter(Boolean).join(" · ") ||
                        "No SKU"}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

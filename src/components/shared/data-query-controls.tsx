import type { ReactNode } from "react";
import { AlertCircle, ArrowDownToLine, ArrowUpToLine, Inbox, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PAGE_SIZE_OPTIONS, totalPages } from "@/lib/query-state";

export function DataQueryState({
  loading,
  error,
  empty,
  emptyTitle = "No results",
  emptyDescription = "Try changing or clearing the filters.",
  children,
}: {
  loading: boolean;
  error?: Error | null;
  empty: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <div
        className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading results
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="flex min-h-32 items-center justify-center gap-2 text-sm text-destructive"
        role="alert"
      >
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        {error.message || "Unable to load results"}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="flex min-h-32 flex-col items-center justify-center text-center">
        <Inbox className="mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">{emptyTitle}</p>
        <p className="text-xs text-muted-foreground">{emptyDescription}</p>
      </div>
    );
  }
  return children;
}

export function SharedListFilters({
  search,
  from,
  to,
  onSearchChange,
  onFromChange,
  onToChange,
  onClear,
  children,
}: {
  search: string;
  from: string | null;
  to: string | null;
  onSearchChange: (value: string) => void;
  onFromChange: (value: string | null) => void;
  onToChange: (value: string | null) => void;
  onClear: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3" aria-label="Report filters">
      <div className="min-w-52 flex-1 space-y-1">
        <Label htmlFor="shared-list-search">Search</Label>
        <Input
          id="shared-list-search"
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search results"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="shared-list-from">From</Label>
        <Input
          id="shared-list-from"
          type="date"
          value={from ?? ""}
          onChange={(event) => onFromChange(event.target.value || null)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="shared-list-to">To</Label>
        <Input
          id="shared-list-to"
          type="date"
          value={to ?? ""}
          onChange={(event) => onToChange(event.target.value || null)}
        />
      </div>
      {children}
      <Button type="button" variant="outline" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

export function ServerPagination({
  page,
  pageSize,
  totalRows,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  const pages = totalPages(totalRows, pageSize);
  const currentPage = Math.min(Math.max(1, page), pages);
  const firstVisiblePage = Math.max(1, Math.min(currentPage - 2, pages - 4));
  const visiblePages = Array.from(
    { length: Math.min(5, pages) },
    (_, index) => firstVisiblePage + index,
  );
  return (
    <nav
      className="flex flex-wrap items-center justify-between gap-3"
      aria-label="Results pagination"
    >
      <div className="flex items-center gap-2">
        <Label htmlFor="shared-page-size">Rows per page</Label>
        <Select value={String(pageSize)} onValueChange={(value) => onPageSizeChange(Number(value))}>
          <SelectTrigger id="shared-page-size" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground" aria-live="polite">
          Page {currentPage} of {pages} · {totalRows} results
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(1)}
        >
          First
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          Previous
        </Button>
        {visiblePages.map((pageNumber) => (
          <Button
            key={pageNumber}
            type="button"
            variant={pageNumber === currentPage ? "default" : "outline"}
            aria-current={pageNumber === currentPage ? "page" : undefined}
            aria-label={`Page ${pageNumber}`}
            onClick={() => onPageChange(pageNumber)}
          >
            {pageNumber}
          </Button>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={currentPage >= pages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          Next
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={currentPage >= pages}
          onClick={() => onPageChange(pages)}
        >
          Last
        </Button>
      </div>
    </nav>
  );
}

export function FastScrollControls() {
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 print:hidden">
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label="Scroll to top"
        title="Scroll to top"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      >
        <ArrowUpToLine className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        aria-label="Scroll to bottom"
        title="Scroll to bottom"
        onClick={() =>
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
        }
      >
        <ArrowDownToLine className="h-4 w-4" />
      </Button>
    </div>
  );
}

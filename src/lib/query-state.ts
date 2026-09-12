export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

export type ListQueryState = {
  search: string;
  from: string | null;
  to: string | null;
  page: number;
  pageSize: number;
  filters: Record<string, string>;
};

type QueryInput = URLSearchParams | Record<string, string | null | undefined>;

function queryValue(input: QueryInput, key: string): string | null {
  if (input instanceof URLSearchParams) return input.get(key);
  return input[key] ?? null;
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isoDateOrNull(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export function parseListQuery(
  input: QueryInput,
  allowedFilters: readonly string[] = [],
): ListQueryState {
  const requestedPageSize = positiveInteger(queryValue(input, "pageSize"), DEFAULT_PAGE_SIZE);
  const pageSize = PAGE_SIZE_OPTIONS.includes(
    requestedPageSize as (typeof PAGE_SIZE_OPTIONS)[number],
  )
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;
  const from = isoDateOrNull(queryValue(input, "from"));
  const to = isoDateOrNull(queryValue(input, "to"));

  return {
    search: (queryValue(input, "search") ?? "").trim().slice(0, 200),
    from: from && to && from > to ? null : from,
    to: from && to && from > to ? null : to,
    page: positiveInteger(queryValue(input, "page"), 1),
    pageSize,
    filters: Object.fromEntries(
      [...allowedFilters]
        .sort()
        .map((key) => [key, (queryValue(input, key) ?? "").trim()])
        .filter(([, value]) => value !== ""),
    ),
  };
}

export function serializeListQuery(state: ListQueryState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.search) params.set("search", state.search);
  if (state.from) params.set("from", state.from);
  if (state.to) params.set("to", state.to);
  if (state.page > 1) params.set("page", String(state.page));
  if (state.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(state.pageSize));
  }
  Object.entries(state.filters)
    .filter(([, value]) => value !== "")
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([key, value]) => params.set(key, value));
  return params;
}

export function updateListFilters(
  state: ListQueryState,
  patch: Partial<Omit<ListQueryState, "page" | "pageSize">> & {
    pageSize?: number;
  },
): ListQueryState {
  const filtersChanged =
    patch.search !== undefined ||
    patch.from !== undefined ||
    patch.to !== undefined ||
    patch.filters !== undefined ||
    patch.pageSize !== undefined;
  return {
    ...state,
    ...patch,
    page: filtersChanged ? 1 : state.page,
  };
}

export function clearListFilters(state: ListQueryState): ListQueryState {
  return {
    search: "",
    from: null,
    to: null,
    page: 1,
    pageSize: state.pageSize,
    filters: {},
  };
}

export function pageRange(page: number, pageSize: number): { from: number; to: number } {
  const safePage = Math.max(1, Math.trunc(page));
  const safeSize = Math.max(1, Math.trunc(pageSize));
  const from = (safePage - 1) * safeSize;
  return { from, to: from + safeSize - 1 };
}

export function totalPages(totalRows: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, totalRows) / Math.max(1, pageSize)));
}

/**
 * A page number that belongs to one specific filter scope.
 *
 * Local-state lists (as opposed to the URL-driven lists updateListFilters()
 * serves) cannot reset the page from an effect: an effect runs one commit
 * AFTER the render that already handed the NEW filters together with the OLD
 * page to the query. That render issues one request for a page range the new
 * result set may not have -- PostgREST answers 416 Range Not Satisfiable --
 * and only the following render corrects it. Pairing the page with the scope
 * it was chosen in turns the reset into a derivation instead of a side
 * effect: the very first render that sees new filters already reads page 1,
 * so the stale combination never reaches a query key at all.
 */
export type ScopedPage = { scope: string; page: number };

/**
 * Stable identity for a filter scope.
 *
 * Each part is percent-encoded before joining, so a separator character inside
 * a value (search text is free-form user input and may contain anything)
 * cannot merge or split parts and make two different filter sets collide on
 * one scope. A null/undefined part gets its own sentinel, which encoding
 * guarantees is distinct from any real value, including the empty string.
 */
export function filterScopeKey(
  parts: readonly (string | number | boolean | null | undefined)[],
): string {
  return parts
    .map((part) => (part === null || part === undefined ? "~" : encodeURIComponent(String(part))))
    .join("|");
}

/** The page actually in effect: a page never outlives the scope it was set in. */
export function scopedPage(state: ScopedPage, scope: string): number {
  return state.scope === scope ? Math.max(1, Math.trunc(state.page)) : 1;
}

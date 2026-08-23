// Shared substring-match helper for every client-side search box added across
// the app (dashboard global search, POS order screen, POS menu management).
// Deliberately just case-insensitive partial matching over already
// property-scoped, already-permitted data — no new query/service, matching
// the same pattern CrudTable/guests.index.tsx/reservations.index.tsx already
// use for their own local filters.

export function matchesSearch(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}

export function reservationSearchText(r: {
  code?: string | null;
  guests?: { first_name?: string | null; last_name?: string | null } | null;
}): string {
  return [r.code, r.guests?.first_name, r.guests?.last_name].filter(Boolean).join(" ");
}

export function guestSearchText(g: {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
}): string {
  return [g.first_name, g.last_name, g.email, g.phone].filter(Boolean).join(" ");
}

export function roomSearchText(room: { number?: string | null }): string {
  return room.number ?? "";
}

export function menuItemSearchText(item: {
  name?: string | null;
  pos_menu_categories?: { name?: string | null } | null;
}): string {
  return [item.name, item.pos_menu_categories?.name].filter(Boolean).join(" ");
}

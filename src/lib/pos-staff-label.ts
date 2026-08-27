/**
 * Display label for a POS staff row from exec_pos_by_user.
 *
 * full_name is frequently NULL in production (POS orders were historically
 * saved without a recorded creator), so the chain degrades to a shortened
 * identifier and finally to an honest placeholder. A raw full UUID is never
 * shown: it is unhelpful to a reader and needlessly exposes the auth id.
 */
export function staffLabel(row: { full_name: string | null; user_id: string | null }): string {
  const name = (row.full_name ?? "").trim();
  if (name) return name;
  if (row.user_id) return `Staff ${row.user_id.slice(0, 8)}`;
  return "Unknown staff";
}

import type { Schematic, SchematicDeleted } from "@/lib/api";

const pages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;

/** The confirm prompt before deleting: says whether the pages come back. */
export function deletePrompt(s: Schematic): string {
  const back = s.refundable_pages ?? 0;
  if (back > 0) return `Delete ${s.title}? Its ${pages(back)} go back into this month's allowance.`;
  if ((s.pages_charged ?? 0) > 0)
    return `Delete ${s.title}? It was uploaded in an earlier month, so its ${pages(s.pages_charged ?? 0)} aren't given back.`;
  return `Delete ${s.title}?`;
}

/** What happened after a delete. */
export function deletedText(title: string, r: SchematicDeleted | null): string {
  if (r && r.refunded_pages > 0) {
    return `Deleted ${title}. ${pages(r.refunded_pages)} returned: ${r.pages_used} of ${r.pages_limit} used this month.`;
  }
  return `Deleted ${title}.`;
}

/** Small per-file line about its charge. */
export function chargeNote(s: Schematic): string | null {
  const charged = s.pages_charged ?? 0;
  if (!charged) return null;
  return (s.refundable_pages ?? 0) > 0 ? `${pages(charged)} counted this month (refunded if deleted)` : `${pages(charged)} counted in an earlier month`;
}

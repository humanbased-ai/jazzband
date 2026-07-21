export interface PrRow {
  state: string; // MERGED | CLOSED | OPEN
  headRefName: string;
  title?: string;
  url?: string;
}

export interface DeliverySummary {
  merged: number;
  closed: number;
  open: number;
  /** merged / (merged + closed), as a 0–100 int; null when nothing is resolved yet. */
  acceptancePct: number | null;
  rows: PrRow[];
}

/** Jazzband opens branches named `fix/<id>-jazzband`; measure how its PRs fared. */
export function summarizeDelivery(prs: PrRow[]): DeliverySummary {
  const rows = prs.filter((p) => p.headRefName.endsWith("-jazzband"));
  const merged = rows.filter((p) => p.state.toUpperCase() === "MERGED").length;
  const closed = rows.filter((p) => p.state.toUpperCase() === "CLOSED").length;
  const open = rows.filter((p) => p.state.toUpperCase() === "OPEN").length;
  const resolved = merged + closed;
  return { merged, closed, open, acceptancePct: resolved === 0 ? null : Math.round((merged / resolved) * 100), rows };
}

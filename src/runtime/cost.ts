/** Accumulates USD spend reported by the Claude CLI and enforces an optional budget cap. */
export class CostMeter {
  private total = 0;
  constructor(private readonly budgetUsd = 0) {}

  add(usd: number | undefined): void {
    if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) this.total += usd;
  }

  get totalUsd(): number {
    return this.total;
  }

  /** True once spend has reached the configured budget (0 = no cap). */
  overBudget(): boolean {
    return this.budgetUsd > 0 && this.total >= this.budgetUsd;
  }

  summary(): string {
    const cap = this.budgetUsd > 0 ? ` / $${this.budgetUsd.toFixed(2)} budget` : "";
    return `$${this.total.toFixed(4)}${cap}`;
  }
}

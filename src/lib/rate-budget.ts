type BudgetWindow = {
  windowMs: number;
  maxPoints: number;
};

type UsageEntry = {
  at: number;
  points: number;
};

const DEFAULT_WINDOWS: BudgetWindow[] = [
  { windowMs: 10_000, maxPoints: 500 },
  { windowMs: 60_000, maxPoints: 1500 }
];

export class MultiWindowPointBudget {
  private usage: UsageEntry[] = [];

  constructor(private readonly windows: BudgetWindow[] = DEFAULT_WINDOWS) {}

  private trim(now: number) {
    const maxWindow = Math.max(...this.windows.map((window) => window.windowMs));
    this.usage = this.usage.filter((entry) => now - entry.at <= maxWindow);
  }

  private pointsUsedInWindow(window: BudgetWindow, now: number) {
    return this.usage
      .filter((entry) => now - entry.at <= window.windowMs)
      .reduce((sum, entry) => sum + entry.points, 0);
  }

  canSpend(points: number, now = Date.now()) {
    this.trim(now);
    return this.windows.every((window) => {
      const used = this.pointsUsedInWindow(window, now);
      return used + points <= window.maxPoints;
    });
  }

  consume(points: number, now = Date.now()) {
    if (!this.canSpend(points, now)) {
      throw new Error("Limitless API point budget exhausted");
    }

    this.usage.push({ at: now, points });
  }
}

import { MarketSnapshot } from "@/lib/market-types";
import { getMarketCache } from "@/lib/cache";
import { createLimitlessClient } from "@/lib/limitless-client";
import { publishMarketSnapshot } from "@/lib/market-stream";

class MarketIndexer {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly client = createLimitlessClient();
  private lastError: string | null = null;
  private lastUpdatedAt: string | null = null;

  constructor(private readonly intervalMs: number) {}

  async start() {
    if (this.timer) {
      return;
    }

    await this.pollOnce();

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
  }

  async pollOnce() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const cache = await getMarketCache();
      const snapshot = await this.client.fetchActiveMarkets();
      const existing = await cache.getSnapshot();

      // Avoid replacing previously usable data with empty batches.
      const shouldUpdate = snapshot.markets.length > 0 || !existing;
      if (shouldUpdate) {
        await cache.setSnapshot(snapshot);
        publishMarketSnapshot(snapshot);
        this.lastUpdatedAt = snapshot.updatedAt;
      }

      this.lastError = null;
    } catch (error) {
      // Keep indexer alive even if an external API call fails.
      this.lastError = error instanceof Error ? error.message : "Unknown indexer error";
    } finally {
      this.running = false;
    }
  }

  async getSnapshot(): Promise<MarketSnapshot | null> {
    const cache = await getMarketCache();
    const existing = await cache.getSnapshot();

    if (existing) {
      return existing;
    }

    await this.pollOnce();
    return cache.getSnapshot();
  }

  getLastError() {
    return this.lastError;
  }

  getLastUpdatedAt() {
    return this.lastUpdatedAt;
  }
}

declare global {
  var __marketIndexer: MarketIndexer | undefined;
}

export async function getMarketIndexer() {
  if (!globalThis.__marketIndexer) {
    const intervalMs = Number(process.env.LIMITLESS_POLL_INTERVAL_MS ?? 3000);
    globalThis.__marketIndexer = new MarketIndexer(intervalMs);
  }

  await globalThis.__marketIndexer.start();
  return globalThis.__marketIndexer;
}

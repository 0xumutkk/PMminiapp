import Redis from "ioredis";
import { MarketSnapshot } from "@/lib/market-types";

const MARKET_CACHE_KEY = "miniapp:markets:snapshot";

type MarketCache = {
  getSnapshot: () => Promise<MarketSnapshot | null>;
  setSnapshot: (snapshot: MarketSnapshot) => Promise<void>;
};

class InMemoryMarketCache implements MarketCache {
  private snapshot: MarketSnapshot | null = null;

  async getSnapshot() {
    return this.snapshot;
  }

  async setSnapshot(snapshot: MarketSnapshot) {
    this.snapshot = snapshot;
  }
}

class RedisMarketCache implements MarketCache {
  private fallbackSnapshot: MarketSnapshot | null = null;

  constructor(private readonly redis: Redis) {}

  async getSnapshot() {
    try {
      const raw = await this.redis.get(MARKET_CACHE_KEY);
      if (!raw) {
        return this.fallbackSnapshot;
      }

      try {
        const parsed = JSON.parse(raw) as MarketSnapshot;
        this.fallbackSnapshot = parsed;
        return parsed;
      } catch {
        await this.redis.del(MARKET_CACHE_KEY);
        return this.fallbackSnapshot;
      }
    } catch {
      return this.fallbackSnapshot;
    }
  }

  async setSnapshot(snapshot: MarketSnapshot) {
    this.fallbackSnapshot = snapshot;

    try {
      await this.redis.set(MARKET_CACHE_KEY, JSON.stringify(snapshot), "EX", 60);
    } catch {
      // Keep in-memory fallback if Redis is temporarily unavailable.
    }
  }
}

let cachePromise: Promise<MarketCache> | undefined;

async function buildCache(): Promise<MarketCache> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return new InMemoryMarketCache();
  }

  try {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true
    });

    await redis.connect();
    await redis.ping();

    return new RedisMarketCache(redis);
  } catch {
    return new InMemoryMarketCache();
  }
}

export function getMarketCache() {
  cachePromise ??= buildCache();
  return cachePromise;
}

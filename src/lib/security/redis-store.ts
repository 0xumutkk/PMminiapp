import Redis from "ioredis";

declare global {
  var __miniAppSecurityRedisPromise: Promise<Redis | null> | undefined;
}

async function buildSecurityRedisClient(): Promise<Redis | null> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  try {
    const redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null
    });

    redis.on("error", () => {
      // no-op: callers can fall back to in-memory behavior.
    });

    await redis.connect();
    await redis.ping();

    return redis;
  } catch {
    return null;
  }
}

export function getSecurityRedisClient() {
  globalThis.__miniAppSecurityRedisPromise ??= buildSecurityRedisClient();
  return globalThis.__miniAppSecurityRedisPromise;
}

import type { PortfolioPositionsSnapshot } from "@/lib/portfolio/limitless-portfolio";
import { isAddress } from "viem";

const DISCOVERY_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60;

type DiscoveryCacheRecord = {
  addresses: string[];
  expiresAt: number;
};

type DiscoveryCacheStore = {
  get(key: string): Promise<string | null>;
  del?(key: string): Promise<number>;
  expire?(key: string, durationSeconds: number): Promise<number>;
  sadd?(key: string, ...members: string[]): Promise<number>;
  smembers?(key: string): Promise<string[]>;
  set(key: string, value: string, mode: "EX", durationSeconds: number): Promise<unknown>;
} | null;

declare global {
  var __pmMiniappPositionsDiscoveryCache: Map<string, DiscoveryCacheRecord> | undefined;
}

function getDiscoveryMemoryCache() {
  if (!globalThis.__pmMiniappPositionsDiscoveryCache) {
    globalThis.__pmMiniappPositionsDiscoveryCache = new Map();
  }

  return globalThis.__pmMiniappPositionsDiscoveryCache;
}

function getDiscoveryCacheKey(account: string) {
  return `pm-miniapp:positions-discovery:v2:${account.toLowerCase()}`;
}

function getLegacyDiscoveryCacheKey(account: string) {
  return `pm-miniapp:positions-discovery:${account.toLowerCase()}`;
}

export function normalizeDiscoveryAddresses(addresses: Iterable<string | null | undefined>) {
  return Array.from(
    new Set(
      Array.from(addresses)
        .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
        .filter((value) => value.length > 0 && isAddress(value))
    )
  );
}

export function extractDiscoveryAddressesFromSnapshot(snapshot: PortfolioPositionsSnapshot) {
  return normalizeDiscoveryAddresses(
    [...snapshot.active, ...snapshot.settled].map((position) => position.marketId)
  );
}

export async function readCachedDiscoveryAddresses(
  account: string,
  store: DiscoveryCacheStore
) {
  const cacheKey = getDiscoveryCacheKey(account);
  const legacyCacheKey = getLegacyDiscoveryCacheKey(account);

  if (store) {
    if (typeof store.smembers === "function") {
      try {
        const members = await store.smembers(cacheKey);
        if (members.length > 0) {
          return normalizeDiscoveryAddresses(members);
        }
      } catch (error) {
        console.warn("[Positions API] Discovery set read failed:", error);
      }
    }

    try {
      const raw = await store.get(legacyCacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          return normalizeDiscoveryAddresses(
            parsed.map((value) => (typeof value === "string" ? value : undefined))
          );
        }
      }
    } catch (error) {
      console.warn("[Positions API] Discovery cache read failed:", error);
    }
  }

  const memoryCache = getDiscoveryMemoryCache();
  const record = memoryCache.get(cacheKey);
  if (!record) {
    return [];
  }

  if (record.expiresAt <= Date.now()) {
    memoryCache.delete(cacheKey);
    return [];
  }

  return normalizeDiscoveryAddresses(record.addresses);
}

export async function writeCachedDiscoveryAddresses(
  account: string,
  addresses: string[],
  store: DiscoveryCacheStore
) {
  const cacheKey = getDiscoveryCacheKey(account);
  const normalizedAddresses = normalizeDiscoveryAddresses(addresses);

  if (normalizedAddresses.length === 0) {
    return [];
  }

  if (store) {
    if (
      typeof store.del === "function" &&
      typeof store.sadd === "function" &&
      typeof store.expire === "function"
    ) {
      try {
        await store.del(cacheKey);
        await store.sadd(cacheKey, ...normalizedAddresses);
        await store.expire(cacheKey, DISCOVERY_CACHE_TTL_SECONDS);
      } catch (error) {
        console.warn("[Positions API] Discovery cache write failed:", error);
      }
    } else {
      try {
        await store.set(cacheKey, JSON.stringify(normalizedAddresses), "EX", DISCOVERY_CACHE_TTL_SECONDS);
      } catch (error) {
        console.warn("[Positions API] Discovery cache write failed:", error);
      }
    }
  }

  getDiscoveryMemoryCache().set(cacheKey, {
    addresses: normalizedAddresses,
    expiresAt: Date.now() + DISCOVERY_CACHE_TTL_SECONDS * 1000
  });

  return normalizedAddresses;
}

export async function appendCachedDiscoveryAddresses(
  account: string,
  addresses: string[],
  store: DiscoveryCacheStore
) {
  const normalizedAddresses = normalizeDiscoveryAddresses(addresses);

  if (normalizedAddresses.length === 0) {
    return [];
  }

  if (store && typeof store.sadd === "function" && typeof store.expire === "function") {
    const cacheKey = getDiscoveryCacheKey(account);
    const mergedAddresses = normalizeDiscoveryAddresses([
      ...(await readCachedDiscoveryAddresses(account, store)),
      ...normalizedAddresses
    ]);

    try {
      await store.sadd(cacheKey, ...normalizedAddresses);
      await store.expire(cacheKey, DISCOVERY_CACHE_TTL_SECONDS);
    } catch (error) {
      console.warn("[Positions API] Discovery cache append failed:", error);
    }

    getDiscoveryMemoryCache().set(cacheKey, {
      addresses: mergedAddresses,
      expiresAt: Date.now() + DISCOVERY_CACHE_TTL_SECONDS * 1000
    });

    return mergedAddresses;
  }

  const mergedAddresses = normalizeDiscoveryAddresses([
    ...(await readCachedDiscoveryAddresses(account, store)),
    ...normalizedAddresses
  ]);

  return writeCachedDiscoveryAddresses(account, mergedAddresses, store);
}

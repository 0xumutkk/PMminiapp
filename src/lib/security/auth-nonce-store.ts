import { getSecurityRedisClient } from "@/lib/security/redis-store";

type NonceRecord = {
  expiresAt: number;
};

type NonceStore = Map<string, NonceRecord>;

declare global {
  var __miniAppAuthNonceStore: NonceStore | undefined;
}

const NONCE_KEY_PREFIX = "miniapp:auth:nonce:";

function getStore() {
  if (!globalThis.__miniAppAuthNonceStore) {
    globalThis.__miniAppAuthNonceStore = new Map();
  }

  return globalThis.__miniAppAuthNonceStore;
}

function pruneExpired(store: NonceStore, now: number) {
  for (const [nonce, record] of store) {
    if (record.expiresAt <= now) {
      store.delete(nonce);
    }
  }
}

async function claimAuthNonceInMemory(nonce: string, ttlMs: number) {
  const now = Date.now();
  const store = getStore();
  pruneExpired(store, now);

  const existing = store.get(nonce);
  if (existing && existing.expiresAt > now) {
    return false;
  }

  store.set(nonce, {
    expiresAt: now + Math.max(ttlMs, 1_000)
  });

  return true;
}

export async function claimAuthNonce(nonce: string, ttlMs: number) {
  const redis = await getSecurityRedisClient();
  const safeTtlMs = Math.max(ttlMs, 1_000);

  if (redis) {
    try {
      const result = await redis.set(`${NONCE_KEY_PREFIX}${nonce}`, "1", "PX", safeTtlMs, "NX");
      return result === "OK";
    } catch {
      // fall back to local in-memory behavior
    }
  }

  return claimAuthNonceInMemory(nonce, safeTtlMs);
}

export async function releaseAuthNonce(nonce: string) {
  const redis = await getSecurityRedisClient();
  if (redis) {
    try {
      await redis.del(`${NONCE_KEY_PREFIX}${nonce}`);
      return;
    } catch {
      // fall back to local in-memory behavior
    }
  }

  getStore().delete(nonce);
}

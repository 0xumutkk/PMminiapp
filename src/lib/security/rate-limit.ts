import { getClientIp } from "@/lib/security/request-context";

type RateLimitEvent = {
  at: number;
  cost: number;
};

type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  resetAfterMs: number;
};

type RateLimitOptions = {
  bucket: string;
  request: Request;
  limit: number;
  windowMs: number;
  cost?: number;
};

type Store = Map<string, RateLimitEvent[]>;

declare global {
  var __apiRateLimitStore: Store | undefined;
}

function getStore() {
  if (!globalThis.__apiRateLimitStore) {
    globalThis.__apiRateLimitStore = new Map();
  }

  return globalThis.__apiRateLimitStore;
}

export function checkRateLimit(options: RateLimitOptions): RateLimitResult {
  const { bucket, request, limit, windowMs, cost = 1 } = options;

  if (process.env.API_RATE_LIMIT_ENABLED === "false") {
    return {
      ok: true,
      limit,
      remaining: limit,
      retryAfterMs: 0,
      resetAfterMs: windowMs
    };
  }

  const now = Date.now();
  const ip = getClientIp(request);
  const key = `${bucket}:${ip}`;
  const store = getStore();
  const currentEvents = (store.get(key) ?? []).filter((event) => now - event.at <= windowMs);
  const used = currentEvents.reduce((sum, event) => sum + event.cost, 0);

  if (used + cost > limit) {
    const oldest = currentEvents[0]?.at ?? now;
    return {
      ok: false,
      limit,
      remaining: Math.max(0, limit - used),
      retryAfterMs: Math.max(0, windowMs - (now - oldest)),
      resetAfterMs: Math.max(0, windowMs - (now - oldest))
    };
  }

  currentEvents.push({ at: now, cost });
  store.set(key, currentEvents);

  const totalUsed = used + cost;
  const oldest = currentEvents[0]?.at ?? now;

  return {
    ok: true,
    limit,
    remaining: Math.max(0, limit - totalUsed),
    retryAfterMs: 0,
    resetAfterMs: Math.max(0, windowMs - (now - oldest))
  };
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAfterMs / 1000)),
    ...(result.ok ? {} : { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) })
  };
}

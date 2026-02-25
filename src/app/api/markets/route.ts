import { getMarketIndexer } from "@/lib/indexer";
import { logEvent } from "@/lib/observability";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
const LIMITLESS_SOURCE = "markets/active";

function sanitizeHeaderValue(value: string) {
  return value.replace(/[^\t\x20-\x7E]+/g, " ").trim().slice(0, 200);
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  let rateHeaders: Record<string, string> = {};
  let rateLimited = false;
  let retryAfterMs = 0;

  try {
    const rate = await checkRateLimit({
      bucket: "markets-read",
      request,
      limit: Number(process.env.MARKETS_RATE_LIMIT_PER_MINUTE ?? "120"),
      windowMs: 60_000
    });
    rateHeaders = rateLimitHeaders(rate);
    rateLimited = !rate.ok;
    retryAfterMs = rate.retryAfterMs;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown rate limit error";
    logEvent("warn", "markets_rate_limit_fallback", { requestId, errorMessage });
    rateHeaders = {};
  }

  if (rateLimited) {
    logEvent("warn", "markets_rate_limited", {
      requestId,
      retryAfterMs
    });

    return Response.json(
      { error: "Too many requests", requestId },
      {
        status: 429,
        headers: {
          ...rateHeaders,
          "Cache-Control": "no-store",
          "X-Limitless-Source": LIMITLESS_SOURCE
        }
      }
    );
  }

  try {
    const indexer = await getMarketIndexer();
    const snapshot = await indexer.getSnapshot();
    const payload = snapshot ?? {
      updatedAt: new Date().toISOString(),
      markets: []
    };

    const indexerError = indexer.getLastError();

    return Response.json(payload, {
      headers: {
        ...rateHeaders,
        "Cache-Control": "no-store",
        "X-Market-Count": String(payload.markets.length),
        "X-Limitless-Source": LIMITLESS_SOURCE,
        "X-Request-Id": requestId,
        ...(indexerError ? { "X-Indexer-Error": sanitizeHeaderValue(indexerError) } : {})
      }
    });
  } catch (error) {
    const payload = { updatedAt: new Date().toISOString(), markets: [] };

    const errorMessage = error instanceof Error ? error.message : "Unknown markets route error";

    logEvent("error", "markets_route_recovered", {
      requestId,
      errorMessage
    });

    return Response.json(payload, {
      status: 200,
      headers: {
        ...rateHeaders,
        "Cache-Control": "no-store",
        "X-Market-Count": String(payload.markets.length),
        "X-Limitless-Source": LIMITLESS_SOURCE,
        "X-Route-Recovered": "true",
        "X-Route-Error": sanitizeHeaderValue(errorMessage),
        "X-Request-Id": requestId
      }
    });
  }
}

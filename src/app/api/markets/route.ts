import { getMarketIndexer } from "@/lib/indexer";
import { logEvent } from "@/lib/observability";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

function sanitizeHeaderValue(value: string) {
  return value.replace(/[^\t\x20-\x7E]+/g, " ").trim().slice(0, 200);
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const rate = checkRateLimit({
    bucket: "markets-read",
    request,
    limit: Number(process.env.MARKETS_RATE_LIMIT_PER_MINUTE ?? "120"),
    windowMs: 60_000
  });
  const rateHeaders = rateLimitHeaders(rate);

  if (!rate.ok) {
    logEvent("warn", "markets_rate_limited", {
      requestId,
      retryAfterMs: rate.retryAfterMs
    });

    return Response.json(
      { error: "Too many requests", requestId },
      {
        status: 429,
        headers: {
          ...rateHeaders,
          "Cache-Control": "no-store"
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
        "X-Route-Recovered": "true",
        "X-Route-Error": sanitizeHeaderValue(errorMessage),
        "X-Request-Id": requestId
      }
    });
  }
}

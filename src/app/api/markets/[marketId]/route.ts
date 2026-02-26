import { getMarketIndexer } from "@/lib/indexer";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    marketId: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
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
  } catch {
    rateHeaders = {};
  }

  if (rateLimited) {
    return Response.json(
      {
        error: "Too many requests",
        retryAfterMs,
        requestId
      },
      {
        status: 429,
        headers: {
          ...rateHeaders,
          "Cache-Control": "no-store"
        }
      }
    );
  }

  const { marketId } = await context.params;

  try {
    const indexer = await getMarketIndexer();
    const snapshot = await indexer.getSnapshot();
    const market = snapshot?.markets.find((item) => item.id === marketId) ?? null;

    if (!market) {
      return Response.json(
        { error: "Market not found", requestId },
        {
          status: 404,
          headers: {
            ...rateHeaders,
            "Cache-Control": "no-store"
          }
        }
      );
    }

    return Response.json(market, {
      headers: {
        ...rateHeaders,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown market route error";

    return Response.json(
      { error: errorMessage, requestId },
      {
        status: 500,
        headers: {
          ...rateHeaders,
          "Cache-Control": "no-store"
        }
      }
    );
  }
}

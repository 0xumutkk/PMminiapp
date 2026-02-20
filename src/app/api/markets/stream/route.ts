import { getMarketIndexer } from "@/lib/indexer";
import { MarketSnapshot } from "@/lib/market-types";
import { subscribeMarketSnapshot } from "@/lib/market-stream";
import { logEvent } from "@/lib/observability";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";

export const runtime = "nodejs";

function toSseData(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toSseEvent(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);
  const rate = checkRateLimit({
    bucket: "markets-stream",
    request,
    limit: Number(process.env.MARKETS_STREAM_RATE_LIMIT_PER_MINUTE ?? "20"),
    windowMs: 60_000
  });
  const rateHeaders = rateLimitHeaders(rate);

  if (!rate.ok) {
    logEvent("warn", "markets_stream_rate_limited", {
      requestId,
      retryAfterMs: rate.retryAfterMs
    });

    return Response.json(
      { error: "Too many stream connections", requestId },
      {
        status: 429,
        headers: {
          ...rateHeaders,
          "Cache-Control": "no-store"
        }
      }
    );
  }

  const encoder = new TextEncoder();
  const indexer = await getMarketIndexer();

  let cleanup = () => {
    // no-op
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (payload: unknown) => {
        controller.enqueue(encoder.encode(toSseData(payload)));
      };

      const writeEvent = (event: string, payload: unknown) => {
        controller.enqueue(encoder.encode(toSseEvent(event, payload)));
      };

      const initial = await indexer.getSnapshot();
      if (initial) {
        write(initial);
      }

      const unsubscribe = subscribeMarketSnapshot((snapshot: MarketSnapshot) => {
        write(snapshot);
      });

      const pingTimer = setInterval(() => {
        writeEvent("ping", { now: Date.now() });
      }, 15_000);

      cleanup = () => {
        clearInterval(pingTimer);
        unsubscribe();
      };

      request.signal.addEventListener("abort", cleanup);
      logEvent("info", "markets_stream_connected", { requestId });
    },
    cancel() {
      cleanup();
      logEvent("info", "markets_stream_cancelled", { requestId });
    }
  });

  return new Response(stream, {
    headers: {
      ...rateHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Request-Id": requestId
    }
  });
}

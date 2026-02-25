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
  const encoder = new TextEncoder();
  let rateHeaders: Record<string, string> = {};
  let rateLimited = false;
  let retryAfterMs = 0;

  try {
    const rate = await checkRateLimit({
      bucket: "markets-stream",
      request,
      limit: Number(process.env.MARKETS_STREAM_RATE_LIMIT_PER_MINUTE ?? "20"),
      windowMs: 60_000
    });
    rateHeaders = rateLimitHeaders(rate);
    rateLimited = !rate.ok;
    retryAfterMs = rate.retryAfterMs;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown stream rate limit error";
    logEvent("warn", "markets_stream_rate_limit_fallback", { requestId, errorMessage });
    rateHeaders = {};
  }

  if (rateLimited) {
    logEvent("warn", "markets_stream_rate_limited", {
      requestId,
      retryAfterMs
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

  let indexer: Awaited<ReturnType<typeof getMarketIndexer>>;
  try {
    indexer = await getMarketIndexer();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown markets stream init error";
    logEvent("error", "markets_stream_init_failed", { requestId, errorMessage });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            toSseEvent("error", {
              message: "Stream temporarily unavailable",
              requestId
            })
          )
        );
        controller.close();
      }
    });

    return new Response(stream, {
      headers: {
        ...rateHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Request-Id": requestId,
        "X-Stream-Recovered": "true"
      }
    });
  }

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

      try {
        const initial = await indexer.getSnapshot();
        if (initial) {
          write(initial);
        }
      } catch {
        writeEvent("error", { message: "Initial snapshot unavailable", requestId });
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

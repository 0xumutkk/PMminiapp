import { buildTradeIntent } from "@/lib/trade/build-intent";
import { getMarketIndexer } from "@/lib/indexer";
import { Market } from "@/lib/market-types";
import { TradeIntentRequest, TradeIntentResponse } from "@/lib/trade/trade-types";
import { logEvent } from "@/lib/observability";
import { isAddressAllowedForBeta, isBetaModeEnabled } from "@/lib/security/beta-access";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { isAddress } from "viem";

export const runtime = "nodejs";

function badRequest(message: string, requestId: string, headers: Record<string, string>) {
  return Response.json(
    { error: message, requestId },
    {
      status: 400,
      headers
    }
  );
}

function isValidTradeSide(side: string): side is "yes" | "no" {
  return side === "yes" || side === "no";
}

async function findMarketById(marketId: string): Promise<Market | null> {
  const indexer = await getMarketIndexer();
  const snapshot = await indexer.getSnapshot();
  if (!snapshot) {
    return null;
  }

  return snapshot.markets.find((market) => market.id === marketId) ?? null;
}

export async function POST(request: Request) {
  const requestId = getRequestId(request);

  const rate = checkRateLimit({
    bucket: "trade-intent",
    request,
    limit: Number(process.env.TRADE_INTENT_RATE_LIMIT ?? "30"),
    windowMs: 60_000,
    cost: 1
  });

  const rateHeaders = rateLimitHeaders(rate);
  if (!rate.ok) {
    logEvent("warn", "trade_intent_rate_limited", { requestId, retryAfterMs: rate.retryAfterMs });
    return Response.json(
      { error: "Too many requests", requestId },
      {
        status: 429,
        headers: rateHeaders
      }
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return badRequest("Invalid JSON body", requestId, rateHeaders);
  }

  if (typeof payload !== "object" || payload === null) {
    return badRequest("Request body must be an object", requestId, rateHeaders);
  }

  const body = payload as Partial<TradeIntentRequest>;

  if (!body.marketId || typeof body.marketId !== "string") {
    return badRequest("marketId is required", requestId, rateHeaders);
  }

  if (!body.amountUsdc || typeof body.amountUsdc !== "string") {
    return badRequest("amountUsdc is required", requestId, rateHeaders);
  }

  if (!body.side || typeof body.side !== "string" || !isValidTradeSide(body.side)) {
    return badRequest("side must be yes or no", requestId, rateHeaders);
  }

  if (!isAddressAllowedForBeta(body.walletAddress)) {
    return Response.json(
      {
        error: isBetaModeEnabled()
          ? "This wallet is not allowlisted for beta"
          : "Wallet is not authorized",
        requestId
      },
      {
        status: 403,
        headers: rateHeaders
      }
    );
  }

  try {
    const market = await findMarketById(body.marketId);
    if (!market) {
      return Response.json(
        { error: "Market not found in active snapshot", requestId },
        {
          status: 404,
          headers: rateHeaders
        }
      );
    }

    const venueExchange = market.tradeVenue?.venueExchange ?? process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS;
    if (!venueExchange) {
      return Response.json(
        {
          error:
            "Selected market does not expose venue.exchange and LIMITLESS_TRADE_CONTRACT_ADDRESS is not set",
          requestId
        },
        {
          status: 400,
          headers: rateHeaders
        }
      );
    }

    if (!isAddress(venueExchange)) {
      return Response.json(
        {
          error: "Resolved trade contract address is invalid",
          requestId
        },
        {
          status: 400,
          headers: rateHeaders
        }
      );
    }

    const intent = buildTradeIntent({
      marketId: body.marketId,
      side: body.side,
      amountUsdc: body.amountUsdc,
      walletAddress: body.walletAddress,
      tradeContract: venueExchange,
      functionSignature: market.tradeVenue?.functionSignature,
      argMap: market.tradeVenue?.argMap
    });

    const response: TradeIntentResponse = intent;

    return Response.json(response, {
      status: 200,
      headers: {
        ...rateHeaders,
        "Cache-Control": "no-store",
        "X-Request-Id": requestId
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown trade intent error";

    logEvent("error", "trade_intent_failed", {
      requestId,
      message
    });

    return Response.json(
      {
        error: message,
        requestId
      },
      {
        status: 400,
        headers: {
          ...rateHeaders,
          "X-Request-Id": requestId
        }
      }
    );
  }
}

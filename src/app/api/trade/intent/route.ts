import { buildTradeIntent } from "@/lib/trade/build-intent";
import { getMarketIndexer } from "@/lib/indexer";
import { Market } from "@/lib/market-types";
import { TradeIntentRequest, TradeIntentResponse } from "@/lib/trade/trade-types";
import { logEvent } from "@/lib/observability";
import { isAddressAllowedForBeta, isBetaModeEnabled } from "@/lib/security/beta-access";
import {
  clearAuthCookieHeader,
  getAuthAddressFromRequest,
  getAuthTokenFromRequest,
  resolveExpectedAuthDomain,
  verifyMiniAppAuthToken
} from "@/lib/security/miniapp-auth";
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

function parseExpectedPrice(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    return null;
  }

  return parsed;
}

function parseMaxSlippageBps(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }

  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const rounded = Math.round(parsed);
  if (rounded < 10 || rounded > 5000) {
    return null;
  }

  return rounded;
}

function computeSlippageBps(expectedPrice: number, executionPrice: number) {
  if (!Number.isFinite(expectedPrice) || expectedPrice <= 0) {
    return null;
  }

  const drift = Math.abs(executionPrice - expectedPrice);
  return Math.round((drift / expectedPrice) * 10_000);
}

function isTradeAuthRequired() {
  const raw = process.env.TRADE_AUTH_REQUIRED;
  if (raw === "true") {
    return true;
  }

  if (raw === "false") {
    return false;
  }

  // Safe default: production requires auth, local development does not.
  return process.env.NODE_ENV === "production";
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

  const rate = await checkRateLimit({
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

  if (!body.walletAddress || typeof body.walletAddress !== "string" || !isAddress(body.walletAddress)) {
    return badRequest("walletAddress must be a valid EVM address", requestId, rateHeaders);
  }

  const expectedPrice = parseExpectedPrice(body.expectedPrice);
  if (body.expectedPrice !== undefined && expectedPrice === null) {
    return badRequest("expectedPrice must be a decimal between 0 and 1", requestId, rateHeaders);
  }

  const maxSlippageBps = parseMaxSlippageBps(body.maxSlippageBps ?? 200);
  if (body.maxSlippageBps !== undefined && maxSlippageBps === null) {
    return badRequest("maxSlippageBps must be an integer between 10 and 5000", requestId, rateHeaders);
  }

  let verifiedWalletAddress = body.walletAddress;

  if (isTradeAuthRequired()) {
    const token = getAuthTokenFromRequest(request);
    if (!token) {
      return Response.json(
        {
          error: "Authentication required before creating trade intent",
          requestId
        },
        {
          status: 401,
          headers: {
            ...rateHeaders,
            "Cache-Control": "no-store"
          }
        }
      );
    }

    const expectedDomain = resolveExpectedAuthDomain(request);
    const addressFromCookie = getAuthAddressFromRequest(request);
    const addressForVerification =
      addressFromCookie ?? (isAddress(body.walletAddress) ? body.walletAddress : undefined);
    const claims = await verifyMiniAppAuthToken(
      token,
      expectedDomain,
      addressForVerification
    );

    if (!claims) {
      const headers = new Headers(rateHeaders);
      headers.set("Cache-Control", "no-store");
      for (const c of clearAuthCookieHeader()) {
        headers.append("Set-Cookie", c);
      }
      return Response.json(
        { error: "Authentication token is invalid or expired", requestId },
        { status: 401, headers }
      );
    }

    if (claims.address.toLowerCase() !== body.walletAddress.toLowerCase()) {
      return Response.json(
        {
          error: "Authenticated wallet does not match walletAddress in request",
          requestId
        },
        {
          status: 403,
          headers: rateHeaders
        }
      );
    }

    verifiedWalletAddress = claims.address;
  }

  if (!isAddressAllowedForBeta(verifiedWalletAddress)) {
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

    if (market.status !== "open") {
      return Response.json(
        {
          error: "Selected market is not open for trading",
          requestId
        },
        {
          status: 409,
          headers: rateHeaders
        }
      );
    }

    if (market.endsAt) {
      const endsAtMs = Date.parse(market.endsAt);
      if (Number.isFinite(endsAtMs) && endsAtMs <= Date.now()) {
        return Response.json(
          {
            error: "Selected market has reached its deadline",
            requestId
          },
          {
            status: 409,
            headers: rateHeaders
          }
        );
      }
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

    const executionPrice = body.side === "yes" ? market.yesPrice : market.noPrice;
    const resolvedMaxSlippageBps = maxSlippageBps ?? 200;
    const slippageBps = expectedPrice !== null ? computeSlippageBps(expectedPrice, executionPrice) : null;

    if (expectedPrice !== null && slippageBps !== null && slippageBps > resolvedMaxSlippageBps) {
      return Response.json(
        {
          error: "Market price moved beyond your slippage tolerance. Please review and try again.",
          requestId,
          guard: {
            expectedPrice,
            executionPrice,
            slippageBps,
            maxSlippageBps: resolvedMaxSlippageBps
          }
        },
        {
          status: 409,
          headers: rateHeaders
        }
      );
    }

    const intent = buildTradeIntent({
      marketId: body.marketId,
      side: body.side,
      amountUsdc: body.amountUsdc,
      walletAddress: verifiedWalletAddress,
      tradeContract: venueExchange,
      functionSignature: market.tradeVenue?.functionSignature,
      argMap: market.tradeVenue?.argMap,
      executionPrice,
      expectedPrice: expectedPrice ?? undefined,
      maxSlippageBps: resolvedMaxSlippageBps
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

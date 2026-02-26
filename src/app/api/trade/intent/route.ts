import { buildTradeIntent } from "@/lib/trade/build-intent";
import { getMarketIndexer } from "@/lib/indexer";
import { Market } from "@/lib/market-types";
import { fetchPublicPortfolioPositions } from "@/lib/portfolio/limitless-portfolio";
import { TradeIntentAction, TradeIntentRequest, TradeIntentResponse } from "@/lib/trade/trade-types";
import { logEvent } from "@/lib/observability";
import { isAddressAllowedForBeta, isBetaModeEnabled } from "@/lib/security/beta-access";
import {
  clearAuthCookieHeader,
  getAuthAddressFromRequest,
  getAuthDomainFromRequest,
  getAuthTokenFromRequest,
  normalizeMiniAppDomain,
  resolveExpectedAuthDomain,
  verifyMiniAppAuthToken
} from "@/lib/security/miniapp-auth";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { base } from "viem/chains";
import { createPublicClient, formatUnits, http, isAddress, parseAbi, parseUnits } from "viem";

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

function isValidTradeAction(action: string): action is TradeIntentAction {
  return action === "buy" || action === "sell" || action === "redeem";
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

function resolveUsdcDecimals() {
  const parsed = Number(process.env.USDC_DECIMALS ?? "6");
  if (!Number.isFinite(parsed)) {
    return 6;
  }

  return Math.max(0, Math.min(18, Math.trunc(parsed)));
}

function parseUsdcUnits(value: string, decimals: number) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }

  try {
    return parseUnits(trimmed, decimals);
  } catch {
    return null;
  }
}

function formatUsdcAmount(units: bigint, decimals: number) {
  const formatted = formatUnits(units, decimals);
  return formatted.replace(/\.?0+$/, "") || "0";
}

function formatAmountForError(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

const ERC20_ALLOWANCE_ABI = parseAbi([
  "function allowance(address owner,address spender) view returns (uint256)"
]);

function resolveBaseRpcUrl() {
  return process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
}

async function shouldRequireUsdcApprove(
  owner: `0x${string}`,
  spender: `0x${string}`,
  amountUsdc: string,
  decimals: number
) {
  const requiredUnits = parseUsdcUnits(amountUsdc, decimals);
  if (requiredUnits === null || requiredUnits <= 0n) {
    return true;
  }

  try {
    const publicClient = createPublicClient({
      chain: base,
      transport: http(resolveBaseRpcUrl(), { timeout: 8_000 })
    });

    const usdcAddress =
      (process.env.USDC_TOKEN_ADDRESS as `0x${string}` | undefined) ??
      (process.env.NEXT_PUBLIC_USDC_TOKEN_ADDRESS as `0x${string}` | undefined) ??
      ("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const);

    const allowance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "allowance",
      args: [owner, spender]
    });

    return allowance < requiredUnits;
  } catch (error) {
    logEvent("warn", "trade_intent_allowance_check_failed", {
      owner,
      spender,
      message: error instanceof Error ? error.message : "unknown"
    });
    return true;
  }
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

function matchesPositionMarket(position: { marketId: string; marketSlug: string }, marketId: string) {
  return position.marketId === marketId || position.marketSlug === marketId;
}

function parseHostCandidate(raw: string | null | undefined) {
  if (!raw) {
    return "";
  }

  const value = raw.trim();
  if (!value) {
    return "";
  }

  try {
    return new URL(value).host;
  } catch {
    if (!/^https?:\/\//i.test(value)) {
      try {
        return new URL(`https://${value}`).host;
      } catch {
        // fall through
      }
    }
  }

  return value;
}

function buildDomainCandidates(request: Request, expectedDomain: string, preferredDomain?: string | null) {
  const candidates = new Set<string>();

  const add = (raw: string | null | undefined) => {
    const parsed = parseHostCandidate(raw);
    const normalized = normalizeMiniAppDomain(parsed);
    if (normalized) {
      candidates.add(normalized);
    }
  };

  add(preferredDomain);
  add(expectedDomain);
  add(process.env.NEXT_PUBLIC_MINI_APP_URL);
  add(request.headers.get("x-forwarded-host")?.split(",")[0] ?? "");
  add(request.headers.get("host"));
  add(request.url);

  return [...candidates];
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
  const actionRaw = typeof body.action === "string" ? body.action.toLowerCase() : "buy";
  if (!isValidTradeAction(actionRaw)) {
    return badRequest("action must be buy, sell, or redeem", requestId, rateHeaders);
  }
  const action = actionRaw as TradeIntentAction;

  if (!body.marketId || typeof body.marketId !== "string") {
    return badRequest("marketId is required", requestId, rateHeaders);
  }
  const marketId = body.marketId;

  if ((action === "buy" || action === "sell") && (!body.amountUsdc || typeof body.amountUsdc !== "string")) {
    return badRequest("amountUsdc is required for buy/sell actions", requestId, rateHeaders);
  }

  if (!body.side || typeof body.side !== "string" || !isValidTradeSide(body.side)) {
    return badRequest("side must be yes or no", requestId, rateHeaders);
  }
  const side = body.side;

  if (!body.walletAddress || typeof body.walletAddress !== "string" || !isAddress(body.walletAddress)) {
    return badRequest("walletAddress must be a valid EVM address", requestId, rateHeaders);
  }

  let expectedPrice: number | null = null;
  let maxSlippageBps: number | null = null;
  if (action === "buy" || action === "sell") {
    expectedPrice = parseExpectedPrice(body.expectedPrice);
    if (body.expectedPrice !== undefined && expectedPrice === null) {
      return badRequest("expectedPrice must be a decimal between 0 and 1", requestId, rateHeaders);
    }

    maxSlippageBps = parseMaxSlippageBps(body.maxSlippageBps ?? 200);
    if (body.maxSlippageBps !== undefined && maxSlippageBps === null) {
      return badRequest("maxSlippageBps must be an integer between 10 and 5000", requestId, rateHeaders);
    }
  }

  if (action === "sell" && expectedPrice === null) {
    return badRequest("expectedPrice is required for sell actions", requestId, rateHeaders);
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
    const authDomainFromCookie = getAuthDomainFromRequest(request);
    const domains = buildDomainCandidates(request, expectedDomain, authDomainFromCookie);
    let claims = null;
    for (const domain of domains) {
      claims = await verifyMiniAppAuthToken(token, domain, addressForVerification);
      if (claims) {
        break;
      }
    }

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
    const market = await findMarketById(marketId);
    const usdcDecimals = resolveUsdcDecimals();
    let tradeContract: string | undefined;
    let functionSignature: string | undefined;
    let argMap: string | undefined;
    let requireUsdcApprove: boolean | undefined;
    let amountUsdc = body.amountUsdc;
    let executionPrice: number | undefined;
    let slippageBps: number | null = null;
    let intentMarketId = marketId;

    if (action === "buy") {
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

      if (amountUsdc && market.minTradeSizeUsdc) {
        const requestedUnits = parseUsdcUnits(amountUsdc, usdcDecimals);
        const minimumUnits = parseUsdcUnits(String(market.minTradeSizeUsdc), usdcDecimals);
        if (requestedUnits !== null && minimumUnits !== null && requestedUnits < minimumUnits) {
          return Response.json(
            {
              error: `Minimum stake for this market is ${formatAmountForError(market.minTradeSizeUsdc)} USDC.`,
              requestId
            },
            {
              status: 409,
              headers: rateHeaders
            }
          );
        }
      }

      tradeContract =
        market.tradeVenue?.venueExchange ??
        market.tradeVenue?.venueAdapter ??
        process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS;
      functionSignature = market.tradeVenue?.functionSignature;
      argMap = market.tradeVenue?.argMap;
      executionPrice = side === "yes" ? market.yesPrice : market.noPrice;
      intentMarketId = market.tradeVenue?.marketRef ?? market.id;
      if (tradeContract && isAddress(tradeContract) && amountUsdc) {
        requireUsdcApprove = await shouldRequireUsdcApprove(
          verifiedWalletAddress as `0x${string}`,
          tradeContract as `0x${string}`,
          amountUsdc,
          usdcDecimals
        );
      } else {
        requireUsdcApprove = true;
      }
    } else if (action === "sell") {
      const snapshot = await fetchPublicPortfolioPositions(verifiedWalletAddress);
      const activePosition = snapshot.active.find(
        (position) => matchesPositionMarket(position, marketId) && position.side === side
      );
      if (!activePosition) {
        return Response.json(
          {
            error: "No active position found for this market/side.",
            requestId
          },
          {
            status: 409,
            headers: rateHeaders
          }
        );
      }

      const maxSellUnits = parseUsdcUnits(activePosition.marketValueUsdc, usdcDecimals);
      if (maxSellUnits === null || maxSellUnits <= 0n) {
        return Response.json(
          {
            error: "Active position has no sellable exposure.",
            requestId
          },
          {
            status: 409,
            headers: rateHeaders
          }
        );
      }

      const requestedSellAmount = body.amountUsdc ?? activePosition.marketValueUsdc;
      const requestedSellUnits = parseUsdcUnits(requestedSellAmount, usdcDecimals);
      if (requestedSellUnits === null || requestedSellUnits <= 0n) {
        return badRequest("amountUsdc must be a positive decimal string for sell action", requestId, rateHeaders);
      }

      const boundedSellUnits = requestedSellUnits > maxSellUnits ? maxSellUnits : requestedSellUnits;
      amountUsdc = formatUsdcAmount(boundedSellUnits, usdcDecimals);
      intentMarketId = activePosition.marketId || activePosition.marketSlug || marketId;

      tradeContract =
        market?.tradeVenue?.venueExchange ??
        market?.tradeVenue?.venueAdapter ??
        process.env.LIMITLESS_SELL_CONTRACT_ADDRESS ??
        process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS;
      functionSignature = process.env.LIMITLESS_SELL_FUNCTION_SIGNATURE;
      argMap = process.env.LIMITLESS_SELL_ARG_MAP;
      requireUsdcApprove = process.env.SELL_REQUIRE_USDC_APPROVE === "true";
      executionPrice = market ? (side === "yes" ? market.yesPrice : market.noPrice) : undefined;
    } else {
      const snapshot = await fetchPublicPortfolioPositions(verifiedWalletAddress);
      const claimablePosition = snapshot.settled.find(
        (position) =>
          matchesPositionMarket(position, marketId) &&
          position.side === side &&
          position.claimable
      );
      if (!claimablePosition) {
        return Response.json(
          {
            error: "No claimable settled position found for this market/side.",
            requestId
          },
          {
            status: 409,
            headers: rateHeaders
          }
        );
      }

      tradeContract =
        process.env.LIMITLESS_REDEEM_CONTRACT_ADDRESS ??
        process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS;
      functionSignature = process.env.LIMITLESS_REDEEM_FUNCTION_SIGNATURE;
      argMap = process.env.LIMITLESS_REDEEM_ARG_MAP;
      requireUsdcApprove = false;
      amountUsdc = amountUsdc ?? claimablePosition.marketValueUsdc;
      intentMarketId = claimablePosition.marketId || claimablePosition.marketSlug || marketId;
    }

    if (!tradeContract) {
      return Response.json(
        {
          error: `Trade contract address is missing for ${action} action`,
          requestId
        },
        {
          status: 400,
          headers: rateHeaders
        }
      );
    }

    if (!isAddress(tradeContract)) {
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

    const resolvedMaxSlippageBps = maxSlippageBps ?? 200;
    if ((action === "buy" || action === "sell") && executionPrice !== undefined) {
      slippageBps = expectedPrice !== null ? computeSlippageBps(expectedPrice, executionPrice) : null;
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
    }

    const intent = buildTradeIntent({
      action,
      marketId: intentMarketId,
      side,
      amountUsdc,
      walletAddress: verifiedWalletAddress,
      tradeContract,
      functionSignature,
      argMap,
      executionPrice,
      expectedPrice: expectedPrice ?? undefined,
      maxSlippageBps: action === "buy" || action === "sell" ? resolvedMaxSlippageBps : undefined,
      requireUsdcApprove
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

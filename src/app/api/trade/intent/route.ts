import { buildTradeIntent } from "@/lib/trade/build-intent";
import * as portfolioPositionsRoute from "@/app/api/portfolio/positions/route";
import { getMarketIndexer } from "@/lib/indexer";
import { Market } from "@/lib/market-types";
import { appendCachedDiscoveryAddresses } from "@/lib/portfolio/discovery-cache";
import {
  fetchPublicPortfolioPositions,
  type PortfolioPositionsSnapshot
} from "@/lib/portfolio/limitless-portfolio";
import {
  CONDITIONAL_TOKENS_ADDRESS,
  fetchOnchainAmmPositions,
  fetchFpmmAddressesFromHistory,
  getConditionalTokensAddress,
  resolveFpmmMetadata
} from "@/lib/portfolio/onchain-portfolio";
import type { AmmMarketRef } from "@/lib/portfolio/onchain-portfolio";
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
import { getSecurityRedisClient } from "@/lib/security/redis-store";
import { base } from "viem/chains";
import { createPublicClient, formatUnits, http, isAddress, parseAbi, parseUnits } from "viem";

export const runtime = "nodejs";

// FPMM view function to check if a given returnAmount is feasible before submitting sell.
const FPMM_CALC_SELL_ABI = parseAbi([
  "function calcSellAmount(uint256 investmentAmount, uint256 outcomeIndex) view returns (uint256 outcomeTokenSellAmount)"
]);

/**
 * Finds the maximum viable returnAmount (USDC) for an FPMM sell.
 * FPMM `sell(returnAmount, outcome, maxTokens)` reverts with SafeMath if the
 * pool does not have enough liquidity to honour the requested USDC return.
 * This helper does a binary-search preflight using calcSellAmount() to avoid that.
 *
 * Returns the adjusted amountUsdc (6-decimal string) or throws if pool is dry.
 */
async function resolveViableSellAmount(
  fpmmAddress: `0x${string}`,
  outcomeIndex: bigint,
  maxSharesToBurnUnits: bigint,
  decimals: number,
  slippageBps: number
): Promise<{ amountUsdc: string; maxTokensRaw: string }> {
  const rpcUrl = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org";
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  // Fast binary search to find the maximum `returnAmount` (USDC collateral output)
  // such that `calcSellAmount(returnAmount)` <= `maxSharesToBurnUnits`.
  let low = 0n;
  let high = maxSharesToBurnUnits;
  let bestReturn = 0n;

  // 15 iterations provides excellent precision over the curve without RPC timeouts
  for (let i = 0; i < 15; i++) {
    const mid = low + (high - low) / 2n;
    if (mid === 0n) break;

    try {
      const requiredTokens = await client.readContract({
        address: fpmmAddress,
        abi: FPMM_CALC_SELL_ABI,
        functionName: "calcSellAmount",
        args: [mid, outcomeIndex]
      });

      if (requiredTokens <= maxSharesToBurnUnits) {
        bestReturn = mid;
        low = mid + 1n; // Safe, try to extract more USDC payout
      } else {
        high = mid - 1n; // Invariant breached, Requires too many shares
      }
    } catch {
      // Reverted: likely means we requested more USDC than the pool's whole balance
      high = mid - 1n;
    }
  }

  if (bestReturn === 0n) {
    throw new Error(
      "Pool has insufficient liquidity to sell this position. " +
      "You may need to wait until the market resolves to redeem your tokens."
    );
  }

  // Authorize burning exactly the units the user asked to sell, 
  // but ask for less USDC as a slippage safety buffer to ensure execution succeeds.
  const safeReturnUnits = (bestReturn * BigInt(Math.max(0, 10000 - slippageBps))) / 10000n;

  if (safeReturnUnits === 0n) {
    throw new Error("Fractional sell amount too small to process over slippage bounds.");
  }

  return {
    amountUsdc: formatUnits(safeReturnUnits, decimals),
    maxTokensRaw: maxSharesToBurnUnits.toString()
  };
}

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

function normalizeMarketCandidate(value: string | undefined | null) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function buildMarketMatchCandidates(marketId: string, market: Market | null) {
  return [
    marketId,
    market?.id,
    market?.tradeVenue?.marketRef,
    market?.tradeVenue?.venueExchange,
    market?.tradeVenue?.venueAdapter
  ]
    .map(normalizeMarketCandidate)
    .filter((value, index, values): value is string => value !== null && values.indexOf(value) === index);
}

function matchesPositionMarketCandidates(
  position: { marketId: string; marketSlug: string },
  candidates: string[]
) {
  const marketId = normalizeMarketCandidate(position.marketId);
  const marketSlug = normalizeMarketCandidate(position.marketSlug);
  return (
    (!!marketId && candidates.includes(marketId)) ||
    (!!marketSlug && candidates.includes(marketSlug))
  );
}

function buildFallbackAmmMarkets(
  historyAddresses: string[],
  market: Market | null
): AmmMarketRef[] {
  const markets: AmmMarketRef[] = [];
  const seen = new Set<string>();
  const marketVenueExchange = market?.tradeVenue?.venueExchange;

  if (marketVenueExchange && isAddress(marketVenueExchange)) {
    const normalized = marketVenueExchange.toLowerCase();
    seen.add(normalized);
    markets.push({
      id: market.id,
      slug: market.id,
      title: market.title,
      contractAddress: marketVenueExchange,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice
    });
  }

  for (const address of historyAddresses) {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    markets.push({
      id: address,
      slug: address,
      title: "Position",
      contractAddress: address
    });
  }

  return markets;
}

function normalizeDiscoveryAddressCandidate(value: string | undefined | null) {
  return typeof value === "string" && isAddress(value) ? (value.toLowerCase() as `0x${string}`) : null;
}

async function persistDiscoveryAddressesForWallet(
  walletAddress: `0x${string}`,
  candidates: Array<string | undefined | null>
) {
  const addresses = Array.from(
    new Set(
      candidates
        .map(normalizeDiscoveryAddressCandidate)
        .filter((value): value is `0x${string}` => value !== null)
    )
  );

  if (addresses.length === 0) {
    return;
  }

  try {
    const redis = await getSecurityRedisClient();
    await appendCachedDiscoveryAddresses(walletAddress, addresses, redis);
  } catch (error) {
    logEvent("warn", "trade_intent_discovery_cache_write_failed", {
      walletAddress,
      addresses,
      message: error instanceof Error ? error.message : "unknown"
    });
  }
}

function isPortfolioSnapshot(value: unknown): value is PortfolioPositionsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<PortfolioPositionsSnapshot>;
  return Array.isArray(candidate.active) && Array.isArray(candidate.settled);
}

async function fetchPortfolioSnapshotForRedeem(
  request: Request,
  walletAddress: `0x${string}`
): Promise<PortfolioPositionsSnapshot | null> {
  const forwardedHeaders = new Headers();
  const auth = request.headers.get("Authorization");
  const deviceId = request.headers.get("limitless-device-id");
  if (auth) forwardedHeaders.set("Authorization", auth);
  if (deviceId) forwardedHeaders.set("limitless-device-id", deviceId);

  const fetchSnapshot = async (fresh: boolean) => {
    const portfolioUrl = new URL(request.url);
    portfolioUrl.pathname = "/api/portfolio/positions";
    portfolioUrl.searchParams.set("account", walletAddress);
    if (fresh) {
      portfolioUrl.searchParams.set("fresh", "1");
    } else {
      portfolioUrl.searchParams.delete("fresh");
    }

    const portfolioRequest = new Request(portfolioUrl, {
      headers: forwardedHeaders
    });
    const portfolioResponse = await portfolioPositionsRoute.GET(portfolioRequest);
    const portfolioBody = (await portfolioResponse.json().catch(() => null)) as unknown;

    return portfolioResponse.ok && isPortfolioSnapshot(portfolioBody) ? portfolioBody : null;
  };

  return (await fetchSnapshot(false)) ?? (await fetchSnapshot(true));
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

function normalizeLimitlessApiBaseUrl(rawBaseUrl: string | undefined) {
  const fallback = "https://api.limitless.exchange";
  try {
    const url = new URL(rawBaseUrl ?? fallback);
    if (url.pathname.endsWith("/api-v1")) {
      url.pathname = "/";
    }
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url.toString();
  } catch {
    return `${fallback}/`;
  }
}

type RedeemMarketMetadata = {
  fpmmAddress?: `0x${string}`;
  conditionId?: `0x${string}`;
  conditionalTokensContract?: `0x${string}`;
};

async function fetchRedeemMarketMetadata(candidates: Array<string | undefined | null>) {
  const uniqueCandidates = candidates
    .map((candidate) => (typeof candidate === "string" ? candidate.trim() : ""))
    .filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index);

  if (uniqueCandidates.length === 0) {
    return null;
  }

  const baseUrl = normalizeLimitlessApiBaseUrl(process.env.LIMITLESS_API_BASE_URL);
  const headers = {
    Accept: "application/json",
    Origin: "https://limitless.exchange",
    Referer: "https://limitless.exchange/",
    "User-Agent": "Mozilla/5.0"
  };

  for (const candidate of uniqueCandidates) {
    try {
      const response = await fetch(new URL(`markets/${encodeURIComponent(candidate)}`, baseUrl), {
        headers,
        cache: "no-store",
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as Record<string, unknown> | { data?: unknown[] };
      const row = Array.isArray((payload as { data?: unknown[] }).data)
        ? (payload as { data?: unknown[] }).data?.[0]
        : payload;

      if (!row || typeof row !== "object") {
        continue;
      }

      const record = row as Record<string, unknown>;
      const venue =
        typeof record.venue === "object" && record.venue !== null
          ? (record.venue as Record<string, unknown>)
          : undefined;
      const fpmmAddress =
        typeof record.address === "string" && isAddress(record.address)
          ? (record.address as `0x${string}`)
          : typeof venue?.exchange === "string" && isAddress(venue.exchange)
            ? (venue.exchange as `0x${string}`)
            : undefined;
      const conditionId =
        typeof record.conditionId === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.conditionId)
          ? (record.conditionId as `0x${string}`)
          : undefined;

      if (!fpmmAddress && !conditionId) {
        continue;
      }

      return {
        fpmmAddress,
        conditionId,
        conditionalTokensContract: conditionId ? CONDITIONAL_TOKENS_ADDRESS : undefined
      } satisfies RedeemMarketMetadata;
    } catch {
      // Continue to the next candidate.
    }
  }

  return null;
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
        { error: "Authenticated wallet does not match trade wallet", requestId },
        {
          status: 403,
          headers: rateHeaders
        }
      );
    }

    verifiedWalletAddress = body.walletAddress;
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
    let conditionalTokensContract: `0x${string}` | undefined;
    let conditionId: `0x${string}` | undefined;
    const discoveryAddressCandidates: Array<string | undefined> = [];
    const registerDiscoveryAddress = (value: string | undefined | null) => {
      if (value && isAddress(value)) {
        discoveryAddressCandidates.push(value);
      }
    };

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

      if (amountUsdc && market.minTradeShares) {
        // Use the correct price for the requested side so YES and NO thresholds differ
        const sidePrice = side === "yes" ? market.yesPrice : market.noPrice;
        const minUsdc = market.minTradeShares * sidePrice;
        const requestedUnits = parseUsdcUnits(amountUsdc, usdcDecimals);
        const minimumUnits = parseUsdcUnits(String(Number(minUsdc.toFixed(usdcDecimals))), usdcDecimals);
        if (requestedUnits !== null && minimumUnits !== null && requestedUnits < minimumUnits) {
          return Response.json(
            {
              error: `Minimum stake for ${side.toUpperCase()} is ${formatAmountForError(minUsdc)} USDC.`,
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
      registerDiscoveryAddress(market.tradeVenue?.venueExchange);
      registerDiscoveryAddress(isAddress(market.id) ? market.id : undefined);
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
      const marketMatchCandidates = buildMarketMatchCandidates(marketId, market);

      // 1. Try Limitless portfolio API first
      let snapshot = await fetchPublicPortfolioPositions(verifiedWalletAddress);

      // 2. If no positions from Limitless API, do comprehensive on-chain lookup.
      //    This checks BOTH the current market's FPMM AND any historical FPMMs
      //    (the user may have bought on an older FPMM instance of the same market).
      if (snapshot.active.length === 0 && snapshot.settled.length === 0) {
        const historyAddresses = await fetchFpmmAddressesFromHistory(verifiedWalletAddress);
        const ammMarkets = buildFallbackAmmMarkets(historyAddresses, market);

        if (ammMarkets.length > 0) {
          snapshot = await fetchOnchainAmmPositions(
            verifiedWalletAddress as `0x${string}`,
            ammMarkets
          );
        }
      }

      // 3. Find the active position for the requested side.
      //    Try exact market slug match first; fall back to side-only match
      //    (historical FPMM positions use address as marketId, not slug).
      const activePosition = snapshot.active.find(
        (position) =>
          position.side === side &&
          matchesPositionMarketCandidates(position, marketMatchCandidates)
      );

      if (!activePosition) {
        return Response.json(
          { error: "No active position found for this market/side.", requestId },
          { status: 409, headers: rateHeaders }
        );
      }

      const maxSellUnits = parseUsdcUnits(activePosition.marketValueUsdc, usdcDecimals);
      const maxSharesToBurnUnits = parseUsdcUnits(activePosition.tokenBalance, usdcDecimals);
      if (maxSellUnits === null || maxSellUnits <= 0n || maxSharesToBurnUnits === null || maxSharesToBurnUnits <= 0n) {
        return Response.json(
          { error: "Active position has no sellable exposure.", requestId },
          { status: 409, headers: rateHeaders }
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

      // 4. Use the FPMM that actually holds the position as trade contract.
      //    If marketId is an on-chain address → it's a historical FPMM (use it directly).
      //    Otherwise fall back to current market's venue.
      if (isAddress(activePosition.marketId)) {
        tradeContract = activePosition.marketId as `0x${string}`;
      } else {
        tradeContract =
          market?.tradeVenue?.venueExchange ??
          market?.tradeVenue?.venueAdapter ??
          process.env.LIMITLESS_SELL_CONTRACT_ADDRESS ??
          process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS;
      }
      registerDiscoveryAddress(activePosition.marketId);
      registerDiscoveryAddress(market?.tradeVenue?.venueExchange);

      // AMM FPMM sell: sell(returnAmount, outcomeIndex, maxOutcomeTokensToSell)
      functionSignature =
        process.env.LIMITLESS_SELL_FUNCTION_SIGNATURE ?? "sell(uint256,uint256,uint256)";
      argMap = process.env.LIMITLESS_SELL_ARG_MAP ?? "amount,outcome-index,const:99999999999999999999";
      requireUsdcApprove = false;
      executionPrice = market ? (side === "yes" ? market.yesPrice : market.noPrice) : undefined;

      // 4b. Preflight: find the max viable returnAmount the pool can honour.
      //     FPMM sell() reverts with SafeMath if returnAmount > pool's liquidity.
      //     Only applies to AMM sell (sell(uint256,uint256,uint256)), not CLOB sellShares.
      const requestedMaxSlippage = maxSlippageBps ?? 200;
      const isAmmSell =
        (functionSignature ?? "").toLowerCase().startsWith("sell(uint256") &&
        !!process.env.NEXT_PUBLIC_BASE_RPC_URL &&
        tradeContract &&
        isAddress(tradeContract) &&
        !!side;

      if (isAmmSell) {
        const outcomeIdx = side === "yes" ? 0n : 1n;
        let dynamicMaxTokensRaw = "99999999999999999999"; // Fallback
        try {
          const viable = await resolveViableSellAmount(
            tradeContract as `0x${string}`,
            outcomeIdx,
            maxSharesToBurnUnits,
            usdcDecimals,
            requestedMaxSlippage
          );
          amountUsdc = viable.amountUsdc;
          dynamicMaxTokensRaw = viable.maxTokensRaw;
        } catch (liquErr) {
          const msg = liquErr instanceof Error ? liquErr.message : "Insufficient pool liquidity for sell.";
          return Response.json({ error: msg, requestId }, { status: 409, headers: rateHeaders });
        }

        // Dynamically override the maxTokensToSell constant injected by ENV with the real
        // mathematically proven requiredTokens limit to fix SafeMath Subtraction Overflow
        argMap = argMap.replace("const:99999999999999999999", `const:${dynamicMaxTokensRaw}`);
      }

      // 5. Fetch ConditionalTokens contract for ERC-1155 setApprovalForAll
      if (tradeContract && isAddress(tradeContract)) {
        try {
          conditionalTokensContract = await getConditionalTokensAddress(tradeContract as `0x${string}`);
        } catch {
          // Non-fatal: proceed without pre-approval if CT address unavailable
        }
      }
    } else {
      const marketMatchCandidates = buildMarketMatchCandidates(marketId, market);

      // Redeem action: find a claimable settled position.
      // 1. Try Limitless portfolio API first, but treat it as best-effort.
      let snapshot = await fetchPublicPortfolioPositions(verifiedWalletAddress).catch(() => ({
        account: verifiedWalletAddress as `0x${string}`,
        fetchedAt: new Date().toISOString(),
        active: [],
        settled: [],
        totals: {
          activeMarketValueUsdc: "0",
          unrealizedPnlUsdc: "0",
          claimableUsdc: "0"
        }
      }));
      let claimablePosition = snapshot.settled.find(
        (position) =>
          matchesPositionMarketCandidates(position, marketMatchCandidates) &&
          position.side === side &&
          position.claimable
      );

      // 2. If the public portfolio cannot find the claimable position, ask the
      // portfolio positions route for the same synthesized snapshot used by the
      // profile screen. This keeps redeem intent aligned with what the user sees.
      if (!claimablePosition) {
        const portfolioSnapshot = await fetchPortfolioSnapshotForRedeem(
          request,
          verifiedWalletAddress as `0x${string}`
        );

        if (portfolioSnapshot) {
          snapshot = portfolioSnapshot;
          claimablePosition = snapshot.settled.find(
            (position) =>
              matchesPositionMarketCandidates(position, marketMatchCandidates) &&
              position.side === side &&
              position.claimable
          );
        }
      }

      // 3. Final fallback: direct on-chain lookup over historical FPMMs.
      if (!claimablePosition && snapshot.settled.length === 0) {
        const historyAddresses = await fetchFpmmAddressesFromHistory(verifiedWalletAddress);
        const ammMarkets = buildFallbackAmmMarkets(historyAddresses, market);

        if (ammMarkets.length > 0) {
          snapshot = await fetchOnchainAmmPositions(
            verifiedWalletAddress as `0x${string}`,
            ammMarkets
          );
          claimablePosition = snapshot.settled.find(
            (position) =>
              matchesPositionMarketCandidates(position, marketMatchCandidates) &&
              position.side === side &&
              position.claimable
          );
        }
      }

      if (!claimablePosition) {
        return Response.json(
          { error: "No claimable settled position found for this market/side.", requestId },
          { status: 409, headers: rateHeaders }
        );
      }

      // 4. Use the FPMM that holds the position as trade contract.
      let fpmmAddr: `0x${string}` | undefined;
      if (isAddress(claimablePosition.marketId)) {
        fpmmAddr = claimablePosition.marketId as `0x${string}`;
      } else if (market?.tradeVenue?.venueExchange && isAddress(market.tradeVenue.venueExchange)) {
        fpmmAddr = market.tradeVenue.venueExchange as `0x${string}`;
      }
      registerDiscoveryAddress(claimablePosition.marketId);
      registerDiscoveryAddress(market?.tradeVenue?.venueExchange);

      tradeContract =
        claimablePosition.conditionalTokensContract ??
        undefined;
      conditionId =
        claimablePosition.conditionId ??
        undefined;
      conditionalTokensContract = tradeContract as `0x${string}` | undefined;

      const marketMetadata = await fetchRedeemMarketMetadata([
        fpmmAddr,
        claimablePosition.marketId,
        claimablePosition.marketSlug,
        marketId,
        market?.tradeVenue?.venueExchange,
        market?.tradeVenue?.marketRef
      ]);

      if (!fpmmAddr && marketMetadata?.fpmmAddress) {
        fpmmAddr = marketMetadata.fpmmAddress;
      }
      registerDiscoveryAddress(marketMetadata?.fpmmAddress);
      if (!tradeContract && marketMetadata?.conditionalTokensContract) {
        tradeContract = marketMetadata.conditionalTokensContract;
        conditionalTokensContract = marketMetadata.conditionalTokensContract;
      }
      if (!conditionId && marketMetadata?.conditionId) {
        conditionId = marketMetadata.conditionId;
      }

      // Final fallback: read the FPMM directly using the more resilient onchain helper.
      if ((!tradeContract || !conditionId) && fpmmAddr) {
        const fpmmMetadata = await resolveFpmmMetadata(fpmmAddr);
        if (fpmmMetadata) {
          tradeContract = fpmmMetadata.ctAddress;
          conditionalTokensContract = fpmmMetadata.ctAddress;
          conditionId = fpmmMetadata.conditionId;
        }
      }

      registerDiscoveryAddress(fpmmAddr);

      if (!tradeContract || !conditionId) {
        return Response.json(
          { error: "Could not resolve redeem metadata for this market.", requestId },
          { status: 409, headers: rateHeaders }
        );
      }

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
      requireUsdcApprove,
      conditionalTokensContract,
      conditionId
    });

    const response: TradeIntentResponse = intent;

    await persistDiscoveryAddressesForWallet(
      verifiedWalletAddress as `0x${string}`,
      discoveryAddressCandidates
    );

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

import { buildTradeIntent } from "@/lib/trade/build-intent";
import { getMarketIndexer } from "@/lib/indexer";
import { Market } from "@/lib/market-types";
import { fetchPublicPortfolioPositions } from "@/lib/portfolio/limitless-portfolio";
import { fetchOnchainAmmPositions, getConditionalTokensAddress, fetchFpmmAddressesFromHistory } from "@/lib/portfolio/onchain-portfolio";
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
  decimals: number
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
  // but ask for 1% less USDC as a slippage safety buffer to ensure execution succeeds.
  const safeReturnUnits = (bestReturn * 99n) / 100n;

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

    // We don't enforce claims.address === body.walletAddress because Farcaster auth 
    // uses a different signing key than the injected transaction wallet.
    // The blockchain inherently protects transactions since the user must sign the returned payload.
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
      // 1. Try Limitless portfolio API first
      let snapshot = await fetchPublicPortfolioPositions(verifiedWalletAddress);

      // 2. If no positions from Limitless API, do comprehensive on-chain lookup.
      //    This checks BOTH the current market's FPMM AND any historical FPMMs
      //    (the user may have bought on an older FPMM instance of the same market).
      if (snapshot.active.length === 0 && snapshot.settled.length === 0) {
        const historyAddresses = await fetchFpmmAddressesFromHistory(verifiedWalletAddress);
        const fpmmAddresses = new Set<string>(historyAddresses);

        // Also include the current market's FPMM if available
        if (market?.tradeVenue?.venueExchange) {
          fpmmAddresses.add(market.tradeVenue.venueExchange);
        }

        const ammMarkets: AmmMarketRef[] = Array.from(fpmmAddresses).map((addr) => ({
          id: addr,      // use address as id — matched below by side only
          slug: addr,
          title: "Position",
          contractAddress: addr,
          yesPrice: market?.yesPrice ?? 0.5,
          noPrice: market?.noPrice ?? 0.5
        }));

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
      let activePosition = snapshot.active.find(
        (position) => matchesPositionMarket(position, marketId) && position.side === side
      );
      if (!activePosition && side) {
        activePosition = snapshot.active.find((p) => p.side === side);
      }

      if (!activePosition) {
        return Response.json(
          { error: "No active position found for this market/side.", requestId },
          { status: 409, headers: rateHeaders }
        );
      }

      const maxSellUnits = parseUsdcUnits(activePosition.marketValueUsdc, usdcDecimals);
      if (maxSellUnits === null || maxSellUnits <= 0n) {
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

      // AMM FPMM sell: sell(returnAmount, outcomeIndex, maxOutcomeTokensToSell)
      functionSignature =
        process.env.LIMITLESS_SELL_FUNCTION_SIGNATURE ?? "sell(uint256,uint256,uint256)";
      argMap = process.env.LIMITLESS_SELL_ARG_MAP ?? "amount,outcome-index,const:99999999999999999999";
      requireUsdcApprove = false;
      executionPrice = market ? (side === "yes" ? market.yesPrice : market.noPrice) : undefined;

      // 4b. Preflight: find the max viable returnAmount the pool can honour.
      //     FPMM sell() reverts with SafeMath if returnAmount > pool's liquidity.
      //     Only applies to AMM sell (sell(uint256,uint256,uint256)), not CLOB sellShares.
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
            boundedSellUnits,
            usdcDecimals
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
      // Redeem action: find a claimable settled position.
      // 1. Try Limitless portfolio API first.
      let snapshot = await fetchPublicPortfolioPositions(verifiedWalletAddress);

      // 2. If no settled positions from API, fall back to on-chain lookup.
      if (snapshot.settled.length === 0) {
        const historyAddresses = await fetchFpmmAddressesFromHistory(verifiedWalletAddress);
        const fpmmAddresses = new Set<string>(historyAddresses);
        if (market?.tradeVenue?.venueExchange) {
          fpmmAddresses.add(market.tradeVenue.venueExchange);
        }

        const ammMarkets: AmmMarketRef[] = Array.from(fpmmAddresses).map((addr) => ({
          id: addr,
          slug: addr,
          title: "Position",
          contractAddress: addr,
          yesPrice: market?.yesPrice ?? 0.5,
          noPrice: market?.noPrice ?? 0.5
        }));

        if (ammMarkets.length > 0) {
          snapshot = await fetchOnchainAmmPositions(
            verifiedWalletAddress as `0x${string}`,
            ammMarkets
          );
        }
      }

      // 3. Find claimable settled position — try slug match first, then side-only.
      let claimablePosition = snapshot.settled.find(
        (position) =>
          matchesPositionMarket(position, marketId) &&
          position.side === side &&
          position.claimable
      );
      if (!claimablePosition && side) {
        claimablePosition = snapshot.settled.find((p) => p.side === side && p.claimable);
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
      }

      // For AMM markets, redeem uses CT.redeemPositions() not the FPMM.
      // We need the ConditionalTokens contract address AND the conditionId.
      if (fpmmAddr) {
        try {
          const rpcUrl = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org";
          const viemClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
          const [ctAddr, cid] = await viemClient.multicall({
            contracts: [
              { address: fpmmAddr, abi: parseAbi(["function conditionalTokens() view returns (address)"]), functionName: "conditionalTokens" },
              { address: fpmmAddr, abi: parseAbi(["function conditionIds(uint256) view returns (bytes32)"]), functionName: "conditionIds", args: [0n] }
            ],
            allowFailure: false
          });
          tradeContract = ctAddr;
          conditionId = cid as `0x${string}`;
          conditionalTokensContract = ctAddr;
        } catch {
          // Fallback to env-based contract
          tradeContract =
            process.env.LIMITLESS_REDEEM_CONTRACT_ADDRESS ??
            process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS;
        }
      } else {
        tradeContract =
          process.env.LIMITLESS_REDEEM_CONTRACT_ADDRESS ??
          process.env.LIMITLESS_TRADE_CONTRACT_ADDRESS;
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

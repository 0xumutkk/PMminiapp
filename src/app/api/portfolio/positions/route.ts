import { fetchPublicPortfolioPositions } from "@/lib/portfolio/limitless-portfolio";
import { fetchOnchainAmmPositions, type AmmMarketRef } from "@/lib/portfolio/onchain-portfolio";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { isAddress } from "viem";

export const runtime = "nodejs";

/**
 * Fetch all active AMM markets from the Limitless API and return the subset
 * that have positionIds — required for on-chain balance reading.
 */
const CT_ADDRESS = "0xC9c98965297Bc527861c898329Ee280632B76e18";

/**
 * Fetch FPMM addresses from the wallet's ERC-1155 token transfer history
 * via Blockscout. This catches positions in markets that may no longer appear
 * in the active markets list.
 */
async function fetchFpmmAddressesFromTransferHistory(account: string): Promise<string[]> {
  try {
    const url = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?filter=to`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { items?: unknown[] };
    const items = Array.isArray(payload.items) ? payload.items : [];

    const fpmmAddresses = new Set<string>();
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const r = item as Record<string, unknown>;
      // Only ERC-1155 transfers from contracts that received tokens to the wallet
      if (r.token_type !== "ERC-1155") continue;
      const token = r.token as Record<string, unknown> | undefined;
      if (token?.address_hash !== CT_ADDRESS) continue;
      // The `from` field is the FPMM that sent us the ERC-1155 tokens
      const from = r.from as Record<string, unknown> | undefined;
      const fromHash = typeof from?.hash === "string" ? from.hash : undefined;
      if (fromHash && isAddress(fromHash)) {
        fpmmAddresses.add(fromHash);
      }
    }
    return Array.from(fpmmAddresses);
  } catch {
    return [];
  }
}

async function fetchAmmMarketsForOnchain(account: string): Promise<AmmMarketRef[]> {
  const baseUrl =
    (process.env.LIMITLESS_API_BASE_URL ?? "https://api.limitless.exchange")
      .replace(/\/api-v1\/?$/, "")
      .replace(/\/$/, "");

  const limit = 25;
  const markets: AmmMarketRef[] = [];

  for (let page = 1; page <= 4; page++) {
    try {
      const url = new URL("/markets/active", baseUrl);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("sortBy", "ending_soon");
      url.searchParams.set("tradeType", "amm");

      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });

      if (!response.ok) break;

      const payload = (await response.json()) as {
        data?: unknown[];
        totalMarketsCount?: number;
      };

      const rows = Array.isArray(payload.data) ? payload.data : [];

      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const r = row as Record<string, unknown>;

        const slug =
          typeof r.slug === "string" ? r.slug : undefined;
        const title =
          typeof r.title === "string" ? r.title : slug ?? "Unknown";
        const address =
          typeof r.address === "string" && isAddress(r.address)
            ? r.address
            : undefined;
        const rawPositionIds = r.positionIds;
        const prices = Array.isArray(r.prices) ? r.prices : [];
        const yesPrice = typeof prices[0] === "number" ? prices[0] / 100 : 0.5;
        const noPrice = typeof prices[1] === "number" ? prices[1] / 100 : 0.5;

        if (!slug || !address || !Array.isArray(rawPositionIds) || rawPositionIds.length < 2) {
          continue;
        }

        const toDecStr = (v: unknown): string | undefined => {
          if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
          if (typeof v === "number" && Number.isFinite(v)) return String(Math.round(v));
          return undefined;
        };

        const yesId = toDecStr(rawPositionIds[0]);
        const noId = toDecStr(rawPositionIds[1]);
        if (!yesId || !noId) continue;

        markets.push({
          id: slug,
          slug,
          title: String(title),
          contractAddress: address,
          positionIds: [yesId, noId],
          yesPrice,
          noPrice
        });
      }

      const totalPages = Math.ceil(
        (typeof payload.totalMarketsCount === "number" ? payload.totalMarketsCount : 0) / limit
      );
      if (page >= totalPages) break;
    } catch {
      break;
    }
  }

  // Also add FPMMs from the wallet's ERC-1155 transfer history (catches expired/delisted markets)
  const historyAddresses = await fetchFpmmAddressesFromTransferHistory(account);
  const existingAddresses = new Set(markets.map((m) => m.contractAddress.toLowerCase()));

  for (const addr of historyAddresses) {
    if (existingAddresses.has(addr.toLowerCase())) continue;

    // Try to resolve market title and price from Limitless API via address
    let title = "Market Position";
    let yesPrice = 0.5;
    let noPrice = 0.5;
    try {
      const baseUrl = (process.env.LIMITLESS_API_BASE_URL ?? "https://api.limitless.exchange")
        .replace(/\/api-v1\/?$/, "").replace(/\/$/, "");
      const apiUrl = new URL(`/markets/${addr}`, baseUrl);
      const resp = await fetch(apiUrl.toString(), { headers: { Accept: "application/json" }, cache: "no-store" });
      if (resp.ok) {
        const mkt = await resp.json() as Record<string, unknown>;
        if (typeof mkt.title === "string" && mkt.title) title = mkt.title;
        const prices = Array.isArray(mkt.prices) ? mkt.prices : [];
        if (typeof prices[0] === "number") yesPrice = prices[0] / 100;
        if (typeof prices[1] === "number") noPrice = prices[1] / 100;
      }
    } catch { /* use placeholders */ }

    markets.push({
      id: addr,
      slug: addr,
      title,
      contractAddress: addr,
      yesPrice,
      noPrice
    });
  }

  return markets;
}

export async function GET(request: Request) {
  const requestId = getRequestId(request);

  const rate = await checkRateLimit({
    bucket: "portfolio-positions",
    request,
    limit: 120,
    windowMs: 60_000
  });
  const headers = new Headers(rateLimitHeaders(rate));
  headers.set("Cache-Control", "no-store");
  headers.set("X-Request-Id", requestId);

  if (!rate.ok) {
    return Response.json(
      { error: "Too many requests", requestId },
      { status: 429, headers }
    );
  }

  const url = new URL(request.url);
  const account = url.searchParams.get("account")?.trim() ?? "";

  if (!isAddress(account)) {
    return Response.json(
      { error: "account query param must be a valid EVM address", requestId },
      { status: 400, headers }
    );
  }

  try {
    // 1. Try the Limitless portfolio API first.
    const snapshot = await fetchPublicPortfolioPositions(account);

    // If the API returned data but positions are all empty, we still try on-chain
    // because the user might not be registered on Limitless (404 → empty snapshot).
    const hasApiPositions =
      snapshot.active.length > 0 || snapshot.settled.length > 0;

    if (hasApiPositions) {
      return Response.json(snapshot, { headers });
    }

    // 2. Fall back: read ERC-1155 balances directly from Base.
    const ammMarkets = await fetchAmmMarketsForOnchain(account);
    const onchainSnapshot = await fetchOnchainAmmPositions(
      account as `0x${string}`,
      ammMarkets
    );
    return Response.json(onchainSnapshot, { headers });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Portfolio positions lookup failed";
    return Response.json(
      { error: message, requestId },
      { status: 502, headers }
    );
  }
}

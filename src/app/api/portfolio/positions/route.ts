import {
  fetchPublicPortfolioPositions,
  type PortfolioPositionsSnapshot,
  type TrackedPosition
} from "@/lib/portfolio/limitless-portfolio";
import {
  fetchOnchainAmmPositions,
  type AmmMarketRef,
  type PositionCostBasisEntry
} from "@/lib/portfolio/onchain-portfolio";
import { getRequestId } from "@/lib/security/request-context";
import { checkRateLimit, rateLimitHeaders } from "@/lib/security/rate-limit";
import { isAddress } from "viem";
import * as fs from "node:fs";

export const runtime = "nodejs";

/**
 * Fetch all active AMM markets from the Limitless API and return the subset
 * that have positionIds — required for on-chain balance reading.
 */
const CT_ADDRESS = "0xC9c98965297Bc527861c898329Ee280632B76e18";
const CT_ADDRESS_LOWER = CT_ADDRESS.toLowerCase();
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ADDRESS_LOWER = USDC_ADDRESS.toLowerCase();

type PositionSide = TrackedPosition["side"];

type HistoryTransferRecord = {
  txHash: string;
  contractAddress?: string;
  tokenAmountRaw: string;
};

type TransferHistorySummary = {
  fpmmAddresses: string[];
  costBasisMap: Record<string, PositionCostBasisEntry>;
};

function normalizeRawTokenAmount(raw: unknown, decimals: number) {
  if (raw === null || raw === undefined) {
    return "0";
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw.toString();
  }

  if (typeof raw !== "string") {
    return "0";
  }

  const value = raw.trim();
  if (!value) {
    return "0";
  }

  if (!/^-?\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed.toString() : "0";
  }

  const unit = 10n ** BigInt(Math.max(0, decimals));
  const amount = BigInt(value);
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(Math.max(1, decimals), "0").replace(/0+$/, "");

  return `${sign}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function extractDecodedParameterValue(parameters: unknown, index: number) {
  if (!Array.isArray(parameters)) {
    return undefined;
  }

  const parameter = parameters[index];
  if (!parameter || typeof parameter !== "object") {
    return undefined;
  }

  const value = (parameter as Record<string, unknown>).value;
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return undefined;
}

function parseOutcomeSide(raw: unknown): PositionSide | null {
  if (raw === "0" || raw === 0) {
    return "yes";
  }
  if (raw === "1" || raw === 1) {
    return "no";
  }
  return null;
}

/**
 * Fetch recent ERC-1155 receipts for the wallet and derive two things:
 * 1. FPMM addresses seen in history, so we can still discover historical markets.
 * 2. Fallback cost basis for active positions by inspecting buy transactions.
 *
 * This is the critical fallback when the public portfolio API rate-limits and
 * returns no cost basis, which otherwise forces Active PNL to stay at zero.
 */
async function fetchTransferHistorySummary(account: string): Promise<TransferHistorySummary> {
  try {
    const fpmmAddresses = new Set<string>();
    const transferRecords: HistoryTransferRecord[] = [];
    const txHashes = new Set<string>();
    const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
    const accountLower = account.toLowerCase();

    let nextPageParams: string | null = null;
    for (let page = 0; page < 2; page++) {
      const baseUrl = `https://base.blockscout.com/api/v2/addresses/${account}/token-transfers?filter=to&type=ERC-1155`;
      const url = nextPageParams ? `${baseUrl}&${nextPageParams}` : baseUrl;
      try {
        const response = await fetch(url, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          // @ts-ignore
          next: { revalidate: 30 },
          signal: AbortSignal.timeout(5000) // 5s timeout
        });
        if (!response.ok) break;

        const payload = (await response.json()) as { items?: unknown[]; next_page_params?: Record<string, unknown> | null };
        const items = Array.isArray(payload.items) ? payload.items : [];

        for (const item of items) {
          if (typeof item !== "object" || item === null) continue;
          const r = item as Record<string, unknown>;
          if (r.token_type !== "ERC-1155") continue;
          const token = r.token as Record<string, unknown> | undefined;
          if (typeof token?.address_hash !== "string" || token.address_hash.toLowerCase() !== CT_ADDRESS_LOWER) continue;

          const from = r.from as Record<string, unknown> | undefined;
          const fromHash = typeof from?.hash === "string" ? from.hash.toLowerCase() : undefined;
          const txHash =
            (typeof r.transaction_hash === "string" ? r.transaction_hash : undefined) ??
            (typeof r.tx_hash === "string" ? r.tx_hash : undefined);
          const total = r.total as Record<string, unknown> | undefined;
          const tokenAmountRaw =
            typeof total?.value === "string"
              ? total.value
              : typeof total?.value === "number"
                ? String(total.value)
                : undefined;

          if (fromHash && fromHash !== ZERO_ADDRESS && isAddress(fromHash)) {
            if (from?.is_contract === true && fromHash !== CT_ADDRESS_LOWER) {
              fpmmAddresses.add(fromHash);
            }
            if (txHash && tokenAmountRaw) {
              transferRecords.push({
                txHash,
                contractAddress: fromHash,
                tokenAmountRaw
              });
              txHashes.add(txHash);
            }
          } else if (txHash && tokenAmountRaw) {
            transferRecords.push({ txHash, tokenAmountRaw });
            txHashes.add(txHash);
          }
        }

        if (payload.next_page_params && typeof payload.next_page_params === "object") {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(payload.next_page_params)) {
            if (value !== null && value !== undefined) {
              params.set(key, String(value));
            }
          }
          nextPageParams = params.toString();
        } else {
          break;
        }
      } catch (e) {
        console.warn("Blockscout fetch failed:", e);
        break;
      }
    }

    const txCostMeta = new Map<string, { contractAddress?: string; side: PositionSide | null; costUsdc?: string }>();

    await Promise.all(
      Array.from(txHashes).slice(0, 20).map(async (txHash) => {
        try {
          const txUrl = `https://base.blockscout.com/api/v2/transactions/${txHash}`;
          const txResp = await fetch(txUrl, { headers: { Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(3000) });
          if (!txResp.ok) return;
          const tx = (await txResp.json()) as Record<string, unknown>;
          const toRecord = tx.to as Record<string, unknown> | undefined;
          const toHash = typeof toRecord?.hash === "string" ? toRecord.hash.toLowerCase() : undefined;
          const contractAddress = toHash && isAddress(toHash) ? toHash : undefined;
          if (contractAddress) {
            fpmmAddresses.add(contractAddress);
          }

          const decodedInput = tx.decoded_input as Record<string, unknown> | undefined;
          const parameters = decodedInput?.parameters;
          const side = parseOutcomeSide(extractDecodedParameterValue(parameters, 1));

          let costUsdc: string | undefined;
          const investmentAmountRaw = extractDecodedParameterValue(parameters, 0);
          if (investmentAmountRaw) {
            costUsdc = normalizeRawTokenAmount(investmentAmountRaw, 6);
          }

          if (!costUsdc) {
            const tokenTransfers = Array.isArray(tx.token_transfers) ? tx.token_transfers : [];
            let rawUsdcSpent = 0n;
            for (const transfer of tokenTransfers) {
              if (!transfer || typeof transfer !== "object") continue;
              const record = transfer as Record<string, unknown>;
              const token = record.token as Record<string, unknown> | undefined;
              const from = record.from as Record<string, unknown> | undefined;
              const to = record.to as Record<string, unknown> | undefined;
              const total = record.total as Record<string, unknown> | undefined;
              const tokenAddress = typeof token?.address_hash === "string" ? token.address_hash.toLowerCase() : undefined;
              const fromHash = typeof from?.hash === "string" ? from.hash.toLowerCase() : undefined;
              const toHash = typeof to?.hash === "string" ? to.hash.toLowerCase() : undefined;
              const rawValue = typeof total?.value === "string" ? total.value : undefined;

              if (
                tokenAddress === USDC_ADDRESS_LOWER &&
                fromHash === accountLower &&
                rawValue &&
                (!contractAddress || toHash === contractAddress)
              ) {
                rawUsdcSpent += BigInt(rawValue);
              }
            }

            if (rawUsdcSpent > 0n) {
              costUsdc = normalizeRawTokenAmount(rawUsdcSpent.toString(), 6);
            }
          }

          txCostMeta.set(txHash, { contractAddress, side, costUsdc });
        } catch { /* non-fatal */ }
      })
    );

    const transfersByTx = new Map<string, HistoryTransferRecord[]>();
    for (const transfer of transferRecords) {
      const bucket = transfersByTx.get(transfer.txHash) ?? [];
      bucket.push(transfer);
      transfersByTx.set(transfer.txHash, bucket);
    }

    const costBasisMap: Record<string, PositionCostBasisEntry> = {};
    for (const [txHash, transfers] of transfersByTx.entries()) {
      const meta = txCostMeta.get(txHash);
      const contractAddress =
        meta?.contractAddress ??
        transfers.find((transfer) => transfer.contractAddress && isAddress(transfer.contractAddress))?.contractAddress;

      if (!contractAddress || !isAddress(contractAddress)) {
        continue;
      }

      fpmmAddresses.add(contractAddress.toLowerCase());

      if (!meta?.side || !meta.costUsdc) {
        continue;
      }

      const tokenAmount = sumDecimalStrings(
        transfers.map((transfer) => normalizeRawTokenAmount(transfer.tokenAmountRaw, 6))
      );
      const key = `${contractAddress.toLowerCase()}:${meta.side}`;
      const previous = costBasisMap[key] ?? { costUsdc: "0", tokenAmount: "0" };

      costBasisMap[key] = {
        costUsdc: sumDecimalStrings([previous.costUsdc, meta.costUsdc]),
        tokenAmount: sumDecimalStrings([previous.tokenAmount ?? "0", tokenAmount])
      };
    }

    return {
      fpmmAddresses: Array.from(fpmmAddresses),
      costBasisMap
    };
  } catch {
    return {
      fpmmAddresses: [],
      costBasisMap: {}
    };
  }
}

async function fetchAmmMarketsForOnchain(historyAddresses: string[] = []): Promise<AmmMarketRef[]> {
  const baseUrl =
    (process.env.LIMITLESS_API_BASE_URL ?? "https://api.limitless.exchange")
      .replace(/\/api-v1\/?$/, "")
      .replace(/\/$/, "");

  const limit = 25;

  const fetchHeaders = {
    Accept: "application/json",
    Origin: "https://limitless.exchange",
    Referer: "https://limitless.exchange/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  };

  async function fetchPage(pathname: string, page: number, extraParams?: Record<string, string>): Promise<unknown[]> {
    try {
      const url = new URL(pathname, baseUrl);
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", String(limit));
      url.searchParams.set("sortBy", "ending_soon");
      url.searchParams.set("tradeType", "amm");
      if (extraParams) {
        for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);
      }
      const response = await fetch(url.toString(), { headers: fetchHeaders, cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (!response.ok) return [];
      const payload = (await response.json()) as { data?: unknown[] };
      return Array.isArray(payload.data) ? payload.data : [];
    } catch {
      return [];
    }
  }

  // Fetch ACTIVE markets (10 pages) + RESOLVED markets (10 pages) in parallel
  const allPageResults = await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => fetchPage("/markets/active", i + 1)),
    ...Array.from({ length: 10 }, (_, i) => fetchPage("/markets", i + 1, { status: "resolved" })),
  ]);

  function flattenLimitlessRows(input: any[]): any[] {
    const output: any[] = [];
    for (const row of input) {
      if (!row) continue;
      const nested = Array.isArray(row.markets) ? row.markets : [];
      if (nested.length > 0 && !Array.isArray(row.prices)) {
        output.push(...flattenLimitlessRows(nested));
        continue;
      }
      output.push(row);
      if (nested.length > 0) {
        output.push(...flattenLimitlessRows(nested));
      }
    }
    return output;
  }

  const rows = flattenLimitlessRows(allPageResults.flat());
  console.log(`[Positions API] Fetched ${allPageResults.flat().length} raw rows, ${rows.length} after flattening`);
  const marketsMap = new Map<string, AmmMarketRef>();

  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;

    const slug = typeof r.slug === "string" ? r.slug : undefined;
    const title = typeof r.title === "string" ? r.title : slug ?? "Unknown";

    // Robust address check: address OR venue.exchange
    const venue = typeof r.venue === "object" && r.venue !== null ? (r.venue as any) : undefined;
    const address = (typeof r.address === "string" && isAddress(r.address) ? r.address : undefined)
      ?? (typeof venue?.exchange === "string" && isAddress(venue.exchange) ? venue.exchange : undefined);

    const rawPositionIds = r.positionIds;
    const prices = Array.isArray(r.prices) ? r.prices : [];

    // Ensure 100% pricing logic
    const rawYes = typeof prices[0] === "number" ? prices[0] : 0.5;
    const yesPrice = rawYes > 1 ? rawYes / 100 : rawYes;
    let noPrice = (typeof prices[1] === "number" ? (prices[1] > 1 ? prices[1] / 100 : prices[1]) : (1 - yesPrice));

    if (Math.abs(yesPrice + noPrice - 1) > 0.05) {
      noPrice = Math.max(0, 1 - yesPrice);
    }

    if (!slug || !address || !Array.isArray(rawPositionIds) || rawPositionIds.length < 2) continue;

    const toDecStr = (v: unknown): string | undefined => {
      if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(Math.round(v));
      return undefined;
    };

    const yesId = toDecStr(rawPositionIds[0]);
    const noId = toDecStr(rawPositionIds[1]);
    if (!yesId || !noId) continue;

    // Use contractAddress as the key because slugs are NOT unique for multi-outcome/nested markets
    const addrKey = address.toLowerCase();
    if (!marketsMap.has(addrKey)) {
      marketsMap.set(addrKey, {
        id: slug, // Keep slug for API calls
        slug,
        title: String(title),
        contractAddress: address,
        positionIds: [yesId, noId],
        yesPrice,
        noPrice,
        endsAt: String(
          r.endsAt ??
          r.ends_at ??
          r.expirationTimestamp ??
          r.expirationDate ??
          r.resolved_at ??
          r.closed_at ??
          r.close_date ??
          ""
        ) || undefined
      });
    }
  }

  const existingAddresses = new Set(Array.from(marketsMap.values()).map((m) => m.contractAddress.toLowerCase()));

  console.log(`[Positions API] API markets: ${marketsMap.size}, History addresses: ${historyAddresses.length}`);
  console.log(`[Positions API] Existing addresses sample:`, Array.from(existingAddresses).slice(0, 5));
  console.log(`[Positions API] History addresses sample:`, historyAddresses.slice(0, 5));

  let matchedFromApi = 0;
  let addedFromHistory = 0;

  for (const addr of historyAddresses) {
    const addrLower = addr.toLowerCase();
    if (existingAddresses.has(addrLower)) {
      matchedFromApi++;
      continue;
    }

    // Check if we already added this address from history (in case history has duplicates)
    if (!marketsMap.has(addrLower)) {
      const shortAddr = `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      marketsMap.set(addrLower, {
        id: addrLower,
        slug: addrLower,
        title: `Market ${shortAddr}`,
        contractAddress: addr,
        yesPrice: 0.5,
        noPrice: 0.5,
        fromHistory: true
      });
      addedFromHistory++;
    }
  }

  console.log(`[Positions API] History matched from API: ${matchedFromApi}, Added as fallback: ${addedFromHistory}`);

  // Try to resolve titles for fallback entries by querying Limitless API directly
  const fallbackEntries = Array.from(marketsMap.entries()).filter(([_, m]) => m.fromHistory);
  if (fallbackEntries.length > 0) {
    await Promise.all(fallbackEntries.map(async ([key, m]) => {
      const endpoints = [
        `${baseUrl}/markets/${m.contractAddress}`,
        `${baseUrl}/markets/${m.contractAddress.toLowerCase()}`,
      ];
      for (const endpoint of endpoints) {
        try {
          const resp = await fetch(endpoint, {
            headers: fetchHeaders,
            cache: "no-store",
            signal: AbortSignal.timeout(3000)
          });
          if (!resp.ok) continue;
          const data = await resp.json() as any;
          const market = Array.isArray(data?.data) ? data.data[0] : (data?.title ? data : null);
          if (market && typeof market.title === "string") {
            m.title = market.title;
            if (typeof market.slug === "string") { m.id = market.slug; m.slug = market.slug; }
            if (market.endsAt || market.ends_at) { m.endsAt = String(market.endsAt ?? market.ends_at); }
            console.log(`[Positions API] Resolved title for ${key}: "${market.title}"`);
            break;
          }
        } catch { /* non-fatal */ }
      }
    }));
  }

  return Array.from(marketsMap.values());
}

function sumDecimalStrings(values: string[]) {
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isFinite(total)) {
    return "0";
  }
  return total.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function formatDecimalString(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function buildPositionLookupKeys(position: Pick<TrackedPosition, "marketId" | "marketSlug" | "side">) {
  const keys = new Set<string>();
  const side = position.side.toLowerCase();

  const marketId = position.marketId.trim().toLowerCase();
  if (marketId.length > 0) {
    keys.add(`${marketId}:${side}`);
  }

  const marketSlug = position.marketSlug.trim().toLowerCase();
  if (marketSlug.length > 0) {
    keys.add(`${marketSlug}:${side}`);
  }

  return Array.from(keys);
}

function recomputeTotals(
  active: TrackedPosition[],
  settled: TrackedPosition[]
): PortfolioPositionsSnapshot["totals"] {
  return {
    activeMarketValueUsdc: sumDecimalStrings(active.map((item) => item.marketValueUsdc)),
    unrealizedPnlUsdc: sumDecimalStrings(active.map((item) => item.unrealizedPnlUsdc)),
    claimableUsdc: sumDecimalStrings(settled.filter((item) => item.claimable).map((item) => item.marketValueUsdc))
  };
}

function mergePosition(primary: TrackedPosition, fallback: TrackedPosition): TrackedPosition {
  return {
    ...fallback,
    ...primary,
    currentPrice: primary.currentPrice ?? fallback.currentPrice
  };
}

function enrichPublicPortfolioSnapshotWithMarketPrices(
  publicPortfolio: PortfolioPositionsSnapshot | null,
  ammMarkets: AmmMarketRef[]
): PortfolioPositionsSnapshot | null {
  if (!publicPortfolio) {
    return null;
  }

  const marketByKey = new Map<string, AmmMarketRef>();
  for (const market of ammMarkets) {
    marketByKey.set(market.contractAddress.toLowerCase(), market);
    marketByKey.set(market.slug.toLowerCase(), market);
    marketByKey.set(market.id.toLowerCase(), market);
  }

  const enrichPosition = (position: TrackedPosition): TrackedPosition => {
    if (position.status !== "active") {
      return position;
    }

    const market =
      marketByKey.get(position.marketId.toLowerCase()) ??
      marketByKey.get(position.marketSlug.toLowerCase());

    if (!market) {
      return position;
    }

    const shares = Number(position.tokenBalance);
    const cost = Number(position.costUsdc);
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost)) {
      return position;
    }

    const currentPrice = position.side === "yes" ? market.yesPrice : market.noPrice;
    const marketValue = shares * currentPrice;
    const pnl = marketValue - cost;

    return {
      ...position,
      marketId: position.marketId || market.contractAddress,
      marketSlug: position.marketSlug || market.slug,
      marketTitle: position.marketTitle || market.title,
      marketValueUsdc: formatDecimalString(marketValue),
      unrealizedPnlUsdc: formatDecimalString(pnl),
      currentPrice
    };
  };

  const active = publicPortfolio.active.map(enrichPosition);
  const settled = publicPortfolio.settled;

  return {
    ...publicPortfolio,
    active,
    settled,
    totals: recomputeTotals(active, settled)
  };
}

function mergePortfolioSnapshots(
  account: `0x${string}`,
  publicPortfolio: PortfolioPositionsSnapshot | null,
  onchainSnapshot: PortfolioPositionsSnapshot
): PortfolioPositionsSnapshot {
  if (!publicPortfolio) {
    return onchainSnapshot;
  }

  const active = [...publicPortfolio.active];
  const settled = [...publicPortfolio.settled];

  const activeIndexByKey = new Map<string, number>();
  const settledIndexByKey = new Map<string, number>();

  const register = (indexMap: Map<string, number>, position: TrackedPosition, index: number) => {
    for (const key of buildPositionLookupKeys(position)) {
      indexMap.set(key, index);
    }
  };

  active.forEach((position, index) => register(activeIndexByKey, position, index));
  settled.forEach((position, index) => register(settledIndexByKey, position, index));

  for (const onchainPosition of [...onchainSnapshot.active, ...onchainSnapshot.settled]) {
    const lookupKeys = buildPositionLookupKeys(onchainPosition);

    const activeMatchKey = lookupKeys.find((key) => activeIndexByKey.has(key));
    if (activeMatchKey) {
      const index = activeIndexByKey.get(activeMatchKey)!;
      active[index] = mergePosition(onchainPosition, active[index]);
      register(activeIndexByKey, active[index], index);
      continue;
    }

    const settledMatchKey = lookupKeys.find((key) => settledIndexByKey.has(key));
    if (settledMatchKey) {
      const index = settledIndexByKey.get(settledMatchKey)!;
      settled[index] = mergePosition(onchainPosition, settled[index]);
      register(settledIndexByKey, settled[index], index);
      continue;
    }

    if (onchainPosition.status === "active") {
      const index = active.push(onchainPosition) - 1;
      register(activeIndexByKey, onchainPosition, index);
    } else {
      const index = settled.push(onchainPosition) - 1;
      register(settledIndexByKey, onchainPosition, index);
    }
  }

  return {
    account: publicPortfolio.account ?? onchainSnapshot.account ?? account,
    fetchedAt: new Date().toISOString(),
    active,
    settled,
    totals: recomputeTotals(active, settled)
  };
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
    const authHeaders: Record<string, string> = {};
    const auth = request.headers.get("Authorization");
    const deviceId = request.headers.get("limitless-device-id");
    if (auth) authHeaders["Authorization"] = auth;
    if (deviceId) authHeaders["limitless-device-id"] = deviceId;

    // 1. Fetch public API portfolio to get real cost basis
    // We do this non-blocking and catch errors so it's a best-effort layer over on-chain data
    const publicPortfolioPromise = fetchPublicPortfolioPositions(account, authHeaders).catch(err => {
      console.warn(`[Positions API] Failed to fetch public portfolio for cost basis:`, err);
      return null;
    });

    // 2. Fetch transfer history once so we can reuse it for both
    // historical market discovery and fallback cost basis.
    const historySummaryPromise = fetchTransferHistorySummary(account);

    const [rawPublicPortfolio, historySummary] = await Promise.all([
      publicPortfolioPromise,
      historySummaryPromise
    ]);
    const ammMarkets = await fetchAmmMarketsForOnchain(historySummary.fpmmAddresses);
    const publicPortfolio = enrichPublicPortfolioSnapshotWithMarketPrices(rawPublicPortfolio, ammMarkets);

    // 3. Create cost basis map keyed as `${marketId}:${side}`.
    // Public portfolio data is exact and should win; history-derived cost is fallback.
    const costBasisMap: Record<string, PositionCostBasisEntry> = {};
    if (publicPortfolio) {
      for (const pos of [...publicPortfolio.active, ...publicPortfolio.settled]) {
        // Limitless API often uses the lowercased address or slug as marketId
        // we'll store multiple variations to maximize match rate
        const entry = {
          costUsdc: pos.costUsdc,
          tokenAmount: pos.status === "active" ? pos.tokenBalance : undefined
        };
        costBasisMap[`${pos.marketId.toLowerCase()}:${pos.side}`] = entry;
        costBasisMap[`${pos.marketSlug.toLowerCase()}:${pos.side}`] = entry;
      }
    }

    for (const [key, entry] of Object.entries(historySummary.costBasisMap)) {
      if (!costBasisMap[key]) {
        costBasisMap[key] = entry;
      }
    }

    console.log(`[Positions API] Public portfolio: ${publicPortfolio ? `${publicPortfolio.active.length} active, ${publicPortfolio.settled.length} settled` : 'FAILED/NULL'}`);
    console.log(`[Positions API] History cost basis keys:`, Object.keys(historySummary.costBasisMap).slice(0, 10));
    console.log(`[Positions API] Cost basis keys:`, Object.keys(costBasisMap).slice(0, 10));
    console.log(`[Positions API] Cost basis sample:`, JSON.stringify(Object.entries(costBasisMap).slice(0, 5)));

    // 4. Read ERC-1155 balances directly from Base, passing in the cost map
    const onchainSnapshot = await fetchOnchainAmmPositions(
      account as `0x${string}`,
      ammMarkets,
      costBasisMap
    );

    console.log(`[Positions API] Discovered ${ammMarkets.length} candidate markets. Found ${onchainSnapshot.active.length} active and ${onchainSnapshot.settled.length} settled positions for ${account}`);
    // Debug: show PNL values
    for (const pos of onchainSnapshot.active) {
      console.log(`[PNL Debug] Active: ${pos.marketTitle?.slice(0, 40)} | cost=${pos.costUsdc} val=${pos.marketValueUsdc} uPNL=${pos.unrealizedPnlUsdc}`);
    }

    const mergedSnapshot = mergePortfolioSnapshots(
      account as `0x${string}`,
      publicPortfolio,
      onchainSnapshot
    );

    console.log(`[Positions API] Returning ${mergedSnapshot.active.length} active and ${mergedSnapshot.settled.length} settled positions for ${account}`);

    return Response.json(mergedSnapshot, { headers });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Portfolio positions lookup failed";
    return Response.json(
      { error: message, requestId },
      { status: 502, headers }
    );
  }
}

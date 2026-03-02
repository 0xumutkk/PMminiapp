import { Market, MarketSnapshot } from "@/lib/market-types";
import { MultiWindowPointBudget } from "@/lib/rate-budget";
import { isAddress } from "viem";

type LimitlessClient = {
  fetchActiveMarkets: () => Promise<MarketSnapshot>;
};

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_MARKETS = 120;
const MAX_PAGE_LIMIT = 25;
const MAX_PAGE_FETCH = 8;

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

type LimitlessVenue = {
  exchange?: unknown;
  adapter?: unknown;
};

type LimitlessCollateralToken = {
  decimals?: unknown;
};

type LimitlessActiveMarketRow = {
  id?: unknown;
  slug?: unknown;
  conditionId?: unknown;
  title?: unknown;
  prices?: unknown;
  status?: unknown;
  expired?: unknown;
  volumeFormatted?: unknown;
  volume?: unknown;
  expirationTimestamp?: unknown;
  expirationDate?: unknown;
  venue?: unknown;
  collateralToken?: unknown;
  settings?: unknown;
  markets?: unknown;
  /** AMM market contract address (used as the trade contract for buyShares calls) */
  address?: unknown;
  /** ERC-1155 position token IDs: [YES, NO] */
  positionIds?: unknown;
  imageUrl?: unknown;
  categories?: unknown;
  tags?: unknown;
};

type LimitlessActiveMarketsResponse = {
  data?: unknown;
  totalMarketsCount?: unknown;
};

function clampProbability(value: number): number {
  if (value > 1) {
    return Math.max(0, Math.min(1, value / 100));
  }

  return Math.max(0, Math.min(1, value));
}

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json"
      },
      cache: "no-store"
    });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeStatus(rawStatus: unknown, expired: unknown): Market["status"] {
  if (expired === true) {
    return "closed";
  }

  const value = toString(rawStatus)?.toLowerCase();
  if (value?.includes("resolved")) {
    return "resolved";
  }

  if (value?.includes("closed")) {
    return "closed";
  }

  return "open";
}

function parsePrices(raw: unknown) {
  if (!Array.isArray(raw) || raw.length < 2) {
    return null;
  }

  const yes = toNumber(raw[0]);
  const no = toNumber(raw[1]);
  if (yes === undefined || no === undefined) {
    return null;
  }

  return {
    yesPrice: clampProbability(yes),
    noPrice: clampProbability(no)
  };
}

function parseEndsAt(row: LimitlessActiveMarketRow) {
  const timestamp = toNumber(row.expirationTimestamp);
  if (timestamp !== undefined) {
    const millis = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
    return new Date(millis).toISOString();
  }

  const expirationDate = toString(row.expirationDate);
  if (!expirationDate) {
    return undefined;
  }

  const parsed = Date.parse(expirationDate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function parseVolume(row: LimitlessActiveMarketRow) {
  const formatted = toNumber(row.volumeFormatted);
  if (formatted !== undefined) {
    return formatted;
  }

  const rawVolume = toNumber(row.volume);
  if (rawVolume === undefined) {
    return undefined;
  }

  const collateral = typeof row.collateralToken === "object" && row.collateralToken !== null
    ? (row.collateralToken as LimitlessCollateralToken)
    : undefined;
  const decimals = toNumber(collateral?.decimals) ?? 6;
  const scaled = rawVolume / 10 ** decimals;

  return Number.isFinite(scaled) ? scaled : undefined;
}

// minSize is expressed in shares × 1e6 (same scaling as takerAmount in EIP-712 orders).
// Returns the raw share count so callers can compute USDC cost per side:
//   YES cost = minShares × yesPrice
//   NO  cost = minShares × noPrice
function parseMinTradeShares(row: LimitlessActiveMarketRow) {
  const settings =
    typeof row.settings === "object" && row.settings !== null ? (row.settings as { minSize?: unknown }) : undefined;
  const minSizeRaw = settings?.minSize;
  if (minSizeRaw === undefined || minSizeRaw === null) {
    return undefined;
  }

  // minSize is always scaled by 1e6 regardless of collateral decimals (shares, not USDC)
  const SHARES_SCALE = 1e6;

  const minShares =
    typeof minSizeRaw === "number"
      ? minSizeRaw / SHARES_SCALE
      : typeof minSizeRaw === "string"
        ? Number(minSizeRaw) / SHARES_SCALE
        : Number.NaN;

  if (!Number.isFinite(minShares) || minShares <= 0) {
    return undefined;
  }

  return minShares;
}

function parsePositionIds(raw: unknown): [string, string] | undefined {
  if (!Array.isArray(raw) || raw.length < 2) {
    return undefined;
  }

  const toDecimalString = (v: unknown): string | undefined => {
    if (typeof v === "string" && /^\d+$/.test(v.trim())) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(Math.round(v));
    return undefined;
  };

  const yes = toDecimalString(raw[0]);
  const no = toDecimalString(raw[1]);
  if (!yes || !no) return undefined;

  // Validate they are safe to convert to BigInt
  try {
    BigInt(yes);
    BigInt(no);
  } catch {
    return undefined;
  }

  return [yes, no];
}

function normalizeMarket(row: LimitlessActiveMarketRow): Market | null {
  const prices = parsePrices(row.prices);
  if (!prices) {
    return null;
  }

  const conditionId = toString(row.conditionId);
  const marketRef =
    (conditionId && /^0x[0-9a-fA-F]{64}$/.test(conditionId) ? conditionId : undefined) ??
    toString(row.id) ??
    toString(row.slug);
  const id = toString(row.slug) ?? marketRef;
  const title = toString(row.title);
  if (!id || !title) {
    return null;
  }

  const venue = typeof row.venue === "object" && row.venue !== null ? (row.venue as LimitlessVenue) : undefined;
  const exchange = toString(venue?.exchange)
    // AMM markets expose the market's own contract address in row.address (venue is null)
    ?? (typeof row.address === "string" && isAddress(row.address) ? row.address : undefined);
  const adapter = toString(venue?.adapter);

  return {
    id,
    title,
    yesPrice: prices.yesPrice,
    noPrice: prices.noPrice,
    minTradeShares: parseMinTradeShares(row),
    volume24h: parseVolume(row),
    endsAt: parseEndsAt(row),
    status: normalizeStatus(row.status, row.expired),
    tradeVenue: {
      ...(exchange && isAddress(exchange) ? { venueExchange: exchange } : {}),
      ...(adapter && isAddress(adapter) ? { venueAdapter: adapter } : {}),
      ...(marketRef ? { marketRef } : {})
    },
    source: "limitless",
    positionIds: parsePositionIds(row.positionIds),
    imageUrl: toString(row.imageUrl),
    categories: Array.isArray(row.categories) ? row.categories.filter((c): c is string => typeof c === "string") : undefined,
    tags: Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : undefined
  };
}

function flattenRows(rows: LimitlessActiveMarketRow[]): LimitlessActiveMarketRow[] {
  const output: LimitlessActiveMarketRow[] = [];

  for (const row of rows) {
    const nested = Array.isArray(row.markets)
      ? row.markets.filter(
        (market): market is LimitlessActiveMarketRow =>
          typeof market === "object" && market !== null
      )
      : [];

    // Group rows may only hold metadata while nested rows contain tradable outcomes.
    if (nested.length > 0 && !Array.isArray(row.prices)) {
      output.push(...flattenRows(nested));
      continue;
    }

    output.push(row);
    if (nested.length > 0) {
      output.push(...flattenRows(nested));
    }
  }

  return output;
}

function normalizeBaseUrl(rawBaseUrl: string | undefined) {
  const fallback = "https://api.limitless.exchange";
  try {
    const url = new URL(rawBaseUrl ?? fallback);
    if (url.pathname.endsWith("/api-v1")) {
      url.pathname = "/";
    }

    return url.origin;
  } catch {
    return fallback;
  }
}

export function createLimitlessClient(): LimitlessClient {
  const baseUrl = normalizeBaseUrl(process.env.LIMITLESS_API_BASE_URL);
  const budget = new MultiWindowPointBudget();

  async function fetchActivePage(page: number, limit: number) {
    budget.consume(2);

    const url = new URL("/markets/active", baseUrl);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sortBy", "ending_soon");
    url.searchParams.set("tradeType", "amm");

    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) {
      throw new Error(`Limitless API request failed: markets/active -> ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error("Limitless API returned non-JSON response for markets/active");
    }

    const payload = (await response.json()) as LimitlessActiveMarketsResponse;
    if (!Array.isArray(payload.data)) {
      throw new Error("Limitless API response missing data array");
    }

    return {
      rows: payload.data.filter(
        (entry): entry is LimitlessActiveMarketRow =>
          typeof entry === "object" && entry !== null
      ),
      totalMarketsCount: toNumber(payload.totalMarketsCount) ?? payload.data.length
    };
  }

  async function fetchActiveMarkets(): Promise<MarketSnapshot> {
    const pageLimit = Number(process.env.LIMITLESS_ACTIVE_PAGE_LIMIT ?? MAX_PAGE_LIMIT);
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number.isFinite(pageLimit) ? pageLimit : MAX_PAGE_LIMIT));

    const firstPage = await fetchActivePage(1, limit);
    const rows = [...firstPage.rows];

    const expectedPages = Math.ceil(firstPage.totalMarketsCount / limit);
    const pagesToFetch = Math.max(1, Math.min(MAX_PAGE_FETCH, expectedPages));

    for (let page = 2; page <= pagesToFetch; page += 1) {
      if (rows.length >= MAX_MARKETS) {
        break;
      }

      const nextPage = await fetchActivePage(page, limit);
      if (nextPage.rows.length === 0) {
        break;
      }

      rows.push(...nextPage.rows);
    }

    const markets = dedupeMarkets(
      flattenRows(rows)
        .map(normalizeMarket)
        .filter((market): market is Market => market !== null)
        .filter((market) => market.status === "open")
    ).slice(0, MAX_MARKETS);

    return {
      updatedAt: new Date().toISOString(),
      markets
    };
  }

  return {
    fetchActiveMarkets
  };
}

function dedupeMarkets(markets: Market[]) {
  const map = new Map<string, Market>();
  for (const market of markets) {
    map.set(market.id, market);
  }

  return [...map.values()];
}

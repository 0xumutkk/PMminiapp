import { Market, MarketSnapshot } from "@/lib/market-types";
import { MultiWindowPointBudget } from "@/lib/rate-budget";
import { isAddress } from "viem";

type JsonRecord = Record<string, unknown>;

type LimitlessClient = {
  fetchActiveMarkets: () => Promise<MarketSnapshot>;
};

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RECORDS_TO_SCAN = 2000;

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

function clampProbability(value: number): number {
  if (value > 1) {
    return Math.max(0, Math.min(1, value / 100));
  }

  return Math.max(0, Math.min(1, value));
}

function pick(obj: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (key in obj) {
      return obj[key];
    }
  }

  return undefined;
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

function normalizeStatus(rawStatus: unknown): Market["status"] {
  const value = toString(rawStatus)?.toLowerCase();
  if (value === "closed" || value === "resolved") {
    return value;
  }

  return "open";
}

function objectValuesAsRecords(value: JsonRecord): JsonRecord[] {
  return Object.values(value).filter((entry): entry is JsonRecord => {
    return typeof entry === "object" && entry !== null && !Array.isArray(entry);
  });
}

function extractRecords(payload: unknown): JsonRecord[] {
  const records: JsonRecord[] = [];
  const queue: unknown[] = [payload];

  while (queue.length > 0 && records.length < MAX_RECORDS_TO_SCAN) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    if (typeof current !== "object") {
      continue;
    }

    const obj = current as JsonRecord;

    const nestedKeys = ["data", "result", "items", "rows", "markets", "pairs", "tickers", "payload"];
    for (const key of nestedKeys) {
      if (key in obj) {
        queue.push(obj[key]);
      }
    }

    const nestedObjects = objectValuesAsRecords(obj);
    if (nestedObjects.length > 0 && nestedObjects.length <= 30) {
      for (const nestedObject of nestedObjects) {
        queue.push(nestedObject);
      }
    }

    records.push(obj);
  }

  return records;
}

function hasMarketShape(row: JsonRecord) {
  const signalKeys = [
    "id",
    "market_id",
    "marketId",
    "pair",
    "symbol",
    "slug",
    "question",
    "title",
    "yesPrice",
    "yes_price",
    "price_yes",
    "probability",
    "outcomes"
  ];

  return signalKeys.some((key) => key in row);
}

function normalizeFromOutcomes(outcomes: unknown) {
  if (!Array.isArray(outcomes)) {
    return { yesPrice: undefined, noPrice: undefined };
  }

  let yesPrice: number | undefined;
  let noPrice: number | undefined;

  for (const outcome of outcomes) {
    if (typeof outcome !== "object" || outcome === null) {
      continue;
    }

    const row = outcome as JsonRecord;
    const name = toString(pick(row, ["name", "title", "label", "outcome"]))?.toLowerCase();
    const priceRaw = toNumber(pick(row, ["price", "probability", "odds", "value"]));
    if (priceRaw === undefined || !name) {
      continue;
    }

    if (name.includes("yes") || name.includes("up") || name.includes("true")) {
      yesPrice = clampProbability(priceRaw);
    }

    if (name.includes("no") || name.includes("down") || name.includes("false")) {
      noPrice = clampProbability(priceRaw);
    }
  }

  return { yesPrice, noPrice };
}

function normalizeMarket(raw: JsonRecord): Market | null {
  const id = toString(
    pick(raw, ["id", "market_id", "marketId", "pair", "symbol", "slug", "market_slug", "ticker"])
  );

  const base = toString(pick(raw, ["base_currency", "base_symbol", "asset", "base"]));
  const quote = toString(pick(raw, ["quote_currency", "quote_symbol", "quote"]));

  const title =
    toString(pick(raw, ["title", "question", "name", "market", "pair", "description", "headline"])) ??
    (base && quote ? `${base}/${quote}` : undefined) ??
    (id ? `Market ${id}` : undefined);

  if (!id || !title) {
    return null;
  }

  const derivedOutcomes = normalizeFromOutcomes(raw.outcomes);

  const yesPriceRaw =
    toNumber(
      pick(raw, [
        "yesPrice",
        "yes_price",
        "price_yes",
        "p_yes",
        "probability",
        "prob",
        "last_price"
      ])
    ) ?? derivedOutcomes.yesPrice;

  const noPriceRaw =
    toNumber(pick(raw, ["noPrice", "no_price", "price_no", "p_no"])) ?? derivedOutcomes.noPrice;

  const yesPrice = yesPriceRaw !== undefined ? clampProbability(yesPriceRaw) : undefined;
  const noPrice = noPriceRaw !== undefined ? clampProbability(noPriceRaw) : undefined;

  const resolvedYes = yesPrice ?? (noPrice !== undefined ? clampProbability(1 - noPrice) : 0.5);
  const resolvedNo = noPrice ?? clampProbability(1 - resolvedYes);

  const venueRaw =
    (typeof raw.venue === "object" && raw.venue !== null ? (raw.venue as JsonRecord) : undefined) ??
    (typeof raw.execution_venue === "object" && raw.execution_venue !== null
      ? (raw.execution_venue as JsonRecord)
      : undefined);

  const exchangeCandidate =
    toString(
      pick(raw, ["venue_exchange", "exchange", "exchange_address", "venueExchange", "trade_contract"])
    ) ?? (venueRaw ? toString(pick(venueRaw, ["exchange", "exchange_address"])) : undefined);

  const adapterCandidate =
    toString(pick(raw, ["venue_adapter", "adapter", "adapter_address", "venueAdapter"])) ??
    (venueRaw ? toString(pick(venueRaw, ["adapter", "adapter_address"])) : undefined);

  const functionSignature =
    toString(pick(raw, ["trade_function_signature", "execution_signature"])) ??
    (venueRaw ? toString(pick(venueRaw, ["function_signature", "trade_function_signature"])) : undefined);

  const argMap =
    toString(pick(raw, ["trade_arg_map", "execution_arg_map"])) ??
    (venueRaw ? toString(pick(venueRaw, ["arg_map", "trade_arg_map"])) : undefined);

  return {
    id,
    title,
    yesPrice: resolvedYes,
    noPrice: resolvedNo,
    volume24h: toNumber(
      pick(raw, ["volume24h", "volume_24h", "volume", "turnover_24h", "volumeUsd", "vol24h"])
    ),
    endsAt: toString(
      pick(raw, ["endsAt", "ends_at", "end_time", "expiration", "expiresAt", "close_time", "resolve_time"])
    ),
    status: normalizeStatus(pick(raw, ["status", "state"])),
    tradeVenue: {
      ...(exchangeCandidate && isAddress(exchangeCandidate) ? { venueExchange: exchangeCandidate } : {}),
      ...(adapterCandidate && isAddress(adapterCandidate) ? { venueAdapter: adapterCandidate } : {}),
      ...(functionSignature ? { functionSignature } : {}),
      ...(argMap ? { argMap } : {})
    },
    source: "limitless"
  };
}

function dedupeMarkets(markets: Market[]) {
  const map = new Map<string, Market>();
  for (const market of markets) {
    map.set(market.id, market);
  }

  return [...map.values()];
}

function withSyntheticEndTimes(markets: Market[]) {
  return markets.map((market, index) => {
    if (market.endsAt) {
      return market;
    }

    const nextQuarterHourMs = 15 * 60 * 1000;
    const endsAt = new Date(Date.now() + nextQuarterHourMs + index * 45_000).toISOString();
    return { ...market, endsAt };
  });
}

export function createLimitlessClient(): LimitlessClient {
  const baseUrl = process.env.LIMITLESS_API_BASE_URL ?? "https://api.limitless.exchange";
  const budget = new MultiWindowPointBudget();

  async function callPublic(method: string, query: Record<string, string> = {}, pointCost = 2) {
    budget.consume(pointCost);

    const url = new URL(`/public/${method}`, baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) {
      throw new Error(`Limitless API request failed: ${method} -> ${response.status}`);
    }

    return (await response.json()) as unknown;
  }

  async function fetchMarketRows() {
    const candidates = ["markets", "pairs", "ticker"];

    for (const method of candidates) {
      try {
        const payload = await callPublic(method);
        const rows = extractRecords(payload).filter(hasMarketShape);
        if (rows.length > 0) {
          return rows;
        }
      } catch {
        // Continue with fallbacks.
      }
    }

    throw new Error("No market data returned from Limitless API public endpoints");
  }

  async function fetchActiveMarkets(): Promise<MarketSnapshot> {
    const rows = await fetchMarketRows();

    const markets = withSyntheticEndTimes(
      dedupeMarkets(
        rows
          .map(normalizeMarket)
          .filter((market): market is Market => market !== null)
          .filter((market) => market.status === "open")
      )
    ).slice(0, 120);

    return {
      updatedAt: new Date().toISOString(),
      markets
    };
  }

  return {
    fetchActiveMarkets
  };
}

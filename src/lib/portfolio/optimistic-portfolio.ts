import type { PortfolioPositionsSnapshot, TrackedPosition } from "./limitless-portfolio";

export const OPTIMISTIC_PORTFOLIO_EVENT = "portfolio:optimistic-update";

const STORAGE_KEY = "miniapp:optimistic-portfolio-buys";
const OPTIMISTIC_BUY_TTL_MS = 30 * 60 * 1000;

export type StoredOptimisticPortfolioBuy = {
  id: string;
  account: string;
  marketId: string;
  marketTitle: string;
  side: "yes" | "no";
  amountUsdc: string;
  executionPrice?: number;
  confirmedAt: string;
  expiresAt: string;
};

type OptimisticPortfolioBuyInput = Omit<StoredOptimisticPortfolioBuy, "id" | "expiresAt">;

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function dispatchOptimisticPortfolioUpdate() {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(OPTIMISTIC_PORTFOLIO_EVENT));
}

function normalizeMarketRef(value: string | undefined | null) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().toLowerCase();
}

function formatPortfolioNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function isLiveOptimisticBuy(entry: StoredOptimisticPortfolioBuy) {
  const expiresAtMs = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return expiresAtMs > Date.now();
}

function readAllStoredOptimisticPortfolioBuys() {
  if (!canUseStorage()) {
    return [] as StoredOptimisticPortfolioBuy[];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((entry): entry is StoredOptimisticPortfolioBuy => {
      if (!entry || typeof entry !== "object") {
        return false;
      }

      const record = entry as Record<string, unknown>;
      return (
        typeof record.id === "string" &&
        typeof record.account === "string" &&
        typeof record.marketId === "string" &&
        typeof record.marketTitle === "string" &&
        (record.side === "yes" || record.side === "no") &&
        typeof record.amountUsdc === "string" &&
        typeof record.confirmedAt === "string" &&
        typeof record.expiresAt === "string"
      );
    });
  } catch {
    return [];
  }
}

function writeAllStoredOptimisticPortfolioBuys(entries: StoredOptimisticPortfolioBuy[]) {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  dispatchOptimisticPortfolioUpdate();
}

function pruneStoredEntries(entries: StoredOptimisticPortfolioBuy[]) {
  return entries.filter(isLiveOptimisticBuy);
}

export function readStoredOptimisticPortfolioBuys(account?: string | null) {
  const rawEntries = readAllStoredOptimisticPortfolioBuys();
  const entries = pruneStoredEntries(rawEntries);
  if (canUseStorage() && entries.length !== rawEntries.length) {
    writeAllStoredOptimisticPortfolioBuys(entries);
  }

  if (!account) {
    return entries;
  }

  const normalizedAccount = account.toLowerCase();
  return entries.filter((entry) => entry.account.toLowerCase() === normalizedAccount);
}

export function storeOptimisticPortfolioBuy(input: OptimisticPortfolioBuyInput) {
  const entries = pruneStoredEntries(readAllStoredOptimisticPortfolioBuys());
  const id = [
    input.account.toLowerCase(),
    normalizeMarketRef(input.marketId),
    input.side,
    Date.parse(input.confirmedAt) || Date.now()
  ].join(":");

  const nextEntries = [
    ...entries.filter((entry) => entry.id !== id),
    {
      ...input,
      id,
      expiresAt: new Date(Date.now() + OPTIMISTIC_BUY_TTL_MS).toISOString()
    }
  ];

  writeAllStoredOptimisticPortfolioBuys(nextEntries);
}

export function removeStoredOptimisticPortfolioBuys(
  account: string,
  marketId: string,
  side?: "yes" | "no"
) {
  const normalizedAccount = account.toLowerCase();
  const normalizedMarketId = normalizeMarketRef(marketId);
  const entries = pruneStoredEntries(readAllStoredOptimisticPortfolioBuys());
  const nextEntries = entries.filter((entry) => {
    if (entry.account.toLowerCase() !== normalizedAccount) {
      return true;
    }

    if (normalizeMarketRef(entry.marketId) !== normalizedMarketId) {
      return true;
    }

    if (side && entry.side !== side) {
      return true;
    }

    return false;
  });

  if (nextEntries.length !== entries.length) {
    writeAllStoredOptimisticPortfolioBuys(nextEntries);
  }
}

function positionMatchesOptimisticBuy(
  position: Pick<TrackedPosition, "marketId" | "marketSlug" | "side">,
  trade: Pick<StoredOptimisticPortfolioBuy, "marketId" | "side">
) {
  if (position.side !== trade.side) {
    return false;
  }

  const target = normalizeMarketRef(trade.marketId);
  return (
    normalizeMarketRef(position.marketId) === target ||
    normalizeMarketRef(position.marketSlug) === target
  );
}

function buildOptimisticPosition(
  trade: StoredOptimisticPortfolioBuy
): TrackedPosition {
  const amountUsdc = Number(trade.amountUsdc);
  const executionPrice =
    typeof trade.executionPrice === "number" &&
    Number.isFinite(trade.executionPrice) &&
    trade.executionPrice > 0 &&
    trade.executionPrice < 1
      ? trade.executionPrice
      : undefined;
  const tokenBalance =
    executionPrice && Number.isFinite(amountUsdc) && amountUsdc > 0
      ? amountUsdc / executionPrice
      : amountUsdc;

  return {
    id: `optimistic:${trade.id}`,
    marketId: trade.marketId,
    marketSlug: trade.marketId,
    marketTitle: trade.marketTitle || trade.marketId,
    side: trade.side,
    status: "active",
    costUsdc: trade.amountUsdc,
    marketValueUsdc: Number.isFinite(amountUsdc) && amountUsdc > 0 ? trade.amountUsdc : "0",
    unrealizedPnlUsdc: "0",
    realizedPnlUsdc: "0",
    claimable: false,
    tokenBalance: Number.isFinite(tokenBalance) && tokenBalance > 0 ? formatPortfolioNumber(tokenBalance) : "0",
    currentPrice: executionPrice,
    hasVerifiedPricing: executionPrice !== undefined,
    activityAt: trade.confirmedAt
  };
}

function buildOptimisticBuyKey(trade: Pick<StoredOptimisticPortfolioBuy, "marketId" | "side">) {
  return `${normalizeMarketRef(trade.marketId)}:${trade.side}`;
}

function recomputeTotals(snapshot: PortfolioPositionsSnapshot): PortfolioPositionsSnapshot["totals"] {
  return {
    activeMarketValueUsdc: formatPortfolioNumber(
      snapshot.active.reduce((sum, item) => sum + Number(item.marketValueUsdc), 0)
    ),
    unrealizedPnlUsdc: formatPortfolioNumber(
      snapshot.active.reduce((sum, item) => sum + Number(item.unrealizedPnlUsdc), 0)
    ),
    claimableUsdc: formatPortfolioNumber(
      snapshot.settled
        .filter((item) => item.claimable)
        .reduce((sum, item) => sum + Number(item.marketValueUsdc), 0)
    )
  };
}

export function createOptimisticPortfolioSnapshot(account: `0x${string}`): PortfolioPositionsSnapshot {
  return {
    account,
    fetchedAt: new Date().toISOString(),
    active: [],
    settled: [],
    totals: {
      activeMarketValueUsdc: "0",
      unrealizedPnlUsdc: "0",
      claimableUsdc: "0"
    }
  };
}

export function mergeOptimisticPortfolioBuys(
  snapshot: PortfolioPositionsSnapshot,
  optimisticBuys: StoredOptimisticPortfolioBuy[]
) {
  const pendingTrades = optimisticBuys.filter((trade) => {
    const matchedActive = snapshot.active.some((position) => positionMatchesOptimisticBuy(position, trade));
    const matchedSettled = snapshot.settled.some((position) => positionMatchesOptimisticBuy(position, trade));
    return !matchedActive && !matchedSettled;
  });

  const groupedTrades = new Map<string, StoredOptimisticPortfolioBuy>();
  for (const trade of pendingTrades) {
    const key = buildOptimisticBuyKey(trade);
    const existing = groupedTrades.get(key);
    if (!existing) {
      groupedTrades.set(key, trade);
      continue;
    }

    const totalAmountUsdc = Number(existing.amountUsdc) + Number(trade.amountUsdc);
    const existingConfirmedAtMs = Date.parse(existing.confirmedAt);
    const tradeConfirmedAtMs = Date.parse(trade.confirmedAt);
    const latestTrade =
      Number.isFinite(tradeConfirmedAtMs) && tradeConfirmedAtMs >= existingConfirmedAtMs
        ? trade
        : existing;

    groupedTrades.set(key, {
      ...latestTrade,
      amountUsdc: formatPortfolioNumber(totalAmountUsdc)
    });
  }

  const pendingPositions = Array.from(groupedTrades.values())
    .sort((left, right) => Date.parse(right.confirmedAt) - Date.parse(left.confirmedAt))
    .map(buildOptimisticPosition);

  if (pendingPositions.length === 0) {
    return snapshot;
  }

  const nextSnapshot = {
    ...snapshot,
    active: [...pendingPositions, ...snapshot.active]
  };

  return {
    ...nextSnapshot,
    totals: recomputeTotals(nextSnapshot)
  };
}

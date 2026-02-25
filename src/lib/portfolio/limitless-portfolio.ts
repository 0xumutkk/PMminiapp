import { isAddress } from "viem";

const REQUEST_TIMEOUT_MS = 8_000;

export type TrackedPosition = {
  id: string;
  marketId: string;
  marketSlug: string;
  marketTitle: string;
  side: "yes" | "no";
  status: "active" | "settled";
  costUsdc: string;
  marketValueUsdc: string;
  unrealizedPnlUsdc: string;
  realizedPnlUsdc: string;
  claimable: boolean;
};

export type PortfolioPositionsSnapshot = {
  account: `0x${string}`;
  fetchedAt: string;
  active: TrackedPosition[];
  settled: TrackedPosition[];
  totals: {
    activeMarketValueUsdc: string;
    unrealizedPnlUsdc: string;
    claimableUsdc: string;
  };
};

type PositionData = {
  cost?: unknown;
  marketValue?: unknown;
  unrealizedPnl?: unknown;
  realisedPnl?: unknown;
};

type ClobPosition = {
  market?: {
    id?: unknown;
    slug?: unknown;
    title?: unknown;
    status?: unknown;
    closed?: unknown;
    collateral?: {
      decimals?: unknown;
    };
  };
  positions?: {
    yes?: PositionData;
    no?: PositionData;
  };
};

type PublicPortfolioResponse = {
  clob?: unknown;
};

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

function toStringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function toNumberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeTokenAmount(raw: unknown, decimals: number) {
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

function hasExposure(data: PositionData | undefined, decimals: number) {
  if (!data) {
    return false;
  }

  const keys: Array<keyof PositionData> = ["cost", "marketValue", "unrealizedPnl", "realisedPnl"];
  return keys.some((key) => Number(normalizeTokenAmount(data[key], decimals)) !== 0);
}

function toTrackedPosition(
  raw: ClobPosition,
  side: "yes" | "no",
  sideData: PositionData | undefined,
  decimals: number
): TrackedPosition | null {
  if (!sideData || !hasExposure(sideData, decimals)) {
    return null;
  }

  const marketId = String(raw.market?.id ?? raw.market?.slug ?? "unknown-market");
  const marketSlug = String(raw.market?.slug ?? marketId);
  const marketTitle = String(raw.market?.title ?? marketSlug);
  const closed = raw.market?.closed === true;
  const statusRaw = toStringValue(raw.market?.status)?.toLowerCase() ?? "";
  const isSettled = closed || statusRaw.includes("resolved") || statusRaw.includes("closed");
  const marketValueUsdc = normalizeTokenAmount(sideData.marketValue, decimals);

  return {
    id: `${marketId}:${side}`,
    marketId,
    marketSlug,
    marketTitle,
    side,
    status: isSettled ? "settled" : "active",
    costUsdc: normalizeTokenAmount(sideData.cost, decimals),
    marketValueUsdc,
    unrealizedPnlUsdc: normalizeTokenAmount(sideData.unrealizedPnl, decimals),
    realizedPnlUsdc: normalizeTokenAmount(sideData.realisedPnl, decimals),
    claimable: isSettled && Number(marketValueUsdc) > 0
  };
}

function addDecimalStrings(values: string[]) {
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isFinite(total)) {
    return "0";
  }
  return total.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function normalizePortfolioPositions(
  account: `0x${string}`,
  payload: PublicPortfolioResponse
): PortfolioPositionsSnapshot {
  const clobEntries = Array.isArray(payload.clob)
    ? payload.clob.filter((entry): entry is ClobPosition => typeof entry === "object" && entry !== null)
    : [];

  const positions: TrackedPosition[] = [];
  for (const entry of clobEntries) {
    const decimals = Math.max(0, Math.min(18, Math.round(toNumberValue(entry.market?.collateral?.decimals) ?? 6)));
    const yes = toTrackedPosition(entry, "yes", entry.positions?.yes, decimals);
    const no = toTrackedPosition(entry, "no", entry.positions?.no, decimals);
    if (yes) {
      positions.push(yes);
    }
    if (no) {
      positions.push(no);
    }
  }

  const active = positions.filter((position) => position.status === "active");
  const settled = positions.filter((position) => position.status === "settled");

  return {
    account,
    fetchedAt: new Date().toISOString(),
    active,
    settled,
    totals: {
      activeMarketValueUsdc: addDecimalStrings(active.map((item) => item.marketValueUsdc)),
      unrealizedPnlUsdc: addDecimalStrings(active.map((item) => item.unrealizedPnlUsdc)),
      claimableUsdc: addDecimalStrings(settled.filter((item) => item.claimable).map((item) => item.marketValueUsdc))
    }
  };
}

export async function fetchPublicPortfolioPositions(account: string): Promise<PortfolioPositionsSnapshot> {
  if (!isAddress(account)) {
    throw new Error("account must be a valid EVM address");
  }

  const normalizedAccount = account as `0x${string}`;
  const baseUrl = normalizeBaseUrl(process.env.LIMITLESS_API_BASE_URL);
  const response = await fetchWithTimeout(`${baseUrl}/portfolio/${normalizedAccount}/positions`);

  if (response.status === 404) {
    return {
      account: normalizedAccount,
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

  if (!response.ok) {
    throw new Error(`Portfolio positions request failed with ${response.status}`);
  }

  const payload = (await response.json()) as PublicPortfolioResponse;
  return normalizePortfolioPositions(normalizedAccount, payload);
}

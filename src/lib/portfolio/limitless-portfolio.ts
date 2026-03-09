import { isAddress } from "viem";
import * as fs from "fs";

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
  tokenBalance: string;
  /** Current market price for this side (0–1). Used by UI to skip market lookup for historical positions. */
  currentPrice?: number;
  /** Whether worth/PNL fields come from verified pricing rather than a fallback estimate. */
  hasVerifiedPricing?: boolean;
  /** The date when the market ends/ended. */
  endsAt?: string;
  /** Internal UI hint for historical positions closed via sell rather than resolution/redeem. */
  isSold?: boolean;
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
  claimable?: unknown;
  redeemable?: unknown;
  canRedeem?: unknown;
  isClaimable?: unknown;
};

type ClobPosition = {
  market?: {
    id?: unknown;
    slug?: unknown;
    title?: unknown;
    status?: unknown;
    closed?: unknown;
    ends_at?: unknown;
    endsAt?: unknown;
    expirationDate?: unknown;
    deadline?: unknown;
    winning_index?: unknown;
    winningOutcomeIndex?: unknown;
    payout_numerators?: unknown;
    position_ids?: unknown;
    yesPositionId?: unknown;
    noPositionId?: unknown;
    collateral?: {
      decimals?: unknown;
    };
  };
  tokensBalance?: unknown;
  latestTrade?: {
    latestYesPrice?: unknown;
    latestNoPrice?: unknown;
    outcomeTokenPrice?: unknown;
  };
  positions?: {
    yes?: PositionData;
    no?: PositionData;
  };
};

type AmmPosition = {
  market?: {
    address?: unknown;
    slug?: unknown;
    title?: unknown;
    status?: unknown;
    closed?: unknown;
    ends_at?: unknown;
    endsAt?: unknown;
    expirationDate?: unknown;
    deadline?: unknown;
    winning_index?: unknown;
    winningOutcomeIndex?: unknown;
    payout_numerators?: unknown;
    collateral?: {
      decimals?: unknown;
    };
  };
  outcomeIndex?: unknown;       // 0 = YES, 1 = NO
  outcomeTokenAmount?: unknown; // shares in token decimals
  collateralAmount?: unknown;   // USDC cost in token decimals
};

type PublicPortfolioResponse = {
  clob?: unknown;
  amm?: unknown;
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

async function fetchWithTimeout(url: string, authHeaders?: Record<string, string>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        // Cloudflare WAF on the portfolio endpoint blocks raw server-side requests.
        // These headers make the request appear to originate from a browser on the Limitless domain.
        Origin: "https://limitless.exchange",
        Referer: "https://limitless.exchange/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        ...authHeaders
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

function toIsoDateString(value: unknown) {
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      return value;
    }
    const d = new Date(value);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value < 10 ** 11 ? value * 1000 : value);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
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

function toBooleanValue(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
  }
  return null;
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

function formatDecimalNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }

  return value.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function deriveActiveUnrealizedPnl(
  marketValueUsdc: string,
  costUsdc: string,
  fallbackPnlUsdc: string
) {
  const marketValue = Number(marketValueUsdc);
  const cost = Number(costUsdc);

  // If cost basis is missing, keep the upstream/fallback PnL instead of inventing one.
  if (!Number.isFinite(marketValue) || !Number.isFinite(cost) || cost === 0) {
    return fallbackPnlUsdc;
  }

  return formatDecimalNumber(marketValue - cost);
}

function hasExposure(data: PositionData | undefined, decimals: number) {
  if (!data) {
    return false;
  }

  const keys: Array<keyof PositionData> = ["cost", "marketValue", "unrealizedPnl", "realisedPnl"];
  return keys.some((key) => Number(normalizeTokenAmount(data[key], decimals)) !== 0);
}

function isPositiveTokenAmount(raw: unknown) {
  if (raw === null || raw === undefined) {
    return false;
  }

  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0;
  }

  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) {
      return false;
    }

    if (/^-?\d+$/.test(value)) {
      try {
        return BigInt(value) > 0n;
      } catch {
        return false;
      }
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0;
  }

  return false;
}

function extractNestedAmount(raw: unknown) {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  for (const key of ["balance", "amount", "value", "tokens", "tokenBalance"]) {
    const value = record[key];
    if (isPositiveTokenAmount(value)) {
      return value;
    }
  }

  return null;
}

function getSideBalanceCandidate(rawBalance: unknown, side: "yes" | "no") {
  if (!rawBalance || typeof rawBalance !== "object") {
    return null;
  }

  const balance = rawBalance as Record<string, unknown>;
  const direct = balance[side];
  if (isPositiveTokenAmount(direct)) {
    return direct;
  }

  const nested = extractNestedAmount(direct);
  if (nested !== null) {
    return nested;
  }

  return null;
}

function resolveSideTokenBalance(raw: ClobPosition, side: "yes" | "no") {
  const byName = getSideBalanceCandidate(raw.tokensBalance, side);
  if (byName !== null) {
    return byName;
  }

  const marketRecord = raw.market as Record<string, unknown> | undefined;
  const positionIds = Array.isArray(raw.market?.position_ids)
    ? raw.market?.position_ids
    : [
      marketRecord?.yesPositionId,
      marketRecord?.noPositionId
    ];
  const sideIndex = side === "yes" ? 0 : 1;
  const positionId = positionIds[sideIndex];
  if (!positionId || typeof raw.tokensBalance !== "object" || raw.tokensBalance === null) {
    return null;
  }

  const byId = (raw.tokensBalance as Record<string, unknown>)[String(positionId)];
  if (isPositiveTokenAmount(byId)) {
    return byId;
  }

  const nestedById = extractNestedAmount(byId);
  if (nestedById !== null) {
    return nestedById;
  }

  return null;
}

function resolveWinningSide(raw: ClobPosition) {
  const winningIndex = toNumberValue(raw.market?.winning_index);
  if (winningIndex === 0) {
    return "yes" as const;
  }
  if (winningIndex === 1) {
    return "no" as const;
  }

  const winningOutcomeIndex = toNumberValue((raw.market as Record<string, unknown> | undefined)?.winningOutcomeIndex);
  if (winningOutcomeIndex === 0) {
    return "yes" as const;
  }
  if (winningOutcomeIndex === 1) {
    return "no" as const;
  }

  if (!Array.isArray(raw.market?.payout_numerators)) {
    return null;
  }

  const numerators = raw.market.payout_numerators
    .map((item) => toNumberValue(item))
    .filter((item): item is number => item !== undefined);

  if (numerators.length < 2) {
    return null;
  }

  const yesPayout = numerators[0];
  const noPayout = numerators[1];
  if (yesPayout > noPayout) {
    return "yes" as const;
  }
  if (noPayout > yesPayout) {
    return "no" as const;
  }

  return null;
}

function resolveCurrentPrice(raw: ClobPosition, side: "yes" | "no") {
  const latestTrade = raw.latestTrade;
  if (!latestTrade || typeof latestTrade !== "object") {
    return undefined;
  }

  const direct = side === "yes"
    ? toNumberValue(latestTrade.latestYesPrice)
    : toNumberValue(latestTrade.latestNoPrice);
  if (direct !== undefined) {
    return direct;
  }

  if (side !== "yes") {
    return undefined;
  }

  return toNumberValue(latestTrade.outcomeTokenPrice);
}

function resolveClaimable(
  raw: ClobPosition,
  side: "yes" | "no",
  sideData: PositionData,
  isSettled: boolean
) {
  const explicitFlag = [
    sideData.claimable,
    sideData.redeemable,
    sideData.canRedeem,
    sideData.isClaimable
  ]
    .map((value) => toBooleanValue(value))
    .find((value): value is boolean => value !== null);

  if (explicitFlag !== undefined) {
    return explicitFlag;
  }

  if (!isSettled) {
    return false;
  }

  const winningSide = resolveWinningSide(raw);
  if (!winningSide) {
    // No explicit redeemability signal from upstream; avoid false positives.
    return false;
  }

  if (winningSide !== side) {
    return false;
  }

  const sideBalance = resolveSideTokenBalance(raw, side);
  return isPositiveTokenAmount(sideBalance);
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
  const costUsdc = normalizeTokenAmount(sideData.cost, decimals);
  const fallbackUnrealizedPnlUsdc = normalizeTokenAmount(sideData.unrealizedPnl, decimals);
  const currentPrice = resolveCurrentPrice(raw, side);
  const claimable = resolveClaimable(raw, side, sideData, isSettled);
  const sideBalance = resolveSideTokenBalance(raw, side);
  const normalizedSideBalance = normalizeTokenAmount(sideBalance, decimals);
  const impliedActiveBalance =
    !isSettled &&
    currentPrice !== undefined &&
    currentPrice > 0 &&
    Number(marketValueUsdc) > 0
      ? formatDecimalNumber(Number(marketValueUsdc) / currentPrice)
      : null;

  return {
    id: `${marketId}:${side}`,
    marketId,
    marketSlug,
    marketTitle,
    side,
    status: isSettled ? "settled" : "active",
    costUsdc,
    marketValueUsdc,
    unrealizedPnlUsdc: isSettled
      ? fallbackUnrealizedPnlUsdc
      : deriveActiveUnrealizedPnl(marketValueUsdc, costUsdc, fallbackUnrealizedPnlUsdc),
    realizedPnlUsdc: normalizeTokenAmount(sideData.realisedPnl, decimals),
    claimable,
    tokenBalance: impliedActiveBalance ?? normalizedSideBalance,
    currentPrice,
    hasVerifiedPricing: isSettled ? false : Number(marketValueUsdc) > 0,
    endsAt: toIsoDateString(
      raw.market?.ends_at ??
      (raw.market as any)?.endsAt ??
      (raw.market as any)?.expirationTimestamp ??
      (raw.market as any)?.expirationDate ??
      (raw.market as any)?.deadline ??
      (raw.market as any)?.resolved_at ??
      (raw.market as any)?.closed_at ??
      (raw.market as any)?.close_date
    )
  };
}

function addDecimalStrings(values: string[]) {
  const total = values.reduce((sum, value) => sum + Number(value), 0);
  if (!Number.isFinite(total)) {
    return "0";
  }
  return total.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function toTrackedAmmPosition(raw: AmmPosition, decimals: number): TrackedPosition | null {
  const marketSlug = String(raw.market?.slug ?? raw.market?.address ?? "unknown");
  const marketTitle = String(raw.market?.title ?? marketSlug);
  const marketId = String(raw.market?.address ?? marketSlug);

  const outcomeIndex = toNumberValue(raw.outcomeIndex);
  if (outcomeIndex !== 0 && outcomeIndex !== 1) {
    return null;
  }
  const side: "yes" | "no" = outcomeIndex === 0 ? "yes" : "no";

  const costRaw = normalizeTokenAmount(raw.collateralAmount, decimals);
  const sharesRaw = normalizeTokenAmount(raw.outcomeTokenAmount, decimals);

  // Skip positions with no exposure
  if (Number(costRaw) === 0 && Number(sharesRaw) === 0) {
    return null;
  }

  const closed = raw.market?.closed === true;
  const statusRaw = toStringValue(raw.market?.status)?.toLowerCase() ?? "";
  const isSettled = closed || statusRaw.includes("resolved") || statusRaw.includes("closed");
  const fallbackUnrealizedPnlUsdc = "0";

  return {
    id: `${marketId}:${side}`,
    marketId,
    marketSlug,
    marketTitle,
    side,
    status: isSettled ? "settled" : "active",
    costUsdc: costRaw,
    marketValueUsdc: sharesRaw,   // approximate: shares held (no live price multiplied)
    unrealizedPnlUsdc: isSettled ? fallbackUnrealizedPnlUsdc : deriveActiveUnrealizedPnl(sharesRaw, costRaw, fallbackUnrealizedPnlUsdc),
    realizedPnlUsdc: "0",
    claimable: false,
    tokenBalance: sharesRaw,
    hasVerifiedPricing: false,
    endsAt: toIsoDateString(
      raw.market?.ends_at ??
      (raw.market as any)?.endsAt ??
      (raw.market as any)?.expirationTimestamp ??
      (raw.market as any)?.expirationDate ??
      (raw.market as any)?.deadline ??
      (raw.market as any)?.resolved_at ??
      (raw.market as any)?.closed_at ??
      (raw.market as any)?.close_date
    )
  };
}

function normalizePortfolioPositions(
  account: `0x${string}`,
  payload: PublicPortfolioResponse
): PortfolioPositionsSnapshot {
  try {
    fs.writeFileSync('/tmp/portfolio-payload.json', JSON.stringify(payload, null, 2));
  } catch (e) { }

  const clobEntries = Array.isArray(payload.clob)
    ? payload.clob.filter((entry): entry is ClobPosition =>
      typeof entry === "object" && entry !== null
    )
    : [];

  const ammEntries = Array.isArray(payload.amm)
    ? payload.amm.filter((entry): entry is AmmPosition =>
      typeof entry === "object" && entry !== null
    )
    : [];

  const positions: TrackedPosition[] = [];

  for (const entry of clobEntries) {
    const decimals = Math.max(0, Math.min(18, Math.round(toNumberValue(entry.market?.collateral?.decimals) ?? 6)));
    const yes = toTrackedPosition(entry, "yes", entry.positions?.yes, decimals);
    const no = toTrackedPosition(entry, "no", entry.positions?.no, decimals);
    if (yes) positions.push(yes);
    if (no) positions.push(no);
  }

  for (const entry of ammEntries) {
    const decimals = Math.max(0, Math.min(18, Math.round(toNumberValue(entry.market?.collateral?.decimals) ?? 6)));
    const pos = toTrackedAmmPosition(entry, decimals);
    if (pos) positions.push(pos);
  }

  const active = positions.filter(
    (position) =>
      position.status === "active" &&
      (Number(position.marketValueUsdc) > 0 || Number(position.tokenBalance) > 0)
  );
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

export async function fetchPublicPortfolioPositions(
  account: string,
  authHeaders?: Record<string, string>
): Promise<PortfolioPositionsSnapshot> {
  if (!isAddress(account)) {
    throw new Error("account must be a valid EVM address");
  }

  const normalizedAccount = account as `0x${string}`;
  const baseUrl = normalizeBaseUrl(process.env.LIMITLESS_API_BASE_URL);
  const response = await fetchWithTimeout(`${baseUrl}/portfolio/${normalizedAccount}/positions`, authHeaders);

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

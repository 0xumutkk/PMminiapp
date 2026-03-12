import type { PortfolioPositionsSnapshot } from "./limitless-portfolio";

export const MIN_VISIBLE_ACTIVE_SHARES = 0.1;

type ActivePosition = PortfolioPositionsSnapshot["active"][number];
type SettledPosition = PortfolioPositionsSnapshot["settled"][number];
type PositionLookup = Pick<ActivePosition, "marketId" | "marketSlug" | "side">;

function buildPositionLookupKeys(position: PositionLookup) {
  const keys = new Set<string>();
  const side = position.side.toLowerCase();
  const marketId = position.marketId.trim().toLowerCase();
  const marketSlug = position.marketSlug.trim().toLowerCase();

  if (marketId) {
    keys.add(`${marketId}:${side}`);
  }

  if (marketSlug) {
    keys.add(`${marketSlug}:${side}`);
  }

  return Array.from(keys);
}

export function isVisibleActivePosition(position: ActivePosition) {
  return Number(position.tokenBalance) >= MIN_VISIBLE_ACTIVE_SHARES;
}

export function filterVisibleActivePositions(
  active: ActivePosition[],
  settled: SettledPosition[] = []
) {
  const soldHistoryKeys = new Set<string>();
  for (const position of settled) {
    if (!position.isSold) {
      continue;
    }

    for (const key of buildPositionLookupKeys(position)) {
      soldHistoryKeys.add(key);
    }
  }

  const activeWithoutSoldDust = active.filter((position) => {
    if (Number(position.tokenBalance) >= MIN_VISIBLE_ACTIVE_SHARES) {
      return true;
    }

    return !buildPositionLookupKeys(position).some((key) => soldHistoryKeys.has(key));
  });

  const visible = activeWithoutSoldDust.filter(isVisibleActivePosition);
  if (visible.length > 0) {
    return visible;
  }

  if (activeWithoutSoldDust.length > 0) {
    return activeWithoutSoldDust;
  }

  // If sold-dust suppression would hide every active position, keep showing the
  // raw active rows so the profile never drops to a misleading zero-state.
  return active;
}

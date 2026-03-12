import type { PortfolioPositionsSnapshot } from "./limitless-portfolio";

export const MIN_VISIBLE_ACTIVE_SHARES = 0.1;

type ActivePosition = PortfolioPositionsSnapshot["active"][number];

function parseTokenBalance(position: Pick<ActivePosition, "tokenBalance">) {
  const tokenBalance = Number(position.tokenBalance);
  return Number.isFinite(tokenBalance) ? tokenBalance : 0;
}

export function isVisibleActivePosition(position: ActivePosition) {
  return parseTokenBalance(position) >= MIN_VISIBLE_ACTIVE_SHARES;
}

export function isSmallActivePosition(position: ActivePosition) {
  const tokenBalance = parseTokenBalance(position);
  return tokenBalance > 0 && tokenBalance < MIN_VISIBLE_ACTIVE_SHARES;
}

export function filterVisibleActivePositions(
  active: ActivePosition[],
  _settled: PortfolioPositionsSnapshot["settled"] = []
) {
  return active.filter(isVisibleActivePosition);
}

export function filterSmallActivePositions(active: ActivePosition[]) {
  return active.filter(isSmallActivePosition);
}

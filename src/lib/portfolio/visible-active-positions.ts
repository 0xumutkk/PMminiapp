import type { PortfolioPositionsSnapshot } from "./limitless-portfolio";

export const MIN_VISIBLE_ACTIVE_SHARES = 0.1;

type ActivePosition = PortfolioPositionsSnapshot["active"][number];

export function isVisibleActivePosition(position: ActivePosition) {
  return Number(position.tokenBalance) >= MIN_VISIBLE_ACTIVE_SHARES;
}

export function filterVisibleActivePositions(active: ActivePosition[]) {
  return active.filter(isVisibleActivePosition);
}

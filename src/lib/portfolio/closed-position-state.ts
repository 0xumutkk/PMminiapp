import type { PortfolioPositionsSnapshot } from "./limitless-portfolio";

type ClosedPosition = PortfolioPositionsSnapshot["settled"][number];

export type ClosedPositionState = "redeemed" | "sold" | "lost";

export function classifyClosedPositionState(
  position: Pick<
    ClosedPosition,
    "status" | "tokenBalance" | "currentPrice" | "isSold" | "isRedeemed"
  >
): ClosedPositionState {
  if (position.isRedeemed === true) {
    return "redeemed";
  }

  if (
    position.status === "settled" &&
    position.isSold !== true &&
    Number(position.tokenBalance) === 0 &&
    Number(position.currentPrice) > 0
  ) {
    return "redeemed";
  }

  if (position.isSold === true) {
    return "sold";
  }

  return "lost";
}

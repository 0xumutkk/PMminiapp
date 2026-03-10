import test from "node:test";
import assert from "node:assert/strict";
import type { TrackedPosition } from "./limitless-portfolio";
import { filterVisibleActivePositions } from "./visible-active-positions";

function createActivePosition(id: string, tokenBalance: string): TrackedPosition {
  return {
    id,
    marketId: `${id}-market`,
    marketSlug: `${id}-market`,
    marketTitle: id,
    side: "yes",
    status: "active",
    costUsdc: "1",
    marketValueUsdc: "1",
    unrealizedPnlUsdc: "0",
    realizedPnlUsdc: "0",
    claimable: false,
    tokenBalance,
    currentPrice: 0.5,
    hasVerifiedPricing: true
  };
}

test("keeps only positions above the visibility threshold when any exist", () => {
  const active = [
    createActivePosition("dust", "0.02"),
    createActivePosition("visible", "0.4")
  ];

  assert.deepEqual(
    filterVisibleActivePositions(active).map((position) => position.id),
    ["visible"]
  );
});

test("falls back to returning dust positions when filtering would otherwise empty the list", () => {
  const active = [
    createActivePosition("dust-1", "0.02"),
    createActivePosition("dust-2", "0.08")
  ];

  assert.deepEqual(
    filterVisibleActivePositions(active).map((position) => position.id),
    ["dust-1", "dust-2"]
  );
});

test("hides sold dust positions from active when the same market exists in history", () => {
  const active = [createActivePosition("dust-1", "0.02")];
  const settled = [
    {
      ...createActivePosition("dust-1", "1.4"),
      status: "settled" as const,
      tokenBalance: "1.38",
      isSold: true
    }
  ];

  assert.deepEqual(filterVisibleActivePositions(active, settled), []);
});

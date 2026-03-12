import assert from "node:assert/strict";
import test from "node:test";
import { classifyClosedPositionState } from "@/lib/portfolio/closed-position-state";

test("classifies explicit redeemed history rows as redeemed even without currentPrice", () => {
  const state = classifyClosedPositionState({
    status: "settled",
    tokenBalance: "0",
    currentPrice: undefined,
    isSold: false,
    isRedeemed: true
  });

  assert.equal(state, "redeemed");
});

test("classifies sold history rows as sold", () => {
  const state = classifyClosedPositionState({
    status: "settled",
    tokenBalance: "0",
    currentPrice: 0.82,
    isSold: true,
    isRedeemed: false
  });

  assert.equal(state, "sold");
});

test("falls back to lost for unresolved closed rows without sold or redeemed flags", () => {
  const state = classifyClosedPositionState({
    status: "settled",
    tokenBalance: "0",
    currentPrice: 0,
    isSold: false,
    isRedeemed: false
  });

  assert.equal(state, "lost");
});

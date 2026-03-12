import assert from "node:assert/strict";
import test from "node:test";
import { buildTradeIntent } from "@/lib/trade/build-intent";

test("redeem intent matches the historical successful conditional tokens calldata", () => {
  const intent = buildTradeIntent({
    action: "redeem",
    marketId: "0x91d3fee86321a6f50b719b8368cf62de44b8e510",
    side: "yes",
    amountUsdc: "0.151683",
    walletAddress: "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc",
    tradeContract: "0xC9c98965297Bc527861c898329Ee280632B76e18",
    usdcToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    conditionId: "0xdf85d39c37aec82fc3a96ffb44ebc1dcb4fa0346ccb42c3adca2b7c9eeef8718"
  });

  assert.equal(intent.mode, "onchain");
  assert.equal(intent.calls.length, 1);
  assert.equal(intent.calls[0]?.to, "0xC9c98965297Bc527861c898329Ee280632B76e18");
  assert.equal(
    intent.calls[0]?.data,
    "0x01b7037c000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000000000df85d39c37aec82fc3a96ffb44ebc1dcb4fa0346ccb42c3adca2b7c9eeef87180000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002"
  );
});

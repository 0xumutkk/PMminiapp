import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldPreferWalletSendCalls,
  shouldUseDirectTransactionSubmission
} from "@/lib/trade/execution-strategy";

test("prefers wallet_sendCalls for Farcaster connectors", () => {
  assert.equal(shouldPreferWalletSendCalls("farcaster"), true);
  assert.equal(shouldPreferWalletSendCalls("farcaster-miniapp"), true);
  assert.equal(shouldPreferWalletSendCalls("injected"), false);
});

test("avoids direct single-tx submission for Farcaster wallets", () => {
  assert.equal(shouldUseDirectTransactionSubmission(1, "farcaster", "buy"), false);
  assert.equal(shouldUseDirectTransactionSubmission(1, "farcaster-miniapp", "sell"), false);
  assert.equal(shouldUseDirectTransactionSubmission(1, "injected", "buy"), true);
  assert.equal(shouldUseDirectTransactionSubmission(2, "injected", "buy"), false);
});

test("uses direct single-tx submission for redeem on every connector", () => {
  assert.equal(shouldUseDirectTransactionSubmission(1, "farcaster", "redeem"), true);
  assert.equal(shouldUseDirectTransactionSubmission(1, "farcaster-miniapp", "redeem"), true);
  assert.equal(shouldUseDirectTransactionSubmission(1, "injected", "redeem"), true);
});

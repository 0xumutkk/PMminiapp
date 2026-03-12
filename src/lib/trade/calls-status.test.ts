import assert from "node:assert/strict";
import test from "node:test";
import { extractCallsStatusTxHashes } from "@/lib/trade/calls-status";

test("extracts confirmed transaction hashes from wallet_getCallsStatus receipts", () => {
  const hashes = extractCallsStatusTxHashes({
    receipts: [
      { transactionHash: "0xabc123" },
      { transactionHash: "0xdef456" }
    ]
  });

  assert.deepEqual(hashes, ["0xabc123", "0xdef456"]);
});

test("ignores empty or malformed receipts", () => {
  const hashes = extractCallsStatusTxHashes({
    receipts: [
      { transactionHash: null },
      {},
      { transactionHash: "not-a-hash" },
      { transactionHash: "0x1234" }
    ]
  });

  assert.deepEqual(hashes, ["0x1234"]);
});

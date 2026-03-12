import assert from "node:assert/strict";
import test from "node:test";
import { matchesSubmittedCall } from "@/lib/trade/submitted-transaction-match";

const CALL = {
  to: "0xC9c98965297Bc527861c898329Ee280632B76e18" as const,
  data:
    "0x01b7037c000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000000000df85d39c37aec82fc3a96ffb44ebc1dcb4fa0346ccb42c3adca2b7c9eeef87180000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000002" as const,
  value: 0n
};

test("matches a submitted transaction with the same to/data/value/from", () => {
  const matches = matchesSubmittedCall(
    {
      from: "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc",
      to: CALL.to,
      input: CALL.data,
      value: 0n
    },
    CALL,
    "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc"
  );

  assert.equal(matches, true);
});

test("rejects an unrelated historical transaction hash", () => {
  const matches = matchesSubmittedCall(
    {
      from: "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc",
      to: "0xA68123f55A0a236280Cd1aC65b2eDea77c38C977",
      input: "0xd96a094a0000000000000000000000000000000000000000000000000000000000000001",
      value: 0n
    },
    CALL,
    "0xBAaED3db46Fc1108c258C743c29F3424e57B3dfc"
  );

  assert.equal(matches, false);
});

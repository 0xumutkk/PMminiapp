import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatWalletConnectError,
  isCrossOriginFrameConnectError,
  resolveFallbackConnector,
  resolvePreferredConnector
} from "@/lib/wallet/connector-preference";

const CONNECTORS = [
  { id: "baseAccount", name: "Base Account" },
  { id: "injected", name: "Injected" }
];

test("resolvePreferredConnector prefers injected when an injected provider is available", () => {
  const connector = resolvePreferredConnector(CONNECTORS, {
    hasInjectedProvider: true,
    isFramed: false
  });

  assert.equal(connector?.id, "injected");
});

test("resolvePreferredConnector falls back to baseAccount when no injected provider is present", () => {
  const connector = resolvePreferredConnector(CONNECTORS, {
    hasInjectedProvider: false,
    isFramed: false
  });

  assert.equal(connector?.id, "baseAccount");
});

test("resolveFallbackConnector retries with injected after a baseAccount frame error", () => {
  const connector = resolveFallbackConnector(
    "baseAccount",
    CONNECTORS,
    new Error("Blocked a frame with origin \"https://mini.swipen.xyz\""),
    {
      hasInjectedProvider: true,
      isFramed: true
    }
  );

  assert.equal(connector?.id, "injected");
});

test("isCrossOriginFrameConnectError detects browser security exceptions", () => {
  assert.equal(
    isCrossOriginFrameConnectError(new Error("Blocked a frame with origin \"https://mini.swipen.xyz\"")),
    true
  );
  assert.equal(
    isCrossOriginFrameConnectError(new Error("Cross-Origin-Opener-Policy policy would block the window.closed call")),
    true
  );
  assert.equal(isCrossOriginFrameConnectError(new Error("User rejected the request.")), false);
});

test("formatWalletConnectError returns a friendly message for frame errors", () => {
  assert.equal(
    formatWalletConnectError(new Error("Blocked a frame with origin \"https://mini.swipen.xyz\"")),
    "This host blocks Base Account in an iframe. Retry with your injected wallet."
  );
  assert.equal(
    formatWalletConnectError(new Error("User rejected the request.")),
    "User rejected the request."
  );
});

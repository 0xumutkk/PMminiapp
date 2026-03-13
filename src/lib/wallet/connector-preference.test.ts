import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getWalletConnectUnavailableReason,
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

test("resolvePreferredConnector prefers a discovered injected connector in framed hosts", () => {
  const connector = resolvePreferredConnector(
    [
      ...CONNECTORS,
      { id: "xyz.wallet", name: "Hosted Wallet", type: "injected" }
    ],
    {
      hasInjectedProvider: false,
      isFramed: true
    }
  );

  assert.equal(connector?.id, "xyz.wallet");
});

test("resolvePreferredConnector disables baseAccount in framed hosts without an injected wallet", () => {
  const connector = resolvePreferredConnector(CONNECTORS, {
    hasInjectedProvider: false,
    isFramed: true
  });

  assert.equal(connector, undefined);
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

test("resolveFallbackConnector does not retry baseAccount after an injected provider miss in a frame", () => {
  const connector = resolveFallbackConnector(
    "injected",
    CONNECTORS,
    new Error("Provider not found"),
    {
      hasInjectedProvider: false,
      isFramed: true
    }
  );

  assert.equal(connector, undefined);
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
    formatWalletConnectError(new Error("Provider not found"), {
      hasInjectedProvider: false,
      isFramed: true
    }),
    "No injected wallet is available in this host. Open the app in a wallet-enabled browser or supported mini app."
  );
  assert.equal(
    formatWalletConnectError(new Error("User rejected the request.")),
    "User rejected the request."
  );
});

test("getWalletConnectUnavailableReason explains framed hosts without an injected wallet", () => {
  assert.equal(
    getWalletConnectUnavailableReason(CONNECTORS, {
      hasInjectedProvider: false,
      isFramed: true
    }),
    "No injected wallet is available in this host. Open the app in a wallet-enabled browser or supported mini app."
  );
  assert.equal(
    getWalletConnectUnavailableReason(CONNECTORS, {
      hasInjectedProvider: false,
      isFramed: false
    }),
    null
  );
});

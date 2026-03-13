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

function createEnvironment(overrides: Partial<{
  hasInjectedProvider: boolean;
  hasMiniAppProvider: boolean;
  hasWindowEthereum: boolean;
  isFramed: boolean;
}> = {}) {
  return {
    hasInjectedProvider: false,
    hasMiniAppProvider: false,
    hasWindowEthereum: false,
    isFramed: false,
    ...overrides
  };
}

test("resolvePreferredConnector prefers injected when an injected provider is available", () => {
  const connector = resolvePreferredConnector(CONNECTORS, {
    ...createEnvironment(),
    hasInjectedProvider: true,
    hasWindowEthereum: true
  });

  assert.equal(connector?.id, "injected");
});

test("resolvePreferredConnector falls back to baseAccount when no injected provider is present", () => {
  const connector = resolvePreferredConnector(CONNECTORS, {
    ...createEnvironment()
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
      ...createEnvironment({ isFramed: true })
    }
  );

  assert.equal(connector?.id, "xyz.wallet");
});

test("resolvePreferredConnector disables baseAccount in framed hosts without an injected wallet", () => {
  const connector = resolvePreferredConnector(CONNECTORS, {
    ...createEnvironment({ isFramed: true })
  });

  assert.equal(connector, undefined);
});

test("resolvePreferredConnector does not select the static miniapp connector before the host provider is ready", () => {
  const connector = resolvePreferredConnector(
    [
      { id: "farcaster-miniapp", name: "Mini App Wallet", type: "injected" },
      ...CONNECTORS
    ],
    {
      ...createEnvironment({ isFramed: true })
    }
  );

  assert.equal(connector, undefined);
});

test("resolvePreferredConnector selects the static miniapp connector when the host provider is ready", () => {
  const connector = resolvePreferredConnector(
    [
      { id: "farcaster-miniapp", name: "Mini App Wallet", type: "injected" },
      ...CONNECTORS
    ],
    {
      ...createEnvironment({
        hasInjectedProvider: true,
        hasMiniAppProvider: true,
        isFramed: true
      })
    }
  );

  assert.equal(connector?.id, "farcaster-miniapp");
});

test("resolveFallbackConnector retries with injected after a baseAccount frame error", () => {
  const connector = resolveFallbackConnector(
    "baseAccount",
    CONNECTORS,
    new Error("Blocked a frame with origin \"https://mini.swipen.xyz\""),
    {
      ...createEnvironment({
        hasInjectedProvider: true,
        hasWindowEthereum: true,
        isFramed: true
      })
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
      ...createEnvironment({ isFramed: true })
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
      ...createEnvironment({ isFramed: true })
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
      ...createEnvironment({ isFramed: true })
    }),
    "No injected wallet is available in this host. Open the app in a wallet-enabled browser or supported mini app."
  );
  assert.equal(
    getWalletConnectUnavailableReason(CONNECTORS, {
      ...createEnvironment()
    }),
    null
  );
});

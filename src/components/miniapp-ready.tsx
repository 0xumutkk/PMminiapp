"use client";

import { useEffect } from "react";

type MiniAppReadyWindow = Window & {
  __swipenMiniAppReadyComplete?: boolean;
  __swipenMiniAppReadyPromise?: Promise<void>;
  __swipenMiniAppWalletBridgeComplete?: boolean;
  __swipenMiniAppWalletBridgePromise?: Promise<void>;
  __swipenMiniAppEthereumProvider?: unknown;
};

async function ensureMiniAppWalletBridge() {
  if (typeof window === "undefined") {
    return;
  }

  const readyWindow = window as MiniAppReadyWindow;
  if (readyWindow.__swipenMiniAppWalletBridgeComplete || readyWindow.__swipenMiniAppEthereumProvider) {
    return;
  }

  if (readyWindow.__swipenMiniAppWalletBridgePromise) {
    return readyWindow.__swipenMiniAppWalletBridgePromise;
  }

  readyWindow.__swipenMiniAppWalletBridgePromise = (async () => {
    const { sdk } = await import("@farcaster/miniapp-sdk");
    const inMiniApp = await sdk.isInMiniApp();
    if (!inMiniApp) {
      return;
    }

    const provider = await sdk.wallet.getEthereumProvider();
    if (!provider || readyWindow.__swipenMiniAppEthereumProvider) {
      return;
    }

    readyWindow.__swipenMiniAppEthereumProvider = provider;
    readyWindow.__swipenMiniAppWalletBridgeComplete = true;
    readyWindow.dispatchEvent(new Event("ethereum#initialized"));
    readyWindow.dispatchEvent(new Event("swipen:wallet-provider-ready"));
  })().finally(() => {
    if (!readyWindow.__swipenMiniAppWalletBridgeComplete && !readyWindow.__swipenMiniAppEthereumProvider) {
      readyWindow.__swipenMiniAppWalletBridgePromise = undefined;
    }
  });

  return readyWindow.__swipenMiniAppWalletBridgePromise;
}

async function ensureMiniAppReady() {
  if (typeof window === "undefined") {
    return;
  }

  const readyWindow = window as MiniAppReadyWindow;
  if (readyWindow.__swipenMiniAppReadyComplete) {
    return;
  }

  if (readyWindow.__swipenMiniAppReadyPromise) {
    return readyWindow.__swipenMiniAppReadyPromise;
  }

  readyWindow.__swipenMiniAppReadyPromise = (async () => {
    const { sdk } = await import("@farcaster/miniapp-sdk");
    const inMiniApp = await sdk.isInMiniApp();
    if (!inMiniApp) {
      return;
    }

    await ensureMiniAppWalletBridge();
    await sdk.actions.ready();
    readyWindow.__swipenMiniAppReadyComplete = true;
  })().finally(() => {
    if (!readyWindow.__swipenMiniAppReadyComplete) {
      readyWindow.__swipenMiniAppReadyPromise = undefined;
    }
  });

  return readyWindow.__swipenMiniAppReadyPromise;
}

export function MiniAppReady() {
  useEffect(() => {
    void ensureMiniAppWalletBridge().catch(() => {
      // Ignore provider bridge failures outside supported mini app hosts.
    });
    void ensureMiniAppReady().catch(() => {
      // Ignore ready failures outside supported mini app hosts.
    });
  }, []);

  return null;
}
